from django.core.management.base import BaseCommand, CommandError
from projects.models import Project
from tasks.furniture_instances.reference import SYNC_TYPE, initialize_binding
from tasks.furniture_instances.template import build_template
from tasks.models import Annotation, Task
from tasks.reference_sync.models import ReferenceSyncBinding, ReferenceSyncMapping
from tasks.reference_sync.service import sync_atomic


class Command(BaseCommand):
    help = 'Explicitly create an isolated L4 project from one pinned formal L3 annotation; never submits L4.'

    def add_arguments(self, parser):
        parser.add_argument('--source-task', type=int, required=True)
        parser.add_argument('--source-annotation', type=int, required=True)
        parser.add_argument('--title', required=True)
        parser.add_argument('--confirm-create', action='store_true')

    @sync_atomic
    def handle(self, *args, **options):
        if not options['confirm_create']:
            raise CommandError('必须显式指定 --confirm-create；不会隐式创建 L4 项目')
        source = Task.objects.select_related('project').get(pk=options['source_task'])
        annotation = Annotation.objects.get(
            pk=options['source_annotation'],
            task=source,
            project=source.project,
            was_cancelled=False,
        )
        if Project.objects.filter(title=options['title'], organization=source.project.organization).exists():
            raise CommandError('同名项目已存在，停止，避免重复创建')
        project = Project.objects.create(
            title=options['title'],
            label_config=build_template(source.project.label_config),
            organization=source.project.organization,
            created_by=source.project.created_by,
            maximum_annotations=1,
            show_collab_predictions=True,
        )
        mapping = ReferenceSyncMapping.objects.create(
            source_project=source.project,
            target_project=project,
            enabled=True,
            auto_create=False,
            sync_type=SYNC_TYPE,
            apply_policy='manual',
        )
        binding = ReferenceSyncBinding.objects.create(
            mapping=mapping,
            source_task_id=source.id,
            source_annotation_id=annotation.id,
        )
        target = initialize_binding(binding)
        self.stdout.write(
            f'Created L4 Project {project.id} / Task {target.id}; pinned L3 Task {source.id} / '
            f'Annotation {annotation.id}; no L4 annotations or drafts created.'
        )
