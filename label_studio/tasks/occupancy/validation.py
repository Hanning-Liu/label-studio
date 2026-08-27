from collections import defaultdict
from shapely import union_all
from .geometry import EPS_AREA, fingerprint, result_geometry

GEOMETRY = {'occupancy_rectangle', 'occupancy_polygon'}
PARENTS = {'zone_rectangle', 'zone_polygon'}
REFERENCES = {'room_rectangle', 'room_polygon', 'portal_rectangle', 'portal_vector',
              'zone_rectangle', 'zone_polygon', 'function_zone', 'connection_vector',
              'visual_connection_vector', 'connection_review', 'visual_connection_review'}
TYPES = {'furniture_group', 'walkable', 'restricted_free', 'unclassified'}
GROUP_TYPES = {'sleeping', 'study_work', 'dining', 'living_social', 'storage', 'dressing_grooming',
               'cooking_preparation', 'washbasin', 'toilet', 'shower_fixtures', 'bathtub',
               'laundry_drying', 'equipment_service', 'other'}


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


def content_fingerprint(results, parent_id, remainder=False):
    parent = next((r for r in results if r.get('from_name') in PARENTS and r['id'] == parent_id), None)
    values = [semantic(r, results) for r in results if r.get('from_name') in GEOMETRY and context(r).get('parent_zone_id') == parent_id
              and (not remainder or context(r).get('generation') != 'remainder')]
    return fingerprint({'parent': source_fingerprint(parent, results) if parent else None,
                        'regions': sorted(values, key=lambda r: r['id'])})


def validate(results, source_version, *, partial=False, review=True):
    """Returns actionable errors; drafts are intentionally not subjected to this gate."""
    errors, parent_map, parsed = [], {}, {}

    def error(code, c, object_id, message):
        parent_id = c.get('parent_zone_id')
        parent = parent_map.get(parent_id)
        label = label_of(results, parent_id, 'function_zone') if parent else '父分区缺失'
        errors.append({'code': code, 'parentId': parent_id, 'objectId': object_id,
                       'message': f'{label} · {parent_id}: {message}'})

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
        if r['id'] in parsed and parent['id'] in parsed and parsed[r['id']].difference(parsed[parent['id']]).area > EPS_AREA:
            error('outside', c, r['id'], '超出父功能分区')
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
            if any(a.intersection(b).area > EPS_AREA for b in shapes[i + 1:]):
                error('parts_overlap', c, logical_id, '分块未归并为互不重叠的并集')
        logical.append((c, union_all(shapes)))
    for parent_id in parent_map:
        children = [(c, g) for c, g in logical if c.get('parent_zone_id') == parent_id]
        for i, (c, a) in enumerate(children):
            for other, b in children[i + 1:]:
                if partial and (c.get('generation') == 'remainder' or other.get('generation') == 'remainder'):
                    continue
                if a.intersection(b).area > EPS_AREA:
                    error('overlap', c, c.get('logical_id'), f"与 {other.get('logical_id')} 存在正面积重叠")
        if not partial and parent_id in parsed and union_all([g for _, g in children]).symmetric_difference(parsed[parent_id]).area > EPS_AREA:
            error('coverage', {'parent_zone_id': parent_id}, parent_id, '子区域并集未完整覆盖父区域')
    return list({(e['code'], e['parentId'], e['objectId']): e for e in errors}.values())
