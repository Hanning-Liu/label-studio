import copy
import logging
import time
import xml.etree.ElementTree as ET
from datetime import timedelta
from functools import wraps

from django.db import OperationalError, connection, transaction
from django.db.models import F, Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.exceptions import APIException

from .models import ReferenceSyncAudit, ReferenceSyncBinding, ReferenceSyncMapping
from .results import (REFERENCES, ROOMS, digest, manual_hash, merge_results, pending_reviews,
                      reference_hash, reference_results, validate_source, validate_submission, diff_refs)
from .room_metadata import RoomV3MetadataError, refresh_room_v3_metadata

logger = logging.getLogger(__name__)


def is_occupancy(mapping):
    return mapping.sync_type == 'function_zone_to_occupancy'


def is_furniture_instances(mapping):
    return mapping.sync_type == 'occupancy_to_furniture_instances'


def task_uses_furniture_instances(task):
    """Detect the explicit L4 editor contract without relying on a binding.

    A copied L4 project can temporarily have no enabled reference binding. Its
    label config must still fail closed on formal submission instead of falling
    through the generic annotation path without validation or provenance.
    """
    config = getattr(getattr(task, 'project', None), 'label_config', '')
    if not isinstance(config, str) or not config:
        return False
    try:
        root = ET.fromstring(config)
    except ET.ParseError:
        return False
    return any(
        element.tag.rsplit('}', 1)[-1].lower() == 'image'
        and element.get('furnitureInstancesV1', '').lower() == 'true'
        for element in root.iter()
    )


def source_room_mappings(task):
    return list(ReferenceSyncMapping.objects.filter(
        enabled=True,
        source_project_id=task.project_id,
        sync_type='room_to_function_zone',
    ).select_related('target_project'))


def prepare_source_annotation_result(task, results):
    """Normalize server-owned Room v3 metadata before a formal save.

    Drafts stay permissive.  A submitted source annotation, however, must not
    persist geometry together with stale derived metadata, because downstream
    reference synchronization treats the formal annotation as authoritative.
    """
    mappings = source_room_mappings(task)
    if not mappings:
        return results, {'room_ids': [], 'portal_ids': []}
    try:
        refreshed, changes = refresh_room_v3_metadata(results)
        for mapping in mappings:
            validate_source(refreshed, mapping.target_project.label_config)
        return refreshed, changes
    except RoomV3MetadataError as exc:
        raise SyncConflict(str(exc), 'invalid_room_v3_geometry', 400) from exc
    except (ValueError, TypeError, KeyError) as exc:
        raise SyncConflict(str(exc), 'invalid_room_v3_source', 400) from exc


def profile_hash(results, mapping):
    if is_occupancy(mapping):
        from tasks.occupancy.reference import reference_hash as occupancy_hash
        return occupancy_hash(results)
    if is_furniture_instances(mapping):
        from tasks.furniture_instances.reference import reference_hash as furniture_instances_hash
        return furniture_instances_hash(results)
    return reference_hash(results)


class SyncConflict(APIException):
    status_code = 409
    default_code = 'reference_sync_conflict'

    def __init__(self, message, code='reference_sync_conflict', status=409, display_context=None):
        self.status_code = status
        if display_context is not None:
            self.display_context = display_context
        super().__init__({'detail':message, 'code':code})


def sync_atomic(fn):
    """Acquire SQLite's writer lock before any transactional reads; retry the
    whole rolled-back unit, never a partially applied operation."""
    @wraps(fn)
    def wrapped(*args, **kwargs):
        for attempt in range(4):
            try:
                with transaction.atomic():
                    if connection.vendor == 'sqlite':
                        ReferenceSyncMapping.objects.filter(enabled=True).update(enabled=F('enabled'))
                    return fn(*args, **kwargs)
            except OperationalError as exc:
                if not any(s in str(exc).lower() for s in ('locked', 'busy', 'deadlock')) or attempt == 3:
                    raise
                time.sleep(.04 * 2**attempt)
    return wrapped


def source_for(binding):
    from tasks.models import Annotation, Task
    task = Task.objects.filter(pk=binding.source_task_id, project_id=binding.mapping.source_project_id).first()
    if not task:
        raise ValueError('来源任务已删除，保留现有 L2')
    candidates = list(Annotation.objects.filter(task=task, was_cancelled=False))
    if len(candidates) != 1:
        raise ValueError('来源正式标注缺失、已取消或存在多个候选；需要人工处理')
    annotation = candidates[0]
    if binding.source_annotation_id is not None and binding.source_annotation_id != annotation.id:
        raise ValueError('绑定的来源标注已删除或替换，不自动切换来源')
    if binding.source_data_hash and binding.source_data_hash != digest(task.data):
        raise ValueError('来源图片数据已变化，不自动替换已有 L2 图片')
    return task, annotation


def source_metadata_repair_status(binding):
    """Describe whether a blocked source can be repaired without geometry edits."""
    try:
        _, annotation = source_for(binding)
        refreshed, changes = refresh_room_v3_metadata(annotation.result)
        validate_source(refreshed, binding.mapping.target_project.label_config)
        changed = bool(changes['room_ids'] or changes['portal_ids'])
        return {
            'source_metadata_repair_available': changed,
            'source_metadata_repair_room_ids': changes['room_ids'],
            'source_metadata_repair_portal_ids': changes['portal_ids'],
            'source_annotation_updated_at': annotation.updated_at,
            'source_metadata_repair_error': '',
        }
    except (RoomV3MetadataError, ValueError, TypeError, KeyError) as exc:
        return {
            'source_metadata_repair_available': False,
            'source_metadata_repair_room_ids': [],
            'source_metadata_repair_portal_ids': [],
            'source_metadata_repair_error': str(exc),
        }


def enqueue_source(source_task_id, source_project_id):
    from tasks.models import Annotation, Task
    for mapping in ReferenceSyncMapping.objects.filter(enabled=True, source_project_id=source_project_id):
        binding = ReferenceSyncBinding.objects.filter(mapping=mapping,source_task_id=source_task_id).first()
        candidates = list(Annotation.objects.filter(task_id=source_task_id,was_cancelled=False).values_list('id', flat=True))
        if not binding:
            if not candidates or not mapping.auto_create:
                continue
            binding, _ = ReferenceSyncBinding.objects.get_or_create(mapping=mapping,source_task_id=source_task_id,
                defaults={'source_annotation_id': candidates[0] if len(candidates)==1 else None})
        try:
            task, annotation = source_for(binding)
            wanted = profile_hash(annotation.result, mapping)
            if not binding.source_annotation_id:
                binding.source_annotation_id = annotation.id
            if binding.desired_hash != wanted or binding.status == 'blocked':
                binding.desired_hash = wanted
                binding.status = 'pending'
                binding.generation += 1
                binding.attempts = 0
                binding.next_attempt_at = None
                binding.error = ''
                binding.save()
        except (ValueError, TypeError, KeyError) as exc:
            binding.status, binding.error = 'blocked', str(exc)
            binding.save(update_fields=['status','error','updated_at'])


@sync_atomic
def reconcile():
    from tasks.models import Task
    for mapping in ReferenceSyncMapping.objects.filter(enabled=True):
        existing = set(mapping.bindings.values_list('source_task_id',flat=True))
        current = set(Task.objects.filter(project_id=mapping.source_project_id,annotations__was_cancelled=False).values_list('id',flat=True))
        for task_id in existing | current:
            enqueue_source(task_id,mapping.source_project_id)


def snapshot(task):
    return {
        'task': {'id':task.id,'meta':copy.deepcopy(task.meta),'data':copy.deepcopy(task.data)},
        'predictions': list(task.predictions.order_by('id').values('id','result','model_version')),
        'drafts': list(task.drafts.order_by('id').values('id','result','annotation_id','user_id')),
        'annotations': list(task.annotations.order_by('id').values('id','result','completed_by_id','was_cancelled')),
    }


def lock_target(task):
    from projects.models import ProjectSummary
    if connection.vendor != 'sqlite':
        ProjectSummary.objects.select_for_update().filter(project_id=task.project_id).first()


@sync_atomic
def process_binding(binding_id):
    from tasks.models import AnnotationDraft, Prediction, Task
    binding = ReferenceSyncBinding.objects.select_for_update().select_related('mapping__target_project').get(pk=binding_id)
    if not binding.mapping.enabled:
        return False
    if (
        is_occupancy(binding.mapping)
        or is_furniture_instances(binding.mapping)
        or binding.mapping.apply_policy == 'manual'
    ):
        # This strategy is initialized explicitly and applied only by its owner.
        return False
    source, annotation = source_for(binding)
    revision = reference_hash(annotation.result)
    target_project = binding.mapping.target_project
    if source.project.organization_id != target_project.organization_id:
        raise ValueError('跨组织同步禁止')
    refs = validate_source(annotation.result,target_project.label_config)
    if binding.applied_hash == revision and binding.target_task_id:
        binding.status, binding.error, binding.desired_hash = 'synced','',revision
        binding.save(update_fields=['status','error','desired_hash','updated_at'])
        return False
    created = False
    if not binding.target_task_id:
        if binding.applied_hash:
            raise ValueError('目标任务已删除，不自动重新创建')
        if not binding.mapping.auto_create:
            raise ValueError('未绑定目标任务且自动创建关闭')
        target = Task.objects.create(project=target_project,data=copy.deepcopy(source.data),meta={},overlap=target_project.maximum_annotations)
        binding.target_task = target
        created = True
    else:
        target = Task.objects.get(pk=binding.target_task_id,project=target_project)
    if digest(target.data) != digest(source.data):
        raise ValueError('来源和目标图片数据不一致，停止同步')
    lock_target(target)
    before = snapshot(target)
    old_refs = []
    if binding.prediction_id:
        prediction = Prediction.objects.filter(pk=binding.prediction_id,task=target).first()
        if not prediction:
            raise ValueError('来源 reference prediction 缺失，不自动覆盖其他 prediction')
        old_refs = prediction.result or []
        prediction.result = refs
        prediction.save(update_fields=['result','updated_at'])
    else:
        prediction = Prediction.objects.create(task=target,project=target_project,result=refs,
            model_version=f'room-v3-task{source.id}-annotation{annotation.id}-reference')
        binding.prediction_id = prediction.id
    difference = diff_refs(old_refs,refs)
    drafts = list(AnnotationDraft.objects.filter(task=target).select_for_update())
    for draft in drafts:
        draft.result = merge_results(draft.result,refs,revision)
        draft.save(update_fields=['result','updated_at'])
    # Existing submitted results are immutable to this worker. Review goes into
    # the owner's linked draft, and repeated sync reuses it.
    for saved in target.annotations.filter(was_cancelled=False):
        owner = saved.completed_by
        if owner is None:
            raise ValueError(f'已提交标注 {saved.id} 没有原标注者，无法创建复核草稿')
        owned = [d for d in drafts if d.annotation_id == saved.id and d.user_id == owner.id]
        if len(owned) > 1:
            raise ValueError('同一标注存在多份归属相同的草稿，停止自动合并')
        if not owned:
            AnnotationDraft.objects.create(task=target,annotation=saved,user=owner,
                result=merge_results(saved.result,refs,revision))
    metadata = copy.deepcopy(target.meta or {})
    provenance = metadata.setdefault('room_layout_reference',{})
    provenance.update(schema_version=3, source_project_id=source.project_id, source_task_id=source.id,
        source_annotation_id=annotation.id, source_result_sha256=revision,
        room_count=sum(r['from_name'] in ROOMS for r in refs),portal_count=sum(r['from_name'] not in ROOMS for r in refs),
        inheritance_mode='readonly_reference_only',source_updated_at=annotation.updated_at.isoformat(),
        last_synced_at=timezone.now().isoformat(),last_sync_added_reference_ids=difference['added'])
    target.meta = metadata
    target.save(update_fields=['meta','updated_at'])
    binding.source_annotation_id = annotation.id
    binding.source_data_hash = digest(source.data)
    binding.desired_hash = binding.applied_hash = revision
    binding.status, binding.error, binding.attempts = 'synced','',0
    binding.next_attempt_at = None
    binding.last_synced_at = timezone.now()
    binding.save()
    after = snapshot(target)
    # A hard safety assertion rolls back everything, including newly made drafts.
    if before['annotations'] != after['annotations']:
        raise RuntimeError('同步不得修改已提交标注')
    prior_manual = {d['id']:manual_hash(d['result']) for d in before['drafts']}
    if any(prior_manual[d['id']] != manual_hash(d['result']) for d in after['drafts'] if d['id'] in prior_manual):
        raise RuntimeError('同步修改了人工标注，事务已回滚')
    ReferenceSyncAudit.objects.create(binding=binding,source_hash=revision,operation='create' if created else 'sync',
        summary=difference,before=before,after=after)
    return True


def process_pending():
    count = 0
    ids = list(ReferenceSyncBinding.objects.filter(mapping__enabled=True,status__in=['pending','retry'])
        .filter(Q(next_attempt_at__isnull=True)|Q(next_attempt_at__lte=timezone.now())).values_list('id',flat=True))
    for binding_id in ids:
        attempted = ReferenceSyncBinding.objects.filter(pk=binding_id).values(
            'generation','desired_hash','applied_hash','attempts').first()
        if attempted is None:
            continue
        try:
            count += bool(process_binding(binding_id))
        except Exception as exc:
            logger.exception('Reference synchronization failed for binding %s',binding_id)
            # Only status is written after the failed data transaction rolled back.
            # A failed older attempt must not overwrite a newer enqueue or a
            # successful competing worker's state after its transaction ends.
            attempts = attempted.pop('attempts') + 1
            ReferenceSyncBinding.objects.filter(pk=binding_id,status__in=['pending','retry'],**attempted).update(
                attempts=attempts,status='blocked' if isinstance(exc,(ValueError,KeyError,TypeError)) else 'retry',
                error=str(exc)[:1500],updated_at=timezone.now(),
                next_attempt_at=timezone.now()+timedelta(seconds=min(60,2**min(attempts,6))))
    return count


def target_binding(task):
    return ReferenceSyncBinding.objects.filter(target_task=task,mapping__enabled=True).select_related('mapping').first()


def current_reference(binding):
    from tasks.models import Prediction
    try:
        _, source = source_for(binding)
    except ValueError as exc:
        raise SyncConflict(str(exc), 'reference_not_ready') from exc
    if binding.status != 'synced' or reference_hash(source.result) != binding.applied_hash:
        raise SyncConflict('Room 参考同步尚未完成或已暂停，请保留草稿并等待同步', 'reference_not_ready')
    prediction = Prediction.objects.filter(pk=binding.prediction_id,task_id=binding.target_task_id).first()
    if not prediction or reference_hash(prediction.result) != binding.applied_hash:
        raise SyncConflict('权威参考缺失或不一致，请重试同步','reference_not_ready')
    return prediction.result


def prepare_write(task, payload, instance=None, *, submission=False):
    """Called only inside sync_atomic, before saving or deleting any drafts."""
    binding = target_binding(task)
    l4_config = task_uses_furniture_instances(task)
    if not binding:
        if submission and l4_config:
            raise SyncConflict(
                'L4 家具实例项目缺少已启用的权威 L3 参考绑定；正式提交已停止，草稿不会被覆盖',
                'furniture_instance_binding_required',
            )
        return payload.get('result'), None
    binding = ReferenceSyncBinding.objects.select_for_update().select_related('mapping').get(pk=binding.id)
    if l4_config and not is_furniture_instances(binding.mapping):
        if submission:
            raise SyncConflict(
                'L4 家具实例项目绑定了错误的参考同步类型；正式提交已停止',
                'furniture_instance_binding_mismatch',
            )
        return payload.get('result'), None
    if is_occupancy(binding.mapping):
        from tasks.occupancy.reference import prepare_write as occupancy_write
        return occupancy_write(task, payload, instance, binding, submission)
    if is_furniture_instances(binding.mapping):
        if not l4_config:
            raise SyncConflict(
                'L4 家具实例参考绑定的目标配置未启用 furnitureInstancesV1',
                'furniture_instance_config_mismatch',
            )
        from tasks.furniture_instances.reference import prepare_write as furniture_instances_write
        return furniture_instances_write(task, payload, instance, binding, submission)
    lock_target(task)
    refs = current_reference(binding)
    revision = payload.get('reference_version')
    baseline = payload.get('base_manual_hash')
    if not revision or not baseline:
        raise SyncConflict('此任务已启用安全同步，请先保留本地修改并重新加载新版客户端','reference_version_required',428)
    prior = instance.result if instance is not None else refs
    if baseline != manual_hash(prior):
        raise SyncConflict('人工内容已被其他窗口更新；当前修改仍在本窗口，请导出备份后处理冲突','manual_version_conflict')
    if instance is not None and not payload.get('expected_updated_at'):
        raise SyncConflict('缺少草稿/标注版本，请加载新版客户端','draft_version_required',428)
    if instance is not None:
        expected = parse_datetime(str(payload.get('expected_updated_at')))
        if expected is None or (expected != instance.updated_at and revision == binding.applied_hash):
            raise SyncConflict('草稿或标注版本已变化，请保留当前窗口并重新核对','draft_version_conflict')
    if submission and revision != binding.applied_hash:
        raise SyncConflict('请先安全应用最新 Room 参考并完成复核，再提交','reference_version_conflict')
    result = payload.get('result',prior)
    if not isinstance(result,list):
        raise SyncConflict('result 必须为列表','invalid_result',400)
    merged = merge_results(result,refs,binding.applied_hash,prior=prior)
    if submission:
        try:
            validate_submission(merged)
        except ValueError as exc:
            raise SyncConflict(str(exc),'reference_review_required',400) from exc
    return merged,binding


def response_tokens(instance):
    binding = target_binding(instance.task)
    if not binding:
        return {}
    if is_occupancy(binding.mapping):
        from tasks.occupancy.reference import reference_hash as rh, manual_hash as mh
        return {'reference_version': rh(instance.result or []), 'base_manual_hash': mh(instance.result or [])}
    if is_furniture_instances(binding.mapping):
        from tasks.furniture_instances.reference import manual_hash as mh
        from tasks.furniture_instances.reference import reference_hash as rh
        return {'reference_version': rh(instance.result or []), 'base_manual_hash': mh(instance.result or [])}
    refs = reference_results(instance.result or [])
    return {'reference_version':reference_hash(refs),'base_manual_hash':manual_hash(instance.result or [])}


def finalize_saved_result(instance):
    """Stamp server-owned metadata that cannot exist before the first save.

    A newly-created Annotation has no primary key during submission validation.
    L4 provenance is therefore added immediately after ``serializer.save()`` in
    the same outer sync transaction. Other sync profiles are byte-for-byte
    unchanged.
    """
    binding = target_binding(instance.task)
    l4_config = task_uses_furniture_instances(instance.task)
    if l4_config and (not binding or not is_furniture_instances(binding.mapping)):
        raise SyncConflict(
            'L4 家具实例正式结果缺少正确的参考绑定，无法写入服务端 provenance',
            'furniture_instance_binding_required',
        )
    if not binding or not is_furniture_instances(binding.mapping):
        return instance
    if not l4_config:
        raise SyncConflict(
            'L4 家具实例参考绑定的目标配置未启用 furnitureInstancesV1',
            'furniture_instance_config_mismatch',
        )
    from tasks.furniture_instances.reference import stamp_provenance
    result = stamp_provenance(
        instance.result or [],
        project_id=instance.project_id,
        task_id=instance.task_id,
        annotation_id=instance.id,
    )
    if result != (instance.result or []):
        type(instance).objects.filter(pk=instance.pk).update(result=result)
        instance.result = result
    return instance


def latest_reference_difference(binding):
    """Recover precise change provenance for legacy pending reviews.

    New reviews persist this context on their geometry result. Older drafts only
    stored the generic reason, but the immutable synchronization audit still
    contains both reference snapshots, so the status endpoint can describe the
    exact source without mutating the draft.
    """
    audit = ReferenceSyncAudit.objects.filter(
        binding=binding,
        source_hash=binding.applied_hash,
        operation__in=('create', 'sync'),
    ).order_by('-id').first()
    if not audit:
        return None, []
    if audit.summary.get('references') is not None:
        difference = audit.summary
    else:
        def prediction_result(snapshot):
            candidates = snapshot.get('predictions', []) if isinstance(snapshot, dict) else []
            selected = next((p for p in candidates if p.get('id') == binding.prediction_id), None)
            return selected.get('result', []) if selected else []
        difference = diff_refs(prediction_result(audit.before), prediction_result(audit.after))
    room_results = [
        r for snapshot in (audit.before, audit.after)
        for prediction in (snapshot.get('predictions', []) if isinstance(snapshot, dict) else [])
        if prediction.get('id') == binding.prediction_id
        for r in reference_results(prediction.get('result', []))
        if r.get('from_name') in ROOMS
    ]
    return difference, room_results


def binding_status(binding,user):
    from tasks.models import AnnotationDraft
    if is_occupancy(binding.mapping) or is_furniture_instances(binding.mapping):
        if is_occupancy(binding.mapping):
            from tasks.occupancy.reference import reference_hash as rh, manual_hash as mh, pending_reviews as pending
        else:
            from tasks.furniture_instances.reference import manual_hash as mh
            from tasks.furniture_instances.reference import pending_reviews as pending
            from tasks.furniture_instances.reference import reference_hash as rh
        desired, error = binding.desired_hash, ''
        try:
            _, source = source_for(binding)
            desired = rh(source.result)
        except ValueError as exc:
            error = str(exc)
        drafts = list(AnnotationDraft.objects.filter(task_id=binding.target_task_id, user=user))
        return {'enabled': binding.mapping.enabled, 'sync_type': binding.mapping.sync_type, 'apply_policy': 'manual',
                'source_task_id': binding.source_task_id, 'source_project_id': binding.mapping.source_project_id,
                'source_annotation_id': binding.source_annotation_id, 'target_task_id': binding.target_task_id,
                'target_project_id': binding.mapping.target_project_id, 'source_version': desired,
                'reference_version': binding.applied_hash, 'status': 'blocked' if error else 'synced' if desired == binding.applied_hash else 'update_available',
                'error': error, 'worker_alive': True, 'last_synced_at': binding.last_synced_at,
                'drafts': [{'id': d.id, 'annotation_id': d.annotation_id, 'updated_at': d.updated_at, 'base_manual_hash': mh(d.result), 'pending': pending(d.result)} for d in drafts]}
    heartbeat = binding.mapping.worker_heartbeat
    alive = heartbeat is not None and (timezone.now()-heartbeat).total_seconds()<15
    drafts = list(AnnotationDraft.objects.filter(task_id=binding.target_task_id,user=user)) if binding.target_task_id else []
    difference, audit_rooms = latest_reference_difference(binding)
    summaries = [{'id':d.id,'annotation_id':d.annotation_id,'updated_at':d.updated_at,
                  'base_manual_hash':manual_hash(d.result),
                  'pending':pending_reviews(d.result,difference,audit_rooms)} for d in drafts]
    repair = source_metadata_repair_status(binding)
    return {'enabled':binding.mapping.enabled,'source_task_id':binding.source_task_id,
        'source_project_id':binding.mapping.source_project_id,'source_annotation_id':binding.source_annotation_id,
        'target_task_id':binding.target_task_id,'target_project_id':binding.mapping.target_project_id,
        'status':binding.status,'source_version':binding.desired_hash,'reference_version':binding.applied_hash,
        'last_synced_at':binding.last_synced_at,'worker_alive':alive,'error':binding.error,
        'drafts':summaries,'needs_review':any(d['pending'] for d in summaries), **repair}
