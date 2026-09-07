"""Manual L3 -> L4 synchronization; no worker may apply it automatically."""

import copy
import xml.etree.ElementTree as ET

from django.utils import timezone
from django.utils.dateparse import parse_datetime
from tasks.occupancy.validation import validate as validate_occupancy
from tasks.reference_sync.results import digest

from .geometry import MANUAL_CONTROLS
from .validation import (
    REFERENCE_CONTROLS,
    effective_review_status,
    furniture_groups,
    validate,
)

SYNC_TYPE = 'occupancy_to_furniture_instances'
DISPLAY_FIELDS = {
    'origin',
    'readonly',
    'score',
    'opacity',
    'fillopacity',
    'fillcolor',
    'strokecolor',
    'strokewidth',
    'hidden',
    'selected',
}
PROVENANCE_META = 'furniture_instance_provenance'


def reference_results(results):
    return [result for result in results if result.get('from_name') in REFERENCE_CONTROLS]


def reference_hash(results):
    normalized = [
        {key: value for key, value in result.items() if key not in DISPLAY_FIELDS}
        for result in reference_results(results)
    ]
    return digest(sorted(normalized, key=lambda result: (result.get('id', ''), result.get('from_name', ''), digest(result))))


def _manual_result(result):
    item = copy.deepcopy(result)
    item.pop('origin', None)
    item.pop('readonly', None)
    meta = item.get('meta')
    if isinstance(meta, dict):
        meta.pop(PROVENANCE_META, None)
        if not meta:
            item.pop('meta', None)
    return item


def manual_hash(results):
    manual = [_manual_result(result) for result in results if result.get('from_name') not in REFERENCE_CONTROLS]
    return digest(sorted(manual, key=lambda result: (result.get('id', ''), result.get('from_name', ''), digest(result))))


def strip_client_provenance(results):
    output = copy.deepcopy(results)
    for result in output:
        if result.get('from_name') not in MANUAL_CONTROLS:
            continue
        meta = result.get('meta')
        if isinstance(meta, dict):
            meta.pop(PROVENANCE_META, None)
    return output


def stamp_provenance(results, project_id, task_id, annotation_id):
    """Attach server-owned result provenance after the Annotation PK exists."""
    if not all(isinstance(value, int) and not isinstance(value, bool) and value > 0 for value in (project_id, task_id, annotation_id)):
        raise ValueError('L4 provenance 需要有效 project/task/annotation ID')
    output = copy.deepcopy(results)
    for result in output:
        if result.get('from_name') not in MANUAL_CONTROLS:
            continue
        result_id = result.get('id')
        if not isinstance(result_id, str) or not result_id:
            raise ValueError('L4 result 缺少稳定 ID，无法写入 provenance')
        result.setdefault('meta', {})[PROVENANCE_META] = {
            'schema_version': 1,
            'project_id': project_id,
            'task_id': task_id,
            'annotation_id': annotation_id,
            'result_id': result_id,
        }
    return output


def validate_provenance(results, project_id, task_id, annotation_id):
    expected_ids = (project_id, task_id, annotation_id)
    for result in results:
        if result.get('from_name') not in MANUAL_CONTROLS:
            continue
        provenance = result.get('meta', {}).get(PROVENANCE_META, {})
        if (
            provenance.get('schema_version') != 1
            or tuple(provenance.get(key) for key in ('project_id', 'task_id', 'annotation_id')) != expected_ids
            or provenance.get('result_id') != result.get('id')
        ):
            raise ValueError(f"L4 result {result.get('id')} provenance 缺失或不匹配")
    return True


def merge_results(results, refs):
    """Replace only readonly L3 references and preserve every manual byte."""
    manual = [copy.deepcopy(result) for result in results if result.get('from_name') not in REFERENCE_CONTROLS]
    return manual + copy.deepcopy(refs)


def validate_source(results, config):
    refs = reference_results(results)
    if not refs:
        raise ValueError('正式 L3 标注没有可引用结果')
    if any(result.get('from_name') in MANUAL_CONTROLS for result in results):
        raise ValueError('L3 来源不得包含 L4 人工控件结果')
    controls = {element.get('name'): element for element in ET.fromstring(config).iter() if element.get('name')}
    seen = set()
    for result in refs:
        key = (result.get('id'), result.get('from_name'))
        if not key[0] or key in seen:
            raise ValueError('L3 参考结果 ID/控件配对缺失或重复')
        seen.add(key)
        control = controls.get(result.get('from_name'))
        if (
            control is None
            or control.tag.lower() != result.get('type')
            or control.get('toName') != result.get('to_name')
        ):
            raise ValueError(f'L4 目标控件与 L3 来源结果不兼容: {key}')
        values = result.get('value', {}).get(result.get('type'), [])
        allowed = {
            child.get('alias') or child.get('value')
            for child in control
            if child.tag in {'Label', 'Choice'}
        }
        if allowed and (not isinstance(values, list) or not set(values) <= allowed):
            raise ValueError(f'L4 目标类别不支持 L3 来源: {key}')

    # Resolving groups enforces the stable L1 -> L2 -> L3 chain and exact
    # Polygon/MultiPolygon semantics required by every future L4 instance.
    furniture_groups(refs)
    issues = validate_occupancy(refs, source_version='formal-l3-source')
    if issues:
        messages = '；'.join(str(issue.get('message') or issue.get('code')) for issue in issues[:6])
        raise ValueError(f'L3 正式来源未通过现有提交校验（{len(issues)} 项）：{messages}')
    return [{**copy.deepcopy(result), 'readonly': True} for result in refs]


def pending_reviews(results):
    return effective_review_status(results, reference_hash(results))


def current_refs(binding):
    from tasks.models import Prediction
    from tasks.reference_sync.service import SyncConflict

    prediction = Prediction.objects.filter(pk=binding.prediction_id, task_id=binding.target_task_id).first()
    if not prediction or reference_hash(prediction.result) != binding.applied_hash:
        raise SyncConflict('L4 已应用的权威 L3 参考缺失或不一致', 'reference_not_ready')
    return prediction.result


def validation_error_summary(issues):
    shown = [str(issue.get('message') or issue.get('code') or '未知校验问题') for issue in issues[:6]]
    suffix = f'；另有 {len(issues) - len(shown)} 项' if len(issues) > len(shown) else ''
    return f"L4 正式提交未通过（{len(issues)} 项）：{'；'.join(shown)}{suffix}。草稿已保留。"


def prepare_write(task, payload, instance, binding, submission):
    from tasks.reference_sync.service import SyncConflict, lock_target, source_for

    lock_target(task)
    refs = current_refs(binding)
    prior = instance.result if instance is not None else refs
    revision = reference_hash(prior)
    if not payload.get('reference_version') or not payload.get('base_manual_hash'):
        raise SyncConflict('请保留本地修改并加载支持 L4 安全保存的客户端', 'reference_version_required', 428)
    if payload['reference_version'] != revision or payload['base_manual_hash'] != manual_hash(prior):
        raise SyncConflict('参考或人工 L4 内容已被其他窗口更新，请保留本地并处理冲突', 'manual_version_conflict')
    if instance is not None:
        expected = parse_datetime(str(payload.get('expected_updated_at', '')))
        if expected is None or expected != instance.updated_at:
            raise SyncConflict('草稿/标注版本已变化，未覆盖任何结果', 'draft_version_conflict')
    result = payload.get('result', prior)
    if not isinstance(result, list):
        raise SyncConflict('result 必须为列表', 'invalid_result', 400)
    merged = strip_client_provenance(merge_results(result, reference_results(prior)))
    if submission:
        try:
            _source_task, source = source_for(binding)
            if reference_hash(source.result) != binding.applied_hash or revision != binding.applied_hash:
                raise SyncConflict('请先保存、检查并手动应用最新 L3 参考', 'reference_version_conflict')
            issues = validate(merged, binding.applied_hash)
            if issues:
                raise SyncConflict(
                    validation_error_summary(issues),
                    'furniture_instance_validation',
                    400,
                    display_context={'reason': 'FURNITURE_INSTANCE_VALIDATION', 'issues': issues},
                )
        except ValueError as exc:
            raise SyncConflict(str(exc), 'invalid_source', 400) from exc
    return merged, binding


def initialize_binding(binding):
    """Create one empty L4 task explicitly; never create an annotation/draft."""
    from tasks.models import Prediction, Task
    from tasks.reference_sync.models import ReferenceSyncAudit
    from tasks.reference_sync.service import snapshot, source_for

    if binding.target_task_id or binding.applied_hash:
        raise ValueError('绑定已初始化，不能重复导入')
    source_task, annotation = source_for(binding)
    project = binding.mapping.target_project
    if source_task.project.organization_id != project.organization_id:
        raise ValueError('禁止跨组织引用')
    refs = validate_source(annotation.result, project.label_config)
    revision = reference_hash(refs)
    target = Task.objects.create(
        project=project,
        data=copy.deepcopy(source_task.data),
        meta={},
        overlap=project.maximum_annotations,
    )
    prediction = Prediction.objects.create(
        task=target,
        project=project,
        result=refs,
        model_version=f'l3-task{source_task.id}-annotation{annotation.id}-reference',
    )
    target.meta = {
        'furniture_instances_reference': {
            'schema_version': 1,
            'source_project_id': source_task.project_id,
            'source_task_id': source_task.id,
            'source_annotation_id': annotation.id,
            'source_result_sha256': revision,
            'source_updated_at': annotation.updated_at.isoformat(),
            'inheritance_mode': 'readonly_reference_only',
        }
    }
    target.save(update_fields=['meta', 'updated_at'])
    binding.target_task = target
    binding.prediction_id = prediction.id
    binding.source_annotation_id = annotation.id
    binding.source_data_hash = digest(source_task.data)
    binding.desired_hash = binding.applied_hash = revision
    binding.status = 'synced'
    binding.last_synced_at = timezone.now()
    binding.save()
    ReferenceSyncAudit.objects.create(
        binding=binding,
        source_hash=revision,
        operation='l4_create',
        before={},
        after=snapshot(target),
    )
    return target


def apply_reference(binding, draft, payload, user):
    from tasks.models import Prediction
    from tasks.reference_sync.models import ReferenceSyncAudit
    from tasks.reference_sync.service import SyncConflict, lock_target, snapshot, source_for

    expected = parse_datetime(str(payload.get('expected_updated_at', '')))
    if (
        expected != draft.updated_at
        or payload.get('base_manual_hash') != manual_hash(draft.result)
        or payload.get('reference_version') != reference_hash(draft.result)
    ):
        raise SyncConflict('应用期间草稿已变化，未修改参考或 L4', 'draft_version_conflict')
    source_task, annotation = source_for(binding)
    revision = reference_hash(annotation.result)
    if payload.get('source_version') != revision:
        raise SyncConflict('L3 来源在确认后再次变化，请重新检查', 'source_version_conflict')
    if digest(source_task.data) != digest(draft.task.data):
        raise SyncConflict('来源图片已变化，停止应用', 'source_image_changed')
    refs = validate_source(annotation.result, binding.mapping.target_project.label_config)
    lock_target(draft.task)
    before = snapshot(draft.task)
    protected = manual_hash(draft.result)
    draft.result = merge_results(draft.result, refs)
    if manual_hash(draft.result) != protected:
        raise RuntimeError('参考应用不得改写人工 L4 实例')
    draft.save(update_fields=['result', 'updated_at'])
    prediction = Prediction.objects.get(pk=binding.prediction_id, task=draft.task)
    prediction.result = refs
    prediction.save(update_fields=['result', 'updated_at'])
    binding.desired_hash = binding.applied_hash = revision
    binding.status, binding.error = 'synced', ''
    binding.last_synced_at = timezone.now()
    binding.save()
    meta = copy.deepcopy(draft.task.meta or {})
    meta.setdefault('furniture_instances_reference', {}).update(
        source_result_sha256=revision,
        source_updated_at=annotation.updated_at.isoformat(),
        last_synced_at=timezone.now().isoformat(),
    )
    draft.task.meta = meta
    draft.task.save(update_fields=['meta', 'updated_at'])
    after = snapshot(draft.task)
    if before['annotations'] != after['annotations']:
        raise RuntimeError('参考应用不得改写正式标注')
    ReferenceSyncAudit.objects.create(
        binding=binding,
        source_hash=revision,
        operation='l4_manual_apply',
        before=before,
        after=after,
        summary={'user_id': user.id, 'draft_id': draft.id},
    )
    return draft
