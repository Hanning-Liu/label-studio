import difflib
import json

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from projects.models import Project
from tasks.furniture_instances.catalog_upgrade import config_sha256, upgrade_choices


class Command(BaseCommand):
    help = 'Preview or append the two L4 catalog additions to one explicitly identified project.'

    def add_arguments(self, parser):
        parser.add_argument('--project-id', type=int, required=True)
        parser.add_argument('--expected-title')
        parser.add_argument('--expected-config-sha256')
        mode = parser.add_mutually_exclusive_group()
        mode.add_argument('--dry-run', action='store_true')
        mode.add_argument('--apply', action='store_true')

    @transaction.atomic
    def handle(self, *args, **options):
        try:
            project = Project.objects.select_for_update().get(pk=options['project_id'])
            original = project.label_config
            digest = config_sha256(original)
            if options['apply'] and not (options['expected_title'] and options['expected_config_sha256']):
                raise ValueError('应用时必须提供 --expected-title 和 --expected-config-sha256')
            if options['expected_title'] is not None and project.title != options['expected_title']:
                raise ValueError('项目名称已改变，未写入')
            if options['expected_config_sha256'] is not None and digest != options['expected_config_sha256']:
                raise ValueError('项目配置已改变，未写入；请重新预览')
            updated, additions = upgrade_choices(original)
            # Preview must not call validate_config(), which may reset an empty project summary.
            Project.validate_label_config(updated)
            report = {
                'project_id': project.id, 'title': project.title, 'original_sha256': digest,
                'updated_sha256': config_sha256(updated), 'additions': additions,
                'applied': bool(options['apply'] and additions),
                'diff': ''.join(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
                                                  fromfile='before.xml', tofile='after.xml')),
            }
            if report['applied']:
                project.validate_config(updated)
                project.label_config = updated
                project.save(update_fields=['label_config'], recalc=False)
            self.stdout.write(json.dumps(report, ensure_ascii=False, indent=2))
        except (ValueError, Project.DoesNotExist) as exc:
            raise CommandError(str(exc)) from exc
