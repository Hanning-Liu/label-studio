#!/usr/bin/env python3
"""Convert one Label Studio room's functional zones into Cytoscape GraphML.

The converter writes two independent GraphML networks:

* ``<prefix>-overview.graphml`` contains the selected parent room node.
* ``<prefix>-zones.graphml`` contains the functional-zone nodes and their
  Vector-annotated direct-boundary connections.

Cytoscape Desktop does not persist a nested-network association in GraphML.
After importing both files, attach the zone network to the room node with
``Nested Networks > Add Nested Network`` and save a Cytoscape session.

Only Python's standard library is required. Conversion is deliberately strict:
a connection Vector must be supported by exactly two zone boundaries; invalid
or ambiguous geometry stops conversion instead of guessing endpoints.
"""

from __future__ import annotations

import argparse
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
        elif from_name == "connection_vector" and result.get("type") == "vectorlabels":
            points = result_vector(result)
            connections.append(
                Connection(
                    result_id=result_id,
                    label=_single_label(result, "vectorlabels"),
                    vertices=points,
                    value=result.get("value", {}),
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
    room_label_key = "rectanglelabels" if room.get("type") == "rectanglelabels" else "polygonlabels"
    room_label = _single_label(room, room_label_key)

    zone_by_id = {zone.result_id: zone for zone in zones}
    zone_metrics = {
        zone.result_id: {
            "area_px2": polygon_area(zone.polygon),
            "perimeter_px": polygon_perimeter(zone.polygon),
            "centroid_px": polygon_centroid(zone.polygon),
        }
        for zone in zones
    }

    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for connection in connections:
        length = polyline_length(connection.vertices)
        if length < resolved_min_length:
            raise ConversionError(
                f"connection Vector {connection.result_id} is too short: "
                f"{length:.3f}px < {resolved_min_length:.3f}px"
            )
        ratios = {
            zone.result_id: boundary_support_ratio(
                connection.vertices, zone.polygon, resolved_epsilon
            )
            for zone in zones
        }
        supported = sorted(
            zone_id for zone_id, ratio in ratios.items() if ratio >= min_support_ratio
        )
        if len(supported) != 2:
            details = ", ".join(
                f"{zone_by_id[zone_id].label}/{zone_id}={ratio:.3f}"
                for zone_id, ratio in sorted(ratios.items(), key=lambda item: item[1], reverse=True)
            )
            raise ConversionError(
                f"connection Vector {connection.result_id} must be supported by exactly two "
                f"zone boundaries, found {len(supported)} ({details})"
            )
        key = supported[0], supported[1]
        grouped.setdefault(key, []).append(
            {
                "connection": connection,
                "length": length,
                "support_ratios": {zone_id: ratios[zone_id] for zone_id in supported},
            }
        )

    edge_models: list[dict[str, Any]] = []
    for pair, items in sorted(grouped.items()):
        vector_segments = [
            segment
            for item in items
            for segment in polyline_segments(item["connection"].vertices)
        ]
        opening_length = union_segment_length(vector_segments, resolved_epsilon)
        first_perimeter = zone_metrics[pair[0]]["perimeter_px"]
        second_perimeter = zone_metrics[pair[1]]["perimeter_px"]
        raw_strength = 0.5 * (
            opening_length / first_perimeter + opening_length / second_perimeter
        )
        shared_length = shared_boundary_length(
            zone_by_id[pair[0]].polygon, zone_by_id[pair[1]].polygon, resolved_epsilon
        )
        if shared_length <= 1e-9:
            raise ConversionError(
                f"zones {pair[0]} and {pair[1]} have a connection Vector but no shared boundary"
            )
        labels = sorted({item["connection"].label for item in items})
        edge_models.append(
            {
                "pair": pair,
                "items": items,
                "labels": labels,
                "opening_length_px": opening_length,
                "shared_boundary_length_px": shared_length,
                "raw_strength": raw_strength,
                "interface_openness": opening_length / shared_length,
            }
        )

    room_max_raw_strength = max(
        (edge["raw_strength"] for edge in edge_models), default=0.0
    )
    for edge in edge_models:
        edge["relative_strength"] = (
            edge["raw_strength"] / room_max_raw_strength
            if room_max_raw_strength > 0
            else 0.0
        )

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
    for index, edge in enumerate(edge_models, start=1):
        pair = edge["pair"]
        item_ids = sorted(item["connection"].result_id for item in edge["items"])
        labels = edge["labels"]
        edge_id = item_ids[0] if len(item_ids) == 1 else f"zone-edge-{index}"
        minimum_support = min(
            ratio
            for item in edge["items"]
            for ratio in item["support_ratios"].values()
        )
        vector_geometry = [
            {
                "result_id": item["connection"].result_id,
                "label": item["connection"].label,
                "vertices_px": [
                    [_round(point[0]), _round(point[1])]
                    for point in item["connection"].vertices
                ],
            }
            for item in edge["items"]
        ]
        row = {
            "name": " / ".join(labels),
            "shared_name": " / ".join(labels),
            "edge_kind": "direct_boundary",
            "connection_type": "+".join(_snake_case(label) for label in labels),
            "connection_labels_json": _json(labels),
            "vector_result_ids_json": _json(item_ids),
            "vector_geometry_px_json": _json(vector_geometry),
            "parent_room_id": parent_room_id,
            "opening_length_px": _round(edge["opening_length_px"]),
            "source_perimeter_px": _round(zone_metrics[pair[0]]["perimeter_px"]),
            "target_perimeter_px": _round(zone_metrics[pair[1]]["perimeter_px"]),
            "shared_boundary_length_px": _round(edge["shared_boundary_length_px"]),
            "raw_strength": _round(edge["raw_strength"]),
            "relative_strength": _round(edge["relative_strength"]),
            "interface_openness": _round(edge["interface_openness"]),
            "minimum_boundary_support_ratio": _round(minimum_support),
            "room_max_raw_strength": _round(room_max_raw_strength),
        }
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
    overview_row = {
        "name": f"{room_label} · {parent_room_id}",
        "shared_name": room_label,
        "node_kind": "room",
        "room_label": room_label,
        "room_result_id": parent_room_id,
        "geometry_type": str(room.get("type")),
        "geometry_percent_json": _json(room.get("value", {})),
        "geometry_px_json": _json(
            [[_round(point[0]), _round(point[1])] for point in room_polygon]
        ),
        "area_px2": _round(polygon_area(room_polygon)),
        "perimeter_px": _round(polygon_perimeter(room_polygon)),
        "zone_count": len(zones),
        "connection_count": len(edge_models),
        "connection_vector_count": len(connections),
        "child_network_name": zones_graph_id,
        "nested_network_setup": "Cytoscape: Add Nested Network after importing both GraphML files",
    }

    overview = _graphml_tree(f"{prefix}-overview", [(parent_room_id, overview_row)], [])
    zone_tree = _graphml_tree(zones_graph_id, node_rows, edge_rows)
    report = {
        "schema_version": 1,
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
            "zones": len(zones),
            "connection_vectors": len(connections),
            "zone_edges": len(edge_models),
        },
        "validation": {
            "boundary_epsilon_px": resolved_epsilon,
            "minimum_boundary_support_ratio": min_support_ratio,
            "minimum_vector_length_px": resolved_min_length,
            "all_zones_inside_parent": True,
            "all_vectors_have_exactly_two_zone_endpoints": True,
        },
        "room_max_raw_strength": _round(room_max_raw_strength),
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
