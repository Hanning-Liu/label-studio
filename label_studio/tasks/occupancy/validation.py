from collections import defaultdict
import math

from shapely import set_precision, union_all
from shapely.geometry import LineString
from .geometry import EPS_AREA, VALIDATION_EPS_AREA, fingerprint, result_geometry, validation_geometry, validation_shape

GEOMETRY = {'occupancy_rectangle', 'occupancy_polygon'}
PARENTS = {'zone_rectangle', 'zone_polygon'}
REFERENCES = {'room_rectangle', 'room_polygon', 'portal_rectangle', 'portal_vector',
              'zone_rectangle', 'zone_polygon', 'function_zone', 'connection_vector',
              'visual_connection_vector', 'connection_review', 'visual_connection_review'}
TYPES = {'furniture_group', 'walkable', 'restricted_free', 'unclassified'}
GROUP_TYPES = {'sleeping', 'study_work', 'dining', 'living_social', 'storage', 'dressing_grooming',
               'cooking_preparation', 'washbasin', 'toilet', 'shower_fixtures', 'bathtub',
               'laundry_drying', 'plant_decor', 'bay_window', 'leisure_recreation',
               'equipment_service', 'other'}
BARRIER_CONTROL = 'occupancy_barrier_vector'
BARRIER_LABEL = 'wall_barrier'
BARRIER_EPS = 1e-5
COORDINATE_GRID_PX = 1e-6


def context(r):
    return r.get('meta', {}).get('occupancy_context', {})


def label_of(results, region_id, control):
    values = next((r.get('value', {}).get('labels', []) for r in results if r.get('id') == region_id and r.get('from_name') == control), [])
    return values[0] if values else None


def source_fingerprint(r, results):
    return fingerprint({'value': r['value'], 'width': r.get('original_width'), 'height': r.get('original_height'),
                        'label': label_of(results, r['id'], 'function_zone'),
                        'room': r.get('meta', {}).get('partition_context', {}).get('parent_room_id')})


def semantic(r, results):
    c = context(r)
    return {'id': r['id'], 'control': r['from_name'], 'value': r['value'],
            'width': r.get('original_width'), 'height': r.get('original_height'),
            'type': label_of(results, r['id'], 'occupancy_type'), 'logical_id': c.get('logical_id'),
            'group_id': c.get('group_id') or None, 'group_type': c.get('group_type') or None,
            'group_note': c.get('group_note') or '', 'parent_zone_id': c.get('parent_zone_id'),
            'parent_room_id': c.get('parent_room_id'), 'generation': c.get('generation'),
            'parent_fingerprint': c.get('parent_fingerprint'),
            'remainder_input_fingerprint': c.get('remainder_input_fingerprint') or None}


def barrier_context(r):
    return r.get('meta', {}).get('occupancy_barrier_context', {})


def barrier_semantic(r):
    c = barrier_context(r)
    return {'id': r['id'], 'control': r['from_name'], 'value': r['value'],
            'width': r.get('original_width'), 'height': r.get('original_height'),
            'barrier_type': c.get('barrier_type'), 'parent_zone_id': c.get('parent_zone_id'),
            'parent_room_id': c.get('parent_room_id'), 'source_version': c.get('source_version'),
            'parent_fingerprint': c.get('parent_fingerprint'), 'match_rule': c.get('match_rule'),
            'matched_pairs': c.get('matched_pairs') or []}


def content_fingerprint(results, parent_id, remainder=False):
    parent = next((r for r in results if r.get('from_name') in PARENTS and r['id'] == parent_id), None)
    values = [semantic(r, results) for r in results if r.get('from_name') in GEOMETRY and context(r).get('parent_zone_id') == parent_id
              and (not remainder or context(r).get('generation') != 'remainder')]
    value = {'parent': source_fingerprint(parent, results) if parent else None,
             'regions': sorted(values, key=lambda r: r['id'])}
    barriers = sorted([barrier_semantic(r) for r in results
                       if r.get('from_name') == BARRIER_CONTROL
                       and barrier_context(r).get('parent_zone_id') == parent_id], key=lambda r: r['id'])
    # Keep review fingerprints stable for annotations created before the
    # optional barrier control existed.
    if barriers and not remainder:
        value['barriers'] = barriers
    return fingerprint(value)


def _barrier_line(result):
    width, height = result.get('original_width'), result.get('original_height')
    vertices = result.get('value', {}).get('vertices')
    if not (isinstance(width, (int, float)) and isinstance(height, (int, float))
            and math.isfinite(width) and math.isfinite(height) and width > 0 and height > 0
            and isinstance(vertices, list) and len(vertices) == 2):
        raise ValueError('隔墙 Vector 必须包含两个有效端点和原图尺寸')
    points = []
    for vertex in vertices:
        if (not isinstance(vertex, dict) or vertex.get('isBezier')
                or not isinstance(vertex.get('x'), (int, float))
                or not isinstance(vertex.get('y'), (int, float))
                or not math.isfinite(vertex['x']) or not math.isfinite(vertex['y'])):
            raise ValueError('隔墙 Vector 端点必须是有限直线坐标')
        points.append((vertex['x'] * width / 100, vertex['y'] * height / 100))
    line = LineString(points)
    if line.length <= 1e-7:
        raise ValueError('隔墙 Vector 长度必须大于零')
    # Vector coordinates are stored as percentages. Converting them back to
    # pixels can turn an exact boundary such as x=569 into
    # x=569.0000000000001. Use the same pixel grid as furniture geometry so an
    # exactly snapped barrier is not rejected as having zero overlap.
    return set_precision(line, grid_size=COORDINATE_GRID_PX)


def _canonical_pairs(pairs):
    normalized = []
    for pair in pairs or []:
        source, target = sorted((pair.get('source_group_id'), pair.get('target_group_id')))
        normalized.append({'source_group_id': source, 'target_group_id': target,
                           'shared_boundary_length_px': pair.get('shared_boundary_length_px'),
                           'barrier_overlap_length_px': pair.get('barrier_overlap_length_px')})
    return sorted(normalized, key=lambda pair: (pair['source_group_id'], pair['target_group_id']))


def _pairs_equal(saved, actual):
    try:
        saved, actual = _canonical_pairs(saved), _canonical_pairs(actual)
        return len(saved) == len(actual) and all(
            left['source_group_id'] == right['source_group_id']
            and left['target_group_id'] == right['target_group_id']
            and all(isinstance(item[key], (int, float)) and math.isfinite(item[key])
                    for item in (left, right)
                    for key in ('shared_boundary_length_px', 'barrier_overlap_length_px'))
            and abs(left['shared_boundary_length_px'] - right['shared_boundary_length_px']) <= BARRIER_EPS
            and abs(left['barrier_overlap_length_px'] - right['barrier_overlap_length_px']) <= BARRIER_EPS
            for left, right in zip(saved, actual)
        )
    except (AttributeError, TypeError, ValueError):
        return False


def validate(results, source_version, *, partial=False, review=True):
    """Returns actionable errors; drafts are intentionally not subjected to this gate."""
    errors, parent_map, parsed, validation_parents = [], {}, {}, {}

    def error(code, c, object_id, message, **details):
        parent_id = c.get('parent_zone_id')
        parent = parent_map.get(parent_id)
        label = label_of(results, parent_id, 'function_zone') if parent else '父分区缺失'
        errors.append({'code': code, 'parentId': parent_id, 'objectId': object_id,
                       'message': f'{label} · {parent_id}: {message}', **details})

    for r in results:
        if r.get('from_name') in PARENTS | GEOMETRY:
            try:
                parsed[r['id']] = result_geometry(r)
            except (ValueError, TypeError, KeyError) as exc:
                error('geometry', context(r), r.get('id'), str(exc))
            if r.get('from_name') in PARENTS:
                if r['id'] in parent_map:
                    error('pair', {'parent_zone_id': r['id']}, r['id'], '父分区 ID 重复')
                parent_map[r['id']] = r
                try:
                    validation_parents[r['id']] = validation_geometry(r)
                except (ValueError, TypeError, KeyError) as exc:
                    error('geometry', {'parent_zone_id': r['id']}, r.get('id'), str(exc))
    regions, groups, seen = defaultdict(list), {}, set()
    for r in results:
        if r.get('from_name') not in GEOMETRY:
            continue
        c = context(r)
        parent = parent_map.get(c.get('parent_zone_id'))
        pairs = [p for p in results if p.get('id') == r.get('id') and p.get('from_name') == 'occupancy_type']
        kind = label_of(results, r['id'], 'occupancy_type')
        if not partial and c.get('generation') not in {'manual', 'remainder'}:
            error('pending_draw', c, c.get('logical_id'), '绘制轮廓尚未确认应用')
        if r['id'] in seen or not c.get('logical_id') or len(pairs) != 1 or len(pairs[0].get('value', {}).get('labels', [])) != 1 or kind not in TYPES:
            error('pair', c, r['id'], '几何与类别配对或逻辑 ID 无效')
        seen.add(r['id'])
        regions[c.get('logical_id', 'invalid:' + r['id'])].append(r)
        if not parent:
            error('parent_missing', c, r['id'], '原父分区已删除或拆并，请明确重新绑定')
            continue
        # Task-wide applied/reference versions are checked by prepare_write.
        # A component retains its creation provenance; unrelated L2 changes
        # must not invalidate an unchanged owning parent.
        if not c.get('source_version') or c.get('parent_fingerprint') != source_fingerprint(parent, results) or c.get('parent_room_id') != parent.get('meta', {}).get('partition_context', {}).get('parent_room_id'):
            error('source', c, r['id'], '来源变化，需检查并接受当前父参考')
        if kind == 'furniture_group':
            if not c.get('group_id') or c.get('group_type') not in GROUP_TYPES or (c.get('group_type') == 'other' and not str(c.get('group_note', '')).strip()):
                error('group', c, r['id'], '组团属性缺失或其他类型未填写说明')
            identity = (c.get('logical_id'), c.get('parent_zone_id'), c.get('group_type'), c.get('group_note', ''))
            if c.get('group_id') in groups and groups[c['group_id']] != identity:
                error('group', c, r['id'], '同组类型或归属不一致')
            groups[c.get('group_id')] = identity
        elif c.get('group_id') or c.get('group_type'):
            error('group', c, r['id'], '空闲区域不能携带组团属性')
        if not partial:
            if kind == 'unclassified':
                error('unclassified', c, c.get('logical_id'), '剩余空间未分类')
            if c.get('generation') == 'remainder' and c.get('remainder_input_fingerprint') != content_fingerprint(results, parent['id'], remainder=True):
                error('stale', c, c.get('logical_id'), '补余已过期，请预览并重新生成')
            if review and (c.get('review_status') != 'reviewed' or c.get('review_fingerprint') != content_fingerprint(results, parent['id'])):
                error('review', c, c.get('logical_id'), '分区未复核或修改后需复核')
    for r in results:
        if r.get('from_name') == 'occupancy_type' and r.get('id') not in seen:
            error('pair', {}, r.get('id'), '类别缺少配对几何')
    logical = []
    for logical_id, parts in regions.items():
        c = context(parts[0])
        if any(context(r) != c or label_of(results, r['id'], 'occupancy_type') != label_of(results, parts[0]['id'], 'occupancy_type') for r in parts):
            error('parts', c, logical_id, '逻辑区域分块属性不一致')
        shapes = [parsed[r['id']] for r in parts if r['id'] in parsed]
        for i, a in enumerate(shapes):
            # These raw geometries are still in percentage coordinates; use the
            # storage epsilon rather than the pixel-space validation tolerance.
            if any(a.intersection(b).area > EPS_AREA for b in shapes[i + 1:]):
                error('parts_overlap', c, logical_id, '分块未归并为互不重叠的并集')
        raw_geometry = union_all(shapes)
        source = parts[0]
        try:
            geometry = validation_shape(raw_geometry, source.get('original_width', 0), source.get('original_height', 0))
            logical.append((c, geometry))
            parent_geometry = validation_parents.get(c.get('parent_zone_id'))
            if parent_geometry is not None:
                outside_area = geometry.difference(parent_geometry).area
                if outside_area > VALIDATION_EPS_AREA:
                    error('outside', c, parts[0]['id'], f'超出父功能分区（越界面积 {outside_area:.6f} px²）',
                          outsideAreaPx=outside_area, logicalId=c.get('logical_id'))
        except (ValueError, TypeError, KeyError) as exc:
            error('geometry', c, parts[0].get('id'), str(exc))
    if not partial:
        furniture = {c.get('logical_id'): set_precision(geometry, grid_size=COORDINATE_GRID_PX) for c, geometry in logical
                     if c.get('group_id') and c.get('group_type') in GROUP_TYPES}
        shared = {}
        furniture_ids = sorted(furniture)
        for index, source_id in enumerate(furniture_ids):
            for target_id in furniture_ids[index + 1:]:
                boundary = furniture[source_id].boundary.intersection(furniture[target_id].boundary)
                if boundary.length > 1e-7:
                    shared[(source_id, target_id)] = boundary
        seen_barriers = set()
        for barrier in [r for r in results if r.get('from_name') == BARRIER_CONTROL]:
            c = barrier_context(barrier)
            barrier_id = barrier.get('id')
            if barrier_id in seen_barriers:
                error('barrier_invalid', c, barrier_id, '隔墙结果 ID 重复', barrierId=barrier_id)
                continue
            seen_barriers.add(barrier_id)
            value = barrier.get('value', {})
            if (barrier.get('type') != 'vectorlabels' or value.get('closed')
                    or value.get('vectorlabels') != [BARRIER_LABEL]):
                error('barrier_invalid', c, barrier_id, '人工隔墙必须是开放的两点“隔墙” Vector', barrierId=barrier_id)
                continue
            parent = parent_map.get(c.get('parent_zone_id'))
            if not parent:
                error('barrier_parent_missing', c, barrier_id, '人工隔墙所属功能分区已不存在', barrierId=barrier_id)
                continue
            if (c.get('schema_version') != 1 or c.get('barrier_type') != 'wall'
                    or c.get('match_rule') != 'shared_boundary_overlap'
                    or c.get('parent_room_id') != parent.get('meta', {}).get('partition_context', {}).get('parent_room_id')
                    or c.get('parent_fingerprint') != source_fingerprint(parent, results)
                    or not c.get('source_version')):
                error('barrier_source', c, barrier_id, '人工隔墙父分区来源已变化', barrierId=barrier_id)
            try:
                line = _barrier_line(barrier)
            except (ValueError, TypeError, KeyError) as exc:
                error('barrier_invalid', c, barrier_id, str(exc), barrierId=barrier_id)
                continue
            actual, covered = [], []
            for pair, boundary in shared.items():
                if any(context(part).get('parent_zone_id') != c.get('parent_zone_id')
                       for logical_id in pair for part in regions.get(logical_id, [])):
                    continue
                overlap = line.intersection(boundary).length
                if overlap <= 1e-7:
                    continue
                actual.append({'source_group_id': pair[0], 'target_group_id': pair[1],
                               'shared_boundary_length_px': boundary.length,
                               'barrier_overlap_length_px': overlap})
                covered.append(boundary)
            if not actual:
                error('barrier_unmatched', c, barrier_id,
                      '人工隔墙未命中当前父分区内家具组团的正长度公共边界', barrierId=barrier_id)
                continue
            uncovered = line.difference(union_all(covered)).length
            parent_geometry = validation_parents.get(c.get('parent_zone_id'))
            outside = line.difference(parent_geometry).length if parent_geometry is not None else 0
            if uncovered > BARRIER_EPS or outside > BARRIER_EPS:
                error('barrier_unsnapped', c, barrier_id,
                      f'人工隔墙未完全落在公共边界（未覆盖长度 {uncovered:.6f} px）',
                      barrierId=barrier_id, uncoveredLengthPx=uncovered, outsideLengthPx=outside)
            if not _pairs_equal(c.get('matched_pairs'), actual):
                error('barrier_stale', c, barrier_id, '人工隔墙保存的匹配家具对已过期',
                      barrierId=barrier_id, matchedPairs=actual)
    for parent_id in parent_map:
        children = [(c, g) for c, g in logical if c.get('parent_zone_id') == parent_id]
        for i, (c, a) in enumerate(children):
            for other, b in children[i + 1:]:
                if partial and (c.get('generation') == 'remainder' or other.get('generation') == 'remainder'):
                    continue
                overlap_area = a.intersection(b).area
                if overlap_area > VALIDATION_EPS_AREA:
                    related_id = other.get('logical_id')
                    error('overlap', c, c.get('logical_id'),
                          f'与 {related_id} 存在正面积重叠（重叠面积 {overlap_area:.6f} px²）',
                          overlapAreaPx=overlap_area, relatedObjectId=related_id)
        if not partial and parent_id in validation_parents:
            coverage_difference = union_all([g for _, g in children]).symmetric_difference(validation_parents[parent_id]).area
            if coverage_difference > VALIDATION_EPS_AREA:
                error('coverage', {'parent_zone_id': parent_id}, parent_id,
                      f'子区域并集未完整覆盖父区域（差异面积 {coverage_difference:.6f} px²）',
                      coverageDifferencePx=coverage_difference)
    return list({(e['code'], e['parentId'], e['objectId']): e for e in errors}.values())
