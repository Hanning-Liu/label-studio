import hashlib

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from projects.models import Project
from tasks.occupancy.template import ensure_barrier_control


class Command(BaseCommand):
    help = 'Idempotently add the L3 occupancy wall-barrier Vector control. Dry-run unless --apply is supplied.'

    def add_arguments(self, parser):
        parser.add_argument('--project', type=int, required=True)
        parser.add_argument('--apply', action='store_true')

    @transaction.atomic
    def handle(self, *args, **options):
        try:
            project = Project.objects.select_for_update().get(pk=options['project'])
            updated = ensure_barrier_control(project.label_config)
        except Project.DoesNotExist as error:
            raise CommandError(f"Project {options['project']} 不存在") from error
        except ValueError as error:
            raise CommandError(str(error)) from error
        before = hashlib.sha256(project.label_config.encode('utf-8')).hexdigest()
        after = hashlib.sha256(updated.encode('utf-8')).hexdigest()
        if updated == project.label_config:
            self.stdout.write(f'Project {project.id}: 隔墙控件已存在；配置未修改；sha256={before}')
            return
        if not options['apply']:
            self.stdout.write(f'Project {project.id}: dry-run；需要新增隔墙控件；before={before} after={after}')
            return
        project.label_config = updated
        project.save(update_fields=['label_config'])
        self.stdout.write(self.style.SUCCESS(
            f'Project {project.id}: 已新增隔墙控件；before={before} after={after}；未修改任务或标注结果'
        ))
