"""Pure L2/L3/L4 relation derivation from immutable window traces."""

from __future__ import annotations

import math

from shapely.geometry import LineString, Point, Polygon, mapping
from shapely.ops import unary_union

from .geometry import (
    PROJECTION_ALGORITHM_VERSION,
    WindowTrace,
    fingerprint,
    inward_normal,
    merge_intervals,
    polygon_from_target,
)


def target_fingerprint_input(target):
    geometry = polygon_from_target(target)
    return {
        "level": target.get("level"),
        "entity_id": target.get("entity_id"),
        "room_id": target.get("room_id"),
        "surface_key": target.get("surface_key"),
        "geometry": mapping(geometry),
    }


def target_fingerprint(target):
    return fingerprint(target_fingerprint_input(target))


def _line_parts(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type == "LineString":
        return [geometry]
    if hasattr(geometry, "geoms"):
        return [part for item in geometry.geoms for part in _line_parts(item)]
    return []


def _intervals_for_lines(trace, lines):
    intervals = []
    for line in lines:
        projected = [trace.line.project(Point(point), normalized=True) for point in line.coords]
        if projected:
            intervals.append((min(projected), max(projected)))
    return merge_intervals(intervals)


def _quad(trace, index, distance):
    start, end = trace.points[index : index + 2]
    normal = inward_normal(trace.room, start, end)
    return Polygon([
        start,
        end,
        (end[0] + normal[0] * distance, end[1] + normal[1] * distance),
        (start[0] + normal[0] * distance, start[1] + normal[1] * distance),
    ])


def _polygon_coordinates(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type == "Polygon":
        return list(geometry.exterior.coords)
    if hasattr(geometry, "geoms"):
        return [point for item in geometry.geoms for point in _polygon_coordinates(item)]
    return []


def _area_parts(geometry):
    """Keep disconnected target pieces separate when deriving path intervals."""
    if geometry.is_empty:
        return []
    if geometry.geom_type == "Polygon":
        return [geometry]
    if hasattr(geometry, "geoms"):
        return [part for item in geometry.geoms for part in _area_parts(item)]
    return []


def _projection_id(trace_id, target):
    token = fingerprint({
        "source_window_trace_id": trace_id,
        "level": target["level"],
        "entity_id": target["entity_id"],
    })[:24]
    return f"window-projection:{token}"


def _base_projection(trace, connection_id, target, intervals, relation, config):
    return {
        "kind": "window_projection",
        "id": _projection_id(trace.trace_id, target),
        "source_window_connection_id": connection_id,
        "source_window_trace_id": trace.trace_id,
        "target": {
            "level": target["level"],
            "entity_id": target["entity_id"],
            "room_id": target["room_id"],
        },
        "path_intervals": [
            {"path_parameter_start": start, "path_parameter_end": end}
            for start, end in intervals
        ],
        "relation": relation,
        "derivation": {
            "algorithm_version": PROJECTION_ALGORITHM_VERSION,
            "source_window_trace_fingerprint": trace.source_fingerprint,
            "target_fingerprint": target_fingerprint(target),
            "flattening_tolerance_px": config.flattening_tolerance_px,
        },
        "read_only": True,
    }


def derive_window_projections(traces, connections, targets, config):
    """Derive relations without modifying source traces, targets, or annotations."""
    connection_by_trace = {
        trace_id: connection["id"]
        for connection in connections
        for trace_id in connection.get("trace_ids", [])
    }
    projections = []
    for trace in traces:
        connection_id = connection_by_trace.get(trace.trace_id)
        if not connection_id:
            continue
        for target in targets:
            level = target.get("level")
            if level not in {"L2", "L3", "L4"}:
                raise ValueError(f"投影目标 {target.get('entity_id')} 的 level 必须是 L2/L3/L4。")
            if not target.get("entity_id") or not target.get("room_id"):
                raise ValueError("投影目标缺少 entity_id 或 room_id。")
            if target["room_id"] != trace.parent_room_id:
                continue
            if target.get("surface_key") is not None and target.get("surface_key") != trace.surface_key:
                continue
            geometry = polygon_from_target(target)
            if geometry.is_empty or not geometry.is_valid or geometry.area <= 1e-9:
                raise ValueError(f"投影目标 {target['entity_id']} 的几何无效。")
            if level == "L2":
                overlap_geometry = trace.line.intersection(geometry.boundary)
                lines = _line_parts(overlap_geometry)
                overlap_length = sum(line.length for line in lines)
                intervals = _intervals_for_lines(trace, lines)
                if overlap_length <= 1e-9 or not intervals:
                    continue
                relation = {
                    "kind": "bounds_zone",
                    "evidence": "positive_length_boundary_overlap",
                    "overlap_length_px": overlap_length,
                }
            else:
                distance = config.lower_level_inward_projection_limit_px
                if distance is None:
                    continue
                strips, intervals = [], []
                for index in range(len(trace.points) - 1):
                    strip = _quad(trace, index, distance).intersection(trace.room.polygon)
                    overlap = strip.intersection(geometry)
                    if overlap.area <= 1e-9:
                        continue
                    strips.append(strip)
                    segment = LineString(trace.points[index : index + 2])
                    parameter_start, parameter_end = trace.parameters[index : index + 2]
                    for component in _area_parts(overlap):
                        projected = [
                            segment.project(Point(point), normalized=True)
                            for point in _polygon_coordinates(component)
                        ]
                        if not projected:
                            continue
                        local_start, local_end = min(projected), max(projected)
                        intervals.append((
                            parameter_start + local_start * (parameter_end - parameter_start),
                            parameter_start + local_end * (parameter_end - parameter_start),
                        ))
                intervals = merge_intervals(intervals)
                if not strips or not intervals:
                    continue
                band = unary_union(strips)
                overlap_area = band.intersection(geometry).area
                if overlap_area <= 1e-9:
                    continue
                relation = {
                    "kind": "adjacent_to_window",
                    "evidence": "positive_area_inward_projection_intersection",
                    "overlap_area_px2": overlap_area,
                    "inward_projection_limit_px": distance,
                }
            projections.append(_base_projection(trace, connection_id, target, intervals, relation, config))
    return sorted(projections, key=lambda item: item["id"])


def projection_is_stale(projection, trace: WindowTrace, target, config, *, current_connection_id=None):
    derivation = projection.get("derivation") if isinstance(projection, dict) else {}
    if not isinstance(derivation, dict):
        return True
    if derivation.get("algorithm_version") != PROJECTION_ALGORITHM_VERSION:
        return True
    if derivation.get("source_window_trace_fingerprint") != trace.source_fingerprint:
        return True
    if current_connection_id is not None and projection.get("source_window_connection_id") != current_connection_id:
        return True
    if derivation.get("target_fingerprint") != target_fingerprint(target):
        return True
    try:
        if not math.isclose(float(derivation.get("flattening_tolerance_px")), config.flattening_tolerance_px):
            return True
    except (TypeError, ValueError):
        return True
    relation = projection.get("relation", {})
    if target.get("level") in {"L3", "L4"}:
        try:
            if not math.isclose(
                float(relation.get("inward_projection_limit_px")),
                float(config.lower_level_inward_projection_limit_px),
            ):
                return True
        except (TypeError, ValueError):
            return True
    return False


def classify_projection_freshness(projections, traces, targets, config, connections=()):
    """Return explicit current/stale wrappers without mutating schema records."""
    trace_by_id = {trace.trace_id: trace for trace in traces}
    connection_by_trace = {
        trace_id: connection.get("id")
        for connection in connections
        for trace_id in connection.get("trace_ids", [])
    }
    targets_by_key = {}
    for target in targets:
        targets_by_key.setdefault((target.get("level"), target.get("entity_id")), []).append(target)
    output = []
    for projection in projections:
        target = projection.get("target", {})
        trace = trace_by_id.get(projection.get("source_window_trace_id"))
        candidates = targets_by_key.get((target.get("level"), target.get("entity_id")), [])
        current_target = next(
            (
                item for item in candidates
                if trace is not None
                and item.get("room_id") == trace.parent_room_id
                and (item.get("surface_key") is None or item.get("surface_key") == trace.surface_key)
            ),
            None,
        )
        connection_id = connection_by_trace.get(projection.get("source_window_trace_id"))
        stale = (
            trace is None
            or current_target is None
            or connection_id is None
            or projection_is_stale(
                projection,
                trace,
                current_target,
                config,
                current_connection_id=connection_id,
            )
        )
        output.append({"status": "stale" if stale else "current", "projection": projection})
    return output
