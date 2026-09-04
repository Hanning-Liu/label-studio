"""Server-owned L2/L3 window projection persistence.

The adapter consumes copied, read-only Room/Window references and manual target
geometry.  Draft writes preserve the last derived relations and mark them
stale when an input changes.  Formal writes always rebuild the complete set.
No result identity, ordering, label, or geometry value is changed.
"""

from __future__ import annotations

import copy
import math

from shapely.ops import unary_union

from .config import WindowConfig
from .geometry import (
    PAIRING_ALGORITHM_VERSION,
    PARENT_ALGORITHM_VERSION,
    PROJECTION_ALGORITHM_VERSION,
    attach_parent,
    boundary_attachment,
    fingerprint,
    geometry_digest,
    parse_room,
    parse_window,
    polygon_from_target,
    result_surface_key,
)
from .pairing import derive_window_connections
from .projections import derive_window_projections, projection_is_stale, target_fingerprint


ROOM_CONTROLS = {"room_rectangle", "room_polygon"}
WINDOW_CONTROL = "window_vector"
L2_CONTROLS = {"zone_rectangle", "zone_polygon"}
L3_CONTROLS = {"occupancy_rectangle", "occupancy_polygon"}
DERIVED_META_KEYS = {"window_projections", "window_projection_state"}


class DownstreamWindowError(ValueError):
    pass


def _finite(value, name, *, positive=True, nullable=False):
    if nullable and value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise DownstreamWindowError(f"窗户策略 {name} 不是数字。") from exc
    if not math.isfinite(number) or (positive and number <= 0):
        raise DownstreamWindowError(f"窗户策略 {name} 必须是正有限数字。")
    return number


def _window_context(result):
    meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
    context = meta.get("window_context")
    return context if isinstance(context, dict) else {}


def _policy_from_results(results):
    windows = [result for result in results if result.get("from_name") == WINDOW_CONTROL]
    policies = [
        _window_context(result).get("window_matching_policy")
        for result in windows
        if isinstance(_window_context(result).get("window_matching_policy"), dict)
    ]
    if policies and any(fingerprint(policy) != fingerprint(policies[0]) for policy in policies[1:]):
        raise DownstreamWindowError("权威窗线携带了不一致的 window_matching_policy。")
    policy = copy.deepcopy(policies[0]) if policies else {}
    if windows and not policy:
        context = _window_context(windows[0])
        parent = context.get("parent_derivation") if isinstance(context.get("parent_derivation"), dict) else {}
        connection = context.get("connection") if isinstance(context.get("connection"), dict) else {}
        evidence = connection.get("evidence") if isinstance(connection.get("evidence"), dict) else {}
        policy = {
            "pairing_rule": "mutual_outward_projection",
            "boundary_match_tolerance_px": parent.get("boundary_match_tolerance_px", 2),
            "pair_search_limit_px": evidence.get("pair_search_limit_px", 40),
            "minimum_projected_overlap_px": 8,
            "maximum_tangent_delta_deg": 10,
            "flattening_tolerance_px": parent.get("flattening_tolerance_px", 0.5),
            "lower_level_inward_projection_limit_px": 60,
        }
    if windows and policy.get("pairing_rule") != "mutual_outward_projection":
        raise DownstreamWindowError("窗户策略 pairing_rule 必须是 mutual_outward_projection。")
    angle = _finite(policy.get("maximum_tangent_delta_deg", 10), "maximum_tangent_delta_deg", positive=False)
    if angle < 0 or angle > 90:
        raise DownstreamWindowError("maximum_tangent_delta_deg 必须介于 0 和 90。")
    return WindowConfig(
        enabled=True,
        boundary_match_tolerance_px=_finite(
            policy.get("boundary_match_tolerance_px", 2), "boundary_match_tolerance_px"
        ),
        pair_search_limit_px=_finite(policy.get("pair_search_limit_px", 40), "pair_search_limit_px"),
        minimum_projected_overlap_px=_finite(
            policy.get("minimum_projected_overlap_px", 8), "minimum_projected_overlap_px"
        ),
        maximum_tangent_delta_deg=angle,
        flattening_tolerance_px=_finite(
            policy.get("flattening_tolerance_px", 0.5), "flattening_tolerance_px"
        ),
        lower_level_inward_projection_limit_px=_finite(
            policy.get("lower_level_inward_projection_limit_px", 60),
            "lower_level_inward_projection_limit_px",
            nullable=True,
        ),
    )


def _equivalent(first, second):
    try:
        return fingerprint(first) == fingerprint(second)
    except (TypeError, ValueError):
        return False


def authoritative_window_domain(results):
    """Rebuild and strictly verify authoritative copied window references."""
    if not isinstance(results, list):
        raise DownstreamWindowError("下游标注结果必须是列表。")
    config = _policy_from_results(results)
    room_results = [result for result in results if result.get("from_name") in ROOM_CONTROLS]
    window_results = [result for result in results if result.get("from_name") == WINDOW_CONTROL]
    if not window_results:
        return [], [], config
    try:
        rooms = [parse_room(result) for result in room_results]
    except (ValueError, TypeError, KeyError) as exc:
        raise DownstreamWindowError(f"权威房间参考无效：{exc}") from exc
    room_by_id = {(room.surface_key, room.result_id): room for room in rooms}
    if len(room_by_id) != len(rooms):
        raise DownstreamWindowError("同一标注画布中的权威房间稳定 node_id 重复。")

    traces = []
    saved_connections = {}
    saved_searches = {}
    context_by_trace = {}
    for result in window_results:
        result_id = result.get("id")
        context = _window_context(result)
        try:
            trace = parse_window(result, config.flattening_tolerance_px)
        except (ValueError, TypeError, KeyError) as exc:
            raise DownstreamWindowError(f"权威窗线 {result_id} 无效：{exc}") from exc
        room = room_by_id.get((trace.surface_key, context.get("parent_room_id")))
        parent = context.get("parent_derivation") if isinstance(context.get("parent_derivation"), dict) else {}
        saved_attachment = context.get("boundary_attachment")
        search = context.get("pairing_search") if isinstance(context.get("pairing_search"), dict) else {}
        connection = context.get("connection") if isinstance(context.get("connection"), dict) else {}
        if (
            context.get("schema_version") != 1
            or context.get("derivation_status") != "current"
            or context.get("source_trace_id") != trace.trace_id
            or context.get("source_window_trace_fingerprint") != trace.source_fingerprint
            or room is None
            or context.get("source_room_fingerprint") != room.source_fingerprint
            or parent.get("algorithm_version") != PARENT_ALGORITHM_VERSION
            or parent.get("source_window_trace_fingerprint") != trace.source_fingerprint
            or parent.get("room_fingerprint") != room.source_fingerprint
            or parent.get("boundary_match_tolerance_px") != config.boundary_match_tolerance_px
            or parent.get("flattening_tolerance_px") != config.flattening_tolerance_px
            or not _equivalent(context.get("window_matching_policy"), config.matching_policy())
            or search.get("status") != "complete"
            or search.get("algorithm_version") != PAIRING_ALGORITHM_VERSION
            or connection.get("kind") != "window_connection"
            or connection.get("read_only") is not True
            or trace.trace_id not in (connection.get("trace_ids") or [])
        ):
            raise DownstreamWindowError(f"权威窗线 {result_id} 的 window_context 已过期或不完整。")
        actual_attachment = boundary_attachment(
            trace,
            room,
            config.boundary_match_tolerance_px,
            config.maximum_tangent_delta_deg,
        )
        if actual_attachment is None or not _equivalent(saved_attachment, actual_attachment):
            raise DownstreamWindowError(f"权威窗线 {result_id} 的房间边界归属已过期。")
        attached = attach_parent(trace, room, actual_attachment)
        traces.append(attached)
        context_by_trace[trace.trace_id] = context
        connection_id = connection.get("id")
        if not isinstance(connection_id, str) or not connection_id:
            raise DownstreamWindowError(f"权威窗线 {result_id} 缺少连接 ID。")
        if connection_id in saved_connections and not _equivalent(saved_connections[connection_id], connection):
            raise DownstreamWindowError(f"窗户连接 {connection_id} 在两侧记录中不一致。")
        saved_connections[connection_id] = copy.deepcopy(connection)
        saved_searches[trace.trace_id] = copy.deepcopy(search)

    expected_connections, expected_searches, unresolved = [], {}, []
    traces_by_surface = {}
    for trace in traces:
        traces_by_surface.setdefault(trace.surface_key, []).append(trace)
    for surface in sorted(traces_by_surface, key=repr):
        surface_connections, surface_searches, surface_unresolved = derive_window_connections(
            traces_by_surface[surface], config, search_complete=True
        )
        expected_connections.extend(surface_connections)
        expected_searches.update(surface_searches)
        unresolved.extend(surface_unresolved)
    if unresolved:
        raise DownstreamWindowError("权威窗户参考没有完成 mutual_outward_projection 配对。")
    expected_by_id = {connection["id"]: connection for connection in expected_connections}
    if not _equivalent(expected_by_id, saved_connections) or not _equivalent(expected_searches, saved_searches):
        raise DownstreamWindowError("权威窗户连接或完整搜索证据已过期。")
    expected_connection_by_trace = {
        trace_id: connection
        for connection in expected_connections
        for trace_id in connection.get("trace_ids", [])
    }
    for trace in traces:
        connection = expected_connection_by_trace[trace.trace_id]
        expected_status = "exterior" if connection.get("connects_to_exterior") else "paired"
        if context_by_trace[trace.trace_id].get("pairing_status") != expected_status:
            raise DownstreamWindowError(f"权威窗线 {trace.result_id} 的 pairing_status 已过期。")
    return traces, expected_connections, config


def validate_authoritative_window_contexts(results):
    """Raise when any copied window context is not reproducibly current."""
    if any(result.get("from_name") == WINDOW_CONTROL for result in results):
        authoritative_window_domain(results)
    return True


def _target_context(result, level):
    meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
    if level == "L2":
        context = meta.get("partition_context") if isinstance(meta.get("partition_context"), dict) else {}
        return result.get("id"), context.get("parent_room_id")
    context = meta.get("occupancy_context") if isinstance(meta.get("occupancy_context"), dict) else {}
    entity_id = context.get("group_id") or context.get("logical_id") or result.get("id")
    return entity_id, context.get("parent_room_id")


def _targets(results, level, *, strict=True):
    controls = L2_CONTROLS if level == "L2" else L3_CONTROLS
    grouped = {}
    for index, result in enumerate(results):
        if result.get("from_name") not in controls:
            continue
        entity_id, room_id = _target_context(result, level)
        if not isinstance(entity_id, str) or not entity_id or not isinstance(room_id, str) or not room_id:
            if strict:
                raise DownstreamWindowError(f"{level} 目标 {result.get('id')} 缺少稳定实体或房间归属。")
            continue
        try:
            geometry = polygon_from_target(result)
        except (ValueError, TypeError, KeyError) as exc:
            if strict:
                raise DownstreamWindowError(f"{level} 目标 {result.get('id')} 几何无效：{exc}") from exc
            continue
        surface = result_surface_key(result)
        key = (surface, entity_id, room_id)
        grouped.setdefault(key, {"geometries": [], "indexes": []})
        grouped[key]["geometries"].append(geometry)
        grouped[key]["indexes"].append(index)
    targets = []
    for (surface, entity_id, room_id), data in sorted(grouped.items(), key=lambda item: repr(item[0])):
        geometry = unary_union(data["geometries"])
        if geometry.geom_type not in {"Polygon", "MultiPolygon"} or geometry.is_empty or not geometry.is_valid:
            if strict:
                raise DownstreamWindowError(f"{level} 目标 {entity_id} 合并后不是有效 Polygon/MultiPolygon。")
            continue
        targets.append({
            "level": level,
            "entity_id": entity_id,
            "room_id": room_id,
            "surface_key": surface,
            "geometry": geometry,
            "result_indexes": data["indexes"],
        })
    return targets


def _has_window_vectors(results):
    return any(result.get("from_name") == WINDOW_CONTROL for result in results)


def _has_derived_window_meta(results):
    return any(
        isinstance(result.get("meta"), dict)
        and any(key in result["meta"] for key in DERIVED_META_KEYS)
        for result in results
    )


def _linked_state(traces, connections, target, config):
    connection_by_trace = {
        trace_id: connection["id"]
        for connection in connections
        for trace_id in connection.get("trace_ids", [])
    }
    linked = [
        {
            "source_window_trace_id": trace.trace_id,
            "source_window_trace_fingerprint": trace.source_fingerprint,
            "parent_room_id": trace.parent_room_id,
            "source_room_fingerprint": trace.room.source_fingerprint,
            "source_window_connection_id": connection_by_trace.get(trace.trace_id),
        }
        for trace in traces
        if trace.parent_room_id == target["room_id"] and trace.surface_key == target["surface_key"]
    ]
    linked.sort(key=lambda item: item["source_window_trace_id"])
    return {
        "schema_version": 1,
        "status": "current",
        "level": target["level"],
        "algorithm_version": PROJECTION_ALGORITHM_VERSION,
        "target_fingerprint": target_fingerprint(target),
        "policy_fingerprint": fingerprint(config.matching_policy()),
        "linked_traces": linked,
    }


def _copy_server_meta(result, previous):
    meta = copy.deepcopy(result.get("meta")) if isinstance(result.get("meta"), dict) else {}
    previous_meta = previous.get("meta") if isinstance(previous, dict) and isinstance(previous.get("meta"), dict) else {}
    for key in DERIVED_META_KEYS:
        if key in previous_meta:
            meta[key] = copy.deepcopy(previous_meta[key])
        else:
            meta.pop(key, None)
    result["meta"] = meta
    return meta


def _stale_reasons(previous_state, current_state, source_error=None):
    reasons = []
    if source_error:
        reasons.append("authoritative_window_reference_invalid")
    if not isinstance(previous_state, dict):
        reasons.append("not_recomputed")
        return reasons
    if previous_state.get("target_fingerprint") != current_state.get("target_fingerprint"):
        reasons.append("target_geometry_changed")
    if previous_state.get("policy_fingerprint") != current_state.get("policy_fingerprint"):
        reasons.append("projection_threshold_changed")
    old_links = {
        item.get("source_window_trace_id"): item
        for item in previous_state.get("linked_traces", [])
        if isinstance(item, dict)
    }
    new_links = {
        item.get("source_window_trace_id"): item
        for item in current_state.get("linked_traces", [])
        if isinstance(item, dict)
    }
    if old_links.keys() != new_links.keys():
        reasons.append("source_window_set_changed")
    for trace_id in old_links.keys() & new_links.keys():
        old, new = old_links[trace_id], new_links[trace_id]
        if old.get("source_window_trace_fingerprint") != new.get("source_window_trace_fingerprint"):
            reasons.append("source_window_geometry_changed")
        if old.get("source_room_fingerprint") != new.get("source_room_fingerprint"):
            reasons.append("source_room_geometry_changed")
        if old.get("source_window_connection_id") != new.get("source_window_connection_id"):
            reasons.append("source_window_connection_changed")
    if previous_state.get("algorithm_version") != PROJECTION_ALGORITHM_VERSION:
        reasons.append("projection_algorithm_changed")
    return sorted(set(reasons))


def prepare_downstream_window_results(results, *, level, submission, prior_results=None):
    """Refresh formal projections or preserve-and-mark stale draft projections."""
    if level not in {"L2", "L3"}:
        raise ValueError("持久化下游窗户投影仅支持 L2/L3；L4 由纯函数聚合管线调用。")
    if not isinstance(results, list):
        raise DownstreamWindowError("result 必须是列表。")
    original_digest = geometry_digest(results)
    output = copy.deepcopy(results)
    previous_results = prior_results if isinstance(prior_results, list) else []
    # This hook is installed in the existing L2/L3 write paths.  Projects that
    # have never contained a window reference must remain byte-for-byte
    # compatible: do not introduce empty derived metadata or recompute hashes.
    if not (
        _has_window_vectors(output)
        or _has_window_vectors(previous_results)
        or _has_derived_window_meta(output)
        or _has_derived_window_meta(previous_results)
    ):
        return output, []
    previous_by_key = {
        (result_surface_key(result), result.get("id"), result.get("from_name")): result
        for result in previous_results
    }
    controls = L2_CONTROLS if level == "L2" else L3_CONTROLS
    legal_upstream_controls = L2_CONTROLS if level == "L3" else set()
    changed = []
    # These keys are server-owned and valid only on the geometry result that
    # is their projection target. Never accept them on label/reference rows,
    # even though optimistic locking intentionally excludes derived metadata.
    for result in output:
        if result.get("from_name") in controls | legal_upstream_controls or not isinstance(result.get("meta"), dict):
            continue
        meta = copy.deepcopy(result["meta"])
        removed = False
        for key in DERIVED_META_KEYS:
            removed = meta.pop(key, None) is not None or removed
        if removed:
            if meta:
                result["meta"] = meta
            else:
                result.pop("meta", None)
            changed.append(result.get("id"))
    targets = _targets(output, level, strict=submission)
    try:
        traces, connections, config = authoritative_window_domain(output)
        source_error = None
    except DownstreamWindowError as exc:
        if submission:
            raise
        traces, connections = [], []
        try:
            config = _policy_from_results(output)
        except DownstreamWindowError:
            # Draft writes are intentionally permissive.  The invalid policy
            # is retained as source_error and formal submission will reject it.
            config = WindowConfig(enabled=True)
        source_error = str(exc)
    projections_by_target = {}
    if submission:
        # Public projection.target deliberately has no surface_key (the public
        # schema is closed). Derive each internal surface target separately so
        # equal entity IDs on different Image items cannot share a bucket.
        for target in targets:
            key = (target["surface_key"], target["level"], target["entity_id"], target["room_id"])
            surface_traces = [trace for trace in traces if trace.surface_key == target["surface_key"]]
            surface_trace_ids = {trace.trace_id for trace in surface_traces}
            surface_connections = [
                connection for connection in connections
                if set(connection.get("trace_ids", [])).issubset(surface_trace_ids)
            ]
            projections_by_target[key] = derive_window_projections(
                surface_traces, surface_connections, [target], config
            )

    for target in targets:
        state = _linked_state(traces, connections, target, config)
        records = projections_by_target.get(
            (target["surface_key"], target["level"], target["entity_id"], target["room_id"]), []
        )
        for index in target["result_indexes"]:
            result = output[index]
            previous = previous_by_key.get(
                (result_surface_key(result), result.get("id"), result.get("from_name")), {}
            )
            meta = _copy_server_meta(result, previous)
            old_state = copy.deepcopy(meta.get("window_projection_state"))
            if submission:
                new_state = state
                new_records = copy.deepcopy(records)
            else:
                new_records = copy.deepcopy(meta.get("window_projections", []))
                reasons = _stale_reasons(old_state, state, source_error)
                if not reasons and old_state.get("status") == "current":
                    new_state = old_state
                else:
                    new_state = {
                        **state,
                        "status": "stale",
                        "stale_reasons": sorted(set(reasons + (old_state.get("stale_reasons", []) if isinstance(old_state, dict) else []))),
                    }
                    if source_error:
                        new_state["source_error"] = source_error
            if meta.get("window_projections") != new_records or meta.get("window_projection_state") != new_state:
                changed.append(result.get("id"))
            meta["window_projections"] = new_records
            meta["window_projection_state"] = new_state
            result["meta"] = meta

    processed_indexes = {
        index
        for target in targets
        for index in target["result_indexes"]
    }
    if not submission:
        for index, result in enumerate(output):
            if index in processed_indexes or result.get("from_name") not in controls:
                continue
            previous = previous_by_key.get(
                (result_surface_key(result), result.get("id"), result.get("from_name")), {}
            )
            meta = _copy_server_meta(result, previous)
            if not any(key in meta for key in DERIVED_META_KEYS):
                # An unfinished new draft target has no derived data to stale.
                continue
            old_state = meta.get("window_projection_state")
            state = copy.deepcopy(old_state) if isinstance(old_state, dict) else {
                "schema_version": 1,
                "level": level,
                "algorithm_version": PROJECTION_ALGORITHM_VERSION,
                "linked_traces": [],
            }
            state["status"] = "stale"
            state["stale_reasons"] = sorted(set((state.get("stale_reasons") or []) + ["target_geometry_or_parent_invalid"]))
            meta["window_projection_state"] = state
            result["meta"] = meta
            changed.append(result.get("id"))

    if geometry_digest(output) != original_digest:
        raise RuntimeError("下游窗户投影不得修改结果 ID、顺序或原始几何。")
    return output, sorted({identifier for identifier in changed if identifier})


def validate_persisted_projection_state(results, *, level):
    """Validate formal persisted relations, including current connection IDs."""
    if not (_has_window_vectors(results) or _has_derived_window_meta(results)):
        return True
    traces, connections, config = authoritative_window_domain(results)
    targets = _targets(results, level)
    connection_by_trace = {
        trace_id: connection["id"]
        for connection in connections
        for trace_id in connection.get("trace_ids", [])
    }
    trace_by_id = {trace.trace_id: trace for trace in traces}
    expected = {}
    for target in targets:
        key = (target["surface_key"], target["level"], target["entity_id"], target["room_id"])
        surface_traces = [trace for trace in traces if trace.surface_key == target["surface_key"]]
        surface_trace_ids = {trace.trace_id for trace in surface_traces}
        surface_connections = [
            connection for connection in connections
            if set(connection.get("trace_ids", [])).issubset(surface_trace_ids)
        ]
        expected[key] = derive_window_projections(
            surface_traces, surface_connections, [target], config
        )
    for target in targets:
        expected_records = expected.get(
            (target["surface_key"], target["level"], target["entity_id"], target["room_id"]), []
        )
        expected_state = _linked_state(traces, connections, target, config)
        for index in target["result_indexes"]:
            meta = results[index].get("meta") if isinstance(results[index].get("meta"), dict) else {}
            records = meta.get("window_projections")
            state = meta.get("window_projection_state")
            if state != expected_state or records != expected_records:
                raise DownstreamWindowError(f"{level} 目标 {results[index].get('id')} 的窗户投影已过期。")
            for record in records:
                trace = trace_by_id.get(record.get("source_window_trace_id"))
                if trace is None or projection_is_stale(
                    record,
                    trace,
                    target,
                    config,
                    current_connection_id=connection_by_trace.get(trace.trace_id),
                ):
                    raise DownstreamWindowError(f"窗户投影 {record.get('id')} 的来源、目标或连接已过期。")
    return True
