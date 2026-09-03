#!/usr/bin/env python3
"""Build a FunctionZone v3 task after its Room v3 annotation is approved."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Any

from room_v3_common import (
    RoomV3Error,
    collinear_overlap,
    json_points,
    load_single_task,
    merge_meta,
    migration_context,
    polygon_inside_polygon,
    result_polygon,
    select_annotation,
)


ZONE_CONTROLS = {"zone_rectangle", "zone_polygon", "function_zone"}
CONNECTION_CONTROLS = {"connection_vector", "visual_connection_vector"}
ROOM_CONTROLS = {"room_rectangle", "room_polygon"}
PORTAL_CONTROLS = {"portal_rectangle", "portal_vector"}
WINDOW_CONTROLS = {"window_vector"}
WINDOW_PARENT_ALGORITHM_VERSION = "window-parent-room/1"
WINDOW_PAIRING_ALGORITHM_VERSION = "window-pairing/1"


def _canonical_fingerprint_value(value: Any) -> Any:
    """Match ``tasks.windows.geometry.fingerprint`` without importing Shapely."""
    if isinstance(value, dict):
        return {key: _canonical_fingerprint_value(value[key]) for key in sorted(value)}
    if isinstance(value, (list, tuple)):
        return [_canonical_fingerprint_value(item) for item in value]
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            raise RoomV3Error("Room v3 window fingerprint contains a non-finite number")
        fixed = format(value, ".10f")
        return "0.0000000000" if fixed == "-0.0000000000" else fixed
    return value


def _fingerprint(value: Any) -> str:
    encoded = json.dumps(
        _canonical_fingerprint_value(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _number(value: Any, field: str, result_id: str, *, positive: bool = False) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise RoomV3Error(f"Room v3 window {result_id} has invalid {field}") from exc
    if not math.isfinite(number) or (positive and number <= 0):
        raise RoomV3Error(f"Room v3 window {result_id} has invalid {field}")
    return number


def _surface_key(result: dict[str, Any]) -> tuple[str, str]:
    item_index = result.get("item_index")
    return str(result.get("to_name") or ""), json.dumps(
        None if item_index is None else item_index,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def _stable_room_id(result: dict[str, Any]) -> str | None:
    meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
    node = meta.get("room_graph_node") if isinstance(meta.get("room_graph_node"), dict) else {}
    node_id = node.get("node_id")
    return node_id if isinstance(node_id, str) and node_id else result.get("id")


def _room_fingerprint(result: dict[str, Any]) -> str:
    result_id = str(result.get("id") or "unknown")
    width = _number(result.get("original_width"), "original_width", result_id, positive=True)
    height = _number(result.get("original_height"), "original_height", result_id, positive=True)
    meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
    return _fingerprint({
        "id": _stable_room_id(result),
        "type": result.get("type"),
        "value": copy.deepcopy(result.get("value")),
        "width": width,
        "height": height,
        "image_rotation": result.get("image_rotation") if result.get("image_rotation") is not None else 0,
        "room_graph_node": copy.deepcopy(meta.get("room_graph_node")),
    })


def _window_trace_fingerprint(result: dict[str, Any]) -> str:
    result_id = str(result.get("id") or "unknown")
    width = _number(result.get("original_width"), "original_width", result_id, positive=True)
    height = _number(result.get("original_height"), "original_height", result_id, positive=True)
    value = result.get("value") if isinstance(result.get("value"), dict) else {}
    return _fingerprint({
        "closed": False,
        "value": {"vertices": copy.deepcopy(value.get("vertices"))},
        "label": "window",
        "width": width,
        "height": height,
    })


def _same_number(first: Any, second: Any) -> bool:
    try:
        return math.isclose(float(first), float(second), rel_tol=1e-12, abs_tol=1e-12)
    except (TypeError, ValueError):
        return False


def _validate_window_vector(result: dict[str, Any]) -> None:
    result_id = str(result.get("id") or "unknown")
    value = result.get("value") if isinstance(result.get("value"), dict) else {}
    vertices = value.get("vertices")
    if result.get("type") != "vectorlabels" or value.get("closed") is not False:
        raise RoomV3Error(f"Room v3 window {result_id} must be an open VectorLabels result")
    labels = value.get("vectorlabels")
    if not isinstance(labels, list) or len(labels) != 1 or str(labels[0]).strip().lower() != "window":
        raise RoomV3Error(f"Room v3 window {result_id} must use exactly the Window label")
    if not isinstance(vertices, list) or len(vertices) < 2:
        raise RoomV3Error(f"Room v3 window {result_id} must contain at least two vertices")
    identifiers: set[str] = set()
    previous_ids: list[str | None] = []
    for vertex in vertices:
        if not isinstance(vertex, dict):
            raise RoomV3Error(f"Room v3 window {result_id} contains an invalid vertex")
        vertex_id = vertex.get("id")
        if not isinstance(vertex_id, str) or not vertex_id or vertex_id in identifiers:
            raise RoomV3Error(f"Room v3 window {result_id} has missing or duplicate vertex IDs")
        identifiers.add(vertex_id)
        previous_ids.append(vertex.get("prevPointId"))
        if not isinstance(vertex.get("isBezier"), bool):
            raise RoomV3Error(f"Room v3 window {result_id} has a vertex without boolean isBezier")
        if vertex.get("disconnected") is True or vertex.get("isBranching") is True:
            raise RoomV3Error(f"Room v3 window {result_id} must be one continuous, unbranched path")
        for field in ("x", "y"):
            coordinate = _number(vertex.get(field), f"vertex.{field}", result_id)
            if coordinate < 0 or coordinate > 100:
                raise RoomV3Error(f"Room v3 window {result_id} has a vertex outside 0..100")
        if vertex["isBezier"] and not all(isinstance(vertex.get(key), dict) for key in ("controlPoint1", "controlPoint2")):
            raise RoomV3Error(f"Room v3 window {result_id} has incomplete Bezier control points")
        for key in ("controlPoint1", "controlPoint2"):
            if key not in vertex:
                continue
            point = vertex[key]
            if not isinstance(point, dict):
                raise RoomV3Error(f"Room v3 window {result_id} has an invalid {key}")
            for field in ("x", "y"):
                coordinate = _number(point.get(field), f"{key}.{field}", result_id)
                if coordinate < 0 or coordinate > 100:
                    raise RoomV3Error(f"Room v3 window {result_id} has a control point outside 0..100")
    roots = sum(previous in (None, "") for previous in previous_ids)
    children = [previous for previous in previous_ids if previous not in (None, "")]
    if roots != 1 or any(previous not in identifiers for previous in children) or len(children) != len(set(children)):
        raise RoomV3Error(f"Room v3 window {result_id} has an invalid open vertex chain")


def _validate_policy(policy: Any, result_id: str) -> dict[str, Any]:
    if not isinstance(policy, dict) or policy.get("pairing_rule") != "mutual_outward_projection":
        raise RoomV3Error(f"Room v3 window {result_id} has an invalid matching policy")
    for field in (
        "boundary_match_tolerance_px",
        "pair_search_limit_px",
        "minimum_projected_overlap_px",
        "flattening_tolerance_px",
    ):
        _number(policy.get(field), field, result_id, positive=True)
    angle = _number(policy.get("maximum_tangent_delta_deg"), "maximum_tangent_delta_deg", result_id)
    if angle < 0 or angle > 90:
        raise RoomV3Error(f"Room v3 window {result_id} has an invalid maximum_tangent_delta_deg")
    inward = policy.get("lower_level_inward_projection_limit_px")
    if inward is not None:
        _number(inward, "lower_level_inward_projection_limit_px", result_id, positive=True)
    return policy


def _validate_window_references(results: list[dict[str, Any]]) -> None:
    """Reject pending/stale contexts using only their immutable source fingerprints.

    The online save path remains responsible for computational geometry.  This
    offline migration verifies that the approved result bytes still match the
    room/window fingerprints and complete-search evidence produced there.  It
    intentionally has no Label Studio, Django, or Shapely import dependency.
    """
    rooms: dict[tuple[tuple[str, str], str], tuple[dict[str, Any], str]] = {}
    windows: list[dict[str, Any]] = []
    for result in results:
        if not isinstance(result, dict):
            continue
        if result.get("from_name") in ROOM_CONTROLS:
            room_id = _stable_room_id(result)
            if not isinstance(room_id, str) or not room_id:
                raise RoomV3Error("Room v3 window validation found a room without a stable ID")
            key = (_surface_key(result), room_id)
            if key in rooms:
                raise RoomV3Error(f"Room v3 window validation found duplicate room ID {room_id}")
            rooms[key] = (result, _room_fingerprint(result))
        elif result.get("from_name") in WINDOW_CONTROLS:
            windows.append(result)

    trace_by_id: dict[str, tuple[dict[str, Any], dict[str, Any], str]] = {}
    connection_by_id: dict[str, dict[str, Any]] = {}
    first_policy_fingerprint: str | None = None
    for result in windows:
        _validate_window_vector(result)
        result_id = result.get("id")
        trace_id = f"window-trace:{result_id}"
        if trace_id in trace_by_id:
            raise RoomV3Error(f"Room v3 window result ID is duplicated: {result_id}")
        trace_fingerprint = _window_trace_fingerprint(result)
        meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
        context = meta.get("window_context") if isinstance(meta.get("window_context"), dict) else {}
        parent_room_id = context.get("parent_room_id")
        room_entry = rooms.get((_surface_key(result), parent_room_id))
        if (
            context.get("schema_version") != 1
            or context.get("derivation_status") != "current"
            or context.get("source_trace_id") != trace_id
            or context.get("source_window_trace_fingerprint") != trace_fingerprint
            or room_entry is None
            or context.get("source_room_fingerprint") != room_entry[1]
        ):
            raise RoomV3Error(f"Room v3 window {result_id} has a stale or incomplete parent context")

        parent = context.get("parent_derivation") if isinstance(context.get("parent_derivation"), dict) else {}
        policy = _validate_policy(context.get("window_matching_policy"), result_id)
        if (
            parent.get("algorithm_version") != WINDOW_PARENT_ALGORITHM_VERSION
            or parent.get("source_window_trace_fingerprint") != trace_fingerprint
            or parent.get("room_fingerprint") != room_entry[1]
            or not _same_number(parent.get("boundary_match_tolerance_px"), policy["boundary_match_tolerance_px"])
            or not _same_number(parent.get("flattening_tolerance_px"), policy["flattening_tolerance_px"])
        ):
            raise RoomV3Error(f"Room v3 window {result_id} has stale parent-derivation evidence")

        attachment = context.get("boundary_attachment") if isinstance(context.get("boundary_attachment"), dict) else {}
        path_length = _number(attachment.get("path_length_px"), "path_length_px", result_id, positive=True)
        overlap_length = _number(attachment.get("overlap_length_px"), "overlap_length_px", result_id, positive=True)
        segment_ids = attachment.get("room_boundary_segment_ids")
        if (
            attachment.get("match_rule") != "full_positive_length_room_boundary_overlap"
            or overlap_length > path_length + 1e-6
            or path_length - overlap_length > max(1e-6, float(policy["boundary_match_tolerance_px"]) * 0.01)
            or not isinstance(segment_ids, list)
            or not segment_ids
            or len(segment_ids) != len(set(segment_ids))
            or any(not isinstance(item, str) or not item for item in segment_ids)
        ):
            raise RoomV3Error(f"Room v3 window {result_id} has incomplete boundary-attachment evidence")

        policy_fingerprint = _fingerprint(policy)
        if first_policy_fingerprint is None:
            first_policy_fingerprint = policy_fingerprint
        elif first_policy_fingerprint != policy_fingerprint:
            raise RoomV3Error("Room v3 windows contain inconsistent matching policies")

        search = context.get("pairing_search") if isinstance(context.get("pairing_search"), dict) else {}
        candidate_ids = search.get("candidate_trace_ids")
        candidate_count = search.get("candidate_count")
        if (
            search.get("status") != "complete"
            or search.get("algorithm_version") != WINDOW_PAIRING_ALGORITHM_VERSION
            or not _same_number(search.get("pair_search_limit_px"), policy["pair_search_limit_px"])
            or isinstance(candidate_count, bool)
            or not isinstance(candidate_count, int)
            or candidate_count < 0
            or not isinstance(candidate_ids, list)
            or len(candidate_ids) != candidate_count
            or len(candidate_ids) != len(set(candidate_ids))
            or any(not isinstance(item, str) or not item for item in candidate_ids)
        ):
            raise RoomV3Error(f"Room v3 window {result_id} has pending or incomplete pairing-search evidence")

        connection = context.get("connection") if isinstance(context.get("connection"), dict) else {}
        connection_id = connection.get("id")
        trace_ids = connection.get("trace_ids")
        if (
            connection.get("kind") != "window_connection"
            or connection.get("read_only") is not True
            or not isinstance(connection_id, str)
            or not connection_id
            or not isinstance(trace_ids, list)
            or trace_id not in trace_ids
            or len(trace_ids) != len(set(trace_ids))
            or connection_id != "window-connection:" + _fingerprint({"trace_ids": sorted(trace_ids)})[:24]
        ):
            raise RoomV3Error(f"Room v3 window {result_id} has incomplete connection evidence")
        previous_connection = connection_by_id.setdefault(connection_id, connection)
        if _fingerprint(previous_connection) != _fingerprint(connection):
            raise RoomV3Error(f"Room v3 window connection {connection_id} is inconsistent across its traces")
        trace_by_id[trace_id] = (result, context, trace_fingerprint)

    for trace_id, (result, context, trace_fingerprint) in trace_by_id.items():
        result_id = result["id"]
        parent_room_id = context["parent_room_id"]
        policy = context["window_matching_policy"]
        search = context["pairing_search"]
        connection = context["connection"]
        evidence = connection.get("evidence") if isinstance(connection.get("evidence"), dict) else {}
        trace_ids = connection["trace_ids"]
        room_ids = connection.get("connected_room_ids")
        if any(candidate_id not in trace_by_id or candidate_id == trace_id for candidate_id in search["candidate_trace_ids"]):
            raise RoomV3Error(f"Room v3 window {result_id} pairing search references a missing trace")
        if connection.get("connection_kind") == "room_to_exterior":
            valid = (
                trace_ids == [trace_id]
                and room_ids == [parent_room_id]
                and connection.get("connects_to_exterior") is True
                and connection.get("review_status") == "derived"
                and context.get("pairing_status") == "exterior"
                and search["candidate_count"] == 0
                and evidence.get("match_rule") == "no_opposite_window_trace_within_search_limit"
                and evidence.get("candidate_count") == 0
                and evidence.get("automatically_classified") is True
                and evidence.get("trace_fingerprints") == [trace_fingerprint]
            )
        elif connection.get("connection_kind") == "room_to_room":
            other_ids = [item for item in trace_ids if item != trace_id]
            connected = [trace_by_id.get(item) for item in trace_ids]
            actual_rooms = sorted(item[1]["parent_room_id"] for item in connected if item is not None)
            actual_fingerprints = sorted(item[2] for item in connected if item is not None)
            valid = (
                len(trace_ids) == 2
                and len(other_ids) == 1
                and all(item is not None for item in connected)
                and sorted(room_ids or []) == actual_rooms
                and len(set(actual_rooms)) == 2
                and connection.get("connects_to_exterior") is False
                and connection.get("review_status") == "candidate"
                and context.get("pairing_status") == "paired"
                and other_ids[0] in search["candidate_trace_ids"]
                and evidence.get("match_rule") == "mutual_outward_projection"
                and evidence.get("mutual_nearest") is True
                and evidence.get("trace_fingerprints") == actual_fingerprints
                and _number(evidence.get("projected_overlap_length_px"), "projected_overlap_length_px", result_id, positive=True) > 0
                and _number(evidence.get("mean_separation_px"), "mean_separation_px", result_id) >= 0
                and 0 <= _number(evidence.get("maximum_tangent_delta_deg"), "maximum_tangent_delta_deg", result_id) <= 90
            )
        else:
            valid = False
        if (
            not valid
            or evidence.get("algorithm_version") != WINDOW_PAIRING_ALGORITHM_VERSION
            or not _same_number(evidence.get("pair_search_limit_px"), policy["pair_search_limit_px"])
        ):
            raise RoomV3Error(f"Room v3 window {result_id} has stale or incomplete pairing evidence")


def _segments_from_edge(edge: dict[str, Any], room_id: str) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    raw_segments = edge.get("boundary_segments", {}).get(room_id, [])
    segments = []
    for raw in raw_segments:
        if isinstance(raw, dict):
            raw = [raw.get("start"), raw.get("end")]
        if not isinstance(raw, list) or len(raw) != 2 or not all(isinstance(point, dict) for point in raw):
            continue
        segments.append(
            (
                (float(raw[0]["x"]), float(raw[0]["y"])),
                (float(raw[1]["x"]), float(raw[1]["y"])),
            )
        )
    return segments


def _zone_openings(
    polygon: list[tuple[float, float]],
    parent_room_id: str,
    portals: list[dict[str, Any]],
) -> tuple[list[str], list[str]]:
    zone_edges = [(point, polygon[(index + 1) % len(polygon)]) for index, point in enumerate(polygon)]
    opening_ids: list[str] = []
    connected_room_ids: set[str] = set()
    for portal in portals:
        edge = portal["meta"]["room_graph_edge"]
        boundary_segments = _segments_from_edge(edge, parent_room_id)
        if not any(collinear_overlap(zone_edge, boundary) for zone_edge in zone_edges for boundary in boundary_segments):
            continue
        opening_ids.append(portal["id"])
        for room_id in edge.get("connected_room_ids") or edge.get("room_ids") or []:
            if room_id != parent_room_id:
                connected_room_ids.add(str(room_id))
        if edge.get("connects_to_exterior"):
            connected_room_ids.add("Exterior")
    return sorted(opening_ids), sorted(connected_room_ids)


def convert(
    zone_task: dict[str, Any],
    room_task: dict[str, Any],
    *,
    approved_room_annotation_id: int,
    source_zone_project_id: int = 3,
    room_v3_project_id: int | None = None,
    expected_zones: int | None = 5,
    expected_transport_vectors: int | None = 5,
    expected_visual_vectors: int | None = 1,
) -> dict[str, Any]:
    zone_annotation = select_annotation(zone_task)
    room_annotation = select_annotation(room_task, approved_room_annotation_id)
    zone_task_id = zone_task.get("id")
    zone_annotation_id = zone_annotation.get("id")
    room_task_id = room_task.get("id")
    if not all(isinstance(value, int) for value in (zone_task_id, zone_annotation_id, room_task_id)):
        raise RoomV3Error("source zone and Room v3 task/annotation IDs must be integers")

    room_results = room_annotation.get("result")
    if not isinstance(room_results, list):
        raise RoomV3Error("approved Room v3 annotation result must be a list")
    rooms: dict[str, list[tuple[float, float]]] = {}
    references: list[dict[str, Any]] = []
    portals: list[dict[str, Any]] = []
    windows: list[dict[str, Any]] = []
    for source in room_results:
        if not isinstance(source, dict) or not isinstance(source.get("id"), str):
            continue
        control = source.get("from_name")
        if control in ROOM_CONTROLS:
            node = source.get("meta", {}).get("room_graph_node")
            polygon = result_polygon(source)
            if not isinstance(node, dict) or node.get("schema_version") != 3 or polygon is None:
                raise RoomV3Error(f"Room v3 result {source['id']} lacks valid schema-v3 node metadata")
            rooms[source["id"]] = polygon
        elif control in PORTAL_CONTROLS:
            edge = source.get("meta", {}).get("room_graph_edge")
            if not isinstance(edge, dict) or edge.get("schema_version") != 3:
                raise RoomV3Error(f"Room v3 portal {source['id']} lacks valid schema-v3 edge metadata")
            portals.append(source)
        elif control in WINDOW_CONTROLS:
            # This remains a lossless readonly copy and never reuses Portal
            # metadata, but the complete domain is verified below first.
            windows.append(source)
        else:
            continue
        item = copy.deepcopy(source)
        item["readonly"] = True
        references.append(item)
    if not rooms:
        raise RoomV3Error("approved Room v3 annotation has no rooms")
    if windows:
        _validate_window_references(room_results)

    zone_results = zone_annotation.get("result")
    if not isinstance(zone_results, list):
        raise RoomV3Error("Zone v2 annotation result must be a list")
    editable: list[dict[str, Any]] = []
    zone_geometry_count = 0
    transport_count = 0
    visual_count = 0
    for source in zone_results:
        if not isinstance(source, dict) or not isinstance(source.get("id"), str):
            continue
        control = source.get("from_name")
        if control not in ZONE_CONTROLS | CONNECTION_CONTROLS:
            continue
        item = copy.deepcopy(source)
        item.pop("readonly", None)
        merge_meta(
            item,
            "migration_context",
            migration_context(
                project_id=source_zone_project_id,
                task_id=zone_task_id,
                annotation_id=zone_annotation_id,
                result_id=source["id"],
            ),
        )
        if control in {"zone_rectangle", "zone_polygon"}:
            zone_geometry_count += 1
            polygon = result_polygon(source)
            if polygon is None:
                raise RoomV3Error(f"functional zone {source['id']} has invalid geometry")
            parents = [room_id for room_id, room in rooms.items() if polygon_inside_polygon(polygon, room)]
            parent_room_id = parents[0] if len(parents) == 1 else None
            opening_ids: list[str] = []
            connected_room_ids: list[str] = []
            if parent_room_id:
                opening_ids, connected_room_ids = _zone_openings(polygon, parent_room_id, portals)
            merge_meta(
                item,
                "partition_context",
                {
                    "schema_version": 3,
                    "parent_room_id": parent_room_id,
                    "opening_ids": opening_ids,
                    "connected_room_ids": connected_room_ids,
                    "requires_geometry_review": parent_room_id is None,
                    "room_v3_source": {
                        "source_project_id": room_v3_project_id,
                        "source_task_id": room_task_id,
                        "source_annotation_id": approved_room_annotation_id,
                        "parent_room_result_id": parent_room_id,
                    },
                    "portal_v3_source": {
                        "source_result_ids": opening_ids,
                    },
                },
            )
        elif control == "connection_vector":
            transport_count += 1
            merge_meta(
                item,
                "geometry_review",
                {"schema_version": 3, "status": "pending", "reason": "migrated_from_v2"},
            )
        elif control == "visual_connection_vector":
            visual_count += 1
            merge_meta(
                item,
                "geometry_review",
                {"schema_version": 3, "status": "pending", "reason": "migrated_from_v2"},
            )
        editable.append(item)

    for label, actual, expected in (
        ("functional zones", zone_geometry_count, expected_zones),
        ("transport vectors", transport_count, expected_transport_vectors),
        ("visual vectors", visual_count, expected_visual_vectors),
    ):
        if expected is not None and actual != expected:
            raise RoomV3Error(f"expected {expected} {label}, found {actual}")

    task_meta = copy.deepcopy(zone_task.get("meta")) if isinstance(zone_task.get("meta"), dict) else {}
    task_meta["function_zone_v3_migration"] = {
        "schema_version": 3,
        "source_project_id": source_zone_project_id,
        "source_task_id": zone_task_id,
        "source_annotation_id": zone_annotation_id,
        "room_v3_project_id": room_v3_project_id,
        "room_v3_task_id": room_task_id,
        "room_v3_annotation_id": approved_room_annotation_id,
        "connectivity_review_required": True,
    }
    return {
        "schema_version": 3,
        "source": {
            "zone_project_id": source_zone_project_id,
            "zone_task_id": zone_task_id,
            "zone_annotation_id": zone_annotation_id,
            "room_v3_project_id": room_v3_project_id,
            "room_v3_task_id": room_task_id,
            "room_v3_annotation_id": approved_room_annotation_id,
        },
        "task": {"data": copy.deepcopy(zone_task.get("data", {})), "meta": task_meta},
        "annotation_result": editable,
        "prediction": {"model_version": "approved-room-v3-reference", "result": references},
        "manifest": {
            "functional_zone_count": zone_geometry_count,
            "transport_vector_count": transport_count,
            "visual_vector_count": visual_count,
            "room_reference_count": len(rooms),
            "portal_reference_count": len(portals),
            "window_reference_count": len(windows),
        },
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build FunctionZone v3 from Zone v2 and approved Room v3 tasks.")
    parser.add_argument("--zone-task-json", required=True, type=Path)
    parser.add_argument("--room-v3-task-json", required=True, type=Path)
    parser.add_argument("--approved-room-annotation-id", required=True, type=int)
    parser.add_argument("--room-v3-project-id", type=int)
    parser.add_argument("--source-zone-project-id", type=int, default=3)
    parser.add_argument("--output-json", required=True, type=Path)
    parser.add_argument("--no-count-assertions", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        bundle = convert(
            load_single_task(args.zone_task_json),
            load_single_task(args.room_v3_task_json),
            approved_room_annotation_id=args.approved_room_annotation_id,
            source_zone_project_id=args.source_zone_project_id,
            room_v3_project_id=args.room_v3_project_id,
            expected_zones=None if args.no_count_assertions else 5,
            expected_transport_vectors=None if args.no_count_assertions else 5,
            expected_visual_vectors=None if args.no_count_assertions else 1,
        )
        args.output_json.parent.mkdir(parents=True, exist_ok=True)
        args.output_json.write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except RoomV3Error as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    manifest = bundle["manifest"]
    print(
        f"wrote {args.output_json}: {manifest['functional_zone_count']} zones, "
        f"{manifest['transport_vector_count']} transport vectors, "
        f"{manifest['visual_vector_count']} visual vector, "
        f"{manifest['window_reference_count']} window references"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
