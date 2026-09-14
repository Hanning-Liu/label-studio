"""Authoritative Room v3 metadata derivation from saved Label Studio geometry.

The browser derives the same fields for immediate feedback, but persisted
``room_graph_node`` and ``room_graph_edge`` values are server-owned.  This
module deliberately never changes IDs, labels, geometry, or result ordering.
"""

from __future__ import annotations

import copy
import math
from typing import Any

from .geometry import (
    distance,
    json_points,
    point_in_polygon,
    polygon_boundary_overlaps,
    result_label,
    result_polygon,
    result_segment,
)
from .results import digest, edges, valid_polygon


ROOM_CONTROLS = {"room_rectangle", "room_polygon"}
PORTAL_CONTROLS = {"portal_rectangle", "portal_vector"}


class RoomV3MetadataError(ValueError):
    """Raised when current user geometry cannot produce valid Room v3 metadata."""

    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__("；".join(errors))


def _length(segment):
    return distance(*segment)


def _midpoint(first, second):
    return ((first[0] + second[0]) / 2, (first[1] + second[1]) / 2)


def _rectangle_portal_geometry(polygon, tolerance):
    if not isinstance(polygon, list) or len(polygon) != 4:
        return None
    polygon_edges = edges(polygon)
    lengths = [_length(segment) for segment in polygon_edges]
    first_pair = lengths[0] + lengths[2]
    second_pair = lengths[1] + lengths[3]
    long_indexes = [0, 2] if first_pair >= second_pair else [1, 3]
    short_indexes = [1, 3] if first_pair >= second_pair else [0, 2]
    clear_width = sum(lengths[index] for index in long_indexes) / 2
    depth = sum(lengths[index] for index in short_indexes) / 2
    if clear_width <= tolerance or depth <= tolerance:
        return None
    first_long = polygon_edges[long_indexes[0]]
    opposite_long = polygon_edges[long_indexes[1]]
    return {
        "long_edges": [polygon_edges[index] for index in long_indexes],
        "clear_width": clear_width,
        "depth": depth,
        "centerline": [
            _midpoint(first_long[0], opposite_long[1]),
            _midpoint(first_long[1], opposite_long[0]),
        ],
    }


def _orientation(first, second, third):
    return (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (
        third[0] - first[0]
    )


def _segments_properly_cross(first, second, tolerance):
    a, b = first
    c, d = second
    first_side = _orientation(a, b, c)
    second_side = _orientation(a, b, d)
    third_side = _orientation(c, d, a)
    fourth_side = _orientation(c, d, b)
    return (
        first_side * second_side < -(tolerance**2)
        and third_side * fourth_side < -(tolerance**2)
    )


def _positive_overlap(first, second, tolerance):
    if not valid_polygon(first) or not valid_polygon(second):
        return False
    if any(point_in_polygon(point, second, include_boundary=False) for point in first):
        return True
    if any(point_in_polygon(point, first, include_boundary=False) for point in second):
        return True
    for first_edge in edges(first):
        midpoint = _midpoint(*first_edge)
        if point_in_polygon(midpoint, second, include_boundary=False):
            return True
        if any(_segments_properly_cross(first_edge, second_edge, tolerance) for second_edge in edges(second)):
            return True
    if all(point_in_polygon(point, second, include_boundary=True) for point in first):
        return True
    if all(point_in_polygon(point, first, include_boundary=True) for point in second):
        return True
    return False


def _dimensions(result):
    width = float(result.get("original_width") or 100)
    height = float(result.get("original_height") or 100)
    if not math.isfinite(width) or not math.isfinite(height) or width <= 0 or height <= 0:
        raise RoomV3MetadataError([f"对象 {result.get('id')} 缺少有效原图尺寸。"])
    return width, height


def _to_pixels(point, result):
    width, height = _dimensions(result)
    return point[0] * width / 100, point[1] * height / 100


def _normalized_opening_type(value):
    return "_".join(str(value or "").strip().lower().split())


def _merge_meta(result, key, value):
    meta = copy.deepcopy(result.get("meta")) if isinstance(result.get("meta"), dict) else {}
    meta[key] = value
    result["meta"] = meta


def _metadata_equivalent(first, second, tolerance=1e-9):
    """Treat serialization-only float noise as unchanged metadata."""
    if isinstance(first, bool) or isinstance(second, bool):
        return first is second
    if isinstance(first, (int, float)) and isinstance(second, (int, float)):
        return math.isfinite(float(first)) and math.isfinite(float(second)) and math.isclose(
            float(first), float(second), rel_tol=tolerance, abs_tol=tolerance
        )
    if isinstance(first, dict) and isinstance(second, dict):
        return first.keys() == second.keys() and all(
            _metadata_equivalent(first[key], second[key], tolerance) for key in first
        )
    if isinstance(first, (list, tuple)) and isinstance(second, (list, tuple)):
        return len(first) == len(second) and all(
            _metadata_equivalent(a, b, tolerance) for a, b in zip(first, second)
        )
    return first == second


def geometry_digest(results):
    """Fingerprint user-owned content while excluding all metadata."""
    payload = []
    for result in results:
        payload.append(
            {
                key: copy.deepcopy(result[key])
                for key in (
                    "id",
                    "from_name",
                    "to_name",
                    "type",
                    "value",
                    "original_width",
                    "original_height",
                    "image_rotation",
                )
                if key in result
            }
        )
    return digest(payload)


def refresh_room_v3_metadata(results, tolerance=0.02):
    """Return a deep-copied result list with metadata derived from geometry.

    Raises ``RoomV3MetadataError`` when the geometry itself is invalid.  The
    caller can therefore reject a formal Update without touching the saved
    annotation while drafts remain available for incomplete work.
    """
    if not isinstance(results, list):
        raise RoomV3MetadataError(["标注结果必须是列表。"])
    refreshed = copy.deepcopy(results)
    rooms = []
    errors = []
    changed_rooms = []
    changed_portals = []

    for result in refreshed:
        if result.get("from_name") not in ROOM_CONTROLS:
            continue
        polygon = result_polygon(result)
        if not valid_polygon(polygon):
            errors.append(f"房间 {result.get('id')} 的几何无效或存在自交。")
            continue
        old = copy.deepcopy(result.get("meta", {}).get("room_graph_node"))
        node = {
            **(old or {}),
            "schema_version": 3,
            "node_id": result.get("id"),
            "room_type": result_label(result) or (old or {}).get("room_type") or "Unclear/other",
            "geometry_type": "rectangle" if result.get("from_name") == "room_rectangle" else "polygon",
        }
        _merge_meta(result, "room_graph_node", node)
        if old != node:
            changed_rooms.append(result.get("id"))
        rooms.append({"id": result.get("id"), "polygon": polygon})

    if not rooms and any(result.get("from_name") in PORTAL_CONTROLS for result in refreshed):
        errors.append("正式 Room 标注没有有效房间。")
    for index, first in enumerate(rooms):
        for second in rooms[index + 1 :]:
            if _positive_overlap(first["polygon"], second["polygon"], tolerance):
                errors.append(f"房间 {first['id']} 与 {second['id']} 发生面积重叠。")

    def analyze_contacts(segments):
        contacts = {}
        segment_rooms = [set() for _ in segments]
        for segment_index, segment in enumerate(segments):
            for room in rooms:
                overlaps = polygon_boundary_overlaps(room["polygon"], segment, tolerance)
                if not overlaps:
                    continue
                segment_rooms[segment_index].add(room["id"])
                contacts.setdefault(room["id"], []).extend(overlaps)
        return contacts, segment_rooms

    for result in refreshed:
        control = result.get("from_name")
        if control not in PORTAL_CONTROLS:
            continue
        portal_id = result.get("id")
        old_edge = copy.deepcopy(result.get("meta", {}).get("room_graph_edge"))
        opening_type = _normalized_opening_type(result_label(result) or (old_edge or {}).get("opening_type"))
        geometry_type = "rectangle" if control == "portal_rectangle" else "vector"
        connected_room_ids = []
        boundary_segments = {}
        clear_width_percent = depth_percent = clear_width_px = depth_px = 0
        centerline = []
        centerline_px = []

        if control == "portal_rectangle":
            polygon = result_polygon(result)
            geometry = _rectangle_portal_geometry(polygon, tolerance) if valid_polygon(polygon) else None
            if geometry is None:
                errors.append(f"Portal {portal_id} 的矩形几何无效。")
            else:
                contacts, segment_rooms = analyze_contacts(geometry["long_edges"])
                boundary_segments = contacts
                connected_room_ids = sorted(boundary_segments)
                occupied_long_edges = sum(bool(room_ids) for room_ids in segment_rooms)
                duplicated_room = any(sum(room_id in room_ids for room_ids in segment_rooms) > 1 for room_id in connected_room_ids)
                overlaps_room_interior = any(_positive_overlap(polygon, room["polygon"], tolerance) for room in rooms)
                if len(connected_room_ids) not in (1, 2):
                    errors.append(f"Portal {portal_id} 必须连接 1 个室内房间（入户）或 2 个室内房间。")
                if len(connected_room_ids) == 2 and occupied_long_edges != 2:
                    errors.append(f"Portal {portal_id} 的两条房间侧长边必须分别与两个房间共边。")
                if len(connected_room_ids) == 1 and occupied_long_edges != 1:
                    errors.append(f"入户 Portal {portal_id} 只能有一条房间侧长边与室内房间共边。")
                if duplicated_room:
                    errors.append(f"Portal {portal_id} 的两条长边不能同时连接同一房间。")
                if overlaps_room_interior:
                    errors.append(f"Portal {portal_id} 不得进入房间净空间内部。")
                clear_width_percent = geometry["clear_width"]
                depth_percent = geometry["depth"]
                centerline = geometry["centerline"]
                pixel_polygon = [_to_pixels(point, result) for point in polygon]
                pixel_geometry = _rectangle_portal_geometry(pixel_polygon, tolerance)
                if pixel_geometry:
                    clear_width_px = pixel_geometry["clear_width"]
                    depth_px = pixel_geometry["depth"]
                    centerline_px = pixel_geometry["centerline"]
        else:
            segment = result_segment(result)
            if segment is None or _length(segment) <= tolerance:
                errors.append(f"Open passage {portal_id} 必须是正长度两点 Vector。")
            else:
                contacts, _ = analyze_contacts([segment])
                boundary_segments = contacts
                connected_room_ids = sorted(boundary_segments)
                fully_supported = all(
                    sum(_length(supported) for supported in boundary_segments[room_id])
                    >= _length(segment) - tolerance
                    for room_id in connected_room_ids
                )
                if opening_type != "open_passage":
                    errors.append(f"Portal Vector {portal_id} 只允许标注 Open passage。")
                if len(connected_room_ids) != 2 or not fully_supported:
                    errors.append(f"Open passage {portal_id} 必须完整位于两个房间的共享边界上。")
                clear_width_percent = _length(segment)
                pixel_segment = tuple(_to_pixels(point, result) for point in segment)
                clear_width_px = _length(pixel_segment)
                centerline = list(segment)
                centerline_px = list(pixel_segment)

        edge = {
            **(old_edge or {}),
            "schema_version": 3,
            "edge_id": portal_id,
            "opening_type": opening_type,
            "geometry_type": geometry_type,
            "connected_room_ids": connected_room_ids,
            "room_ids": connected_room_ids,
            "connects_to_exterior": geometry_type == "rectangle" and len(connected_room_ids) == 1,
            "clear_width_percent": clear_width_percent,
            "depth_percent": depth_percent,
            "clear_width_px": clear_width_px,
            "depth_px": depth_px,
            "centerline": json_points(tuple(centerline)) if len(centerline) == 2 else [],
            "centerline_px": json_points(tuple(centerline_px)) if len(centerline_px) == 2 else [],
            "boundary_segments": {
                room_id: [json_points(segment) for segment in segments]
                for room_id, segments in boundary_segments.items()
            },
        }
        if not _metadata_equivalent(old_edge, edge):
            _merge_meta(result, "room_graph_edge", edge)
            changed_portals.append(portal_id)

    if errors:
        raise RoomV3MetadataError(errors)
    if geometry_digest(results) != geometry_digest(refreshed):
        raise RuntimeError("Room v3 元数据重算不得修改用户几何")
    return refreshed, {
        "room_ids": sorted(identifier for identifier in changed_rooms if identifier),
        "portal_ids": sorted(identifier for identifier in changed_portals if identifier),
    }
