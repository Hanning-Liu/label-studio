import copy
import json
from pathlib import Path
from django.test import TransactionTestCase
from rest_framework.test import APIClient
from organizations.models import Organization
from projects.models import Project
from tasks.models import Annotation, AnnotationDraft, Prediction, Task
from users.models import User
from tasks.reference_sync.models import ReferenceSyncBinding, ReferenceSyncMapping
from tasks.reference_sync.service import process_pending, response_tokens, sync_atomic
from .reference import SYNC_TYPE, initialize_binding, manual_hash, reference_hash
from .template import build_template
from .validation import GEOMETRY, content_fingerprint, validate

SOURCE_CONFIG = '''<View><Image name="image" value="$image"/>
<RectangleLabels name="room_rectangle" toName="image"><Label value="Bathroom"/></RectangleLabels>
<PolygonLabels name="room_polygon" toName="image"><Label value="Bathroom"/></PolygonLabels>
<RectangleLabels name="portal_rectangle" toName="image"><Label value="Door"/></RectangleLabels>
<VectorLabels name="portal_vector" toName="image"><Label value="Open passage"/></VectorLabels>
<Rectangle name="zone_rectangle" toName="image"/><Polygon name="zone_polygon" toName="image"/>
<Labels name="function_zone" toName="image"><Label value="Sanitary/general"/><Label value="Toilet"/></Labels>
<VectorLabels name="connection_vector" toName="image"><Label value="Open passage"/></VectorLabels>
<VectorLabels name="visual_connection_vector" toName="image"><Label value="Visual only"/></VectorLabels>
<Choices name="connection_review" toName="image" perRegion="true"><Choice value="Reviewed"/></Choices>
<Choices name="visual_connection_review" toName="image" perRegion="true"><Choice value="Reviewed"/></Choices></View>'''


class OccupancySyncTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create(email='occupancy-qa@example.invalid')
        self.org = Organization.create_organization(created_by=self.user, title='L3 isolated tests')
        self.user.active_organization = self.org
        self.user.save()
        self.source_project = Project.objects.create(title='source L2', label_config=SOURCE_CONFIG, organization=self.org, created_by=self.user)
        self.target_project = Project.objects.create(title='target L3', label_config=build_template(SOURCE_CONFIG), organization=self.org, created_by=self.user)
        self.source_task = Task.objects.create(project=self.source_project, data={'image': '/fixture.png'}, overlap=1)
        fixture_path = Path(__file__).resolve().parents[3] / 'examples/occupancy-v1/frontend-fixtures.json'
        self.fixture = json.loads(fixture_path.read_text())[0]['results']
        self.parent_id = self.fixture[0]['id']
        room = {'id': 'room', 'from_name': 'room_rectangle', 'to_name': 'image', 'type': 'rectanglelabels',
                'value': {'x': 0, 'y': 0, 'width': 100, 'height': 100, 'rotation': 0, 'rectanglelabels': ['Bathroom']},
                'original_width': 1080, 'original_height': 671, 'meta': {'room_graph_node': {'schema_version': 3, 'room_type': 'Bathroom'}}}
        self.source = Annotation.objects.create(task=self.source_task, project=self.source_project, completed_by=self.user, result=[room] + copy.deepcopy(self.fixture[:2]))
        self.mapping = ReferenceSyncMapping.objects.create(source_project=self.source_project, target_project=self.target_project, sync_type=SYNC_TYPE, apply_policy='manual', auto_create=False, enabled=True)
        self.binding = ReferenceSyncBinding.objects.create(mapping=self.mapping, source_task_id=self.source_task.id, source_annotation_id=self.source.id)
        self.task = sync_atomic(initialize_binding)(self.binding)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def complete_result(self):
        refs = Prediction.objects.get(pk=self.binding.prediction_id).result
        results = copy.deepcopy(refs + self.fixture[2:])
        for r in results:
            if r['from_name'] in GEOMETRY:
                r['meta']['occupancy_context']['source_version'] = self.binding.applied_hash
        stamp = content_fingerprint(results, self.parent_id)
        for r in results:
            if r['from_name'] in GEOMETRY:
                r['meta']['occupancy_context']['review_fingerprint'] = stamp
        return results

    def draft(self):
        return AnnotationDraft.objects.create(task=self.task, user=self.user, result=self.complete_result())

    def payload(self, draft):
        return {**response_tokens(draft), 'draft_id': draft.id, 'expected_updated_at': draft.updated_at.isoformat(), 'result': copy.deepcopy(draft.result)}

    def update_source(self):
        self.source.result[2]['value']['labels'] = ['Toilet']
        self.source.save()
        self.binding.refresh_from_db()

    def test_manual_profile_never_worker_applies_and_stale_draft_still_saves(self):
        draft = self.draft()
        before = copy.deepcopy(draft.result)
        applied = self.binding.applied_hash
        self.update_source()
        self.assertEqual(process_pending(), 0)
        self.binding.refresh_from_db()
        self.assertEqual(applied, self.binding.applied_hash)
        draft.refresh_from_db()
        self.assertEqual(before, draft.result)
        response = self.client.patch(f'/api/drafts/{draft.id}/', self.payload(draft), format='json')
        self.assertEqual(response.status_code, 200, response.data)
        draft.refresh_from_db()
        response = self.client.post(f'/api/tasks/{self.task.id}/annotations/', self.payload(draft), format='json')
        self.assertEqual(response.status_code, 409, response.data)
        self.assertTrue(AnnotationDraft.objects.filter(pk=draft.id).exists())

    def test_explicit_apply_preserves_manual_submitted_and_other_drafts(self):
        draft = self.draft()
        submitted = Annotation.objects.create(task=self.task, project=self.target_project, completed_by=self.user, result=draft.result)
        original = copy.deepcopy(submitted.result)
        other = AnnotationDraft.objects.create(task=self.task, user=self.user, annotation=submitted, result=copy.deepcopy(draft.result))
        other_result = copy.deepcopy(other.result)
        protected = manual_hash(draft.result)
        self.update_source()
        payload = {**self.payload(draft), 'source_version': reference_hash(self.source.result)}
        response = self.client.post(f'/api/tasks/{self.task.id}/reference-sync/apply/', payload, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        draft.refresh_from_db(); other.refresh_from_db(); submitted.refresh_from_db()
        self.assertEqual(manual_hash(draft.result), protected)
        self.assertEqual(original, submitted.result)
        self.assertEqual(other_result, other.result)
        again = self.client.post(f'/api/tasks/{self.task.id}/reference-sync/apply/', payload, format='json')
        self.assertEqual(again.status_code, 409)

    def test_conflicts_no_mutation_and_no_implicit_submission(self):
        draft = self.draft()
        payload = self.payload(draft)
        draft.save()
        before = copy.deepcopy(draft.result)
        response = self.client.patch(f'/api/drafts/{draft.id}/', payload, format='json')
        self.assertEqual(response.status_code, 409)
        draft.refresh_from_db()
        self.assertEqual(before, draft.result)
        self.assertFalse(self.task.annotations.exists())

    def test_incomplete_draft_saved_but_backend_submission_blocks(self):
        draft = self.draft()
        payload = self.payload(draft)
        for r in payload['result']:
            if r.get('from_name') == 'occupancy_type':
                r['value']['labels'] = ['unclassified']
        response = self.client.patch(f'/api/drafts/{draft.id}/', payload, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        draft.refresh_from_db()
        response = self.client.post(f'/api/tasks/{self.task.id}/annotations/', self.payload(draft), format='json')
        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn('L3 正式提交未通过', str(response.data.get('detail', '')))
        self.assertEqual(response.data.get('display_context', {}).get('reason'), 'OCCUPANCY_VALIDATION')
        self.assertTrue(response.data.get('display_context', {}).get('issues'))
        self.assertTrue(AnnotationDraft.objects.filter(pk=draft.id).exists())
        response = self.client.patch(f'/api/drafts/{draft.id}/', self.payload(draft), format='json')
        self.assertEqual(response.status_code, 200, response.data)

    def test_valid_roundtrip_formal_submission(self):
        draft = self.draft()
        expected = manual_hash(draft.result)
        response = self.client.post(f'/api/tasks/{self.task.id}/annotations/', self.payload(draft), format='json')
        self.assertEqual(response.status_code, 201, response.data)
        saved = self.task.annotations.get()
        self.assertEqual(manual_hash(saved.result), expected)
        self.assertFalse(AnnotationDraft.objects.filter(pk=draft.id).exists())

    def test_leisure_recreation_group_passes_backend_validation_and_submission(self):
        draft = self.draft()
        results = copy.deepcopy(draft.result)
        group_geometry = next(
            r for r in results
            if r.get('from_name') in GEOMETRY
            and next(
                (
                    label.get('value', {}).get('labels', [None])[0]
                    for label in results
                    if label.get('id') == r.get('id') and label.get('from_name') == 'occupancy_type'
                ),
                None,
            ) == 'furniture_group'
        )
        group_geometry['meta']['occupancy_context']['group_type'] = 'leisure_recreation'
        group_geometry['meta']['occupancy_context']['group_note'] = ''

        remainder_stamp = content_fingerprint(results, self.parent_id, remainder=True)
        for result in results:
            if result.get('from_name') in GEOMETRY and result['meta']['occupancy_context'].get('generation') == 'remainder':
                result['meta']['occupancy_context']['remainder_input_fingerprint'] = remainder_stamp
        review_stamp = content_fingerprint(results, self.parent_id)
        for result in results:
            if result.get('from_name') in GEOMETRY:
                result['meta']['occupancy_context']['review_status'] = 'reviewed'
                result['meta']['occupancy_context']['review_fingerprint'] = review_stamp

        self.assertEqual(validate(results, self.binding.applied_hash), [])
        draft.result = results
        draft.save()
        response = self.client.post(f'/api/tasks/{self.task.id}/annotations/', self.payload(draft), format='json')
        self.assertEqual(response.status_code, 201, response.data)
        saved = self.task.annotations.get()
        saved_group = next(r for r in saved.result if r.get('id') == group_geometry['id'] and r.get('from_name') in GEOMETRY)
        self.assertEqual(saved_group['meta']['occupancy_context']['group_type'], 'leisure_recreation')
        self.assertEqual(saved_group['meta']['occupancy_context']['group_note'], '')

    def test_readonly_reference_tampering_not_saved(self):
        draft = self.draft()
        payload = self.payload(draft)
        payload['result'][0]['value']['width'] = 1
        response = self.client.patch(f'/api/drafts/{draft.id}/', payload, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        draft.refresh_from_db()
        self.assertEqual(draft.result[-3]['value']['width'], 100)

    def test_missing_or_replaced_source_is_not_silently_bound(self):
        self.source.delete()
        response = self.client.get(f'/api/tasks/{self.task.id}/reference-sync/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['status'], 'blocked')
        self.assertTrue(Prediction.objects.filter(pk=self.binding.prediction_id).exists())
