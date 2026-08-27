"""Manual L2 -> L3 strategy. No worker may apply this profile automatically."""
import copy
import xml.etree.ElementTree as ET
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from .geometry import result_geometry
from .validation import REFERENCES, PARENTS, GEOMETRY, context, label_of, validate
from tasks.reference_sync.results import digest

SYNC_TYPE = 'function_zone_to_occupancy'
DISPLAY = {'origin', 'readonly', 'score', 'opacity', 'fillopacity', 'fillcolor', 'strokecolor', 'strokewidth', 'hidden', 'selected'}


def reference_results(results):
    return [r for r in results if r.get('from_name') in REFERENCES]


def reference_hash(results):
    return digest(sorted([{k: v for k, v in r.items() if k not in DISPLAY} for r in reference_results(results)],
                         key=lambda r: (r.get('id', ''), r['from_name'])))


def manual_hash(results):
    return digest(sorted([{k: v for k, v in r.items() if k not in {'origin', 'readonly'}} for r in results if r.get('from_name') not in REFERENCES],
                         key=lambda r: (r.get('id', ''), r.get('from_name', ''), digest(r))))


def merge_results(results, refs):
    # Invalidation is derived from source + content fingerprints. Keep all manual
    # bytes, including old parent IDs and review stamps, for audit and recovery.
    return [copy.deepcopy(r) for r in results if r.get('from_name') not in REFERENCES] + copy.deepcopy(refs)


def validate_source(results, config):
    refs = reference_results(results)
    controls = {e.get('name'): e for e in ET.fromstring(config).iter() if e.get('name')}
    seen = set()
    rooms = {r['id'] for r in refs if r.get('from_name') in {'room_rectangle', 'room_polygon'}}
    parents = {r['id'] for r in refs if r.get('from_name') in PARENTS}
    if not parents:
        raise ValueError('正式功能分区标注没有父区域')
    for r in refs:
        key = (r.get('id'), r.get('from_name'))
        if not key[0] or key in seen:
            raise ValueError('参考结果 ID/控件配对重复')
        seen.add(key)
        control = controls.get(r['from_name'])
        if control is None or control.tag.lower() != r.get('type') or control.get('toName') != r.get('to_name'):
            raise ValueError(f"目标控件与来源结果不兼容: {key}")
        values = r.get('value', {}).get(r.get('type'), [])
        allowed = {e.get('value') for e in control if e.tag in {'Label', 'Choice'}}
        if allowed and (not isinstance(values, list) or not set(values) <= allowed):
            raise ValueError(f'目标类别不支持来源: {key}')
        if r['from_name'] in PARENTS:
            result_geometry(r)
            if not label_of(refs, r['id'], 'function_zone'):
                raise ValueError('功能分区缺少配对类别')
            if r.get('meta', {}).get('partition_context', {}).get('parent_room_id') not in rooms:
                raise ValueError('功能分区缺少父房间关联')
        if r['from_name'] == 'function_zone' and r['id'] not in parents:
            raise ValueError('功能类别缺少配对几何')
    return [{**copy.deepcopy(r), 'readonly': True} for r in refs]


def pending_reviews(results):
    # Complete validation is exposed by the L3 UI; this compact summary drives
    # reference-status only and must tolerate unfinished draft polygons.
    return [{'id': r['id'], 'parent_zone_id': context(r).get('parent_zone_id')} for r in results
            if r.get('from_name') in GEOMETRY and context(r).get('review_status') != 'reviewed']


def current_refs(binding):
    from tasks.models import Prediction
    from tasks.reference_sync.service import SyncConflict
    prediction = Prediction.objects.filter(pk=binding.prediction_id, task_id=binding.target_task_id).first()
    if not prediction or reference_hash(prediction.result) != binding.applied_hash:
        raise SyncConflict('L3 已应用的权威参考缺失或不一致', 'reference_not_ready')
    return prediction.result


def prepare_write(task, payload, instance, binding, submission):
    from tasks.reference_sync.service import SyncConflict, source_for, lock_target
    lock_target(task)
    refs = current_refs(binding)
    prior = instance.result if instance is not None else refs
    revision = reference_hash(prior)
    if not payload.get('reference_version') or not payload.get('base_manual_hash'):
        raise SyncConflict('请保留本地修改并加载支持 L3 安全保存的客户端', 'reference_version_required', 428)
    if payload['reference_version'] != revision or payload['base_manual_hash'] != manual_hash(prior):
        raise SyncConflict('参考或人工内容已被其他窗口更新，请保留本地并处理冲突', 'manual_version_conflict')
    if instance is not None:
        expected = parse_datetime(str(payload.get('expected_updated_at', '')))
        if expected is None or expected != instance.updated_at:
            raise SyncConflict('草稿/标注版本已变化，未覆盖任何结果', 'draft_version_conflict')
    result = payload.get('result', prior)
    if not isinstance(result, list):
        raise SyncConflict('result 必须为列表', 'invalid_result', 400)
    merged = merge_results(result, reference_results(prior))
    if submission:
        try:
            _, source = source_for(binding)
            if reference_hash(source.result) != binding.applied_hash or revision != binding.applied_hash:
                raise SyncConflict('请先保存、备份并手动应用最新 L2 参考', 'reference_version_conflict')
            issues = validate(merged, binding.applied_hash)
            if issues:
                raise SyncConflict({'message': 'L3 校验未通过', 'issues': issues}, 'occupancy_validation', 400)
        except ValueError as exc:
            raise SyncConflict(str(exc), 'invalid_source', 400) from exc
    return merged, binding


def initialize_binding(binding):
    """Called explicitly by project creation only, within sync_atomic."""
    from tasks.models import Prediction, Task
    from tasks.reference_sync.models import ReferenceSyncAudit
    from tasks.reference_sync.service import source_for, snapshot
    if binding.target_task_id or binding.applied_hash:
        raise ValueError('绑定已初始化，不能重复导入')
    source, annotation = source_for(binding)
    project = binding.mapping.target_project
    if source.project.organization_id != project.organization_id:
        raise ValueError('禁止跨组织引用')
    refs = validate_source(annotation.result, project.label_config)
    revision = reference_hash(refs)
    target = Task.objects.create(project=project, data=copy.deepcopy(source.data), meta={}, overlap=project.maximum_annotations)
    prediction = Prediction.objects.create(task=target, project=project, result=refs, model_version=f'l2-task{source.id}-annotation{annotation.id}-reference')
    target.meta = {'occupancy_reference': {'schema_version': 1, 'source_project_id': source.project_id, 'source_task_id': source.id,
                                         'source_annotation_id': annotation.id, 'source_result_sha256': revision, 'source_updated_at': annotation.updated_at.isoformat()}}
    target.save(update_fields=['meta', 'updated_at'])
    binding.target_task = target
    binding.prediction_id = prediction.id
    binding.source_annotation_id = annotation.id
    binding.source_data_hash = digest(source.data)
    binding.desired_hash = binding.applied_hash = revision
    binding.status = 'synced'
    binding.last_synced_at = timezone.now()
    binding.save()
    ReferenceSyncAudit.objects.create(binding=binding, source_hash=revision, operation='l3_create', before={}, after=snapshot(target))
    return target


def apply_reference(binding, draft, payload, user):
    from tasks.models import Prediction
    from tasks.reference_sync.models import ReferenceSyncAudit
    from tasks.reference_sync.service import SyncConflict, source_for, snapshot, lock_target
    expected = parse_datetime(str(payload.get('expected_updated_at', '')))
    if expected != draft.updated_at or payload.get('base_manual_hash') != manual_hash(draft.result) or payload.get('reference_version') != reference_hash(draft.result):
        raise SyncConflict('应用期间草稿已变化，未修改参考或 L3', 'draft_version_conflict')
    source, annotation = source_for(binding)
    revision = reference_hash(annotation.result)
    if payload.get('source_version') != revision:
        raise SyncConflict('来源在确认后再次变化，请重新检查', 'source_version_conflict')
    if digest(source.data) != digest(draft.task.data):
        raise SyncConflict('来源图片已变化，停止应用', 'source_image_changed')
    refs = validate_source(annotation.result, binding.mapping.target_project.label_config)
    lock_target(draft.task)
    before = snapshot(draft.task)
    protected = manual_hash(draft.result)
    draft.result = merge_results(draft.result, refs)
    if manual_hash(draft.result) != protected:
        raise RuntimeError('参考应用不得改写人工 L3')
    draft.save(update_fields=['result', 'updated_at'])
    prediction = Prediction.objects.get(pk=binding.prediction_id, task=draft.task)
    prediction.result = refs
    prediction.save(update_fields=['result', 'updated_at'])
    binding.desired_hash = binding.applied_hash = revision
    binding.status, binding.error = 'synced', ''
    binding.last_synced_at = timezone.now()
    binding.save()
    meta = copy.deepcopy(draft.task.meta or {})
    meta.setdefault('occupancy_reference', {}).update(source_result_sha256=revision, source_updated_at=annotation.updated_at.isoformat())
    draft.task.meta = meta
    draft.task.save(update_fields=['meta', 'updated_at'])
    after = snapshot(draft.task)
    if before['annotations'] != after['annotations']:
        raise RuntimeError('参考应用不得改写正式标注')
    ReferenceSyncAudit.objects.create(binding=binding, source_hash=revision, operation='l3_manual_apply', before=before, after=after, summary={'user_id': user.id, 'draft_id': draft.id})
    return draft
