"""Formal-save validation and refresh of server-owned ``window_context``."""

from __future__ import annotations

import copy

from .config import parse_window_config
from .geometry import (
    PARENT_ALGORITHM_VERSION,
    attach_parent,
    boundary_attachment,
    geometry_digest,
    parse_room,
    parse_window,
    result_surface_key,
)
from .pairing import derive_window_connections


class WindowValidationError(ValueError):
    def __init__(self, issues):
        self.issues = issues
        super().__init__("；".join(issue["message"] for issue in issues))


def _issue(code, message, *, result_id=None, room_ids=None, bbox=None, **extra):
    return {
        "code": code,
        "message": message,
        "result_id": result_id,
        "room_ids": sorted(room_ids or []),
        "bbox": bbox,
        **extra,
    }


def _window_results(results, controls):
    return [result for result in results if result.get("from_name") in controls]


def _room_results(results, controls):
    return [result for result in results if result.get("from_name") in controls]


def prepare_formal_results(label_config, results):
    """Validate all windows and atomically replace only their derived metadata."""
    config = parse_window_config(label_config)
    if not config.enabled:
        return results, {"window_ids": [], "window_traces": [], "window_connections": []}
    if not isinstance(results, list):
        raise WindowValidationError([_issue("invalid_result_list", "标注结果必须是列表。")])
    original_digest = geometry_digest(results)
    refreshed = copy.deepcopy(results)
    issues, rooms, traces = [], [], []
    room_surfaces = {}
    for result in _room_results(refreshed, config.room_controls):
        try:
            room = parse_room(result)
            rooms.append(room)
            room_surfaces.setdefault(room.surface_key, []).append(room)
        except (ValueError, TypeError, KeyError) as exc:
            issues.append(_issue("invalid_room_geometry", str(exc), result_id=result.get("id")))
    for result in _window_results(refreshed, config.window_controls):
        try:
            trace = parse_window(result, config.flattening_tolerance_px)
            traces.append(trace)
        except (ValueError, TypeError, KeyError) as exc:
            issues.append(_issue("invalid_window_geometry", str(exc), result_id=result.get("id")))
    identifiers = [item.result_id for item in rooms] + [item.result_id for item in traces]
    duplicates = sorted({identifier for identifier in identifiers if identifiers.count(identifier) > 1})
    if duplicates:
        issues.append(_issue(
            "duplicate_room_window_result_id",
            f"房间和窗线必须使用互不重复的稳定 result ID；重复值：{duplicates}。",
            room_ids=[room.result_id for room in rooms if room.result_id in duplicates],
            duplicate_result_ids=duplicates,
        ))
    if issues:
        raise WindowValidationError(issues)

    attached = []
    for trace in traces:
        matches = []
        for room in room_surfaces.get(trace.surface_key, []):
            attachment = boundary_attachment(
                trace,
                room,
                config.boundary_match_tolerance_px,
                config.maximum_tangent_delta_deg,
            )
            if attachment:
                matches.append((room, attachment))
        if len(matches) == 0:
            issues.append(_issue(
                "window_parent_room_not_found",
                f"窗线 {trace.result_id} 未与任何房间内轮廓形成完整正长度重叠；bbox={trace.bbox}。",
                result_id=trace.result_id,
                room_ids=[],
                bbox=trace.bbox,
            ))
        elif len(matches) > 1:
            room_ids = [room.result_id for room, _ in matches]
            issues.append(_issue(
                "window_parent_room_ambiguous",
                f"窗线 {trace.result_id} 同时命中多个房间 {sorted(room_ids)}；bbox={trace.bbox}。",
                result_id=trace.result_id,
                room_ids=room_ids,
                bbox=trace.bbox,
            ))
        else:
            attached.append(attach_parent(trace, *matches[0]))
    if issues:
        raise WindowValidationError(issues)

    connections, searches, unresolved = [], {}, []
    attached_surfaces = {}
    for trace in attached:
        attached_surfaces.setdefault(trace.surface_key, []).append(trace)
    for surface in sorted(attached_surfaces, key=repr):
        surface_connections, surface_searches, surface_unresolved = derive_window_connections(
            attached_surfaces[surface],
            config,
            search_complete=True,
        )
        connections.extend(surface_connections)
        searches.update(surface_searches)
        unresolved.extend(surface_unresolved)
    connections.sort(key=lambda item: item["id"])
    if unresolved:
        raise WindowValidationError([
            _issue(
                "window_pairing_not_mutual_best",
                f"窗线 {item['result_id']} 存在对侧候选 {item['candidate_trace_ids']}，但未形成互为最佳配对；"
                f"涉及房间 {item['room_ids']}；bbox={item['bbox']}。",
                result_id=item["result_id"],
                room_ids=item["room_ids"],
                bbox=item["bbox"],
                candidate_trace_ids=item["candidate_trace_ids"],
            )
            for item in unresolved
        ])

    connection_by_trace = {
        trace_id: connection
        for connection in connections
        for trace_id in connection["trace_ids"]
    }
    result_by_id = {(result_surface_key(result), result.get("id")): result for result in refreshed}
    changed = []
    for trace in attached:
        result = result_by_id[(trace.surface_key, trace.result_id)]
        connection = connection_by_trace[trace.trace_id]
        context = {
            "schema_version": 1,
            "parent_room_id": trace.parent_room_id,
            "source_trace_id": trace.trace_id,
            "source_window_trace_fingerprint": trace.source_fingerprint,
            "source_room_fingerprint": trace.room.source_fingerprint,
            "boundary_attachment": copy.deepcopy(trace.boundary_attachment),
            "parent_derivation": {
                "algorithm_version": PARENT_ALGORITHM_VERSION,
                "source_window_trace_fingerprint": trace.source_fingerprint,
                "room_fingerprint": trace.room.source_fingerprint,
                "boundary_match_tolerance_px": config.boundary_match_tolerance_px,
                "flattening_tolerance_px": config.flattening_tolerance_px,
            },
            "derivation_status": "current",
            "pairing_status": "exterior" if connection["connects_to_exterior"] else "paired",
            "pairing_search": searches[trace.trace_id],
            "connection": copy.deepcopy(connection),
            "window_matching_policy": config.matching_policy(),
        }
        meta = copy.deepcopy(result.get("meta")) if isinstance(result.get("meta"), dict) else {}
        if meta.get("window_context") != context:
            meta["window_context"] = context
            result["meta"] = meta
            changed.append(trace.result_id)

    if geometry_digest(refreshed) != original_digest:
        raise RuntimeError("窗户元数据刷新不得修改原始标注几何或结果顺序。")
    return refreshed, {
        "window_ids": sorted(changed),
        "window_traces": attached,
        "window_connections": connections,
        "window_matching_policy": config.matching_policy(),
    }
