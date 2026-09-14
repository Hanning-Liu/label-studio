import json
from pathlib import Path
import hashlib

from django.core.management.base import BaseCommand, CommandError
from tasks.models import Task, AnnotationDraft
from tasks.reference_sync.lineage import collect_documents, consistent_read, report_for_task, validate_documents
from tasks.reference_sync.lineage_bundle import export_bundle, json_bytes


class Command(BaseCommand):
    help = 'Read-only L1--L4 audit from an explicit L4 task; optionally export a consistent evidence snapshot.'

    def add_arguments(self, parser):
        parser.add_argument('--task-id', type=int, required=True)
        parser.add_argument('--output', help='New local directory for raw formal annotations and lineage manifest')

    @consistent_read
    def handle(self, *args, **options):
        try:
            task = Task.objects.select_related('project').get(pk=options['task_id'])
            try:
                documents = collect_documents(task, level=4, formal=True)
            except ValueError:
                report = report_for_task(task, complete=True)
                self.stdout.write(json.dumps(report, ensure_ascii=False, indent=2))
                raise CommandError('来源不完整；未导出完整数据包')
            report = validate_documents(documents, complete=True)
            self.stdout.write(json.dumps(report, ensure_ascii=False, indent=2))
            if options['output']:
                export_bundle(documents, options['output'])
                drafts = list(AnnotationDraft.objects.filter(task_id__in=[doc['task_id'] for doc in documents])
                              .order_by('id').values('id', 'task_id', 'annotation_id', 'user_id', 'updated_at', 'result'))
                for draft in drafts:
                    draft['updated_at'] = draft['updated_at'].isoformat()
                content = json_bytes(drafts)
                path = Path(options['output'])
                (path / 'drafts-backup.json').write_bytes(content)
                (path / 'drafts-backup.sha256').write_text(hashlib.sha256(content).hexdigest() + '\n', encoding='ascii')
            if not report['complete']:
                raise CommandError('未通过完整标注验收；报告和原始证据仅供诊断')
        except (Task.DoesNotExist, ValueError, OSError) as exc:
            raise CommandError(str(exc)) from exc
