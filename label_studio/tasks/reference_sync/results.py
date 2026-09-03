"""Pure reference validation and non-destructive result merging."""
import copy
import hashlib
import json
import math
import xml.etree.ElementTree as ET

from .geometry import collinear_overlap, point_in_polygon, point_on_segment, result_polygon, result_segment

ROOMS = {'room_rectangle', 'room_polygon'}
PORTALS = {'portal_rectangle', 'portal_vector'}
REFERENCES = ROOMS | PORTALS
ZONES = {'zone_rectangle', 'zone_polygon'}
VECTORS = {'connection_vector', 'visual_connection_vector'}
DERIVED_META = {'partition_context', 'reference_review', 'geometry_review'}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def reference_results(results):
    return [r for r in results if r.get('from_name') in REFERENCES]


def normalized_refs(results):
    return sorted([{k: v for k, v in r.items() if k not in {
                       'origin', 'readonly', 'score', 'opacity', 'fillopacity', 'fillcolor',
                       'strokecolor', 'strokewidth', 'hidden', 'selected'}}
                   for r in reference_results(results)], key=lambda r: (r.get('id', ''), r['from_name']))


def reference_hash(results):
    return digest(normalized_refs(results))


def manual_payload(results):
    """Content protected by optimistic locking; exclude only server-derived data.

    Parent assignment, geometry, labels, Relations, and explicit user reviews
    remain protected. A reference-only sync must not change this fingerprint.
    """
    output = []
    for r in results:
        if r.get('from_name') in REFERENCES:
            continue
        item = copy.deepcopy(r)
        item.pop('origin', None)
        item.pop('readonly', None)
        meta = item.get('meta', {})
        parent = meta.get('partition_context', {}).get('parent_room_id')
        for key in DERIVED_META:
            meta.pop(key, None)
        if parent is not None:
            meta['partition_context'] = {'parent_room_id': parent}
        # The worker invalidates inherited confirmation without changing user content.
        if isinstance(meta.get('zone_inheritance'), dict):
            meta['zone_inheritance'].pop('review_status', None)
        if meta:
            item['meta'] = meta
        else:
            item.pop('meta', None)
        output.append(item)
    return sorted(output, key=lambda r: (r.get('id', ''), r.get('from_name', ''), digest(r)))


def manual_hash(results):
    return digest(manual_payload(results))


def region_hash(results, region_id):
    items = []
    for r in results:
        if r.get('id') == region_id and r.get('from_name') not in REFERENCES:
            item = {k: r[k] for k in ('id', 'from_name', 'to_name', 'type', 'value', 'original_width', 'original_height', 'image_rotation') if k in r}
            if r.get('from_name') in ZONES:
                item['parent_room_id'] = r.get('meta', {}).get('partition_context', {}).get('parent_room_id')
            items.append(item)
    return digest(sorted(items, key=lambda r: r.get('from_name', '')))


def edges(poly):
    return list(zip(poly, poly[1:] + poly[:1]))


def intersection_t(a, b, c, d):
    dx, dy = b[0]-a[0], b[1]-a[1]
    ex, ey = d[0]-c[0], d[1]-c[1]
    den = dx*ey-dy*ex
    if abs(den) < 1e-10:
        return None
    t = ((c[0]-a[0])*ey-(c[1]-a[1])*ex)/den
    u = ((c[0]-a[0])*dy-(c[1]-a[1])*dx)/den
    return t if -1e-9 <= t <= 1+1e-9 and -1e-9 <= u <= 1+1e-9 else None


def valid_polygon(poly):
    if not poly or len(poly) < 3 or any(not math.isfinite(v) for p in poly for v in p):
        return False
    if abs(sum(a[0]*b[1]-b[0]*a[1] for a, b in edges(poly))) < 1e-9:
        return False
    es = edges(poly)
    for i, (a, b) in enumerate(es):
        if math.dist(a, b) < 1e-9:
            return False
        for j, (c, d) in enumerate(es):
            if j <= i+1 or (i == 0 and j == len(es)-1):
                continue
            if intersection_t(a, b, c, d) is not None or collinear_overlap((a,b),(c,d)):
                return False
    return True


def inside(poly, room):
    if not valid_polygon(poly) or not valid_polygon(room):
        return False
    for a, b in edges(poly):
        if not point_in_polygon(a, room):
            return False
        ts = [0., 1.]
        for c, d in edges(room):
            t = intersection_t(a,b,c,d)
            if t is not None:
                ts.append(max(0., min(1., t)))
        ts = sorted(set(ts))
        for lo, hi in zip(ts, ts[1:]):
            t = (lo+hi)/2
            if not point_in_polygon((a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1])), room):
                return False
    return True


def validate_source(results, target_config):
    refs = reference_results(results)
    if len({r.get('id') for r in refs}) != len(refs) or any(not r.get('id') for r in refs):
        raise ValueError('Room/Portal ID 缺失或重复')
    controls = {e.get('name'): e for e in ET.fromstring(target_config).iter() if e.get('name')}
    rooms = {}
    for r in refs:
        control = controls.get(r['from_name'])
        labels = r.get('value', {}).get(r.get('type'), [])
        if control is None or not labels or not set(labels) <= {e.get('value') for e in control if e.tag == 'Label'}:
            raise ValueError(f"目标配置不支持 {r['id']} 的控件或标签")
        if control.tag.lower() != r.get('type') or control.get('toName') != r.get('to_name'):
            raise ValueError(f"目标配置与 {r['id']} 的几何类型或图像控件不兼容")
        if r['from_name'] in ROOMS:
            poly = result_polygon(r)
            if not valid_polygon(poly) or r.get('meta', {}).get('room_graph_node', {}).get('schema_version') != 3:
                raise ValueError(f"房间 {r['id']} 的 v3 元数据或几何无效")
            rooms[r['id']] = poly
    if not rooms:
        raise ValueError('正式 Room 标注没有有效房间')
    for r in refs:
        if r['from_name'] not in PORTALS:
            continue
        edge = r.get('meta', {}).get('room_graph_edge', {})
        ids = edge.get('connected_room_ids') or edge.get('room_ids') or []
        if edge.get('schema_version') != 3 or len(set(ids)) != (1 if edge.get('connects_to_exterior') else 2) or not set(ids) <= rooms.keys():
            raise ValueError(f"Portal {r['id']} 的房间关联无效")
        if r['from_name'] == 'portal_vector':
            seg = result_segment(r)
            if not seg or math.dist(*seg) < 1e-8 or any(not math.isfinite(v) for p in seg for v in p):
                raise ValueError(f"Portal {r['id']} 的 Vector 几何无效")
        elif not valid_polygon(result_polygon(r)):
            raise ValueError(f"Portal {r['id']} 的 Rectangle 几何无效")
        for room_id in ids:
            segments = edge.get('boundary_segments', {}).get(room_id, [])
            if not segments:
                raise ValueError(f"Portal {r['id']} 缺少父房间接触边")
            for segment in segments:
                if not isinstance(segment, list) or len(segment) != 2:
                    raise ValueError('Portal 接触边格式无效')
                points = [(float(p['x']),float(p['y'])) for p in segment]
                if not any(all(point_on_segment(p,a,b,0.02) for p in points) for a,b in edges(rooms[room_id])):
                    raise ValueError(f"Portal {r['id']} 接触边不在房间边界")
                portal_edges = [result_segment(r)] if r['from_name'] == 'portal_vector' else edges(result_polygon(r))
                if not any(all(point_on_segment(p,*e,0.02) for p in points) for e in portal_edges):
                    raise ValueError(f"Portal {r['id']} 接触边与实际开口几何不一致")
    return [{**copy.deepcopy(r), 'readonly': True} for r in refs]


def openings(poly, room_id, refs):
    ids, connected = [], set()
    for r in refs:
        if r['from_name'] not in PORTALS:
            continue
        edge = r.get('meta', {}).get('room_graph_edge', {})
        segments = [tuple((float(p['x']), float(p['y'])) for p in seg)
                    for seg in edge.get('boundary_segments', {}).get(room_id, [])]
        if any(collinear_overlap(e,s) for e in edges(poly) for s in segments):
            ids.append(r['id'])
            connected.update(str(i) for i in (edge.get('connected_room_ids') or edge.get('room_ids') or []) if i != room_id)
            if edge.get('connects_to_exterior'):
                connected.add('Exterior')
    return sorted(ids), sorted(connected)


def diff_refs(old, new):
    a = {r['id']:r for r in normalized_refs(old)}
    b = {r['id']:r for r in normalized_refs(new)}
    changed = {key for key in a.keys() | b.keys() if a.get(key) != b.get(key)}
    affected = set()
    references = []
    for key in changed:
        reference_types = set()
        affected_for_reference = set()
        for r in (a.get(key), b.get(key)):
            if not r:
                continue
            if r['from_name'] in ROOMS:
                reference_types.add('room')
                affected.add(key)
                affected_for_reference.add(key)
            else:
                reference_types.add('portal')
                edge = r.get('meta', {}).get('room_graph_edge', {})
                room_ids = edge.get('connected_room_ids') or edge.get('room_ids') or []
                affected.update(room_ids)
                affected_for_reference.update(room_ids)
        references.append({
            'id': key,
            'types': sorted(reference_types),
            'affected_room_ids': sorted(affected_for_reference),
        })
    return {'added': sorted(b.keys()-a.keys()), 'deleted': sorted(a.keys()-b.keys()),
            'changed': sorted(changed & a.keys() & b.keys()), 'affected_rooms': sorted(affected),
            'references': sorted(references, key=lambda item: item['id'])}


def _segment_touches_polygon(segment, polygon):
    return segment and polygon and (
        any(point_in_polygon(point, polygon) for point in segment)
        or any(intersection_t(*segment, *edge) is not None for edge in edges(polygon))
    )


def reference_review_context(result, difference, room_results):
    """Return the exact upstream reference kinds relevant to one review row."""
    affected = set(difference.get('affected_rooms', []))
    control = result.get('from_name')
    if control in ZONES:
        parent = result.get('meta', {}).get('partition_context', {}).get('parent_room_id')
        touched = {parent} if parent in affected else set()
    elif control in VECTORS:
        segment = result_segment(result)
        touched = {
            room_id for room_id in affected
            if any(
                room.get('id') == room_id and _segment_touches_polygon(segment, result_polygon(room))
                for room in room_results
            )
        }
    else:
        touched = set()
    relevant = [
        change for change in difference.get('references', [])
        if touched.intersection(change.get('affected_room_ids', []))
    ]
    return {
        'changed_reference_ids': sorted({change['id'] for change in relevant}),
        'changed_reference_types': sorted({kind for change in relevant for kind in change.get('types', [])}),
        'affected_room_ids': sorted(touched),
    }


def merge_results(results, refs, revision, *, prior=None):
    """Never replace user geometry, IDs, labels, assignments, or Relations."""
    # A regular draft/annotation save must compare the server-owned previous
    # references with the authoritative references. Browser serialization can
    # legitimately normalize readonly objects and must not re-issue reviews.
    # The synchronization worker has no ``prior`` and still compares the old
    # copied references in ``results`` with the new authoritative set.
    prior = results if prior is None else prior
    difference = diff_refs(prior, refs)
    affected = set(difference['affected_rooms'])
    rooms = {r['id']:result_polygon(r) for r in refs if r['from_name'] in ROOMS}
    all_room_results = [r for r in reference_results(prior)+refs if r['from_name'] in ROOMS]
    previous = {(r.get('id'),r.get('from_name')):r for r in prior}
    manual = copy.deepcopy([r for r in results if r.get('from_name') not in REFERENCES])
    for r in manual:
        control = r.get('from_name')
        if control not in ZONES | VECTORS:
            continue
        meta = r.setdefault('meta', {})
        old = previous.get((r.get('id'),control), {})
        # Review is server-owned; a client cannot clear a pending review by omitting metadata.
        review = copy.deepcopy(old.get('meta', {}).get('reference_review'))
        reason = None
        if control in ZONES:
            context = meta.setdefault('partition_context', {})
            parent = context.get('parent_room_id')
            poly = result_polygon(r)
            valid = parent in rooms and inside(poly, rooms[parent])
            opening_ids, connected = openings(poly,parent,refs) if valid else ([],[])
            context.update(schema_version=3, opening_ids=opening_ids, connected_room_ids=connected, requires_geometry_review=not valid)
            if 'portal_v3_source' in context:
                context['portal_v3_source']['source_result_ids'] = opening_ids
            if not valid:
                reason = 'source_missing' if parent not in rooms else 'outside_parent_room'
            elif parent in affected:
                reason = 'room_or_portal_changed'
            if reason and isinstance(meta.get('zone_inheritance'),dict):
                meta['zone_inheritance']['review_status'] = 'pending'
        else:
            seg = result_segment(r)
            if seg and any(room.get('id') in affected and _segment_touches_polygon(seg, result_polygon(room))
                           for room in all_room_results):
                reason = 'room_or_portal_changed'
        content_hash = region_hash(manual, r.get('id'))
        if reason:
            review = {'status':'pending','revision':revision,'reason':reason,'content_hash':content_hash}
            if reason == 'room_or_portal_changed':
                review.update(reference_review_context(r, difference, all_room_results))
        elif review:
            if review.get('revision') != revision:
                review['revision'] = revision
            if review.get('content_hash') != content_hash:
                review.update(status='pending',content_hash=content_hash,reason='geometry_or_label_changed')
                for key in ('changed_reference_ids','changed_reference_types','affected_room_ids'):
                    review.pop(key,None)
            if review.get('reason') in {'source_missing','outside_parent_room'} and control in ZONES:
                review['reason'] = 'geometry_corrected_needs_review'
        if review:
            meta['reference_review'] = review
        else:
            meta.pop('reference_review',None)
    return copy.deepcopy(refs)+manual


def pending_reviews(results, difference=None, room_results=None):
    output, seen = [], set()
    room_results = room_results or [r for r in reference_results(results) if r.get('from_name') in ROOMS]
    for r in results:
        review = r.get('meta',{}).get('reference_review',{})
        region_id = r.get('id')
        if review.get('status') != 'pending' or not region_id or region_id in seen:
            continue
        seen.add(region_id)
        item = {'id':region_id,'from_name':r.get('from_name'),'reason':review.get('reason')}
        context = {key: copy.deepcopy(review.get(key)) for key in (
            'changed_reference_ids', 'changed_reference_types', 'affected_room_ids'
        ) if review.get(key) is not None}
        if difference and not context.get('changed_reference_types'):
            context = reference_review_context(r, difference, room_results)
        item.update(context)
        output.append(item)
    return output


def validate_submission(results):
    pending = pending_reviews(results)
    if pending:
        raise ValueError(f"{len(pending)} 个区域需要复核 Room 参考变更")
    rooms = {r['id']:result_polygon(r) for r in results if r.get('from_name') in ROOMS}
    ids = {r.get('id') for r in results if r.get('id')}
    for r in results:
        if r.get('from_name') in ZONES:
            parent = r.get('meta',{}).get('partition_context',{}).get('parent_room_id')
            if parent not in rooms or not inside(result_polygon(r),rooms[parent]):
                raise ValueError(f"分区 {r.get('id')} 来源房间缺失或超出房间")
        if r.get('type') == 'relation' and (r.get('from_id') not in ids or r.get('to_id') not in ids):
            raise ValueError('手工 Relation 引用了已删除区域，请先处理')
