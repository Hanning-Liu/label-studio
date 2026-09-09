import difflib
import json

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from projects.models import Project
from tasks.models import Task
from tasks.reference_sync.lineage import canonical_windows, collect_documents, config_digest, validate_documents
from tasks.reference_sync.window_config_upgrade import upgrade_window_control


class Command(BaseCommand):
    help = 'Preview or explicitly add the L1 window reference control to one identified downstream project.'

    def add_arguments(self, parser):
        parser.add_argument('--project-id', type=int, required=True)
        parser.add_argument('--l1-task-id', type=int, required=True)
        parser.add_argument('--expected-title')
        parser.add_argument('--expected-config-sha256')
        parser.add_argument('--expected-source-version')
        modes = parser.add_mutually_exclusive_group()
        modes.add_argument('--dry-run', action='store_true')
        modes.add_argument('--apply', action='store_true')

    @transaction.atomic
    def handle(self, *args, **options):
        try:
            project = Project.objects.select_for_update().get(pk=options['project_id'])
            task = Task.objects.select_related('project').get(pk=options['l1_task_id'])
            documents = collect_documents(task, level=1, formal=True, lock=options['apply'])
            source = validate_documents(documents)
            if not source['ready']:
                raise ValueError('；'.join(issue['message'] for issue in source['issues']))
            if project.organization_id != task.project.organization_id or project.id == task.project_id:
                raise ValueError('目标必须是同组织的下游项目')
            original = project.label_config
            guards = {'expected_title': project.title, 'expected_config_sha256': config_digest(original),
                      'expected_source_version': source['version']}
            for key, actual in guards.items():
                if options['apply'] and not options[key]:
                    raise ValueError(f"应用时必须提供 --{key.replace('_', '-')}")
                if options[key] is not None and options[key] != actual:
                    raise ValueError(f'{key} 已变化，未写入；请重新预览')
            updated, additions = upgrade_window_control(original, task.project.label_config,
                                                        canonical_windows(documents[0]['result']))
            Project.validate_label_config(updated)
            report = {'project_id': project.id, 'title': project.title, 'l1_task_id': task.id,
                      'l1_annotation_id': documents[0]['annotation_id'], 'source_version': source['version'],
                      'original_sha256': config_digest(original), 'updated_sha256': config_digest(updated),
                      'additions': additions, 'applied': bool(options['apply'] and additions),
                      'diff': ''.join(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
                                                         fromfile='before.xml', tofile='after.xml'))}
            if report['applied']:
                project.validate_config(updated)
                project.label_config = updated
                project.save(update_fields=['label_config'], recalc=False)
            self.stdout.write(json.dumps(report, ensure_ascii=False, indent=2))
        except (ValueError, Task.DoesNotExist, Project.DoesNotExist) as exc:
            raise CommandError(str(exc)) from exc
