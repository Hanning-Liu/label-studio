"""Lossless L4 geometry handling and cross-client fingerprint primitives.

Stored Label Studio results are never repaired, simplified, buffered, or
rewritten here.  Canonicalization is used only as input to fingerprints.
"""

import json
import math

from shapely import union_all
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from tasks.occupancy.geometry import (
    EPS_AREA,
    VALIDATION_PIXEL_EPS,
    canonical,
    fingerprint,
    result_geometry,
    validation_shape,
)

GEOMETRY_CONTROLS = {'furniture_instance_rectangle', 'furniture_instance_polygon'}
CATEGORY_CONTROL = 'furniture_instance_type'
FRONT_DIRECTION_CONTROL = 'furniture_front_direction'
FRONT_EDGE_CONTROL = 'furniture_front_edge'
ORIENTATION_CONTROLS = {FRONT_DIRECTION_CONTROL, FRONT_EDGE_CONTROL}
MANUAL_CONTROLS = GEOMETRY_CONTROLS | {CATEGORY_CONTROL} | ORIENTATION_CONTROLS

VECTOR_LENGTH_EPS = 1e-7
BOUNDARY_LENGTH_EPS_PX = 1e-5


def _finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _rounded_coordinate(value):
    if not _finite_number(value):
        raise ValueError('几何包含非有限坐标')
    rounded = float(format(value, '.10f'))
    return 0.0 if rounded == 0 else rounded


def _ring_area(points):
    return sum(
        left[0] * right[1] - right[0] * left[1]
        for left, right in zip(points, points[1:] + points[:1])
    ) / 2


def canonical_ring(coordinates, *, counterclockwise):
    """Canonicalize a ring for hashing without changing stored geometry."""
    points = [(_rounded_coordinate(point[0]), _rounded_coordinate(point[1])) for point in coordinates]
    if len(points) > 1 and points[0] == points[-1]:
        points.pop()
    if len(points) < 3 or len(set(points)) < 3:
        raise ValueError('轮廓环至少需要三个不同点')
    area = _ring_area(points)
    if abs(area) <= EPS_AREA:
        raise ValueError('轮廓环面积为零')
    if (area > 0) != counterclockwise:
        points.reverse()
    start = min(range(len(points)), key=lambda index: points[index])
    points = points[start:] + points[:start]
    points.append(points[0])
    return [[x, y] for x, y in points]


def _sort_key(value):
    return json.dumps(canonical(value), ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def _canonical_polygon(polygon):
    rings = [canonical_ring(polygon.exterior.coords, counterclockwise=True)]
    holes = [canonical_ring(ring.coords, counterclockwise=False) for ring in polygon.interiors]
    rings.extend(sorted(holes, key=_sort_key))
    return rings


def canonicalize_parent_geometry(geometry):
    """Return order/winding-independent GeoJSON used only for hashing.

    All Polygon/MultiPolygon components and all holes are retained.  Collinear
    points are intentionally retained as part of the agreed frontend/backend
    contract.
    """
    if geometry.is_empty or not geometry.is_valid:
        raise ValueError('父家具组团几何为空或无效')
    if isinstance(geometry, Polygon):
        return {'type': 'Polygon', 'coordinates': _canonical_polygon(geometry)}
    if isinstance(geometry, MultiPolygon):
        polygons = sorted((_canonical_polygon(part) for part in geometry.geoms), key=_sort_key)
        if len(polygons) == 1:
            return {'type': 'Polygon', 'coordinates': polygons[0]}
        return {'type': 'MultiPolygon', 'coordinates': polygons}
    raise ValueError('父家具组团并集必须是 Polygon 或 MultiPolygon')


def parent_fingerprint_payload(group, geometry):
    """Exact minimal L1 -> L2 -> L3 parent-chain payload."""
    return {
        'schema_version': 1,
        'room_id': group['room_id'],
        'zone_id': group['zone_id'],
        'group_id': group['group_id'],
        'group_type': group['group_type'],
        'group_note': group.get('group_note') or '',
        'zone_parent_fingerprint': group['zone_parent_fingerprint'],
        'geometry': canonicalize_parent_geometry(geometry),
    }


def parent_fingerprint(group, geometry):
    return fingerprint(parent_fingerprint_payload(group, geometry))


def union_result_geometry(results, *, reject_overlap=True):
    """Build a logical Polygon/MultiPolygon while retaining every component/hole."""
    if not results:
        raise ValueError('家具实例缺少几何')
    shapes = [result_geometry(result) for result in results]
    if reject_overlap:
        for index, shape in enumerate(shapes):
            if any(shape.intersection(other).area > EPS_AREA for other in shapes[index + 1 :]):
                raise ValueError('同一逻辑对象的几何分块存在正面积重叠')
    geometry = union_all(shapes)
    if geometry.is_empty or not geometry.is_valid or not isinstance(geometry, (Polygon, MultiPolygon)):
        raise ValueError('逻辑对象并集必须是有效 Polygon 或 MultiPolygon')
    return geometry


def validation_union_geometry(results, *, reject_overlap=True):
    """Return the validation-only logical geometry in source-image pixels."""
    geometry = union_result_geometry(results, reject_overlap=reject_overlap)
    widths = {result.get('original_width') for result in results}
    heights = {result.get('original_height') for result in results}
    if len(widths) != 1 or len(heights) != 1:
        raise ValueError('同一逻辑对象的原图尺寸不一致')
    return validation_shape(geometry, widths.pop(), heights.pop())


def _vector_vertices(result, expected_label):
    value = result.get('value', {})
    vertices = value.get('vertices')
    if (
        result.get('type') != 'vectorlabels'
        or value.get('closed') is not False
        or value.get('vectorlabels') != [expected_label]
        or not isinstance(vertices, list)
        or len(vertices) != 2
    ):
        raise ValueError(f'{expected_label} 必须是开放的两点 Vector')
    points = []
    for vertex in vertices:
        if (
            not isinstance(vertex, dict)
            or vertex.get('isBezier')
            or not _finite_number(vertex.get('x'))
            or not _finite_number(vertex.get('y'))
            or not 0 <= vertex['x'] <= 100
            or not 0 <= vertex['y'] <= 100
        ):
            raise ValueError(f'{expected_label} 必须只含两个有限直线端点')
        points.append((0.0 if vertex['x'] == 0 else vertex['x'], 0.0 if vertex['y'] == 0 else vertex['y']))
    if math.dist(*points) <= VECTOR_LENGTH_EPS:
        raise ValueError(f'{expected_label} 向量长度必须大于零')
    return points


def vector_vertices(result, expected_label):
    """Public parser used by submission validation and aggregation."""
    return _vector_vertices(result, expected_label)


def validation_vector(result, expected_label):
    """Return an orientation evidence line in source-image pixels."""
    width, height = result.get('original_width'), result.get('original_height')
    if not (_finite_number(width) and _finite_number(height) and width > 0 and height > 0):
        raise ValueError(f'{expected_label} 缺少有效原图尺寸')

    def pixel(value):
        integer = round(value)
        return integer if abs(value - integer) <= VALIDATION_PIXEL_EPS else value

    points = _vector_vertices(result, expected_label)
    return LineString([(pixel(x * width / 100), pixel(y * height / 100)) for x, y in points])


def direction_orientation(result, geometry):
    start, end = _vector_vertices(result, 'front_direction')
    if not geometry.covers(Point(start)):
        raise ValueError('front_direction 起点必须位于家具实例内部或边界')
    dx, dy = end[0] - start[0], end[1] - start[1]
    length = math.hypot(dx, dy)
    return {
        'status': 'front_direction',
        'origin': {'x': start[0], 'y': start[1]},
        'direction_vector': {'dx': dx / length, 'dy': dy / length},
    }


def _edge_outward_normal(start, end, geometry):
    dx, dy = end[0] - start[0], end[1] - start[1]
    length = math.hypot(dx, dy)
    left = (-dy / length, dx / length)
    right = (dy / length, -dx / length)
    midpoint = ((start[0] + end[0]) / 2, (start[1] + end[1]) / 2)
    for step in (1e-7, 1e-6, 1e-5, 1e-4, 1e-3):
        left_point = Point(midpoint[0] + left[0] * step, midpoint[1] + left[1] * step)
        right_point = Point(midpoint[0] + right[0] * step, midpoint[1] + right[1] * step)
        left_inside, right_inside = geometry.contains(left_point), geometry.contains(right_point)
        if left_inside != right_inside:
            normal = right if left_inside else left
            return {'dx': normal[0], 'dy': normal[1]}
    raise ValueError('front_edge 无法从实例边界确定外法向')


def edge_orientation(result, geometry):
    start, end = _vector_vertices(result, 'front_edge')
    edge = validation_vector(result, 'front_edge')
    boundary = validation_shape(geometry, result.get('original_width'), result.get('original_height')).boundary
    if edge.difference(boundary).length > BOUNDARY_LENGTH_EPS_PX:
        raise ValueError('front_edge 必须完整位于家具实例精确边界')
    return {
        'status': 'front_edge',
        'start': {'x': start[0], 'y': start[1]},
        'end': {'x': end[0], 'y': end[1]},
        'outward_normal': _edge_outward_normal(start, end, geometry),
    }


def orientation_from_results(direction_results, edge_results, geometry):
    if direction_results and edge_results:
        raise ValueError('同一家具实例不能同时保存 front_direction 和 front_edge')
    if len(direction_results) > 1 or len(edge_results) > 1:
        raise ValueError('同一家具实例只能保存一条朝向证据')
    if direction_results:
        return direction_orientation(direction_results[0], geometry)
    if edge_results:
        return edge_orientation(edge_results[0], geometry)
    return {'status': 'unknown'}


def review_fingerprint_payload(instance, geometry, orientation):
    return {
        'schema_version': 1,
        'instance_id': instance['instance_id'],
        'instance_type': instance['instance_type'],
        'note': instance.get('note') or '',
        'parent': {
            'room_id': instance['room_id'],
            'zone_id': instance['zone_id'],
            'group_id': instance['group_id'],
        },
        'source_version': instance['source_version'],
        'parent_fingerprint': instance['parent_fingerprint'],
        'geometry': canonicalize_parent_geometry(geometry),
        'orientation': orientation,
    }


def review_fingerprint(instance, geometry, orientation):
    return fingerprint(review_fingerprint_payload(instance, geometry, orientation))
