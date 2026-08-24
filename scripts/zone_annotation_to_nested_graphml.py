#!/usr/bin/env python3
"""Convert one Label Studio room's functional zones into Cytoscape GraphML.

The converter writes two independent GraphML networks:

* ``<prefix>-overview.graphml`` contains the complete room/opening reference
  network and marks the selected parent room as the nested-network entry.
* ``<prefix>-zones.graphml`` contains the functional-zone nodes and their
  Vector-annotated direct-boundary connections.

Cytoscape Desktop does not persist a nested-network association in GraphML.
After importing both files, attach the zone network to the room node with
``Nested Networks > Add Nested Network`` and save a Cytoscape session.

Only Python's standard library is required. Conversion is deliberately strict:
a connection Vector must be supported by exactly two zone boundaries; invalid
or ambiguous geometry stops conversion instead of guessing endpoints. Version
2 keeps movement and visual-only Vectors separate, derives visual connectivity
from their geometric union, and normalizes both modalities independently.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence


GRAPHML_NS = "http://graphml.graphdrawing.org/xmlns"
ET.register_namespace("", GRAPHML_NS)

Point = tuple[float, float]
Segment = tuple[Point, Point]


class ConversionError(ValueError):
    """Raised when the annotation cannot be converted without guessing."""


@dataclass(frozen=True)
class Zone:
    result_id: str
    label: str
    geometry_type: str
    polygon: tuple[Point, ...]
    value: dict[str, Any]
    partition_context: dict[str, Any]


@dataclass(frozen=True)
class Connection:
    result_id: str
    label: str
    vertices: tuple[Point, ...]
    value: dict[str, Any]
    modality: str = "movement"
    control_name: str = "connection_vector"


CONNECTION_CONTROLS = {
    "connection_vector": "movement",
    "visual_connection_vector": "visual_only",
}


@dataclass
class ConvertedNetworks:
    overview: ET.ElementTree
    zones: ET.ElementTree
    report: dict[str, Any]


def _qname(name: str) -> str:
    return f"{{{GRAPHML_NS}}}{name}"


def load_payload(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConversionError(f"cannot read Label Studio JSON {path}: {exc}") from exc


def select_task(payload: Any, task_id: int | None) -> dict[str, Any]:
    tasks = payload if isinstance(payload, list) else [payload]
    tasks = [task for task in tasks if isinstance(task, dict)]
    if task_id is not None:
        matches = [task for task in tasks if task.get("id") == task_id]
        if len(matches) != 1:
            raise ConversionError(
                f"expected exactly one task with id {task_id}, found {len(matches)}"
            )
        return matches[0]
    if len(tasks) != 1:
        raise ConversionError(
            f"input contains {len(tasks)} tasks; pass --task-id to select exactly one"
        )
    return tasks[0]


def select_annotation(task: dict[str, Any]) -> dict[str, Any]:
    annotations = [
        item
        for item in task.get("annotations", [])
        if isinstance(item, dict) and not item.get("was_cancelled", False)
    ]
    if not annotations:
        raise ConversionError("task does not contain a completed, non-cancelled annotation")

    def sort_key(annotation: dict[str, Any]) -> tuple[str, int]:
        timestamp = str(annotation.get("updated_at") or annotation.get("created_at") or "")
        annotation_id = annotation.get("id")
        return timestamp, annotation_id if isinstance(annotation_id, int) else -1

    return max(annotations, key=sort_key)


def _result_dimensions(result: dict[str, Any]) -> tuple[float, float]:
    width = result.get("original_width")
    height = result.get("original_height")
    if not isinstance(width, (int, float)) or not isinstance(height, (int, float)):
        raise ConversionError(f"result {result.get('id')} is missing original dimensions")
    if width <= 0 or height <= 0:
        raise ConversionError(f"result {result.get('id')} has invalid original dimensions")
    if result.get("image_rotation", 0) not in (0, 0.0, None):
        raise ConversionError(
            f"result {result.get('id')} uses unsupported image_rotation "
            f"{result.get('image_rotation')}; rotate the source image first"
        )
    return float(width), float(height)


def _percent_point(x: Any, y: Any, width: float, height: float) -> Point:
    try:
        return float(x) * width / 100.0, float(y) * height / 100.0
    except (TypeError, ValueError) as exc:
        raise ConversionError(f"invalid percentage coordinate ({x!r}, {y!r})") from exc


def _rotate(point: Point, origin: Point, angle_degrees: float) -> Point:
    radians = math.radians(angle_degrees)
    cosine, sine = math.cos(radians), math.sin(radians)
    dx, dy = point[0] - origin[0], point[1] - origin[1]
    return (
        origin[0] + dx * cosine - dy * sine,
        origin[1] + dx * sine + dy * cosine,
    )


def result_polygon(result: dict[str, Any]) -> tuple[Point, ...]:
    width, height = _result_dimensions(result)
    value = result.get("value")
    if not isinstance(value, dict):
        raise ConversionError(f"result {result.get('id')} has no value object")

    result_type = result.get("type")
    if result_type in {"rectangle", "rectanglelabels"}:
        try:
            x = float(value["x"]) * width / 100.0
            y = float(value["y"]) * height / 100.0
            rectangle_width = float(value["width"]) * width / 100.0
            rectangle_height = float(value["height"]) * height / 100.0
            rotation = float(value.get("rotation", 0))
        except (KeyError, TypeError, ValueError) as exc:
            raise ConversionError(f"invalid Rectangle result {result.get('id')}") from exc
        if rectangle_width <= 0 or rectangle_height <= 0:
            raise ConversionError(f"Rectangle result {result.get('id')} has non-positive size")
        origin = (x, y)
        corners = (
            origin,
            (x + rectangle_width, y),
            (x + rectangle_width, y + rectangle_height),
            (x, y + rectangle_height),
        )
        return tuple(_rotate(point, origin, rotation) for point in corners)

    if result_type in {"polygon", "polygonlabels"}:
        raw_points = value.get("points")
        if not isinstance(raw_points, list) or len(raw_points) < 3:
            raise ConversionError(f"Polygon result {result.get('id')} needs at least 3 points")
        points: list[Point] = []
        for raw_point in raw_points:
            if not isinstance(raw_point, (list, tuple)) or len(raw_point) < 2:
                raise ConversionError(f"invalid Polygon point in result {result.get('id')}")
            points.append(_percent_point(raw_point[0], raw_point[1], width, height))
        return tuple(points)

    raise ConversionError(
        f"unsupported geometry type {result_type!r} for result {result.get('id')}"
    )


def result_vector(result: dict[str, Any]) -> tuple[Point, ...]:
    width, height = _result_dimensions(result)
    value = result.get("value")
    vertices = value.get("vertices") if isinstance(value, dict) else None
    if not isinstance(vertices, list) or len(vertices) < 2:
        raise ConversionError(f"Vector result {result.get('id')} needs at least 2 vertices")
    points: list[Point] = []
    for vertex in vertices:
        if not isinstance(vertex, dict):
            raise ConversionError(f"invalid Vector vertex in result {result.get('id')}")
        points.append(_percent_point(vertex.get("x"), vertex.get("y"), width, height))
    return tuple(points)


def polygon_segments(polygon: Sequence[Point]) -> list[Segment]:
    return [(polygon[index], polygon[(index + 1) % len(polygon)]) for index in range(len(polygon))]


def polyline_segments(points: Sequence[Point]) -> list[Segment]:
    return [(points[index], points[index + 1]) for index in range(len(points) - 1)]


def distance(a: Point, b: Point) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def segment_length(segment: Segment) -> float:
    return distance(segment[0], segment[1])


def polyline_length(points: Sequence[Point]) -> float:
    return sum(segment_length(segment) for segment in polyline_segments(points))


def polygon_area(polygon: Sequence[Point]) -> float:
    twice_area = sum(
        polygon[index][0] * polygon[(index + 1) % len(polygon)][1]
        - polygon[(index + 1) % len(polygon)][0] * polygon[index][1]
        for index in range(len(polygon))
    )
    return abs(twice_area) / 2.0


def polygon_signed_area(polygon: Sequence[Point]) -> float:
    return sum(
        polygon[index][0] * polygon[(index + 1) % len(polygon)][1]
        - polygon[(index + 1) % len(polygon)][0] * polygon[index][1]
        for index in range(len(polygon))
    ) / 2.0


def polygon_perimeter(polygon: Sequence[Point]) -> float:
    return sum(segment_length(segment) for segment in polygon_segments(polygon))


def polygon_centroid(polygon: Sequence[Point]) -> Point:
    signed_area = polygon_signed_area(polygon)
    if abs(signed_area) < 1e-12:
        raise ConversionError("polygon has zero area")
    factor_sum_x = 0.0
    factor_sum_y = 0.0
    for index, point in enumerate(polygon):
        next_point = polygon[(index + 1) % len(polygon)]
        cross = point[0] * next_point[1] - next_point[0] * point[1]
        factor_sum_x += (point[0] + next_point[0]) * cross
        factor_sum_y += (point[1] + next_point[1]) * cross
    return factor_sum_x / (6.0 * signed_area), factor_sum_y / (6.0 * signed_area)


def point_segment_distance(point: Point, segment: Segment) -> float:
    start, end = segment
    dx, dy = end[0] - start[0], end[1] - start[1]
    length_squared = dx * dx + dy * dy
    if length_squared <= 1e-18:
        return distance(point, start)
    projection = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length_squared
    projection = max(0.0, min(1.0, projection))
    closest = start[0] + projection * dx, start[1] + projection * dy
    return distance(point, closest)


def point_boundary_distance(point: Point, polygon: Sequence[Point]) -> float:
    return min(point_segment_distance(point, segment) for segment in polygon_segments(polygon))


def point_in_polygon(point: Point, polygon: Sequence[Point], epsilon: float = 0.0) -> bool:
    if point_boundary_distance(point, polygon) <= epsilon:
        return True
    inside = False
    x, y = point
    for start, end in polygon_segments(polygon):
        if (start[1] > y) == (end[1] > y):
            continue
        x_intersection = (end[0] - start[0]) * (y - start[1]) / (end[1] - start[1]) + start[0]
        if x < x_intersection:
            inside = not inside
    return inside


def _sample_polyline(points: Sequence[Point], sample_count: int) -> list[Point]:
    segments = polyline_segments(points)
    lengths = [segment_length(segment) for segment in segments]
    total = sum(lengths)
    if total <= 1e-12:
        return [points[0]]
    samples: list[Point] = []
    for index in range(sample_count):
        target = total * index / (sample_count - 1)
        walked = 0.0
        for segment, length in zip(segments, lengths):
            if target <= walked + length or segment is segments[-1]:
                ratio = 0.0 if length <= 1e-12 else (target - walked) / length
                ratio = max(0.0, min(1.0, ratio))
                samples.append(
                    (
                        segment[0][0] + ratio * (segment[1][0] - segment[0][0]),
                        segment[0][1] + ratio * (segment[1][1] - segment[0][1]),
                    )
                )
                break
            walked += length
    return samples


def boundary_support_ratio(
    vector: Sequence[Point], polygon: Sequence[Point], epsilon: float, sample_count: int = 401
) -> float:
    samples = _sample_polyline(vector, sample_count)
    supported = sum(point_boundary_distance(point, polygon) <= epsilon for point in samples)
    return supported / len(samples)


def _cross(a: Point, b: Point) -> float:
    return a[0] * b[1] - a[1] * b[0]


def collinear_overlap_length(first: Segment, second: Segment, epsilon: float) -> float:
    first_length = segment_length(first)
    second_length = segment_length(second)
    if first_length <= 1e-12 or second_length <= 1e-12:
        return 0.0
    unit = (
        (first[1][0] - first[0][0]) / first_length,
        (first[1][1] - first[0][1]) / first_length,
    )
    second_unit = (
        (second[1][0] - second[0][0]) / second_length,
        (second[1][1] - second[0][1]) / second_length,
    )
    if abs(_cross(unit, second_unit)) > math.sin(math.radians(1.0)):
        return 0.0
    if max(
        abs(_cross(unit, (point[0] - first[0][0], point[1] - first[0][1])))
        for point in second
    ) > epsilon:
        return 0.0
    projections = [
        (point[0] - first[0][0]) * unit[0] + (point[1] - first[0][1]) * unit[1]
        for point in second
    ]
    return max(0.0, min(first_length, max(projections)) - max(0.0, min(projections)))


def shared_boundary_length(first: Sequence[Point], second: Sequence[Point], epsilon: float) -> float:
    return sum(
        collinear_overlap_length(first_segment, second_segment, epsilon)
        for first_segment in polygon_segments(first)
        for second_segment in polygon_segments(second)
    )


def union_segment_length(segments: Sequence[Segment], epsilon: float) -> float:
    """Return non-overlapping length, merging collinear overlapping segments."""
    clusters: list[dict[str, Any]] = []
    for segment in segments:
        length = segment_length(segment)
        if length <= 1e-12:
            continue
        unit = (
            (segment[1][0] - segment[0][0]) / length,
            (segment[1][1] - segment[0][1]) / length,
        )
        matched: dict[str, Any] | None = None
        for cluster in clusters:
            base_unit: Point = cluster["unit"]
            if abs(_cross(unit, base_unit)) > math.sin(math.radians(1.0)):
                continue
            origin: Point = cluster["origin"]
            if max(
                abs(_cross(base_unit, (point[0] - origin[0], point[1] - origin[1])))
                for point in segment
            ) <= epsilon:
                matched = cluster
                break
        if matched is None:
            matched = {"origin": segment[0], "unit": unit, "intervals": []}
            clusters.append(matched)
        origin = matched["origin"]
        base_unit = matched["unit"]
        projections = [
            (point[0] - origin[0]) * base_unit[0] + (point[1] - origin[1]) * base_unit[1]
            for point in segment
        ]
        matched["intervals"].append((min(projections), max(projections)))

    total = 0.0
    for cluster in clusters:
        intervals = sorted(cluster["intervals"])
        if not intervals:
            continue
        current_start, current_end = intervals[0]
        for start, end in intervals[1:]:
            if start <= current_end + epsilon:
                current_end = max(current_end, end)
            else:
                total += current_end - current_start
                current_start, current_end = start, end
        total += current_end - current_start
    return total


def _single_label(result: dict[str, Any], key: str) -> str:
    value = result.get("value")
    labels = value.get(key) if isinstance(value, dict) else None
    if not isinstance(labels, list) or len(labels) != 1 or not isinstance(labels[0], str):
        raise ConversionError(
            f"result {result.get('id')} must contain exactly one non-empty {key} label"
        )
    label = labels[0].strip()
    if not label:
        raise ConversionError(f"result {result.get('id')} has an empty {key} label")
    return label


def _room_label(result: dict[str, Any]) -> str:
    if result.get("type") == "rectanglelabels":
        return _single_label(result, "rectanglelabels")
    if result.get("type") == "polygonlabels":
        return _single_label(result, "polygonlabels")
    raise ConversionError(f"result {result.get('id')} is not a room geometry")


def _extract_room_reference_graph(
    annotation: dict[str, Any], selected_room_id: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Read the complete room/opening reference layer embedded in the annotation."""
    results = annotation.get("result")
    if not isinstance(results, list):
        raise ConversionError("selected annotation result must be a list")

    rooms: dict[str, dict[str, Any]] = {}
    openings: dict[str, dict[str, Any]] = {}
    for result in results:
        if not isinstance(result, dict):
            continue
        result_id = result.get("id")
        if not isinstance(result_id, str) or not result_id:
            continue
        if result.get("from_name") in {"label", "polygon_label"} and result.get("type") in {
            "rectanglelabels",
            "polygonlabels",
        }:
            if result_id in rooms:
                raise ConversionError(f"duplicate room reference result ID: {result_id}")
            node_meta = result.get("meta", {}).get("room_graph_node")
            if not isinstance(node_meta, dict):
                raise ConversionError(
                    f"room reference {result_id} is missing meta.room_graph_node"
                )
            rooms[result_id] = result
        elif result.get("from_name") == "opening_label" and result.get("type") == "vectorlabels":
            if result_id in openings:
                raise ConversionError(f"duplicate opening reference result ID: {result_id}")
            edge_meta = result.get("meta", {}).get("room_graph_edge")
            if not isinstance(edge_meta, dict):
                raise ConversionError(
                    f"opening reference {result_id} is missing meta.room_graph_edge"
                )
            openings[result_id] = result

    if selected_room_id not in rooms:
        raise ConversionError(
            f"selected parent room {selected_room_id} is absent from the room reference graph"
        )
    if not openings:
        raise ConversionError("annotation does not contain room opening references")

    for result_id, result in openings.items():
        edge_meta = result["meta"]["room_graph_edge"]
        room_ids = edge_meta.get("room_ids")
        if (
            not isinstance(room_ids, list)
            or len(room_ids) != 2
            or not all(isinstance(room_id, str) and room_id for room_id in room_ids)
        ):
            raise ConversionError(
                f"opening reference {result_id} must contain exactly two room_ids"
            )
        dangling = sorted(set(room_ids) - set(rooms))
        if dangling:
            raise ConversionError(
                f"opening reference {result_id} has dangling room endpoint(s): "
                + ", ".join(dangling)
            )

    return (
        [rooms[result_id] for result_id in sorted(rooms)],
        [openings[result_id] for result_id in sorted(openings)],
    )


def _extract_results(
    annotation: dict[str, Any], parent_room_id: str, epsilon: float
) -> tuple[dict[str, Any], list[Zone], list[Connection], tuple[float, float]]:
    results = annotation.get("result")
    if not isinstance(results, list):
        raise ConversionError("selected annotation result must be a list")

    pairs: set[tuple[str, str]] = set()
    for result in results:
        if not isinstance(result, dict):
            continue
        result_id = result.get("id")
        from_name = result.get("from_name")
        if not isinstance(result_id, str) or not result_id:
            continue
        key = result_id, str(from_name)
        if key in pairs:
            raise ConversionError(f"duplicate result for id/control {result_id}/{from_name}")
        pairs.add(key)

    room_matches = [
        result
        for result in results
        if isinstance(result, dict)
        and result.get("id") == parent_room_id
        and result.get("from_name") in {"label", "polygon_label"}
        and result.get("type") in {"rectanglelabels", "polygonlabels"}
    ]
    if len(room_matches) != 1:
        raise ConversionError(
            f"expected exactly one parent room result {parent_room_id}, found {len(room_matches)}"
        )
    room = room_matches[0]
    image_dimensions = _result_dimensions(room)

    zone_geometry: dict[str, dict[str, Any]] = {}
    zone_labels: dict[str, dict[str, Any]] = {}
    connections: list[Connection] = []

    for result in results:
        if not isinstance(result, dict):
            continue
        result_id = result.get("id")
        if not isinstance(result_id, str) or not result_id:
            continue
        from_name = result.get("from_name")
        if from_name in {"zone_rectangle", "zone_polygon"} and result.get("type") in {
            "rectangle",
            "polygon",
        }:
            context = result.get("meta", {}).get("partition_context", {})
            if isinstance(context, dict) and context.get("parent_room_id") == parent_room_id:
                if result_id in zone_geometry:
                    raise ConversionError(f"zone {result_id} has more than one geometry result")
                zone_geometry[result_id] = result
        elif from_name == "function_zone" and result.get("type") == "labels":
            if result_id in zone_labels:
                raise ConversionError(f"zone {result_id} has more than one function_zone result")
            zone_labels[result_id] = result
        elif from_name in CONNECTION_CONTROLS and result.get("type") == "vectorlabels":
            points = result_vector(result)
            connections.append(
                Connection(
                    result_id=result_id,
                    label=_single_label(result, "vectorlabels"),
                    vertices=points,
                    value=result.get("value", {}),
                    modality=CONNECTION_CONTROLS[str(from_name)],
                    control_name=str(from_name),
                )
            )

    if not zone_geometry:
        raise ConversionError(f"no zones belong to parent room {parent_room_id}")
    missing_labels = sorted(set(zone_geometry) - set(zone_labels))
    if missing_labels:
        raise ConversionError(
            "zone geometry is missing a matching function_zone label: " + ", ".join(missing_labels)
        )

    parent_polygon = result_polygon(room)
    zones: list[Zone] = []
    for result_id, result in zone_geometry.items():
        polygon = result_polygon(result)
        if polygon_area(polygon) <= 1e-9:
            raise ConversionError(f"zone {result_id} has zero area")
        for segment in polygon_segments(polygon):
            for point in _sample_polyline(segment, 21):
                if not point_in_polygon(point, parent_polygon, epsilon):
                    raise ConversionError(
                        f"zone {result_id} extends outside parent room {parent_room_id}"
                    )
        context = result.get("meta", {}).get("partition_context", {})
        zones.append(
            Zone(
                result_id=result_id,
                label=_single_label(zone_labels[result_id], "labels"),
                geometry_type=str(result.get("type")),
                polygon=polygon,
                value=result.get("value", {}),
                partition_context=context if isinstance(context, dict) else {},
            )
        )

    zone_ids = {zone.result_id for zone in zones}
    if len(zone_ids) != len(zones):
        raise ConversionError("duplicate zone result ID")
    connection_ids = {connection.result_id for connection in connections}
    if len(connection_ids) != len(connections):
        raise ConversionError("duplicate connection Vector result ID")

    return room, zones, connections, image_dimensions


def connectivity_edge_models(
    zones: Sequence[Zone],
    connections: Sequence[Connection],
    epsilon: float,
    min_support_ratio: float,
    min_vector_length: float,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], dict[str, dict[str, float]]]:
    """Validate and aggregate movement and visual-only boundary vectors.

    Movement vectors imply visual connectivity. Visual-only vectors add to the
    visual layer but never to the movement layer. Both layers are normalized
    independently within each parent room.
    """

    zone_by_id = {zone.result_id: zone for zone in zones}
    zone_metrics = {
        zone.result_id: {
            "area_px2": polygon_area(zone.polygon),
            "perimeter_px": polygon_perimeter(zone.polygon),
            "centroid_px": polygon_centroid(zone.polygon),
        }
        for zone in zones
    }
    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = {}

    for connection in connections:
        length = polyline_length(connection.vertices)
        visual_only = connection.modality == "visual_only"
        prefix = "visual-only" if visual_only else "connection"
        if length < min_vector_length:
            code = "VISUAL_VECTOR_TOO_SHORT: " if visual_only else ""
            raise ConversionError(
                f"{code}{prefix} Vector {connection.result_id} is too short: "
                f"{length:.3f}px < {min_vector_length:.3f}px"
            )
        ratios = {
            zone.result_id: boundary_support_ratio(
                connection.vertices, zone.polygon, epsilon
            )
            for zone in zones
        }
        supported = sorted(
            result_id
            for result_id, ratio in ratios.items()
            if ratio >= min_support_ratio
        )
        if len(supported) != 2:
            details = ", ".join(
                f"{zone_by_id[result_id].label}/{result_id}={ratio:.3f}"
                for result_id, ratio in sorted(
                    ratios.items(), key=lambda item: item[1], reverse=True
                )
            )
            code = ""
            if visual_only:
                code = (
                    "VISUAL_VECTOR_CROSSES_MULTIPLE_ZONES: "
                    if len(supported) > 2
                    else "VISUAL_VECTOR_WITHOUT_TWO_ZONES: "
                )
            raise ConversionError(
                f"{code}{prefix} Vector {connection.result_id} must be supported by "
                f"exactly two zone boundaries, found {len(supported)} ({details})"
            )
        parents = {
            str(zone_by_id[result_id].partition_context.get("parent_room_id"))
            for result_id in supported
        }
        if len(parents) != 1:
            code = "VISUAL_VECTOR_CROSSES_MULTIPLE_ZONES: " if visual_only else ""
            raise ConversionError(
                f"{code}{prefix} Vector {connection.result_id} crosses parent rooms: "
                + ", ".join(sorted(parents))
            )
        parent_id = next(iter(parents))
        grouped.setdefault((parent_id, supported[0], supported[1]), []).append(
            {
                "connection": connection,
                "length": length,
                "support_ratios": {
                    result_id: ratios[result_id] for result_id in supported
                },
            }
        )

    models: list[dict[str, Any]] = []
    room_max: dict[str, dict[str, float]] = {}
    for (parent_id, first, second), items in sorted(grouped.items()):
        movement_items = [
            item for item in items if item["connection"].modality == "movement"
        ]
        visual_only_items = [
            item for item in items if item["connection"].modality == "visual_only"
        ]
        movement_segments = [
            segment
            for item in movement_items
            for segment in polyline_segments(item["connection"].vertices)
        ]
        visual_only_segments = [
            segment
            for item in visual_only_items
            for segment in polyline_segments(item["connection"].vertices)
        ]
        for movement_segment in movement_segments:
            for visual_segment in visual_only_segments:
                overlap = collinear_overlap_length(
                    movement_segment, visual_segment, epsilon
                )
                if overlap > 1e-6:
                    movement_ids = sorted(
                        item["connection"].result_id for item in movement_items
                    )
                    visual_ids = sorted(
                        item["connection"].result_id for item in visual_only_items
                    )
                    raise ConversionError(
                        "VISUAL_VECTOR_OVERLAPS_MOVEMENT: zone pair "
                        f"{first}/{second} has {overlap:.3f}px positive overlap; "
                        f"movement={movement_ids}, visual_only={visual_ids}"
                    )

        movement_length = union_segment_length(movement_segments, epsilon)
        visual_length = union_segment_length(
            [*movement_segments, *visual_only_segments], epsilon
        )
        first_perimeter = zone_metrics[first]["perimeter_px"]
        second_perimeter = zone_metrics[second]["perimeter_px"]
        movement_raw = 0.5 * (
            movement_length / first_perimeter + movement_length / second_perimeter
        )
        visual_raw = 0.5 * (
            visual_length / first_perimeter + visual_length / second_perimeter
        )
        shared_length = shared_boundary_length(
            zone_by_id[first].polygon, zone_by_id[second].polygon, epsilon
        )
        if shared_length <= 1e-9:
            code = "VISUAL_VECTOR_OUTSIDE_SHARED_BOUNDARY: " if visual_only_items else ""
            raise ConversionError(
                f"{code}zones {first} and {second} have a connectivity Vector but no shared boundary"
            )
        if visual_length > shared_length + max(epsilon, 1e-6):
            raise ConversionError(
                "VISUAL_VECTOR_OUTSIDE_SHARED_BOUNDARY: visual connectivity length "
                f"{visual_length:.3f}px exceeds shared boundary {shared_length:.3f}px "
                f"for zones {first}/{second}"
            )
        if visual_length + 1e-6 < movement_length:
            raise ConversionError(
                "VISUAL_STRENGTH_INCONSISTENT: visual length is smaller than movement "
                f"length for zones {first}/{second}"
            )
        model = {
            "parent_room_id": parent_id,
            "pair": (first, second),
            "items": items,
            "movement_items": movement_items,
            "visual_only_items": visual_only_items,
            "movement_labels": sorted(
                {item["connection"].label for item in movement_items}
            ),
            "visual_only_labels": sorted(
                {item["connection"].label for item in visual_only_items}
            ),
            "movement_length_px": movement_length,
            "visual_length_px": visual_length,
            "shared_boundary_length_px": shared_length,
            "movement_raw_strength": movement_raw,
            "visual_raw_strength": visual_raw,
            "movement_interface_openness": movement_length / shared_length,
            "visual_interface_openness": visual_length / shared_length,
            "edge_kind": "direct_boundary" if movement_items else "visual_boundary",
            "connectivity_modalities": (
                ["movement", "visual"] if movement_items else ["visual"]
            ),
        }
        models.append(model)
        maxima = room_max.setdefault(parent_id, {"movement": 0.0, "visual": 0.0})
        if movement_items:
            maxima["movement"] = max(maxima["movement"], movement_raw)
        maxima["visual"] = max(maxima["visual"], visual_raw)

    for model in models:
        maxima = room_max[model["parent_room_id"]]
        movement_max = maxima["movement"]
        visual_max = maxima["visual"]
        model["movement_room_max_raw_strength"] = movement_max
        model["visual_room_max_raw_strength"] = visual_max
        model["movement_relative_strength"] = (
            model["movement_raw_strength"] / movement_max
            if model["movement_items"] and movement_max > 0
            else 0.0
        )
        model["visual_relative_strength"] = (
            model["visual_raw_strength"] / visual_max if visual_max > 0 else 0.0
        )
        if model["movement_items"]:
            model.update(
                {
                    "opening_length_px": model["movement_length_px"],
                    "raw_strength": model["movement_raw_strength"],
                    "relative_strength": model["movement_relative_strength"],
                    "interface_openness": model["movement_interface_openness"],
                    "room_max_raw_strength": movement_max,
                    "labels": model["movement_labels"],
                }
            )
        else:
            model["labels"] = model["visual_only_labels"]

    return models, zone_metrics, room_max


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _round(value: float) -> float:
    return round(float(value), 6)


def _snake_case(value: str) -> str:
    normalized = re.sub(r"[^0-9A-Za-z]+", "_", value.strip()).strip("_").lower()
    return normalized or "unknown"


def _graphml_tree(
    graph_id: str,
    node_rows: Sequence[tuple[str, dict[str, Any]]],
    edge_rows: Sequence[tuple[str, str, str, dict[str, Any]]],
) -> ET.ElementTree:
    node_keys: dict[str, str] = {}
    edge_keys: dict[str, str] = {}

    def graphml_type(value: Any) -> str:
        if isinstance(value, bool):
            return "boolean"
        if isinstance(value, int):
            return "int"
        if isinstance(value, float):
            return "double"
        return "string"

    for _, row in node_rows:
        for name, value in row.items():
            node_keys.setdefault(name, graphml_type(value))
    for _, _, _, row in edge_rows:
        for name, value in row.items():
            edge_keys.setdefault(name, graphml_type(value))

    root = ET.Element(_qname("graphml"))
    node_key_ids: dict[str, str] = {}
    edge_key_ids: dict[str, str] = {}
    for index, (name, attr_type) in enumerate(sorted(node_keys.items())):
        key_id = f"n{index}"
        node_key_ids[name] = key_id
        ET.SubElement(
            root,
            _qname("key"),
            {"id": key_id, "for": "node", "attr.name": name, "attr.type": attr_type},
        )
    for index, (name, attr_type) in enumerate(sorted(edge_keys.items())):
        key_id = f"e{index}"
        edge_key_ids[name] = key_id
        ET.SubElement(
            root,
            _qname("key"),
            {"id": key_id, "for": "edge", "attr.name": name, "attr.type": attr_type},
        )

    graph = ET.SubElement(
        root, _qname("graph"), {"id": graph_id, "edgedefault": "undirected"}
    )
    for node_id, row in node_rows:
        node = ET.SubElement(graph, _qname("node"), {"id": node_id})
        for name, value in sorted(row.items()):
            data = ET.SubElement(node, _qname("data"), {"key": node_key_ids[name]})
            data.text = str(value).lower() if isinstance(value, bool) else str(value)
    for edge_id, source, target, row in edge_rows:
        edge = ET.SubElement(
            graph,
            _qname("edge"),
            {"id": edge_id, "source": source, "target": target},
        )
        for name, value in sorted(row.items()):
            data = ET.SubElement(edge, _qname("data"), {"key": edge_key_ids[name]})
            data.text = str(value).lower() if isinstance(value, bool) else str(value)

    ET.indent(root, space="  ")
    return ET.ElementTree(root)


def convert(
    task: dict[str, Any],
    parent_room_id: str,
    prefix: str,
    epsilon: float | None = None,
    min_support_ratio: float = 0.95,
    min_vector_length: float | None = None,
) -> ConvertedNetworks:
    annotation = select_annotation(task)
    results = annotation.get("result")
    if not isinstance(results, list):
        raise ConversionError("selected annotation result must be a list")

    dimension_result = next(
        (result for result in results if isinstance(result, dict) and result.get("original_width")),
        None,
    )
    if dimension_result is None:
        raise ConversionError("annotation does not contain image dimensions")
    width, height = _result_dimensions(dimension_result)
    resolved_epsilon = (
        float(epsilon) if epsilon is not None else float(max(2, round(0.001 * min(width, height))))
    )
    resolved_min_length = (
        float(min_vector_length)
        if min_vector_length is not None
        else max(4.0, 2.0 * resolved_epsilon)
    )
    if resolved_epsilon <= 0:
        raise ConversionError("epsilon must be positive")
    if not 0 < min_support_ratio <= 1:
        raise ConversionError("min_support_ratio must be in (0, 1]")
    if resolved_min_length <= 0:
        raise ConversionError("min_vector_length must be positive")

    room, zones, connections, dimensions = _extract_results(
        annotation, parent_room_id, resolved_epsilon
    )
    if dimensions != (width, height):
        width, height = dimensions

    room_polygon = result_polygon(room)
    room_label = _room_label(room)
    reference_rooms, reference_openings = _extract_room_reference_graph(
        annotation, parent_room_id
    )

    zone_by_id = {zone.result_id: zone for zone in zones}
    edge_models, zone_metrics, room_maxima = connectivity_edge_models(
        zones,
        connections,
        resolved_epsilon,
        min_support_ratio,
        resolved_min_length,
    )
    parent_maxima = room_maxima.get(
        parent_room_id, {"movement": 0.0, "visual": 0.0}
    )
    room_max_raw_strength = parent_maxima["movement"]
    visual_room_max_raw_strength = parent_maxima["visual"]
    movement_connections = [
        connection for connection in connections if connection.modality == "movement"
    ]
    visual_only_connections = [
        connection
        for connection in connections
        if connection.modality == "visual_only"
    ]

    node_rows: list[tuple[str, dict[str, Any]]] = []
    for zone in sorted(zones, key=lambda item: item.result_id):
        metrics = zone_metrics[zone.result_id]
        centroid = metrics["centroid_px"]
        node_rows.append(
            (
                zone.result_id,
                {
                    "name": zone.label,
                    "shared_name": zone.label,
                    "node_kind": "functional_zone",
                    "zone_label": zone.label,
                    "zone_result_id": zone.result_id,
                    "parent_room_id": parent_room_id,
                    "parent_room_label": room_label,
                    "geometry_type": zone.geometry_type,
                    "geometry_percent_json": _json(zone.value),
                    "geometry_px_json": _json(
                        [[_round(point[0]), _round(point[1])] for point in zone.polygon]
                    ),
                    "area_px2": _round(metrics["area_px2"]),
                    "perimeter_px": _round(metrics["perimeter_px"]),
                    "centroid_x_px": _round(centroid[0]),
                    "centroid_y_px": _round(centroid[1]),
                    "opening_ids_json": _json(zone.partition_context.get("opening_ids", [])),
                    "connected_room_ids_json": _json(
                        zone.partition_context.get("connected_room_ids", [])
                    ),
                },
            )
        )

    edge_rows: list[tuple[str, str, str, dict[str, Any]]] = []
    report_edges: list[dict[str, Any]] = []
    movement_edge_index = 0
    for edge in edge_models:
        pair = edge["pair"]
        movement_items = edge["movement_items"]
        visual_only_items = edge["visual_only_items"]
        movement_ids = sorted(
            item["connection"].result_id for item in movement_items
        )
        visual_only_ids = sorted(
            item["connection"].result_id for item in visual_only_items
        )
        labels = edge["labels"]
        if movement_ids:
            movement_edge_index += 1
            edge_id = (
                movement_ids[0]
                if len(movement_ids) == 1
                else f"zone-edge-{movement_edge_index}"
            )
        elif len(visual_only_ids) == 1:
            edge_id = visual_only_ids[0]
        else:
            identity = "|".join((parent_room_id, pair[0], pair[1]))
            digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12]
            edge_id = f"visual-zone-edge-{digest}"
        minimum_support = min(
            ratio
            for item in edge["items"]
            for ratio in item["support_ratios"].values()
        )
        movement_geometry = [
            {
                "result_id": item["connection"].result_id,
                "label": item["connection"].label,
                "vertices_px": [
                    [_round(point[0]), _round(point[1])]
                    for point in item["connection"].vertices
                ],
            }
            for item in movement_items
        ]
        visual_only_geometry = [
            {
                "result_id": item["connection"].result_id,
                "label": item["connection"].label,
                "vertices_px": [
                    [_round(point[0]), _round(point[1])]
                    for point in item["connection"].vertices
                ],
            }
            for item in visual_only_items
        ]
        row = {
            "name": " / ".join(labels),
            "shared_name": " / ".join(labels),
            "edge_kind": edge["edge_kind"],
            "connection_type": "+".join(_snake_case(label) for label in labels),
            "connection_labels_json": _json(labels),
            "connectivity_modalities_json": _json(edge["connectivity_modalities"]),
            "movement_vector_result_ids_json": _json(movement_ids),
            "visual_only_vector_result_ids_json": _json(visual_only_ids),
            "movement_vector_geometry_px_json": _json(movement_geometry),
            "visual_only_vector_geometry_px_json": _json(visual_only_geometry),
            "parent_room_id": parent_room_id,
            "source_perimeter_px": _round(zone_metrics[pair[0]]["perimeter_px"]),
            "target_perimeter_px": _round(zone_metrics[pair[1]]["perimeter_px"]),
            "shared_boundary_length_px": _round(edge["shared_boundary_length_px"]),
            "movement_length_px": _round(edge["movement_length_px"]),
            "movement_raw_strength": _round(edge["movement_raw_strength"]),
            "movement_relative_strength": _round(
                edge["movement_relative_strength"]
            ),
            "movement_interface_openness": _round(
                edge["movement_interface_openness"]
            ),
            "movement_room_max_raw_strength": _round(
                edge["movement_room_max_raw_strength"]
            ),
            "visual_length_px": _round(edge["visual_length_px"]),
            "visual_raw_strength": _round(edge["visual_raw_strength"]),
            "visual_relative_strength": _round(edge["visual_relative_strength"]),
            "visual_interface_openness": _round(
                edge["visual_interface_openness"]
            ),
            "visual_room_max_raw_strength": _round(
                edge["visual_room_max_raw_strength"]
            ),
            "minimum_boundary_support_ratio": _round(minimum_support),
        }
        if movement_ids:
            row.update(
                {
                    "vector_result_ids_json": _json(movement_ids),
                    "vector_geometry_px_json": _json(movement_geometry),
                    "opening_length_px": _round(edge["opening_length_px"]),
                    "raw_strength": _round(edge["raw_strength"]),
                    "relative_strength": _round(edge["relative_strength"]),
                    "interface_openness": _round(edge["interface_openness"]),
                    "room_max_raw_strength": _round(edge["room_max_raw_strength"]),
                }
            )
        edge_rows.append((edge_id, pair[0], pair[1], row))
        report_edges.append(
            {
                "edge_id": edge_id,
                "source_zone_id": pair[0],
                "source_zone_label": zone_by_id[pair[0]].label,
                "target_zone_id": pair[1],
                "target_zone_label": zone_by_id[pair[1]].label,
                **row,
            }
        )

    zones_graph_id = f"{prefix}-zones"
    overview_nodes: list[tuple[str, dict[str, Any]]] = []
    for reference_room in reference_rooms:
        reference_id = str(reference_room["id"])
        reference_label = _room_label(reference_room)
        reference_polygon = result_polygon(reference_room)
        reference_centroid = polygon_centroid(reference_polygon)
        node_meta = reference_room["meta"]["room_graph_node"]
        row: dict[str, Any] = {
            "name": f"{reference_label} · {reference_id[:8]}",
            "shared_name": reference_label,
            "node_kind": "room",
            "room_label": reference_label,
            "room_result_id": reference_id,
            "geometry_type": str(reference_room.get("type")),
            "geometry_percent_json": _json(reference_room.get("value", {})),
            "geometry_px_json": _json(
                [[_round(point[0]), _round(point[1])] for point in reference_polygon]
            ),
            "area_px2": _round(polygon_area(reference_polygon)),
            "perimeter_px": _round(polygon_perimeter(reference_polygon)),
            "centroid_x_px": _round(reference_centroid[0]),
            "centroid_y_px": _round(reference_centroid[1]),
            "room_graph_node_json": _json(node_meta),
            "has_nested_zone_network": reference_id == parent_room_id,
        }
        if reference_id == parent_room_id:
            row.update(
                {
                    "zone_count": len(zones),
                    "zone_connection_count": len(edge_models),
                    "connection_vector_count": len(movement_connections),
                    "visual_connection_vector_count": len(
                        visual_only_connections
                    ),
                    "child_network_name": zones_graph_id,
                    "nested_network_setup": (
                        "Cytoscape: Add Nested Network after importing both GraphML files"
                    ),
                }
            )
        overview_nodes.append((reference_id, row))

    overview_edges: list[tuple[str, str, str, dict[str, Any]]] = []
    for reference_opening in reference_openings:
        opening_id = str(reference_opening["id"])
        edge_meta = reference_opening["meta"]["room_graph_edge"]
        room_ids = edge_meta["room_ids"]
        opening_label = _single_label(reference_opening, "vectorlabels")
        opening_vertices = result_vector(reference_opening)
        row = {
            "name": opening_label,
            "shared_name": opening_label,
            "edge_kind": "room_opening",
            "opening_result_id": opening_id,
            "opening_type": str(edge_meta.get("opening_type") or opening_label),
            "walkable": bool(edge_meta.get("walkable", False)),
            "width_pixels": float(edge_meta.get("width_pixels") or polyline_length(opening_vertices)),
            "midpoint_x_percent": float(edge_meta.get("midpoint_x", 0.0)),
            "midpoint_y_percent": float(edge_meta.get("midpoint_y", 0.0)),
            "confidence": float(edge_meta.get("confidence", 0.0)),
            "geometry_percent_json": _json(reference_opening.get("value", {})),
            "geometry_px_json": _json(
                [[_round(point[0]), _round(point[1])] for point in opening_vertices]
            ),
            "room_graph_edge_json": _json(edge_meta),
        }
        overview_edges.append((opening_id, room_ids[0], room_ids[1], row))

    overview = _graphml_tree(
        f"{prefix}-overview", overview_nodes, overview_edges
    )
    zone_tree = _graphml_tree(zones_graph_id, node_rows, edge_rows)
    report = {
        "schema_version": 2,
        "connectivity_schema_version": 2,
        "status": "ok",
        "task_id": task.get("id"),
        "annotation_id": annotation.get("id"),
        "image_width": int(width) if width.is_integer() else width,
        "image_height": int(height) if height.is_integer() else height,
        "parent_room": {
            "result_id": parent_room_id,
            "label": room_label,
            "geometry_type": room.get("type"),
            "area_px2": _round(polygon_area(room_polygon)),
            "perimeter_px": _round(polygon_perimeter(room_polygon)),
        },
        "counts": {
            "rooms": len(reference_rooms),
            "room_openings": len(reference_openings),
            "zones": len(zones),
            "connection_vectors": len(movement_connections),
            "visual_connection_vectors": len(visual_only_connections),
            "direct_boundary_edges": sum(
                edge["edge_kind"] == "direct_boundary" for edge in edge_models
            ),
            "visual_boundary_edges": sum(
                edge["edge_kind"] == "visual_boundary" for edge in edge_models
            ),
            "zone_edges": len(edge_models),
        },
        "validation": {
            "boundary_epsilon_px": resolved_epsilon,
            "minimum_boundary_support_ratio": min_support_ratio,
            "minimum_vector_length_px": resolved_min_length,
            "all_zones_inside_parent": True,
            "all_vectors_have_exactly_two_zone_endpoints": True,
            "movement_and_visual_only_vectors_do_not_overlap": True,
            "movement_implies_visual": True,
            "movement_and_visual_strengths_normalized_independently": True,
        },
        "room_max_raw_strength": _round(room_max_raw_strength),
        "movement_room_max_raw_strength": _round(room_max_raw_strength),
        "visual_room_max_raw_strength": _round(visual_room_max_raw_strength),
        "zones": [
            {
                "result_id": zone.result_id,
                "label": zone.label,
                "area_px2": _round(zone_metrics[zone.result_id]["area_px2"]),
                "perimeter_px": _round(zone_metrics[zone.result_id]["perimeter_px"]),
            }
            for zone in sorted(zones, key=lambda item: item.result_id)
        ],
        "edges": report_edges,
    }
    return ConvertedNetworks(overview=overview, zones=zone_tree, report=report)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Convert Label Studio functional zones and connection Vectors into a "
            "Cytoscape room overview GraphML plus a zone child-network GraphML."
        )
    )
    parser.add_argument("--input-json", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--parent-room-id", required=True)
    parser.add_argument("--task-id", type=int)
    parser.add_argument("--prefix", default="room")
    parser.add_argument("--epsilon-px", type=float)
    parser.add_argument("--min-support-ratio", type=float, default=0.95)
    parser.add_argument("--min-vector-length-px", type=float)
    parser.add_argument(
        "--overwrite", action="store_true", help="replace files with the same output names"
    )
    return parser.parse_args(argv)


def _write_tree(tree: ET.ElementTree, path: Path) -> None:
    tree.write(path, encoding="utf-8", xml_declaration=True)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    output_dir: Path = args.output_dir
    overview_path = output_dir / f"{args.prefix}-overview.graphml"
    zones_path = output_dir / f"{args.prefix}-zones.graphml"
    report_path = output_dir / f"{args.prefix}-conversion-report.json"
    targets = [overview_path, zones_path, report_path]
    existing = [path for path in targets if path.exists()]
    if existing and not args.overwrite:
        print(
            "conversion failed: output file(s) already exist; pass --overwrite: "
            + ", ".join(str(path) for path in existing),
            file=sys.stderr,
        )
        return 2

    try:
        payload = load_payload(args.input_json)
        task = select_task(payload, args.task_id)
        converted = convert(
            task,
            parent_room_id=args.parent_room_id,
            prefix=args.prefix,
            epsilon=args.epsilon_px,
            min_support_ratio=args.min_support_ratio,
            min_vector_length=args.min_vector_length_px,
        )
        output_dir.mkdir(parents=True, exist_ok=True)
        _write_tree(converted.overview, overview_path)
        _write_tree(converted.zones, zones_path)
        report = {
            **converted.report,
            "input_json": str(args.input_json.resolve()),
            "outputs": {
                "overview_graphml": str(overview_path.resolve()),
                "zones_graphml": str(zones_path.resolve()),
                "report_json": str(report_path.resolve()),
            },
        }
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    except ConversionError as exc:
        print(f"conversion failed: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"conversion failed while writing output: {exc}", file=sys.stderr)
        return 2

    print(
        f"wrote {converted.report['counts']['zones']} zones and "
        f"{converted.report['counts']['zone_edges']} edges:\n"
        f"- {overview_path}\n- {zones_path}\n- {report_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
