from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils.dateparse import parse_datetime
from rest_framework.response import Response
from shapely.geometry import Polygon
from tasks.models import AnnotationDraft
from tasks.serializers import AnnotationDraftSerializer

from .api import ReferenceSyncStatusAPI
from .models import ReferenceSyncAudit, ReferenceSyncBinding
from .results import ROOMS, ZONES, manual_hash, result_polygon, valid_polygon
from .service import SyncConflict, current_reference, lock_target, prepare_write, sync_atomic


SNAPSHOT_OPERATION = 'l2_subdivision'


def parent_id(result):
    return result.get('meta', {}).get('partition_context', {}).get('parent_room_id')


def classify_region(results, region_id):
    return next((
        label for result in results if result.get('id') == region_id and result.get('from_name') == 'function_zone'
        for label in result.get('value', {}).get('labels', [])
    ), '')


def region_summary(results, region_id):
    return {'zone_id': region_id, 'label': classify_region(results, region_id)}


def polygon(result):
    points = result_polygon(result)
    if result.get('value', {}).get('closed') is False or not valid_polygon(points):
        return None
    return Polygon(points)


def touching_relation(results, region_id):
    return any(result.get('type') == 'relation' and any(
        str(result.get(key, '')).split('#', 1)[0] == region_id for key in ('from_id', 'to_id')
    ) for result in results)


def conflicting_zones(results, room_id, room_polygon, *, exclude=None):
    conflicts = []
    for result in results:
        if result.get('from_name') not in ZONES or result.get('id') == exclude:
            continue
        if parent_id(result) == room_id:
            conflicts.append(region_summary(results, result['id']))
            continue
        candidate = polygon(result)
        if candidate is None:
            conflicts.append(region_summary(results, result['id']))
        elif candidate.intersection(room_polygon).area > 1e-6:
            conflicts.append(region_summary(results, result['id']))
    return conflicts


def snapshot_summary(results, refs, zone_id):
    pair = [r for r in results if r.get('id') == zone_id]
    zone = next((r for r in pair if r.get('from_name') in ZONES), None)
    label = classify_region(pair, zone_id)
    if (not zone or zone.get('readonly') or not label or len(pair) != 2 or
            zone.get('meta', {}).get('zone_inheritance', {}).get('generation_method') != 'whole_room'):
        raise SyncConflict('只能为可编辑的自动整室分区创建细分快照', 'invalid_whole_room_zone')
    room_id = parent_id(zone)
    room = next((r for r in refs if r.get('id') == room_id and r.get('from_name') in ROOMS), None)
    zone_shape, room_shape = polygon(zone), polygon(room) if room else None
    if (zone_shape is None or room_shape is None or zone.get('to_name') != room.get('to_name') or
            zone_shape.symmetric_difference(room_shape).area > 1e-6):
        raise SyncConflict('分区未覆盖整个来源房间', 'invalid_whole_room_zone')
    if touching_relation(results, zone_id) or conflicting_zones(results, room_id, room_shape, exclude=zone_id):
        raise SyncConflict('房间内已有其他分区，或该分区存在手工关联', 'subdivision_conflict')
    room_type = room.get('meta', {}).get('room_graph_node', {}).get('room_type')
    return {'zone_id': zone_id, 'label': label, 'room_id': room_id, 'room_type': room_type}


def public_snapshot(entry):
    return {
        'id': entry.pk,
        'created_at': entry.created_at,
        **{key: entry.summary[key] for key in ('zone_id', 'label', 'room_id', 'room_type')},
    }


def restore_preview(entry, results, refs, reference_version):
    summary = entry.summary
    room_id, zone_id = summary['room_id'], summary['zone_id']
    room = next((r for r in refs if r.get('id') == room_id and r.get('from_name') in ROOMS), None)
    shape = polygon(room) if room else None
    conflicts = conflicting_zones(results, room_id, shape) if shape is not None else []
    reason = None
    if entry.source_hash != reference_version or shape is None:
        reason = 'L1 参考已变化，不能自动恢复旧的整室分区'
    elif conflicts:
        reason = '房间已有分区；不会覆盖这些分区'
    elif any(r.get('id') == zone_id for r in results) or touching_relation(results, zone_id):
        reason = '原分区 ID 或关联仍在草稿中；不能重复恢复'
    return {**public_snapshot(entry), 'conflicts': conflicts, 'blocked_reason': reason}


def revision_token(draft):
    return draft.updated_at.isoformat().replace('+00:00', 'Z')


class L2SubdivisionAPI(ReferenceSyncStatusAPI):
    def binding(self, task, *, lock=False):
        bindings = ReferenceSyncBinding.objects
        if lock:
            bindings = bindings.select_for_update()
        return get_object_or_404(bindings.select_related('mapping'), target_task=task,
                                 mapping__enabled=True, mapping__sync_type='room_to_function_zone')

    def entries(self, binding, draft):
        lineage = Q(summary__draft_id=draft.id)
        if draft.annotation_id is not None:
            lineage = Q(summary__annotation_id=draft.annotation_id)
        return ReferenceSyncAudit.objects.filter(
            lineage, binding=binding, operation=SNAPSHOT_OPERATION, summary__user_id=draft.user_id,
        )

    def get(self, request, *args, **kwargs):
        task = self.task()
        binding = self.binding(task)
        draft_id = request.query_params.get('draft_id')
        if not draft_id or not draft_id.isascii() or not draft_id.isdecimal() or len(draft_id) > 18:
            raise SyncConflict('请先保存复核草稿', 'draft_required', 400)
        draft = get_object_or_404(AnnotationDraft, pk=draft_id, task=task, user=request.user)
        entries = self.entries(binding, draft).defer('before', 'after').order_by('-created_at', '-id')
        return Response({'snapshots': [public_snapshot(entry) for entry in entries]})

    @sync_atomic
    def post(self, request, *args, **kwargs):
        task = self.task()
        binding = self.binding(task, lock=True)
        lock_target(task)
        payload = request.data
        draft_id = payload.get('draft_id')
        if type(draft_id) is not int or not 0 < draft_id < 10**18:
            raise SyncConflict('请先保存复核草稿', 'draft_required', 400)
        draft = get_object_or_404(AnnotationDraft.objects.select_for_update(), pk=draft_id, task=task, user=request.user)
        try:
            expected = parse_datetime(str(payload.get('expected_updated_at') or ''))
        except ValueError:
            expected = None
        refs = current_reference(binding)
        if expected != draft.updated_at or payload.get('reference_version') != binding.applied_hash:
            raise SyncConflict('草稿或参考已变化，请重新加载后再操作', 'draft_version_conflict')
        results = draft.result or []
        action = payload.get('action')
        if action == 'snapshot':
            zone_id = payload.get('zone_id')
            if not isinstance(zone_id, str) or not zone_id:
                raise SyncConflict('请选择自动整室分区', 'invalid_whole_room_zone', 400)
            summary = snapshot_summary(results, refs, zone_id)
            entry = self.entries(binding, draft).filter(
                summary__draft_id=draft.id, summary__draft_revision=revision_token(draft), summary__zone_id=zone_id,
            ).first()
            if entry is None:
                entry = ReferenceSyncAudit.objects.create(
                    binding=binding, source_hash=binding.applied_hash, operation=SNAPSHOT_OPERATION,
                    before={'result': results}, after={},
                    summary={**summary, 'draft_id': draft.id, 'annotation_id': draft.annotation_id,
                             'draft_revision': revision_token(draft), 'user_id': request.user.id},
                )
            return Response(public_snapshot(entry))

        snapshot_id = payload.get('snapshot_id')
        if action not in ('preview', 'restore') or type(snapshot_id) is not int or not 0 < snapshot_id < 10**18:
            raise SyncConflict('请选择细分快照', 'invalid_subdivision_action', 400)
        entry = get_object_or_404(self.entries(binding, draft), pk=snapshot_id)
        preview = restore_preview(entry, results, refs, binding.applied_hash)
        if action == 'preview':
            return Response(preview)
        if preview['blocked_reason']:
            raise SyncConflict(preview['blocked_reason'], 'subdivision_restore_blocked')
        zone_id = entry.summary['zone_id']
        pairs = [r for r in entry.before['result'] if r.get('id') == zone_id]
        merged, _ = prepare_write(task, {
            'result': [*results, *pairs], 'base_manual_hash': manual_hash(results),
            'reference_version': binding.applied_hash, 'expected_updated_at': revision_token(draft),
        }, draft)
        # Run the usual validation, but restore only the requested region, not the old draft.
        restored = [r for r in merged if r.get('id') == zone_id]
        if len(restored) != 2:
            raise SyncConflict('快照中的整室分区不完整，未恢复', 'subdivision_restore_blocked')
        draft.result = [*results, *restored]
        draft.save(update_fields=['result', 'updated_at'])
        return Response(AnnotationDraftSerializer(draft, context={'request': request}).data)
