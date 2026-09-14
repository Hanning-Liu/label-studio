import copy
import json

from django.core.management.base import BaseCommand, CommandError
from tasks.models import AnnotationDraft, Prediction, Task
from tasks.reference_sync.models import ReferenceSyncAudit
from tasks.reference_sync.results import reference_hash
from tasks.reference_sync.service import snapshot, sync_atomic


class Command(BaseCommand):
    help = 'Dry-run task-scoped reference recovery. Requires disabled mapping and an unchanged audit after-state.'

    def add_arguments(self, parser):
        parser.add_argument('--audit', type=int, required=True)
        parser.add_argument('--apply', action='store_true')

    @sync_atomic
    def handle(self, *args, **options):
        audit = ReferenceSyncAudit.objects.select_related('binding__mapping').get(pk=options['audit'])
        binding = audit.binding
        if audit.operation not in {'create', 'sync'}:
            raise CommandError('Only worker sync audits can be restored by this command')
        if binding.mapping.enabled:
            raise CommandError('Disable the project mapping before task-scoped recovery')
        task = Task.objects.get(pk=binding.target_task_id)
        current = snapshot(task)
        if current != audit.after:
            raise CommandError('Task changed after this audit; stop to avoid overwriting newer annotations')
        self.stdout.write(json.dumps({'dry_run': not options['apply'], 'task': task.id, 'audit': audit.id}))
        if not options['apply']:
            return
        before = audit.before
        if before['annotations'] != current['annotations']:
            raise CommandError('Submitted results differ; automatic restoration is prohibited')
        old_predictions = {p['id']: p for p in before['predictions']}
        old_drafts = {d['id']: d for d in before['drafts']}
        for prediction in task.predictions.all():
            if prediction.id not in old_predictions:
                prediction.delete()
            else:
                prediction.result = copy.deepcopy(old_predictions[prediction.id]['result'])
                prediction.model_version = old_predictions[prediction.id]['model_version']
                prediction.save(update_fields=['result', 'model_version', 'updated_at'])
        for draft in task.drafts.all():
            if draft.id not in old_drafts:
                draft.delete()
            else:
                draft.result = copy.deepcopy(old_drafts[draft.id]['result'])
                draft.save(update_fields=['result', 'updated_at'])
        task.meta = copy.deepcopy(before['task']['meta'])
        task.save(update_fields=['meta', 'updated_at'])
        prediction = task.predictions.filter(pk=binding.prediction_id).first()
        binding.applied_hash = reference_hash(prediction.result) if prediction else ''
        if not prediction:
            binding.prediction_id = None
        binding.status = 'blocked'
        binding.error = '已按任务审计恢复；映射保持关闭，重新启用前需人工核对'
        binding.save()
        restored = snapshot(task)
        if restored != before:
            raise CommandError('Restoration verification failed; all changes rolled back')
        ReferenceSyncAudit.objects.create(binding=binding, operation='restore', source_hash=binding.applied_hash,
            before=current, after=restored, summary={'restored_audit': audit.id})
