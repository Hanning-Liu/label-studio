import copy
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from unittest.mock import patch
from django.core.management import call_command, CommandError
from io import StringIO

from django.test import TransactionTestCase
from django.db import transaction, close_old_connections, connections
from rest_framework.test import APIClient
from organizations.models import Organization
from projects.models import Project
from tasks.models import Annotation,AnnotationDraft,Prediction,Task
from users.models import User
from .models import ReferenceSyncAudit,ReferenceSyncBinding,ReferenceSyncMapping
from .results import manual_hash,reference_hash,merge_results,pending_reviews,inside,validate_source,openings
from .service import process_pending,reconcile,response_tokens,snapshot,process_binding,sync_atomic,prepare_write,SyncConflict


CONFIG='''<View><Image name="image" value="$image" roomV3Validate="true" functionZoneV3Validate="true"/>
<RectangleLabels name="room_rectangle" toName="image"><Label value="Hallway"/><Label value="Bathroom"/></RectangleLabels>
<PolygonLabels name="room_polygon" toName="image"><Label value="Bathroom"/></PolygonLabels>
<RectangleLabels name="portal_rectangle" toName="image"><Label value="Door"/><Label value="Sliding door"/><Label value="Open passage"/></RectangleLabels>
<VectorLabels name="portal_vector" toName="image"><Label value="Open passage"/></VectorLabels>
<Rectangle name="zone_rectangle" toName="image"/><Polygon name="zone_polygon" toName="image"/>
<Labels name="function_zone" toName="image"><Label value="Circulation"/><Label value="Bathing/washing"/></Labels>
<VectorLabels name="connection_vector" toName="image"><Label value="Open passage"/></VectorLabels></View>'''


def room(i,x,label):
    return {'id':i,'from_name':'room_rectangle','to_name':'image','type':'rectanglelabels',
        'original_width':1000,'original_height':1000,'image_rotation':0,
        'value':{'x':x,'y':0,'width':50,'height':100,'rotation':0,'rectanglelabels':[label]},
        'meta':{'room_graph_node':{'schema_version':3,'room_type':label}}}


def portal(i='passage'):
    points=[{'x':50,'y':20},{'x':50,'y':30}]
    return {'id':i,'from_name':'portal_vector','to_name':'image','type':'vectorlabels',
        'original_width':1000,'original_height':1000,'image_rotation':0,
        'value':{'vertices':points,'closed':False,'vectorlabels':['Open passage']},
        'meta':{'room_graph_edge':{'schema_version':3,'room_ids':['hall','bath'],'connected_room_ids':['hall','bath'],
        'boundary_segments':{'hall':[copy.deepcopy(points)],'bath':[copy.deepcopy(points)]}}}}


def zones():
    output=[]
    for rid,x,label in [('hall',0,'Circulation'),('bath',50,'Bathing/washing')]:
        value={'x':x,'y':0,'width':50,'height':100,'rotation':0}
        output.extend([{'id':rid+'-zone','from_name':'zone_rectangle','to_name':'image','type':'rectangle',
            'value':copy.deepcopy(value),'meta':{'partition_context':{'parent_room_id':rid}}},
            {'id':rid+'-zone','from_name':'function_zone','to_name':'image','type':'labels',
             'value':{**value,'labels':[label]}}])
    output.append({'type':'relation','from_id':'hall-zone','to_id':'bath-zone','direction':'right'})
    return output


class ReferenceSyncTests(TransactionTestCase):
    reset_sequences=True

    def setUp(self):
        self.user=User.objects.create(email='reference-sync-test@example.invalid')
        self.org=Organization.create_organization(created_by=self.user,title='Reference tests')
        self.user.active_organization=self.org
        self.user.save()
        self.source_project=Project.objects.create(title='L1_Room_v3',label_config=CONFIG,created_by=self.user,organization=self.org)
        self.target_project=Project.objects.create(title='L2_FunctionZone_v3',label_config=CONFIG,created_by=self.user,organization=self.org)
        self.mapping=ReferenceSyncMapping.objects.create(source_project=self.source_project,target_project=self.target_project,enabled=True)
        self.task=Task.objects.create(project=self.source_project,data={'image':'/test.png'},overlap=1)
        self.source=Annotation.objects.create(task=self.task,project=self.source_project,completed_by=self.user,
            result=[room('hall',0,'Hallway'),room('bath',50,'Bathroom')])
        self.assertEqual(process_pending(),1)
        self.binding=ReferenceSyncBinding.objects.get(source_task_id=self.task.id)
        self.target=Task.objects.get(pk=self.binding.target_task_id)
        self.client=APIClient()
        self.client.force_authenticate(self.user)

    def draft(self):
        return AnnotationDraft.objects.create(task=self.target,user=self.user,
            result=copy.deepcopy(Prediction.objects.get(pk=self.binding.prediction_id).result)+zones())

    def change(self):
        self.source.result.append(portal())
        self.source.save()
        self.assertEqual(process_pending(),1)
        self.binding.refresh_from_db()

    def payload(self,obj):
        return {**response_tokens(obj),'expected_updated_at':obj.updated_at.isoformat().replace('+00:00','Z'),
                'result':copy.deepcopy(obj.result),'draft_id':obj.id if isinstance(obj,AnnotationDraft) else None}

    def test_first_submit_idempotent_order_and_draft_not_triggered(self):
        self.assertEqual(Task.objects.filter(project=self.target_project).count(),1)
        self.target.refresh_from_db()
        self.assertEqual(self.target.total_predictions,1)
        self.assertFalse(self.target.annotations.exists())
        self.source.result.reverse()
        self.source.save()
        self.assertEqual(process_pending(),0)
        AnnotationDraft.objects.create(task=self.task,user=self.user,result=self.source.result+[portal()])
        reconcile()
        self.assertEqual(process_pending(),0)
        self.assertEqual(ReferenceSyncAudit.objects.count(),1)
        self.assertEqual(Task.objects.filter(project=self.target_project).count(),1)

    def test_add_modify_delete_preserves_manual_and_relations(self):
        draft=self.draft()
        protected=manual_hash(draft.result)
        self.change()
        draft.refresh_from_db()
        self.assertEqual(manual_hash(draft.result),protected)
        self.assertIn('passage',{r.get('id') for r in draft.result})
        zone=next(r for r in draft.result if r.get('from_name')=='zone_rectangle')
        self.assertEqual(zone['meta']['partition_context']['opening_ids'],['passage'])
        self.assertTrue(pending_reviews(draft.result))
        self.source.result[-1]=portal('replacement')
        self.source.save()
        process_pending()
        draft.refresh_from_db()
        self.assertNotIn('passage',{r.get('id') for r in draft.result})
        self.assertIn('replacement',{r.get('id') for r in draft.result})
        self.assertEqual(manual_hash(draft.result),protected)

    def test_submitted_is_unchanged_and_review_draft_reused(self):
        draft=self.draft()
        saved=Annotation.objects.create(task=self.target,project=self.target_project,completed_by=self.user,result=draft.result)
        draft.delete()
        before=copy.deepcopy(saved.result)
        self.change()
        saved.refresh_from_db()
        self.assertEqual(saved.result,before)
        review=AnnotationDraft.objects.get(task=self.target,annotation=saved,user=self.user)
        self.source.result.append(portal('second'))
        self.source.save()
        process_pending()
        self.assertEqual(AnnotationDraft.objects.filter(task=self.target,annotation=saved).count(),1)
        saved.refresh_from_db()
        self.assertEqual(saved.result,before)

    def test_reference_only_rebase_and_manual_conflict(self):
        draft=self.draft()
        original=self.payload(draft)
        self.change()
        # A local manual edit based on the old reference is safely rebased.
        original['result'][-2]['value']['labels']=['Circulation']
        result=self.client.patch(f'/api/drafts/{draft.id}/',original,format='json')
        self.assertEqual(result.status_code,200,result.data)
        self.assertIn('passage',{r.get('id') for r in result.data['result']})
        rejected=self.client.patch(f'/api/drafts/{draft.id}/',original,format='json')
        self.assertEqual(rejected.status_code,409)
        self.assertIn('人工内容',str(rejected.data['detail']))
        old_client=self.client.patch(f'/api/drafts/{draft.id}/',{'result':[]},format='json')
        self.assertEqual(old_client.status_code,428)

    def test_stale_submission_preserves_draft_and_pending_review_blocks(self):
        draft=self.draft()
        old=self.payload(draft)
        self.change()
        response=self.client.post(f'/api/tasks/{self.target.id}/annotations/',old,format='json')
        self.assertEqual(response.status_code,409,response.data)
        self.assertTrue(AnnotationDraft.objects.filter(pk=draft.id).exists())
        draft.refresh_from_db()
        response=self.client.post(f'/api/tasks/{self.target.id}/annotations/',self.payload(draft),format='json')
        self.assertEqual(response.status_code,400,response.data)
        self.assertFalse(self.target.annotations.exists())

    def test_explicit_review_and_submit(self):
        draft=self.draft()
        self.change()
        draft.refresh_from_db()
        p=self.payload(draft)
        p.pop('result')
        p['region_ids']=[r['id'] for r in pending_reviews(draft.result)]
        response=self.client.post(f'/api/tasks/{self.target.id}/reference-sync/review/',p,format='json')
        self.assertEqual(response.status_code,200,response.data)
        draft.refresh_from_db()
        response=self.client.post(f'/api/tasks/{self.target.id}/annotations/',self.payload(draft),format='json')
        self.assertEqual(response.status_code,201,response.data)
        self.assertFalse(AnnotationDraft.objects.filter(pk=draft.id).exists())

    def test_missing_parent_retained_and_cannot_be_reviewed(self):
        draft=self.draft()
        self.source.result=self.source.result[:1]
        self.source.save()
        process_pending()
        draft.refresh_from_db()
        self.assertTrue(any(r.get('id')=='bath-zone' for r in draft.result))
        bad=next(r for r in pending_reviews(draft.result) if r['id']=='bath-zone')
        self.assertEqual(bad['reason'],'source_missing')
        p=self.payload(draft)
        p['region_ids']=['bath-zone']
        response=self.client.post(f'/api/tasks/{self.target.id}/reference-sync/review/',p,format='json')
        self.assertEqual(response.status_code,400)

    def test_invalid_source_rolls_back_and_restart_reconcile_recovers(self):
        before=snapshot(self.target)
        self.source.result.append(portal())
        self.source.result[-1]['meta']['room_graph_edge']['room_ids']=['missing']
        self.source.result[-1]['meta']['room_graph_edge']['connected_room_ids']=['missing']
        self.source.save()
        process_pending()
        self.binding.refresh_from_db()
        self.assertEqual(self.binding.status,'blocked')
        self.assertEqual(snapshot(self.target),before)
        self.source.result[-1]=portal()
        Annotation.objects.filter(pk=self.source.id).update(result=self.source.result)
        reconcile()
        self.assertEqual(process_pending(),1)

    def test_transaction_failure_no_partial_prediction_draft_or_audit(self):
        self.draft()
        before=snapshot(self.target)
        audits=ReferenceSyncAudit.objects.count()
        self.source.result.append(portal())
        self.source.save()
        with patch.object(AnnotationDraft,'save',side_effect=RuntimeError('injected failure')):
            process_pending()
        self.assertEqual(snapshot(self.target),before)
        self.assertEqual(ReferenceSyncAudit.objects.count(),audits)

    def test_source_transaction_rollback_has_no_pending_job(self):
        with self.assertRaises(RuntimeError):
            with transaction.atomic():
                self.source.result.append(portal())
                self.source.save()
                raise RuntimeError('rollback')
        self.binding.refresh_from_db()
        self.assertEqual(self.binding.status,'synced')
        self.assertEqual(process_pending(),0)

    def test_source_cancel_delete_multiple_and_image_change_pause(self):
        self.source.was_cancelled=True
        self.source.save()
        self.binding.refresh_from_db()
        self.assertEqual(self.binding.status,'blocked')
        self.source.was_cancelled=False
        self.source.save()
        process_pending()
        extra=Annotation.objects.create(task=self.task,project=self.source_project,completed_by=self.user,result=self.source.result)
        self.binding.refresh_from_db()
        self.assertEqual(self.binding.status,'blocked')
        extra.delete()
        process_pending()
        self.task.data={'image':'/different.png'}
        self.task.save()
        reconcile()
        self.binding.refresh_from_db()
        self.assertEqual(self.binding.status,'blocked')
        self.assertTrue(Task.objects.filter(pk=self.target.id).exists())

    def test_status_auth_and_retry_cannot_rebind(self):
        url=f'/api/tasks/{self.target.id}/reference-sync/'
        response=self.client.get(url)
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.data['source_task_id'],self.task.id)
        self.assertEqual(self.client.post(url,{'source_task_id':999},format='json').status_code,400)
        self.client.force_authenticate(None)
        self.assertIn(self.client.get(url).status_code,[401,403])

    def test_concave_containment_does_not_only_check_midpoints(self):
        room_poly=[(0,0),(10,0),(10,10),(8,10),(8,3),(7,3),(7,10),(0,10)]
        self.assertFalse(inside([(1,4),(9,4),(9,5),(1,5)],room_poly))

    def test_hash_ignores_order_and_display_only_properties(self):
        refs=self.source.result
        other=copy.deepcopy(list(reversed(refs)))
        other[0].update(origin='prediction',readonly=True,opacity=.2,fillcolor='#ffffff')
        self.assertEqual(reference_hash(refs),reference_hash(other))

    def test_frontend_geometry_parity(self):
        for case in json.loads(Path(__file__).with_name('geometry_cases.json').read_text()):
            with self.subTest(case=case['name']):
                refs={}
                for opening in case['openings']:
                    r=refs.setdefault(opening['id'],{'id':opening['id'],'from_name':'portal_vector',
                        'meta':{'room_graph_edge':{'connected_room_ids':[r for r in opening['roomIds'] if r!='Exterior'],
                        'connects_to_exterior':'Exterior' in opening['roomIds'],'boundary_segments':{case['room']:[]}}}})
                    r['meta']['room_graph_edge']['boundary_segments'][case['room']].append([{'x':x,'y':y} for x,y in opening['points']])
                ids,connected=openings([tuple(p) for p in case['polygon']],case['room'],list(refs.values()))
                self.assertEqual({'opening_ids':ids,'connected_room_ids':connected},case['expected'])

    def test_sqlite_concurrent_windows_and_workers(self):
        draft=self.draft()
        baseline=self.payload(draft)
        barrier=Barrier(2)
        @sync_atomic
        def save(payload):
            current=AnnotationDraft.objects.get(pk=draft.id)
            result,_=prepare_write(current.task,payload,current)
            current.result=result
            current.save(update_fields=['result','updated_at'])
        def window(label):
            close_old_connections()
            payload=copy.deepcopy(baseline)
            payload['result'][-2]['value']['labels']=[label]
            barrier.wait(timeout=5)
            try:
                save(payload)
                return 200
            except SyncConflict as exc:
                return exc.status_code
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses=list(pool.map(window,['Circulation','Bathing/washing changed']))
        self.assertEqual(sorted(responses),[200,409])
        self.source.result.append(portal())
        self.source.save()
        barrier=Barrier(2)
        def worker(_):
            close_old_connections()
            barrier.wait(timeout=5)
            try:
                return process_binding(self.binding.id)
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(worker,[1,2])),[False,True])
        self.assertEqual(Task.objects.filter(project=self.target_project).count(),1)
        self.assertEqual(ReferenceSyncAudit.objects.filter(operation='sync').count(),1)

    def test_timestamp_conflict_and_update_preserve_draft(self):
        draft=self.draft()
        old=self.payload(draft)
        draft.save(update_fields=['updated_at'])
        self.assertEqual(self.client.patch(f'/api/drafts/{draft.id}/',old,format='json').status_code,409)
        saved=Annotation.objects.create(task=self.target,project=self.target_project,completed_by=self.user,result=draft.result)
        draft.annotation=saved
        draft.save()
        old=self.payload(draft)
        self.change()
        response=self.client.patch(f'/api/annotations/{saved.id}/',old,format='json')
        self.assertEqual(response.status_code,409,response.data)
        self.assertTrue(AnnotationDraft.objects.filter(pk=draft.id).exists())
        saved.refresh_from_db()
        self.assertNotIn('passage',{r.get('id') for r in saved.result})

    def test_disabled_mapping_does_not_sync_and_nonbound_draft_still_works(self):
        self.mapping.enabled=False
        self.mapping.save()
        before=snapshot(self.target)
        self.source.result.append(portal())
        self.source.save()
        reconcile()
        self.assertEqual(process_pending(),0)
        self.assertEqual(snapshot(self.target),before)
        d=AnnotationDraft.objects.create(task=self.task,user=self.user,result=self.source.result)
        response=self.client.patch(f'/api/drafts/{d.id}/',{'result':d.result,'expected_updated_at':d.updated_at.isoformat().replace('+00:00','Z')},format='json')
        self.assertEqual(response.status_code,200,response.data)

    def test_task_scoped_restore_requires_unchanged_state_and_disabled_mapping(self):
        self.draft()
        before=snapshot(self.target)
        self.change()
        audit=ReferenceSyncAudit.objects.latest('id')
        with self.assertRaises(CommandError):
            call_command('restore_reference_sync',audit=audit.id,apply=True,stdout=StringIO())

        self.mapping.enabled=False
        self.mapping.save()
        call_command('restore_reference_sync',audit=audit.id,stdout=StringIO())
        self.assertNotEqual(snapshot(self.target),before)
        call_command('restore_reference_sync',audit=audit.id,apply=True,stdout=StringIO())
        self.assertEqual(snapshot(self.target),before)
        with self.assertRaises(CommandError):
            call_command('restore_reference_sync',audit=audit.id,apply=True,stdout=StringIO())

    def test_source_portal_geometry_and_target_configuration_validation(self):
        invalid=portal()
        invalid['value']['vertices'][0]['x']=60
        with self.assertRaises(ValueError):
            validate_source(self.source.result+[invalid],CONFIG)
        with self.assertRaises(ValueError):
            validate_source(self.source.result,CONFIG.replace('<Label value="Hallway"/>',''))

    def test_linked_review_draft_updates_only_after_explicit_update(self):
        draft=self.draft()
        saved=Annotation.objects.create(task=self.target,project=self.target_project,completed_by=self.user,result=draft.result)
        original=copy.deepcopy(saved.result)
        draft.annotation=saved
        draft.save()
        self.change()
        response=self.client.get(f'/api/annotations/{saved.id}/')
        self.assertEqual(response.data['result'],original)
        self.assertNotEqual(response.data['reference_version'],self.binding.applied_hash)
        draft.refresh_from_db()
        payload=self.payload(draft)
        payload['region_ids']=[r['id'] for r in pending_reviews(draft.result)]
        reviewed=self.client.post(f'/api/tasks/{self.target.id}/reference-sync/review/',payload,format='json')
        self.assertEqual(reviewed.status_code,200,reviewed.data)
        draft.refresh_from_db()
        response=self.client.patch(f'/api/annotations/{saved.id}/',self.payload(draft),format='json')
        self.assertEqual(response.status_code,200,response.data)
        saved.refresh_from_db()
        self.assertIn('passage',{r.get('id') for r in saved.result})
        self.assertFalse(AnnotationDraft.objects.filter(pk=draft.id).exists())
