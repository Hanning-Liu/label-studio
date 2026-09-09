"""Explicit, database-backed ancestry for integration fixtures (never production repair)."""

import copy
import xml.etree.ElementTree as ET


def attach_ancestors(task, annotation, level):
    from projects.models import Project
    from tasks.models import Annotation, Prediction, Task
    from tasks.windows.downstream import prepare_downstream_window_results
    from .lineage import PROFILES, digest, profile_reference_hash
    from .models import ReferenceSyncBinding, ReferenceSyncMapping
    if level == 1:
        return
    if level == 2:
        from .results import REFERENCES, reference_results, merge_results
    else:
        from tasks.occupancy.validation import REFERENCES
        from tasks.occupancy.reference import reference_results, merge_results
    root = ET.fromstring(task.project.label_config)
    for parent in root.iter():
        for node in list(parent):
            if node.get('name') and node.tag != 'Image' and node.get('name') not in REFERENCES:
                parent.remove(node)
    for image in root.iter('Image'):
        for attr in ('occupancyV1', 'furnitureInstancesV1', 'functionZoneV3Validate'):
            image.attrib.pop(attr, None)
    project = Project.objects.create(title=f'fixture L{level - 1} for {task.id}',
                                     label_config=ET.tostring(root, encoding='unicode'),
                                     organization=task.project.organization, created_by=task.project.created_by)
    parent_task = Task.objects.create(project=project, data=copy.deepcopy(task.data), overlap=1)
    parent_annotation = Annotation.objects.create(task=parent_task, project=project,
                                                completed_by=annotation.completed_by,
                                                result=copy.deepcopy(reference_results(annotation.result)))
    attach_ancestors(parent_task, parent_annotation, level - 1)
    refs = reference_results(parent_annotation.result)
    revision = profile_reference_hash(refs, level)
    # Preserve fixture ordering as well as content. Older regressions select a
    # particular geometry by position; adding ancestry must not change that test.
    by_key = {(r.get('id'), r.get('from_name')): r for r in refs}
    annotation.result = [copy.deepcopy(by_key.get((r.get('id'), r.get('from_name')), r)) for r in annotation.result]
    annotation.result, _ = prepare_downstream_window_results(annotation.result, level=f'L{level}', submission=True)
    Annotation.objects.filter(pk=annotation.pk).update(result=annotation.result)
    mapping = ReferenceSyncMapping.objects.create(source_project=project, target_project=task.project,
                                                  enabled=True, auto_create=False, apply_policy='manual',
                                                  sync_type=PROFILES[level])
    prediction = Prediction.objects.create(task=task, project=task.project, result=copy.deepcopy(refs))
    ReferenceSyncBinding.objects.create(mapping=mapping, source_task_id=parent_task.id,
                                       source_annotation_id=parent_annotation.id, target_task=task,
                                       prediction_id=prediction.id, source_data_hash=digest(task.data),
                                       applied_hash=revision, desired_hash=revision, status='synced')


def update_fixture_l1(l2_task, l2_annotation):
    """Model an explicitly submitted L1 change followed by L2 acceptance."""
    from tasks.models import Annotation, Prediction
    from tasks.windows.downstream import prepare_downstream_window_results
    from .models import ReferenceSyncBinding
    from .results import reference_results, reference_hash
    binding = ReferenceSyncBinding.objects.get(target_task=l2_task)
    root = Annotation.objects.get(pk=binding.source_annotation_id)
    root.result = copy.deepcopy(reference_results(l2_annotation.result))
    root.save(update_fields=['result', 'updated_at'])
    binding.applied_hash = binding.desired_hash = reference_hash(root.result)
    binding.save(update_fields=['applied_hash', 'desired_hash'])
    Prediction.objects.filter(pk=binding.prediction_id).update(result=copy.deepcopy(root.result))
    l2_annotation.result, _ = prepare_downstream_window_results(l2_annotation.result, level='L2', submission=True)
    l2_annotation.save(update_fields=['result', 'updated_at'])
