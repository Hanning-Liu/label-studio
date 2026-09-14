import json
from django.core.management.base import BaseCommand,CommandError
from django.db import transaction
from projects.models import Project
from tasks.models import Task,Annotation,Prediction
from tasks.reference_sync.models import ReferenceSyncMapping,ReferenceSyncBinding
from tasks.reference_sync.results import digest,reference_hash
from tasks.reference_sync.service import reconcile


class Command(BaseCommand):
    help = 'Dry-run by default. Adopt explicit provenance, never match on image names.'

    def add_arguments(self,p):
        p.add_argument('--source-project',required=True,type=int)
        p.add_argument('--target-project',required=True,type=int)
        p.add_argument('--apply',action='store_true')
        p.add_argument('--disable',action='store_true')

    def handle(self,*args,**o):
        source=Project.objects.get(pk=o['source_project'])
        target=Project.objects.get(pk=o['target_project'])
        if source.id==target.id or source.organization_id!=target.organization_id or 'Legacy' in source.title or 'Legacy' in target.title:
            raise CommandError('Invalid project pair; legacy and cross-organization pairs are prohibited')
        if 'roomV3Validate="true"' not in source.label_config or 'functionZoneV3Validate="true"' not in target.label_config:
            raise CommandError('Project pair is not Room v3 -> FunctionZone v3')
        adopted=[]
        seen=set()
        for task in Task.objects.filter(project=target):
            provenance=(task.meta or {}).get('room_layout_reference',{})
            if provenance.get('source_project_id')!=source.id:
                continue
            source_id=provenance.get('source_task_id')
            annotation_id=provenance.get('source_annotation_id')
            annotation=Annotation.objects.filter(pk=annotation_id,task_id=source_id,project=source).first()
            if not annotation or source_id in seen:
                raise CommandError('Missing source or duplicate target provenance; manual resolution required')
            seen.add(source_id)
            model_version=f'room-v3-task{source_id}-annotation{annotation_id}-reference'
            predictions=list(Prediction.objects.filter(task=task,model_version=model_version))
            if len(predictions)!=1 or digest(task.data)!=digest(annotation.task.data):
                raise CommandError('Reference prediction or image mapping ambiguous')
            adopted.append({'source_task':source_id,'source_annotation':annotation_id,'target_task':task.id,
                'prediction':predictions[0].id,'applied_hash':reference_hash(predictions[0].result),'data_hash':digest(task.data)})
        self.stdout.write(json.dumps({'dry_run':not o['apply'],'pair':[source.id,target.id],'adopt':adopted,'enabled':not o['disable']}))
        if not o['apply']:
            return
        with transaction.atomic():
            mapping,_=ReferenceSyncMapping.objects.get_or_create(source_project=source,target_project=target)
            for item in adopted:
                binding,created=ReferenceSyncBinding.objects.get_or_create(mapping=mapping,source_task_id=item['source_task'],
                    defaults={'source_annotation_id':item['source_annotation'],'target_task_id':item['target_task'],
                              'prediction_id':item['prediction'],'applied_hash':item['applied_hash'],
                              'source_data_hash':item['data_hash']})
                if not created and (binding.target_task_id!=item['target_task'] or binding.source_annotation_id!=item['source_annotation']):
                    raise CommandError('Existing binding conflicts with provenance')
            mapping.enabled=not o['disable']
            mapping.save(update_fields=['enabled'])
        if not o['disable']:
            reconcile()
