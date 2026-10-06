import copy
import xml.etree.ElementTree as ET
from importlib.resources import files

from django.shortcuts import get_object_or_404
from projects.models import Project
from tasks.models import Task
from tasks.reference_sync.models import ReferenceSyncBinding, ReferenceSyncMapping
from hanning.backend.reference_sync.lineage import (
    PROFILES, collect_documents, configured_level, digest, require_report, validate_documents,
)
from hanning.backend.reference_sync.service import SyncConflict, process_binding, sync_atomic


def template(level, source_config=None):
    if level == 3:
        from hanning.backend.validation.occupancy.template import build_template
        return build_template(source_config)
    if level == 4:
        from hanning.backend.validation.furniture_instances.template import build_template
        return build_template(source_config)
    config = files(__package__).joinpath(f'templates/l{level}.xml').read_text(encoding='utf-8')
    if level == 1:
        return config
    # Keep the source's control identities, image variable and custom label sets.
    from hanning.backend.reference_sync.results import REFERENCES
    source = ET.fromstring(source_config)
    images = list(source.iter('Image'))
    if len(images) != 1 or not images[0].get('name') or not images[0].get('value'):
        raise ValueError('来源必须包含唯一、具名且配置图片字段的 Image')
    root = ET.fromstring(config)
    image_name = images[0].get('name')
    image = next(root.iter('Image'))
    image.set('name', image_name)
    image.set('value', images[0].get('value'))
    source_controls = {node.get('name'): node for node in source.iter() if node.get('name') in REFERENCES}
    for parent in root.iter():
        for node in list(parent):
            name = node.get('name')
            if name in REFERENCES:
                index = list(parent).index(node)
                parent.remove(node)
                if name in source_controls:
                    copied = copy.deepcopy(source_controls[name])
                    for child in copied.iter():
                        for attr in ('hotkey', 'required', 'constrainTo', 'openingFrom', 'constraintMode', 'constraintSnapPx'):
                            child.attrib.pop(attr, None)
                    parent.insert(index, copied)
            elif node.get('toName') == 'image':
                node.set('toName', image_name)
    return ET.tostring(root, encoding='unicode')


def source_snapshot(task, *, lock=False):
    """Pin the complete formal ancestry, including configuration and image data."""
    documents = collect_documents(task, formal=True, lock=lock)
    report = validate_documents(documents)
    require_report(report)
    return documents[-1]['annotation_id'], digest(documents)


def source_choice(task):
    images = list(ET.fromstring(task.project.label_config).iter('Image'))
    variable = images[0].get('value', '$image').removeprefix('$') if images else 'image'
    image = task.data.get(variable, '')
    choice = {'id': task.id, 'image_name': str(image).split('/')[-1].split('?')[0],
              'annotation_id': None, 'version': None, 'ready': False, 'reason': ''}
    try:
        choice['annotation_id'], choice['version'] = source_snapshot(task)
        choice['ready'] = True
    except (ValueError, SyncConflict) as exc:
        choice['reason'] = str(exc.detail.get('detail', exc)) if isinstance(exc, SyncConflict) else str(exc)
    return choice


@sync_atomic
def create_project(user, *, level, title, source_task=None, source_annotation=None, source_version=None):
    # Serialize creation per organization, including duplicate clicks in separate tabs.
    from organizations.models import Organization
    organization = Organization.objects.select_for_update().get(pk=user.active_organization_id)
    if Project.objects.for_user(user).filter(title=title).exists():
        raise SyncConflict('同名项目已存在，请打开已有项目或更换名称。', 'project_exists')
    source = None
    if level > 1:
        source = get_object_or_404(Task.objects.for_user(user).select_related('project'), pk=source_task)
        if source.project.is_draft or configured_level(source.project.label_config) != level - 1:
            raise ValueError(f'请选择已创建的 L{level - 1} 项目中的图片。')
        annotation_id, version = source_snapshot(source, lock=True)
        if annotation_id != source_annotation or version != source_version:
            raise SyncConflict('上游标注或配置已变化，请重新选择来源图片后创建。', 'source_changed')
        source.project.refresh_from_db()
    config = template(level, source.project.label_config if source else None)
    if level == 4:
        from hanning.backend.catalog.api import extend_config
        config = extend_config(config, organization.furniture_catalog)
    project = Project.objects.create(
        title=title, label_config=config,
        organization=user.active_organization, created_by=user, maximum_annotations=1,
        show_collab_predictions=True, is_draft=False,
    )
    if source is None:
        return project, None
    mapping = ReferenceSyncMapping.objects.create(
        source_project=source.project, target_project=project, enabled=True,
        sync_type=PROFILES[level], auto_create=level == 2,
        apply_policy='automatic' if level == 2 else 'manual',
    )
    binding = ReferenceSyncBinding.objects.create(
        mapping=mapping, source_task_id=source.id, source_annotation_id=source_annotation,
    )
    if level == 2:
        process_binding(binding.id)
        binding.refresh_from_db()
        if not binding.target_task_id:
            raise ValueError('未能初始化 L2 参考标注，本次创建已取消。')
        target = binding.target_task
        # Only the chosen image belongs in this project; future upstream tasks are not imported.
        mapping.auto_create = False
        mapping.save(update_fields=['auto_create'])
    else:
        if level == 3:
            from hanning.backend.validation.occupancy.reference import initialize_binding
        else:
            from hanning.backend.validation.furniture_instances.reference import initialize_binding
        target = initialize_binding(binding)
    return project, target
