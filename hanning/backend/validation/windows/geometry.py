"""Geometry and deterministic fingerprint primitives for room windows.

All computation uses original-image pixels.  The Label Studio ``value`` is
only read and copied into fingerprints/aggregate paths; it is never rewritten.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
from dataclasses import dataclass
from typing import Any

from shapely.geometry import GeometryCollection, LineString, MultiLineString, MultiPolygon, Point, Polygon, shape


PARENT_ALGORITHM_VERSION = "window-parent-room/1"
PAIRING_ALGORITHM_VERSION = "window-pairing/1"
PROJECTION_ALGORITHM_VERSION = "window-projection/2"


def _canonical(value):
    if isinstance(value, dict):
        return {key: _canonical(value[key]) for key in sorted(value)}
    if isinstance(value, (list, tuple)):
        return [_canonical(item) for item in value]
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            raise ValueError("指纹输入包含非有限数字。")
        fixed = format(value, ".10f")
        return "0.0000000000" if fixed == "-0.0000000000" else fixed
    return value


def canonical_json(value) -> str:
    return json.dumps(_canonical(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def fingerprint(value) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def geometry_digest(results) -> str:
    """Digest every user-owned result field while excluding server metadata."""
    if not isinstance(results, list):
        raise ValueError("标注结果必须是列表。")
    keys = (
        "id", "from_name", "to_name", "type", "value", "original_width",
        "original_height", "image_rotation", "item_index",
    )
    return fingerprint([{key: copy.deepcopy(item[key]) for key in keys if key in item} for item in results])


def _number(value, field, result_id):
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"对象 {result_id} 的 {field} 不是数字。") from exc
    if not math.isfinite(number):
        raise ValueError(f"对象 {result_id} 的 {field} 不是有限数字。")
    return number


def dimensions(result):
    result_id = result.get("id")
    width = _number(result.get("original_width"), "original_width", result_id)
    height = _number(result.get("original_height"), "original_height", result_id)
    if width <= 0 or height <= 0:
        raise ValueError(f"对象 {result_id} 缺少有效原图尺寸。")
    return width, height


def percent_point(point, result, field="point"):
    if not isinstance(point, dict):
        raise ValueError(f"对象 {result.get('id')} 的 {field} 无效。")
    width, height = dimensions(result)
    return (
        _number(point.get("x"), f"{field}.x", result.get("id")) * width / 100,
        _number(point.get("y"), f"{field}.y", result.get("id")) * height / 100,
    )


def _room_points(result):
    value = result.get("value") if isinstance(result.get("value"), dict) else {}
    width, height = dimensions(result)
    if result.get("type") in {"rectangle", "rectanglelabels"}:
        x = _number(value.get("x"), "x", result.get("id"))
        y = _number(value.get("y"), "y", result.get("id"))
        w = _number(value.get("width"), "width", result.get("id"))
        h = _number(value.get("height"), "height", result.get("id"))
        rotation = math.radians(_number(value.get("rotation", 0), "rotation", result.get("id")))
        cosine, sine = math.cos(rotation), math.sin(rotation)
        # Label Studio rotates in image-pixel space while storing percentages;
        # the aspect-ratio factors preserve that geometry on non-square images.
        relative = [
            (x + dx * cosine - dy * height / width * sine,
             y + dx * width / height * sine + dy * cosine)
            for dx, dy in ((0, 0), (w, 0), (w, h), (0, h))
        ]
        return [(px * width / 100, py * height / 100) for px, py in relative]
    if result.get("type") in {"polygon", "polygonlabels"}:
        points = value.get("points")
        if not isinstance(points, list) or len(points) < 3:
            raise ValueError(f"房间 {result.get('id')} 的多边形点不足。")
        return [percent_point(point, result) if isinstance(point, dict) else (
            _number(point[0], "point.x", result.get("id")) * width / 100,
            _number(point[1], "point.y", result.get("id")) * height / 100,
        ) for point in points]
    raise ValueError(f"房间 {result.get('id')} 的几何类型不受支持。")


@dataclass(frozen=True)
class RoomGeometry:
    result_id: str
    surface_key: tuple[str | None, str]
    polygon: Polygon
    boundary_segments: tuple[tuple[tuple[float, float], tuple[float, float]], ...]
    segment_ids: tuple[str, ...]
    source_fingerprint: str


@dataclass(frozen=True)
class WindowTrace:
    result_id: str
    trace_id: str
    surface_key: tuple[str | None, str]
    source_result: dict[str, Any]
    raw_vertices: tuple[dict[str, Any], ...]
    path_kind: str
    points: tuple[tuple[float, float], ...]
    parameters: tuple[float, ...]
    line: LineString
    source_fingerprint: str
    parent_room_id: str | None = None
    room: RoomGeometry | None = None
    boundary_attachment: dict[str, Any] | None = None

    @property
    def bbox(self):
        return [round(value, 6) for value in self.line.bounds]


def room_fingerprint_input(result):
    width, height = dimensions(result)
    return {
        "id": stable_room_id(result),
        "type": result.get("type"),
        "value": copy.deepcopy(result.get("value")),
        "width": width,
        "height": height,
        "image_rotation": result.get("image_rotation") if result.get("image_rotation") is not None else 0,
        "room_graph_node": copy.deepcopy((result.get("meta") or {}).get("room_graph_node")),
    }


def stable_room_id(result):
    """Use the Room v3 semantic identity, falling back to the LS region ID."""
    meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
    node = meta.get("room_graph_node") if isinstance(meta.get("room_graph_node"), dict) else {}
    node_id = node.get("node_id")
    return node_id if isinstance(node_id, str) and node_id else result.get("id")


def result_surface_key(result):
    """Identify one Label Studio object/item surface without guessing geometry.

    ``item_index`` is absent for the common single-image case.  Canonical JSON
    keeps integers, strings, and an explicit null distinct enough for grouping
    while still accepting the serializer variants used by Label Studio.
    """
    item_index = result.get("item_index")
    # Match the editor's ``itemIndex ?? null`` rule exactly: missing and null
    # are the same default surface, while zero remains a real item index.
    return str(result.get("to_name") or ""), json.dumps(
        None if item_index is None else item_index,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def trace_fingerprint_input(result):
    width, height = dimensions(result)
    value = result.get("value") if isinstance(result.get("value"), dict) else {}
    return {
        "closed": False,
        "value": {"vertices": copy.deepcopy(value.get("vertices"))},
        "label": "window",
        "width": width,
        "height": height,
    }


def parse_room(result) -> RoomGeometry:
    result_id = stable_room_id(result)
    if not isinstance(result_id, str) or not result_id:
        raise ValueError("房间结果缺少稳定 ID。")
    points = _room_points(result)
    polygon = Polygon(points)
    if not polygon.is_valid or polygon.area <= 1e-9:
        raise ValueError(f"房间 {result_id} 的几何无效或自交。")
    coords = list(polygon.exterior.coords)[:-1]
    segments = tuple((coords[index], coords[(index + 1) % len(coords)]) for index in range(len(coords)))
    segment_ids = []
    for start, end in segments:
        ordered = sorted((tuple(round(v, 6) for v in start), tuple(round(v, 6) for v in end)))
        token = fingerprint({"room_id": result_id, "endpoints_px": ordered})[:16]
        segment_ids.append(f"room-segment:{result_id}:{token}")
    return RoomGeometry(
        result_id=result_id,
        surface_key=result_surface_key(result),
        polygon=polygon,
        boundary_segments=segments,
        segment_ids=tuple(segment_ids),
        source_fingerprint=fingerprint(room_fingerprint_input(result)),
    )


def _distance_point_line(point, start, end):
    dx, dy = end[0] - start[0], end[1] - start[1]
    length = math.hypot(dx, dy)
    if length <= 1e-12:
        return math.dist(point, start)
    return abs(dx * (start[1] - point[1]) - (start[0] - point[0]) * dy) / length


def _flatten_cubic(start, first, second, end, tolerance, depth=0):
    if depth >= 20 or max(_distance_point_line(first, start, end), _distance_point_line(second, start, end)) <= tolerance:
        return [start, end]
    a = ((start[0] + first[0]) / 2, (start[1] + first[1]) / 2)
    b = ((first[0] + second[0]) / 2, (first[1] + second[1]) / 2)
    c = ((second[0] + end[0]) / 2, (second[1] + end[1]) / 2)
    d = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    e = ((b[0] + c[0]) / 2, (b[1] + c[1]) / 2)
    middle = ((d[0] + e[0]) / 2, (d[1] + e[1]) / 2)
    left = _flatten_cubic(start, a, d, middle, tolerance, depth + 1)
    right = _flatten_cubic(middle, e, c, end, tolerance, depth + 1)
    return left[:-1] + right


def _ordered_vertices(vertices, result_id):
    identifiers = [vertex.get("id") for vertex in vertices]
    if any(not isinstance(identifier, str) or not identifier for identifier in identifiers):
        raise ValueError(f"窗线 {result_id} 的每个顶点必须有稳定 ID。")
    if len(set(identifiers)) != len(identifiers):
        raise ValueError(f"窗线 {result_id} 的顶点 ID 重复。")
    by_id = dict(zip(identifiers, vertices))
    children = {identifier: [] for identifier in identifiers}
    roots = []
    for vertex in vertices:
        previous = vertex.get("prevPointId")
        if previous in (None, ""):
            roots.append(vertex)
        elif previous not in by_id:
            raise ValueError(f"窗线 {result_id} 的 prevPointId {previous} 不存在。")
        else:
            children[previous].append(vertex)
    if len(roots) != 1 or any(len(items) > 1 for items in children.values()):
        raise ValueError(f"窗线 {result_id} 必须是一条不分叉的开放路径。")
    ordered, current, seen = [], roots[0], set()
    while current is not None:
        if current["id"] in seen:
            raise ValueError(f"窗线 {result_id} 的顶点连接形成环。")
        seen.add(current["id"])
        ordered.append(current)
        following = children[current["id"]]
        current = following[0] if following else None
    if len(ordered) != len(vertices):
        raise ValueError(f"窗线 {result_id} 包含不相连的顶点。")
    return ordered


def _control(vertex, key, result):
    control = vertex.get(key)
    return percent_point(control, result, key) if isinstance(control, dict) else None


def _validate_percentage_point(point, field, result_id):
    if not isinstance(point, dict):
        raise ValueError(f"窗线 {result_id} 的 {field} 无效。")
    for axis in ("x", "y"):
        number = _number(point.get(axis), f"{field}.{axis}", result_id)
        if number < 0 or number > 100:
            raise ValueError(f"窗线 {result_id} 的 {field}.{axis} 必须介于 0 和 100。")


def parse_window(result, flattening_tolerance_px=0.5) -> WindowTrace:
    result_id = result.get("id")
    if not isinstance(flattening_tolerance_px, (int, float)) or not math.isfinite(flattening_tolerance_px) or flattening_tolerance_px <= 0:
        raise ValueError("windowFlatteningTolerancePx 必须是正有限数字。")
    if not isinstance(result_id, str) or not result_id:
        raise ValueError("窗线结果缺少稳定 ID。")
    if result.get("type") != "vectorlabels":
        raise ValueError(f"窗线 {result_id} 必须是 VectorLabels 结果（type=vectorlabels）。")
    value = result.get("value") if isinstance(result.get("value"), dict) else {}
    if value.get("closed") is not False:
        raise ValueError(f"窗线 {result_id} 必须是开放 Vector（closed=false）。")
    labels = value.get("vectorlabels")
    if not isinstance(labels, list) or len(labels) != 1 or str(labels[0]).strip().lower() != "window":
        raise ValueError(f"窗线 {result_id} 必须且只能使用 Window 标签。")
    vertices = value.get("vertices")
    if not isinstance(vertices, list) or len(vertices) < 2 or any(not isinstance(item, dict) for item in vertices):
        raise ValueError(f"窗线 {result_id} 至少需要两个顶点。")
    for vertex in vertices:
        _validate_percentage_point(vertex, "vertex", result_id)
        if not isinstance(vertex.get("isBezier"), bool):
            raise ValueError(f"窗线 {result_id} 的每个顶点必须包含布尔 isBezier。")
        if vertex.get("disconnected") is True or vertex.get("isBranching") is True:
            raise ValueError(f"窗线 {result_id} 不允许 disconnected 或 branching 顶点。")
        if vertex["isBezier"] and not all(isinstance(vertex.get(key), dict) for key in ("controlPoint1", "controlPoint2")):
            raise ValueError(f"窗线 {result_id} 的 Bezier 顶点必须同时包含 controlPoint1 和 controlPoint2。")
        # The public Vector vertex schema constrains every supplied control
        # point, including legacy straight vertices that still carry handles.
        # Bezier vertices additionally require the complete pair above.
        for key in ("controlPoint1", "controlPoint2"):
            if key in vertex:
                _validate_percentage_point(vertex[key], key, result_id)
                _control(vertex, key, result)
    ordered = _ordered_vertices(vertices, result_id)
    points = []
    has_bezier = False
    for index in range(len(ordered) - 1):
        first, second = ordered[index], ordered[index + 1]
        start, end = percent_point(first, result), percent_point(second, result)
        if math.dist(start, end) <= 1e-9:
            raise ValueError(f"窗线 {result_id} 包含零长度线段。")
        first_cp = _control(first, "controlPoint2", result) if first.get("isBezier") is True else None
        second_cp = _control(second, "controlPoint1", result) if second.get("isBezier") is True else None
        if first_cp is not None or second_cp is not None:
            has_bezier = True
            dx, dy = end[0] - start[0], end[1] - start[1]
            first_cp = first_cp or (start[0] + dx * 0.3, start[1] + dy * 0.3)
            second_cp = second_cp or (end[0] - dx * 0.3, end[1] - dy * 0.3)
            segment = _flatten_cubic(start, first_cp, second_cp, end, flattening_tolerance_px)
        else:
            segment = [start, end]
        points.extend(segment if not points else segment[1:])
    line = LineString(points)
    if not line.is_simple or line.length <= 1e-9:
        raise ValueError(f"窗线 {result_id} 必须是正长度且不自交的开放路径。")
    cumulative = [0.0]
    for first, second in zip(points, points[1:]):
        cumulative.append(cumulative[-1] + math.dist(first, second))
    parameters = tuple(value / cumulative[-1] for value in cumulative)
    path_kind = "bezier" if has_bezier else ("line" if len(ordered) == 2 else "polyline")
    return WindowTrace(
        result_id=result_id,
        trace_id=f"window-trace:{result_id}",
        surface_key=result_surface_key(result),
        source_result=result,
        raw_vertices=tuple(copy.deepcopy(ordered)),
        path_kind=path_kind,
        points=tuple(points),
        parameters=parameters,
        line=line,
        source_fingerprint=fingerprint(trace_fingerprint_input(result)),
    )


def angle_delta_deg(first, second):
    first_angle = math.atan2(first[1], first[0])
    second_angle = math.atan2(second[1], second[0])
    difference = abs(math.degrees(first_angle - second_angle)) % 180
    return min(difference, 180 - difference)


def _line_parts(geometry):
    if geometry.is_empty:
        return []
    if isinstance(geometry, LineString):
        return [geometry]
    if isinstance(geometry, (MultiLineString, GeometryCollection)):
        return [part for item in geometry.geoms for part in _line_parts(item)]
    return []


def merge_intervals(intervals, epsilon=1e-9):
    merged = []
    for start, end in sorted((max(0.0, min(a, b)), min(1.0, max(a, b))) for a, b in intervals if abs(b - a) > epsilon):
        if merged and start <= merged[-1][1] + epsilon:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def boundary_attachment(trace: WindowTrace, room: RoomGeometry, tolerance, maximum_tangent_delta_deg):
    intervals, touched = [], set()
    total = trace.line.length
    for index, (start, end) in enumerate(zip(trace.points, trace.points[1:])):
        segment = LineString((start, end))
        segment_length = segment.length
        if segment_length <= 1e-12:
            continue
        tangent = (end[0] - start[0], end[1] - start[1])
        offset = trace.parameters[index]
        span = trace.parameters[index + 1] - offset
        for boundary_index, (first, second) in enumerate(room.boundary_segments):
            if angle_delta_deg(tangent, (second[0] - first[0], second[1] - first[1])) > maximum_tangent_delta_deg:
                continue
            clipped = segment.intersection(LineString((first, second)).buffer(tolerance, cap_style=2))
            for part in _line_parts(clipped):
                if part.length <= 1e-9:
                    continue
                values = [segment.project(Point(point)) / segment_length for point in part.coords]
                intervals.append((offset + min(values) * span, offset + max(values) * span))
                touched.add(boundary_index)
    merged = merge_intervals(intervals)
    overlap = sum((end - start) * total for start, end in merged)
    uncovered = max(0.0, total - overlap)
    if overlap <= 1e-9 or uncovered > max(1e-6, tolerance * 0.01):
        return None
    return {
        "match_rule": "full_positive_length_room_boundary_overlap",
        "path_length_px": total,
        "overlap_length_px": overlap,
        "room_boundary_segment_ids": [room.segment_ids[index] for index in sorted(touched)],
    }


def attach_parent(trace, room, attachment):
    return WindowTrace(
        **{
            **trace.__dict__,
            "parent_room_id": room.result_id,
            "room": room,
            "boundary_attachment": attachment,
        }
    )


def inward_normal(room: RoomGeometry, start, end):
    dx, dy = end[0] - start[0], end[1] - start[1]
    length = math.hypot(dx, dy)
    if length <= 1e-12:
        return (0.0, 0.0)
    left = (-dy / length, dx / length)
    midpoint = ((start[0] + end[0]) / 2, (start[1] + end[1]) / 2)
    probe = max(0.01, min(1.0, length * 0.01))
    left_inside = room.polygon.contains(Point(midpoint[0] + left[0] * probe, midpoint[1] + left[1] * probe))
    right = (-left[0], -left[1])
    right_inside = room.polygon.contains(Point(midpoint[0] + right[0] * probe, midpoint[1] + right[1] * probe))
    if left_inside != right_inside:
        return left if left_inside else right
    representative = room.polygon.representative_point()
    toward = (representative.x - midpoint[0], representative.y - midpoint[1])
    return left if left[0] * toward[0] + left[1] * toward[1] >= 0 else right


def _custom_ring(ring, width, height):
    if not isinstance(ring, (list, tuple)):
        raise ValueError("投影目标的 ring 无效。")
    points = []
    for point in ring:
        if isinstance(point, dict):
            x, y = _number(point.get("x"), "geometry.x", "projection-target"), _number(point.get("y"), "geometry.y", "projection-target")
            points.append((x * width / 100, y * height / 100) if width and height else (x, y))
        elif isinstance(point, (list, tuple)) and len(point) == 2:
            points.append((float(point[0]), float(point[1])))
        else:
            raise ValueError("投影目标的坐标点无效。")
    return points


def _custom_geometry(geometry, width=None, height=None):
    coordinates = geometry.get("coordinates")
    if geometry.get("type") == "Polygon":
        if not coordinates:
            raise ValueError("投影目标 Polygon 没有 coordinates。")
        return Polygon(
            _custom_ring(coordinates[0], width, height),
            [_custom_ring(ring, width, height) for ring in coordinates[1:]],
        )
    if geometry.get("type") == "MultiPolygon":
        if not coordinates:
            raise ValueError("投影目标 MultiPolygon 没有 coordinates。")
        return MultiPolygon([
            Polygon(
                _custom_ring(polygon[0], width, height),
                [_custom_ring(ring, width, height) for ring in polygon[1:]],
            )
            for polygon in coordinates
        ])
    raise ValueError("投影目标必须是 Polygon/MultiPolygon。")


def polygon_from_target(value):
    """Accept Shapely, GeoJSON/custom Polygon/MultiPolygon (with holes), or LS result."""
    if isinstance(value, (Polygon, MultiPolygon)):
        return value
    if isinstance(value, dict) and "geometry" in value:
        geometry = value["geometry"]
        if isinstance(geometry, (Polygon, MultiPolygon)):
            return geometry
        if not isinstance(geometry, dict):
            raise ValueError("投影目标 geometry 无效。")
        coordinates = geometry.get("coordinates")
        first = coordinates
        while isinstance(first, (list, tuple)) and first:
            first = first[0]
        if isinstance(first, dict):
            width = value.get("original_width") or value.get("width")
            height = value.get("original_height") or value.get("height")
            if width is not None or height is not None:
                width = _number(width, "width", "projection-target")
                height = _number(height, "height", "projection-target")
                if width <= 0 or height <= 0:
                    raise ValueError("投影目标 width/height 必须为正数。")
            return _custom_geometry(geometry, width, height)
        return shape(geometry)
    if isinstance(value, dict) and value.get("type") in {"Polygon", "MultiPolygon"} and "coordinates" in value:
        coordinates = value.get("coordinates")
        first = coordinates
        while isinstance(first, (list, tuple)) and first:
            first = first[0]
        return _custom_geometry(value) if isinstance(first, dict) else shape(value)
    if isinstance(value, dict) and value.get("value") is not None:
        return parse_room({**value, "id": value.get("id") or "projection-target"}).polygon
    raise ValueError("投影目标必须提供 Polygon/MultiPolygon 几何。")
