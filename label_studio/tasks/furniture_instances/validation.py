"""Authoritative Shapely validation for L4 furniture instances."""

import re
from collections import defaultdict

from tasks.occupancy.geometry import VALIDATION_EPS_AREA
from tasks.occupancy.validation import (
    BARRIER_CONTROL,
    GROUP_TYPES,
    label_of,
)
from tasks.occupancy.validation import (
    GEOMETRY as GROUP_GEOMETRY_CONTROLS,
)
from tasks.occupancy.validation import (
    PARENTS as ZONE_CONTROLS,
)
from tasks.occupancy.validation import (
    REFERENCES as L2_REFERENCE_CONTROLS,
)
from tasks.occupancy.validation import (
    context as occupancy_context,
)
from tasks.occupancy.validation import (
    source_fingerprint as zone_fingerprint,
)

from . import FURNITURE_TYPES
from .geometry import (
    CATEGORY_CONTROL,
    FRONT_DIRECTION_CONTROL,
    FRONT_EDGE_CONTROL,
    GEOMETRY_CONTROLS,
    MANUAL_CONTROLS,
    orientation_from_results,
    parent_fingerprint,
    review_fingerprint,
    union_result_geometry,
    validation_union_geometry,
)

ROOM_CONTROLS = {'room_rectangle', 'room_polygon'}
OCCUPANCY_TYPE_CONTROL = 'occupancy_type'
REFERENCE_CONTROLS = (
    L2_REFERENCE_CONTROLS
    | GROUP_GEOMETRY_CONTROLS
    | {OCCUPANCY_TYPE_CONTROL, BARRIER_CONTROL}
)
ROLE_BY_CONTROL = {
    **{control: 'geometry' for control in GEOMETRY_CONTROLS},
    CATEGORY_CONTROL: 'category',
    FRONT_DIRECTION_CONTROL: 'front_direction',
    FRONT_EDGE_CONTROL: 'front_edge',
}
SHA256 = re.compile(r'^[0-9a-f]{64}$')
COMMON_CONTEXT_KEYS = (
    'schema_version',
    'instance_id',
    'instance_type',
    'note',
    'room_id',
    'zone_id',
    'group_id',
    'source_version',
    'parent_fingerprint',
    'review_status',
    'review_fingerprint',
)


def context(result):
    meta = result.get('meta')
    value = meta.get('furniture_instance_context') if isinstance(meta, dict) else None
    return value if isinstance(value, dict) else {}


def common_context(value):
    return {key: value.get(key) for key in COMMON_CONTEXT_KEYS}


def _group_identity(group_context):
    return {
        'room_id': group_context.get('parent_room_id'),
        'zone_id': group_context.get('parent_zone_id'),
        'group_id': group_context.get('group_id'),
        'group_type': group_context.get('group_type'),
        'group_note': group_context.get('group_note') or '',
        'zone_parent_fingerprint': group_context.get('parent_fingerprint'),
    }


def furniture_groups(results):
    """Resolve every current L3 furniture group and its exact logical geometry.

    Invalid source semantics raise rather than silently dropping or repairing a
    group.  A caller can therefore never use another group as an implicit
    replacement for a missing/stale saved parent.
    """
    room_results = [result for result in results if result.get('from_name') in ROOM_CONTROLS]
    zone_results = [result for result in results if result.get('from_name') in ZONE_CONTROLS]
    if len({result.get('id') for result in room_results}) != len(room_results):
        raise ValueError('L1 房间稳定 ID 重复')
    if len({result.get('id') for result in zone_results}) != len(zone_results):
        raise ValueError('L2 功能分区稳定 ID 重复')
    rooms = {result['id']: result for result in room_results}
    zones = {result['id']: result for result in zone_results}
    pieces = defaultdict(list)
    for result in results:
        if result.get('from_name') not in GROUP_GEOMETRY_CONTROLS:
            continue
        if label_of(results, result.get('id'), OCCUPANCY_TYPE_CONTROL) != 'furniture_group':
            continue
        group_context = occupancy_context(result)
        group_id = group_context.get('group_id')
        if not group_id:
            raise ValueError('L3 家具组团缺少稳定 group_id')
        pieces[group_id].append(result)

    groups = {}
    for group_id, group_pieces in pieces.items():
        first_context = occupancy_context(group_pieces[0])
        identity = _group_identity(first_context)
        if (
            first_context.get('schema_version') != 1
            or identity['group_id'] != group_id
            or not all(
                isinstance(identity[key], str) and bool(identity[key])
                for key in ('room_id', 'zone_id', 'group_id')
            )
            or identity['group_type'] not in GROUP_TYPES
            or not isinstance(first_context.get('group_note', ''), str)
            or not isinstance(identity['zone_parent_fingerprint'], str)
            or not SHA256.fullmatch(identity['zone_parent_fingerprint'])
        ):
            raise ValueError(f'L3 家具组团 {group_id} 的父级或元数据不完整')
        for part in group_pieces:
            part_context = occupancy_context(part)
            if _group_identity(part_context) != identity or part_context.get('logical_id') != first_context.get('logical_id'):
                raise ValueError(f'L3 家具组团 {group_id} 的多个几何部分元数据不一致')
            paired = [
                result
                for result in results
                if result.get('id') == part.get('id') and result.get('from_name') == OCCUPANCY_TYPE_CONTROL
            ]
            if len(paired) != 1 or paired[0].get('value', {}).get('labels') != ['furniture_group']:
                raise ValueError(f'L3 家具组团 {group_id} 的几何/类别配对无效')
        zone = zones.get(identity['zone_id'])
        room = rooms.get(identity['room_id'])
        if zone is None or room is None:
            raise ValueError(f'L3 家具组团 {group_id} 缺少 L1→L2 父级链')
        if zone.get('meta', {}).get('partition_context', {}).get('parent_room_id') != identity['room_id']:
            raise ValueError(f'L3 家具组团 {group_id} 的 room_id/zone_id 父级链不一致')
        if zone_fingerprint(zone, results) != identity['zone_parent_fingerprint']:
            raise ValueError(f'L3 家具组团 {group_id} 的功能分区指纹已过期')
        geometry = union_result_geometry(group_pieces)
        validation_geometry = validation_union_geometry(group_pieces)
        groups[group_id] = {
            **identity,
            'logical_id': first_context.get('logical_id'),
            'geometry': geometry,
            'validation_geometry': validation_geometry,
            'parts': group_pieces,
            'fingerprint': parent_fingerprint(identity, geometry),
        }
    return groups


def _valid_context(value, expected_role):
    return (
        value.get('schema_version') == 1
        and isinstance(value.get('instance_id'), str)
        and bool(value['instance_id'])
        and value.get('instance_type') in FURNITURE_TYPES
        and 'note' in value
        and isinstance(value.get('note'), str)
        and all(isinstance(value.get(key), str) and bool(value[key]) for key in ('room_id', 'zone_id', 'group_id', 'source_version'))
        and isinstance(value.get('parent_fingerprint'), str)
        and bool(SHA256.fullmatch(value['parent_fingerprint']))
        and value.get('review_status') in {'pending', 'reviewed', 'stale'}
        and 'review_fingerprint' in value
        and (value.get('review_fingerprint') is None or (
            isinstance(value.get('review_fingerprint'), str)
            and bool(SHA256.fullmatch(value['review_fingerprint']))
        ))
        and value.get('role') == expected_role
    )


def _category_value(result):
    values = result.get('value', {}).get('choices')
    return values[0] if isinstance(values, list) and len(values) == 1 else None


def _dimensions_match(results):
    dimensions = {(result.get('original_width'), result.get('original_height')) for result in results}
    return len(dimensions) == 1


def instance_records(results):
    records = defaultdict(list)
    for result in results:
        if result.get('from_name') in MANUAL_CONTROLS:
            records[context(result).get('instance_id')].append(result)
    return records


def effective_review_status(results, source_version=None):
    """Return current derived state without mutating saved L4 bytes."""
    try:
        groups = furniture_groups(results)
    except (ValueError, TypeError, KeyError):
        groups = {}
    output = []
    for instance_id, instance_results in instance_records(results).items():
        if not instance_id:
            continue
        value = context(instance_results[0])
        group = groups.get(value.get('group_id'))
        stale = (
            group is None
            or value.get('parent_fingerprint') != group.get('fingerprint')
            or value.get('room_id') != group.get('room_id')
            or value.get('zone_id') != group.get('zone_id')
        )
        output.append({
            'id': instance_id,
            'group_id': value.get('group_id'),
            'review_status': 'stale' if stale else value.get('review_status', 'pending'),
        })
    return sorted(output, key=lambda item: item['id'])


def validate(results, source_version, *, partial=False, review=True):
    """Return stable, actionable L4 errors; never mutate or repair results."""
    errors = []

    def error(code, object_id, message, **details):
        errors.append({'code': code, 'objectId': object_id, 'message': message, **details})

    try:
        groups = furniture_groups(results)
    except (ValueError, TypeError, KeyError) as exc:
        error('reference', None, str(exc))
        groups = {}

    records = defaultdict(list)
    manual_keys = defaultdict(list)
    for result in results:
        control = result.get('from_name')
        value = context(result)
        if control not in MANUAL_CONTROLS:
            if value:
                error('control', result.get('id'), 'L4 上下文出现在未知控件结果上')
            continue
        expected_role = ROLE_BY_CONTROL[control]
        instance_id = value.get('instance_id')
        if not _valid_context(value, expected_role):
            error('context', instance_id or result.get('id'), f'{control} 的 L4 上下文不完整或 role 不匹配')
        records[instance_id].append(result)
        result_id = result.get('id')
        if not isinstance(result_id, str) or not result_id:
            error('pair', instance_id, 'L4 人工结果必须包含非空稳定字符串 ID', control=control)
        manual_keys[(result_id, control)].append(instance_id or result_id)

    for (result_id, control), owners in manual_keys.items():
        if len(owners) > 1:
            error(
                'pair',
                owners[0],
                'L4 人工结果 ID/控件配对必须在整个任务内唯一',
                resultId=result_id,
                control=control,
            )

    for instance_id, instance_results in records.items():
        if not instance_id:
            continue
        common = common_context(context(instance_results[0]))
        if any(common_context(context(result)) != common for result in instance_results[1:]):
            error('parts', instance_id, '同一家具实例的父级、类别、来源或复核元数据不一致')
        if len({(result.get('id'), result.get('from_name')) for result in instance_results}) != len(instance_results):
            error('pair', instance_id, '家具实例包含重复的结果 ID/控件配对')

        geometry_results = [result for result in instance_results if result.get('from_name') in GEOMETRY_CONTROLS]
        category_results = [result for result in instance_results if result.get('from_name') == CATEGORY_CONTROL]
        direction_results = [result for result in instance_results if result.get('from_name') == FRONT_DIRECTION_CONTROL]
        edge_results = [result for result in instance_results if result.get('from_name') == FRONT_EDGE_CONTROL]
        if not geometry_results:
            error('orphan', instance_id, '类别或朝向结果没有对应家具实例几何')
            continue
        if len(category_results) != len(geometry_results):
            error('pair', instance_id, '每个家具几何部分必须恰好配对一个同 ID 类别结果')
            continue
        for result in geometry_results:
            expected_type = 'rectangle' if result.get('from_name') == 'furniture_instance_rectangle' else 'polygon'
            if result.get('type') != expected_type:
                error('geometry', instance_id, '家具几何结果类型与控件不匹配')
            paired = [category for category in category_results if category.get('id') == result.get('id')]
            if len(paired) != 1:
                error('pair', instance_id, f"家具几何 {result.get('id')} 缺少唯一同 ID 类别结果")
            elif (
                paired[0].get('type') != 'choices'
                or _category_value(paired[0]) not in FURNITURE_TYPES
                or _category_value(paired[0]) != common.get('instance_type')
            ):
                error('category', instance_id, '家具类别必须是唯一稳定英文值并与上下文一致')
        for category_result in category_results:
            paired = [geometry for geometry in geometry_results if geometry.get('id') == category_result.get('id')]
            if len(paired) != 1:
                error('pair', instance_id, f"家具类别 {category_result.get('id')} 缺少唯一同 ID 几何结果")
        if not _dimensions_match(geometry_results + direction_results + edge_results):
            error('geometry', instance_id, '家具实例几何与朝向证据的原图尺寸不一致')

        try:
            geometry = union_result_geometry(geometry_results)
            validation_geometry = validation_union_geometry(geometry_results)
        except (ValueError, TypeError, KeyError) as exc:
            error('geometry', instance_id, str(exc))
            continue
        try:
            orientation = orientation_from_results(direction_results, edge_results, geometry)
        except (ValueError, TypeError, KeyError) as exc:
            error('orientation', instance_id, str(exc))
            orientation = {'status': 'unknown'}

        group = groups.get(common.get('group_id'))
        stale = group is None
        if group is None:
            error('parent_missing', instance_id, '保存的父家具组团已删除；不会自动迁移实例')
        else:
            if common.get('room_id') != group['room_id'] or common.get('zone_id') != group['zone_id']:
                error('parent_chain', instance_id, 'room_id → zone_id → group_id 父级链不一致')
                stale = True
            if common.get('parent_fingerprint') != group['fingerprint']:
                error('parent_stale', instance_id, '父家具组团语义或完整几何已变化，实例必须明确复核且不会自动迁移')
                stale = True
            outside_area = validation_geometry.difference(group['validation_geometry']).area
            if outside_area > VALIDATION_EPS_AREA:
                error(
                    'outside',
                    instance_id,
                    f'家具实例超出 Focus 家具组团（越界面积 {outside_area:.6f} px²）',
                    outsideAreaPx=outside_area,
                    groupId=group['group_id'],
                )
            for other_id, other in groups.items():
                if other_id == group['group_id']:
                    continue
                overlap_area = validation_geometry.intersection(other['validation_geometry']).area
                if overlap_area > VALIDATION_EPS_AREA:
                    error(
                        'cross_group',
                        instance_id,
                        f'家具实例跨入其他家具组团 {other_id}（重叠面积 {overlap_area:.6f} px²）',
                        overlapAreaPx=overlap_area,
                        relatedGroupId=other_id,
                    )
        if not partial and review:
            try:
                expected_review = review_fingerprint(common, geometry, orientation)
            except (KeyError, TypeError, ValueError) as exc:
                error('context', instance_id, f'无法计算家具复核指纹：{exc}')
                continue
            if stale:
                if common.get('review_status') != 'stale':
                    error('stale_status', instance_id, '父级变化后保存的复核状态已过期')
            elif common.get('review_status') != 'reviewed' or common.get('review_fingerprint') != expected_review:
                error('review', instance_id, '家具实例未复核或内容修改后必须重新复核')

    # Stable deduplication keeps the first detailed occurrence.
    unique = {}
    for item in errors:
        unique.setdefault((item['code'], item['objectId'], item.get('relatedGroupId')), item)
    return list(unique.values())
