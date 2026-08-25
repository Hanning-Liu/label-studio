#!/usr/bin/env python3
"""Create an auditable Room v2 -> Room v3 seed bundle.

Editable rooms and zero-thickness open passages are separated from the read-only
Door/Sliding door reference prediction so the v2 source annotation stays frozen.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any

from room_v3_common import (
    RoomV3Error,
    load_single_task,
    merge_meta,
    migration_context,
    normalized_opening_type,
    result_label,
    select_annotation,
)


ROOM_CONTROLS = {"label": "room_rectangle", "polygon_label": "room_polygon"}


def convert(
    task: dict[str, Any],
    *,
    source_project_id: int = 5,
    expected_rooms: int | None = 16,
    expected_open_passages: int | None = 7,
    expected_references: int | None = 11,
) -> dict[str, Any]:
    annotation = select_annotation(task)
    task_id = task.get("id")
    annotation_id = annotation.get("id")
    if not isinstance(task_id, int) or not isinstance(annotation_id, int):
        raise RoomV3Error("source task and annotation require integer IDs")
    results = annotation.get("result")
    if not isinstance(results, list):
        raise RoomV3Error("source annotation result must be a list")

    editable: list[dict[str, Any]] = []
    references: list[dict[str, Any]] = []
    result_id_map: list[dict[str, Any]] = []
    seen_output_ids: set[str] = set()

    for source in results:
        if not isinstance(source, dict) or not isinstance(source.get("id"), str):
            continue
        source_id = source["id"]
        source_control = source.get("from_name")
        label = result_label(source)
        context = migration_context(
            project_id=source_project_id,
            task_id=task_id,
            annotation_id=annotation_id,
            result_id=source_id,
        )
        if source_control in ROOM_CONTROLS and source.get("type") in {
            "rectanglelabels",
            "polygonlabels",
        }:
            item = copy.deepcopy(source)
            item["from_name"] = ROOM_CONTROLS[source_control]
            item.pop("readonly", None)
            geometry_type = "rectangle" if source.get("type") == "rectanglelabels" else "polygon"
            merge_meta(
                item,
                "room_graph_node",
                {
                    "schema_version": 3,
                    "node_id": source_id,
                    "room_type": label,
                    "geometry_type": geometry_type,
                },
            )
            merge_meta(item, "migration_context", context)
            editable.append(item)
            output_id = source_id
            role = "editable_room"
        elif source_control == "opening_label" and source.get("type") == "vectorlabels":
            normalized = normalized_opening_type(label)
            if normalized == "open_passage":
                item = copy.deepcopy(source)
                item["from_name"] = "portal_vector"
                item.pop("readonly", None)
                merge_meta(
                    item,
                    "room_graph_edge",
                    {
                        "schema_version": 3,
                        "edge_id": source_id,
                        "opening_type": normalized,
                        "geometry_type": "vector",
                        "connected_room_ids": [],
                        "room_ids": [],
                        "connects_to_exterior": False,
                        "review_required": True,
                    },
                )
                merge_meta(item, "migration_context", context)
                editable.append(item)
                output_id = source_id
                role = "editable_open_passage"
            elif normalized in {"door", "sliding_door"}:
                item = copy.deepcopy(source)
                output_id = f"v2-ref-{source_id}"
                item["id"] = output_id
                item["from_name"] = "portal_v2_reference"
                item["readonly"] = True
                merge_meta(
                    item,
                    "room_graph_edge",
                    {
                        "schema_version": 2,
                        "edge_id": output_id,
                        "opening_type": normalized,
                        "geometry_type": "vector_reference",
                        "source_result_id": source_id,
                        "room_ids": [],
                        "connected_room_ids": [],
                    },
                )
                merge_meta(item, "migration_context", context)
                references.append(item)
                role = "readonly_portal_reference"
            else:
                continue
        else:
            continue

        if output_id in seen_output_ids:
            raise RoomV3Error(f"duplicate output result id: {output_id}")
        seen_output_ids.add(output_id)
        result_id_map.append(
            {
                "source_result_id": source_id,
                "target_result_id": output_id,
                "role": role,
            }
        )

    room_count = sum(item["role"] == "editable_room" for item in result_id_map)
    passage_count = sum(item["role"] == "editable_open_passage" for item in result_id_map)
    reference_count = sum(item["role"] == "readonly_portal_reference" for item in result_id_map)
    expectations = [
        ("rooms", room_count, expected_rooms),
        ("open passages", passage_count, expected_open_passages),
        ("Door/Sliding references", reference_count, expected_references),
    ]
    for label_name, actual, expected in expectations:
        if expected is not None and actual != expected:
            raise RoomV3Error(f"expected {expected} {label_name}, found {actual}")

    task_meta = copy.deepcopy(task.get("meta")) if isinstance(task.get("meta"), dict) else {}
    task_meta["room_v3_migration"] = {
        "schema_version": 3,
        "source_project_id": source_project_id,
        "source_task_id": task_id,
        "source_annotation_id": annotation_id,
        "requires_manual_room_boundary_review": True,
        "requires_manual_portal_redraw": True,
    }
    return {
        "schema_version": 3,
        "source": {
            "project_id": source_project_id,
            "task_id": task_id,
            "annotation_id": annotation_id,
        },
        "task": {"data": copy.deepcopy(task.get("data", {})), "meta": task_meta},
        "annotation_result": editable,
        "prediction": {
            "model_version": "room-v2-door-reference-for-room-v3",
            "result": references,
        },
        "manifest": {
            "editable_room_count": room_count,
            "editable_open_passage_count": passage_count,
            "readonly_reference_count": reference_count,
            "result_id_map": result_id_map,
        },
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the Room v3 seed bundle from one Room v2 task export.")
    parser.add_argument("--input-json", required=True, type=Path)
    parser.add_argument("--output-json", required=True, type=Path)
    parser.add_argument(
        "--output-import-json",
        type=Path,
        help="also write a Label Studio import payload containing the editable annotation and reference prediction",
    )
    parser.add_argument("--source-project-id", type=int, default=5)
    parser.add_argument("--no-count-assertions", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    expected = None if args.no_count_assertions else object()
    try:
        bundle = convert(
            load_single_task(args.input_json),
            source_project_id=args.source_project_id,
            expected_rooms=None if expected is None else 16,
            expected_open_passages=None if expected is None else 7,
            expected_references=None if expected is None else 11,
        )
        args.output_json.parent.mkdir(parents=True, exist_ok=True)
        args.output_json.write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if args.output_import_json:
            import_payload = [
                {
                    **bundle["task"],
                    "annotations": [{"result": bundle["annotation_result"]}],
                    "predictions": [bundle["prediction"]],
                }
            ]
            args.output_import_json.parent.mkdir(parents=True, exist_ok=True)
            args.output_import_json.write_text(
                json.dumps(import_payload, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
    except RoomV3Error as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    manifest = bundle["manifest"]
    print(
        f"wrote {args.output_json}: {manifest['editable_room_count']} rooms, "
        f"{manifest['editable_open_passage_count']} editable open passages, "
        f"{manifest['readonly_reference_count']} read-only references"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
