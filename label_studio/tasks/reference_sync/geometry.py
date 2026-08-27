"""Shared geometry and Label Studio helpers for the Room v3 pilot."""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path
from typing import Any, Iterable


class RoomV3Error(ValueError):
    """Raised when a Room v3 conversion cannot be completed safely."""


def load_single_task(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RoomV3Error(f"cannot read Label Studio JSON {path}: {exc}") from exc
    tasks = payload if isinstance(payload, list) else [payload]
    if len(tasks) != 1 or not isinstance(tasks[0], dict):
        raise RoomV3Error(f"expected exactly one task, got {len(tasks)}")
    return tasks[0]


def select_annotation(task: dict[str, Any], annotation_id: int | None = None) -> dict[str, Any]:
    annotations = [
        item
        for item in task.get("annotations", [])
        if isinstance(item, dict) and not item.get("was_cancelled", False)
    ]
    if annotation_id is not None:
        annotations = [item for item in annotations if item.get("id") == annotation_id]
    if not annotations:
        suffix = f" with id {annotation_id}" if annotation_id is not None else ""
        raise RoomV3Error(f"task has no non-cancelled annotation{suffix}")

    def key(annotation: dict[str, Any]) -> tuple[str, int]:
        updated = str(annotation.get("updated_at") or annotation.get("created_at") or "")
        identifier = annotation.get("id")
        return updated, identifier if isinstance(identifier, int) else -1

    return max(annotations, key=key)


def result_label(result: dict[str, Any]) -> str:
    value = result.get("value") if isinstance(result.get("value"), dict) else {}
    for key in ("rectanglelabels", "polygonlabels", "vectorlabels", "labels"):
        labels = value.get(key)
        if isinstance(labels, list) and labels:
            return str(labels[0])
    return ""


def normalized_opening_type(value: str) -> str:
    return "_".join(value.strip().lower().split())


def merge_meta(result: dict[str, Any], key: str, value: dict[str, Any]) -> None:
    meta = copy.deepcopy(result.get("meta")) if isinstance(result.get("meta"), dict) else {}
    meta[key] = value
    result["meta"] = meta


def migration_context(
    *,
    project_id: int,
    task_id: int,
    annotation_id: int,
    result_id: str,
) -> dict[str, Any]:
    return {
        "source_project_id": project_id,
        "source_task_id": task_id,
        "source_annotation_id": annotation_id,
        "source_result_id": result_id,
    }


Point = tuple[float, float]
Segment = tuple[Point, Point]


def _point(value: dict[str, Any] | Iterable[float]) -> Point:
    if isinstance(value, dict):
        return float(value["x"]), float(value["y"])
    pair = list(value)
    return float(pair[0]), float(pair[1])


def rectangle_points(value: dict[str, Any]) -> list[Point]:
    x = float(value.get("x", 0))
    y = float(value.get("y", 0))
    width = float(value.get("width", 0))
    height = float(value.get("height", 0))
    radians = math.radians(float(value.get("rotation", 0)))
    cosine = math.cos(radians)
    sine = math.sin(radians)

    def rotate(dx: float, dy: float) -> Point:
        return x + dx * cosine - dy * sine, y + dx * sine + dy * cosine

    return [rotate(0, 0), rotate(width, 0), rotate(width, height), rotate(0, height)]


def result_polygon(result: dict[str, Any]) -> list[Point] | None:
    value = result.get("value") if isinstance(result.get("value"), dict) else {}
    if result.get("type") in {"rectangle", "rectanglelabels"}:
        return rectangle_points(value)
    if result.get("type") in {"polygon", "polygonlabels"}:
        points = value.get("points")
        if isinstance(points, list) and len(points) >= 3:
            return [_point(point) for point in points]
    return None


def result_segment(result: dict[str, Any]) -> Segment | None:
    value = result.get("value") if isinstance(result.get("value"), dict) else {}
    vertices = value.get("vertices")
    if not isinstance(vertices, list) or len(vertices) != 2:
        return None
    return _point(vertices[0]), _point(vertices[1])


def _subtract(first: Point, second: Point) -> Point:
    return first[0] - second[0], first[1] - second[1]


def _cross(first: Point, second: Point) -> float:
    return first[0] * second[1] - first[1] * second[0]


def _dot(first: Point, second: Point) -> float:
    return first[0] * second[0] + first[1] * second[1]


def distance(first: Point, second: Point) -> float:
    return math.hypot(first[0] - second[0], first[1] - second[1])


def point_on_segment(point: Point, start: Point, end: Point, tolerance: float = 1e-5) -> bool:
    segment = _subtract(end, start)
    offset = _subtract(point, start)
    if abs(_cross(segment, offset)) > tolerance * max(1.0, distance(start, end)):
        return False
    projection = _dot(offset, segment)
    return -tolerance <= projection <= _dot(segment, segment) + tolerance


def point_in_polygon(point: Point, polygon: list[Point], include_boundary: bool = True) -> bool:
    inside = False
    previous = len(polygon) - 1
    for index, end in enumerate(polygon):
        start = polygon[previous]
        if point_on_segment(point, start, end):
            return include_boundary
        crosses = (start[1] > point[1]) != (end[1] > point[1]) and point[0] < (
            (end[0] - start[0]) * (point[1] - start[1]) / (end[1] - start[1]) + start[0]
        )
        if crosses:
            inside = not inside
        previous = index
    return inside


def polygon_inside_polygon(candidate: list[Point], container: list[Point]) -> bool:
    # Room v3 and zone inputs are expected to be simple polygons. Sampling every
    # edge midpoint catches the relevant concave-boundary violations in the pilot.
    for index, point in enumerate(candidate):
        end = candidate[(index + 1) % len(candidate)]
        midpoint = ((point[0] + end[0]) / 2, (point[1] + end[1]) / 2)
        if not point_in_polygon(point, container) or not point_in_polygon(midpoint, container):
            return False
    return True


def collinear_overlap(first: Segment, second: Segment, tolerance: float = 1e-5) -> Segment | None:
    start, end = first
    other_start, other_end = second
    direction = _subtract(end, start)
    length_squared = _dot(direction, direction)
    length = math.sqrt(length_squared)
    if length <= tolerance or distance(other_start, other_end) <= tolerance:
        return None
    if (
        abs(_cross(direction, _subtract(other_start, start))) > tolerance * length
        or abs(_cross(direction, _subtract(other_end, start))) > tolerance * length
    ):
        return None
    first_parameter = _dot(_subtract(other_start, start), direction) / length_squared
    second_parameter = _dot(_subtract(other_end, start), direction) / length_squared
    lower = max(0.0, min(first_parameter, second_parameter))
    upper = min(1.0, max(first_parameter, second_parameter))
    if (upper - lower) * length <= tolerance:
        return None
    overlap = (
        (start[0] + direction[0] * lower, start[1] + direction[1] * lower),
        (start[0] + direction[0] * upper, start[1] + direction[1] * upper),
    )
    other_direction = _subtract(other_end, other_start)
    return (overlap[1], overlap[0]) if _dot(_subtract(overlap[1], overlap[0]), other_direction) < 0 else overlap


def polygon_boundary_overlaps(
    polygon: list[Point], segment: Segment, tolerance: float = 1e-5
) -> list[Segment]:
    overlaps: list[Segment] = []
    for index, point in enumerate(polygon):
        overlap = collinear_overlap((point, polygon[(index + 1) % len(polygon)]), segment, tolerance)
        if overlap:
            overlaps.append(overlap)
    return overlaps


def json_points(segment: Segment) -> list[dict[str, float]]:
    return [{"x": point[0], "y": point[1]} for point in segment]
