#!/usr/bin/env python3
"""Build a FunctionZone v3 task after its Room v3 annotation is approved."""

from __future__ import annotations

import argparse
import copy
import json
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
        else:
            continue
        item = copy.deepcopy(source)
        item["readonly"] = True
        references.append(item)
    if not rooms:
        raise RoomV3Error("approved Room v3 annotation has no rooms")

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
        f"{manifest['visual_vector_count']} visual vector"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
