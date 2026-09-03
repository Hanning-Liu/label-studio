"""Backward-compatible floorplan-unified/4 window aggregate adapter."""

from __future__ import annotations

import copy

from .geometry import WindowTrace, fingerprint


def trace_record(trace: WindowTrace, provenance=None):
    provenance_keys = ("project_id", "task_id", "annotation_id")
    if (
        not provenance
        or any(
            isinstance(provenance.get(key), bool)
            or not isinstance(provenance.get(key), int)
            or provenance[key] <= 0
            for key in provenance_keys
        )
    ):
        raise ValueError("v4 window trace 聚合需要 project_id/task_id/annotation_id provenance。")
    if trace.room is None or not trace.parent_room_id or not trace.boundary_attachment:
        raise ValueError(f"v4 window trace {trace.trace_id} 尚未完成房间归属。")
    allowed_vertex_keys = ("id", "x", "y", "isBezier", "prevPointId", "controlPoint1", "controlPoint2", "disconnected")
    schema_vertices = []
    for vertex in trace.raw_vertices:
        item = {key: copy.deepcopy(vertex[key]) for key in allowed_vertex_keys if key in vertex}
        for key in ("controlPoint1", "controlPoint2"):
            if key in item:
                item[key] = {axis: item[key][axis] for axis in ("x", "y")}
        schema_vertices.append(item)
    record = {
        "kind": "window_trace",
        "id": trace.trace_id,
        "label": "window",
        "path": {
            "path_kind": trace.path_kind,
            "closed": False,
            "vertices": schema_vertices,
        },
        "parent_room_id": trace.parent_room_id,
        "boundary_attachment": copy.deepcopy(trace.boundary_attachment),
        "parent_derivation": {
            "algorithm_version": "window-parent-room/1",
            "source_window_trace_fingerprint": trace.source_fingerprint,
            "room_fingerprint": trace.room.source_fingerprint,
            "boundary_match_tolerance_px": None,
            "flattening_tolerance_px": None,
        },
        "provenance": {
            **{key: provenance[key] for key in provenance_keys},
            "result_id": trace.result_id,
        },
    }
    return record


def augment_floorplan_aggregate(base, *, traces=None, connections=None, projections=None, config=None, provenance=None):
    """Add window collections only to v4; all older aggregates remain deep-equal."""
    output = copy.deepcopy(base)
    if not isinstance(output, dict) or output.get("schema") != "floorplan-unified/4":
        return output
    if traces is None and connections is None and projections is None and config is None and provenance is None:
        return output
    if traces and config is None:
        raise ValueError("v4 window trace 聚合需要 WindowConfig。")
    if traces is not None:
        records = []
        for trace in traces:
            record = trace_record(trace, provenance)
            if config is not None:
                record["parent_derivation"]["boundary_match_tolerance_px"] = config.boundary_match_tolerance_px
                record["parent_derivation"]["flattening_tolerance_px"] = config.flattening_tolerance_px
            records.append(record)
        output["window_traces"] = sorted(records, key=lambda item: item["id"])
    if config is not None:
        output["window_matching_policy"] = config.matching_policy()
    if connections is not None:
        output["window_connections"] = sorted(copy.deepcopy(list(connections)), key=lambda item: item["id"])
    if projections is not None:
        output["window_projections"] = sorted(copy.deepcopy(list(projections)), key=lambda item: item["id"])
    output.setdefault("furniture_instances", [])
    # Aggregate fingerprints are derived after every read-only window field has
    # been replaced, never by changing any source annotation result.
    if "fingerprint" in output:
        fingerprint_input = {key: value for key, value in output.items() if key != "fingerprint"}
        output["fingerprint"] = fingerprint(fingerprint_input)
    return output
