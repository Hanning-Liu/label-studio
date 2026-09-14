#!/usr/bin/env python3
"""Convert one Label Studio room export and its GraphML into predictions.

The output is a Label Studio basic task JSON file whose room and opening
results are explicitly read-only. GraphML node/edge attributes are joined to
the results by their stable Label Studio result IDs.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any


GRAPHML_NS = {"g": "http://graphml.graphdrawing.org/xmlns"}
ROOM_RESULT_TYPES = {"rectanglelabels", "polygonlabels"}
OPENING_RESULT_TYPES = {"vectorlabels"}


class ConversionError(ValueError):
    """Raised when the JSON and GraphML cannot be joined safely."""


def _csv_names(value: str) -> set[str]:
    names = {item.strip() for item in value.split(",") if item.strip()}
    if not names:
        raise argparse.ArgumentTypeError("at least one control name is required")
    return names


def _typed_value(value: str | None, attr_type: str | None) -> Any:
    if value is None:
        return None
    if attr_type in {"double", "float"}:
        return float(value)
    if attr_type in {"int", "long"}:
        return int(value)
    if attr_type == "boolean":
        lowered = value.strip().lower()
        if lowered not in {"true", "false"}:
            raise ConversionError(f"invalid GraphML boolean: {value!r}")
        return lowered == "true"
    return value


def load_graphml(path: Path) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError) as exc:
        raise ConversionError(f"cannot read GraphML {path}: {exc}") from exc

    keys: dict[str, tuple[str, str | None]] = {}
    for key in root.findall("g:key", GRAPHML_NS):
        key_id = key.get("id")
        attr_name = key.get("attr.name")
        if key_id and attr_name:
            keys[key_id] = (attr_name, key.get("attr.type"))

    def read_data(element: ET.Element) -> dict[str, Any]:
        values: dict[str, Any] = {}
        for data in element.findall("g:data", GRAPHML_NS):
            key_id = data.get("key")
            if not key_id or key_id not in keys:
                continue
            name, attr_type = keys[key_id]
            values[name] = _typed_value(data.text, attr_type)
        return values

    graph = root.find("g:graph", GRAPHML_NS)
    if graph is None:
        raise ConversionError("GraphML does not contain a graph element")

    nodes: dict[str, dict[str, Any]] = {}
    for node in graph.findall("g:node", GRAPHML_NS):
        node_id = node.get("id")
        if not node_id:
            raise ConversionError("GraphML node without id")
        if node_id in nodes:
            raise ConversionError(f"duplicate GraphML node id: {node_id}")
        nodes[node_id] = read_data(node)

    edges: dict[str, dict[str, Any]] = {}
    for edge in graph.findall("g:edge", GRAPHML_NS):
        edge_id = edge.get("id")
        source = edge.get("source")
        target = edge.get("target")
        if not edge_id or not source or not target:
            raise ConversionError("GraphML edge requires id, source, and target")
        if edge_id in edges:
            raise ConversionError(f"duplicate GraphML edge id: {edge_id}")
        if source not in nodes or target not in nodes:
            raise ConversionError(
                f"GraphML edge {edge_id} has dangling endpoint(s): {source}, {target}"
            )
        edges[edge_id] = {
            "room_ids": [source, target],
            **read_data(edge),
        }

    return nodes, edges


def load_single_task(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, OSError) as exc:
        raise ConversionError(f"cannot read Label Studio JSON {path}: {exc}") from exc

    tasks = payload if isinstance(payload, list) else [payload]
    if len(tasks) != 1 or not isinstance(tasks[0], dict):
        raise ConversionError(
            f"expected exactly one Label Studio task for one GraphML graph, got {len(tasks)}"
        )
    return tasks[0]


def select_annotation(task: dict[str, Any]) -> dict[str, Any]:
    annotations = [
        item
        for item in task.get("annotations", [])
        if isinstance(item, dict) and not item.get("was_cancelled", False)
    ]
    if not annotations:
        raise ConversionError("task does not contain a non-cancelled annotation")

    def sort_key(annotation: dict[str, Any]) -> tuple[str, int]:
        timestamp = str(annotation.get("updated_at") or annotation.get("created_at") or "")
        annotation_id = annotation.get("id")
        return timestamp, annotation_id if isinstance(annotation_id, int) else -1

    return max(annotations, key=sort_key)


def _set_nested_meta(result: dict[str, Any], key: str, value: dict[str, Any]) -> None:
    current = result.get("meta")
    meta = copy.deepcopy(current) if isinstance(current, dict) else {}
    meta[key] = value
    result["meta"] = meta


def _describe_difference(label: str, expected: set[str], actual: set[str]) -> list[str]:
    messages: list[str] = []
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    if missing:
        messages.append(f"{label} missing in GraphML: {', '.join(missing)}")
    if extra:
        messages.append(f"{label} extra in GraphML: {', '.join(extra)}")
    return messages


def convert(
    task: dict[str, Any],
    nodes: dict[str, dict[str, Any]],
    edges: dict[str, dict[str, Any]],
    room_controls: set[str],
    opening_controls: set[str],
    model_version: str,
) -> list[dict[str, Any]]:
    annotation = select_annotation(task)
    results = annotation.get("result")
    if not isinstance(results, list):
        raise ConversionError("selected annotation result must be a list")

    room_results: dict[str, dict[str, Any]] = {}
    opening_results: dict[str, dict[str, Any]] = {}
    selected_ids: set[str] = set()
    for result in results:
        if not isinstance(result, dict):
            continue
        result_id = result.get("id")
        if not isinstance(result_id, str) or not result_id:
            continue
        from_name = result.get("from_name")
        result_type = result.get("type")
        if from_name in room_controls and result_type in ROOM_RESULT_TYPES:
            if result_id in selected_ids:
                raise ConversionError(f"duplicate selected Label Studio result id: {result_id}")
            selected_ids.add(result_id)
            room_results[result_id] = result
        elif from_name in opening_controls and result_type in OPENING_RESULT_TYPES:
            if result_id in selected_ids:
                raise ConversionError(f"duplicate selected Label Studio result id: {result_id}")
            selected_ids.add(result_id)
            opening_results[result_id] = result

    if not room_results:
        raise ConversionError("no room Rectangle/Polygon results matched the configured controls")
    if not opening_results:
        raise ConversionError("no opening Vector results matched the configured controls")

    differences = [
        *_describe_difference("room result IDs", set(room_results), set(nodes)),
        *_describe_difference("opening result IDs", set(opening_results), set(edges)),
    ]
    if differences:
        raise ConversionError("JSON/GraphML ID mismatch:\n- " + "\n- ".join(differences))

    converted: list[dict[str, Any]] = []
    for result in results:
        if not isinstance(result, dict):
            continue
        result_id = result.get("id")
        if result_id not in room_results and result_id not in opening_results:
            continue
        item = copy.deepcopy(result)
        item["readonly"] = True
        if result_id in room_results:
            _set_nested_meta(
                item,
                "room_graph_node",
                {"schema_version": 1, "node_id": result_id, **nodes[result_id]},
            )
        else:
            _set_nested_meta(
                item,
                "room_graph_edge",
                {"schema_version": 1, "edge_id": result_id, **edges[result_id]},
            )
        converted.append(item)

    task_meta = copy.deepcopy(task.get("meta")) if isinstance(task.get("meta"), dict) else {}
    task_meta["room_layout_reference"] = {
        "schema_version": 1,
        "source_task_id": task.get("id"),
        "source_annotation_id": annotation.get("id"),
        "room_count": len(room_results),
        "opening_count": len(opening_results),
    }

    output_task = {
        "data": copy.deepcopy(task.get("data", {})),
        "meta": task_meta,
        "predictions": [
            {
                "model_version": model_version,
                "result": converted,
            }
        ],
    }
    return [output_task]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert a room annotation export and GraphML into read-only Label Studio predictions."
    )
    parser.add_argument("--input-json", required=True, type=Path)
    parser.add_argument("--input-graphml", required=True, type=Path)
    parser.add_argument("--output-json", required=True, type=Path)
    parser.add_argument("--room-controls", type=_csv_names, default={"label", "polygon_label"})
    parser.add_argument("--opening-controls", type=_csv_names, default={"opening_label"})
    parser.add_argument("--model-version", default="room-layout-reference-v1")
    parser.add_argument("--compact", action="store_true", help="write compact JSON instead of indented JSON")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        task = load_single_task(args.input_json)
        nodes, edges = load_graphml(args.input_graphml)
        output = convert(
            task,
            nodes,
            edges,
            room_controls=args.room_controls,
            opening_controls=args.opening_controls,
            model_version=args.model_version,
        )
        args.output_json.parent.mkdir(parents=True, exist_ok=True)
        args.output_json.write_text(
            json.dumps(
                output,
                ensure_ascii=False,
                indent=None if args.compact else 2,
                separators=(",", ":") if args.compact else None,
            )
            + "\n",
            encoding="utf-8",
        )
    except ConversionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    prediction = output[0]["predictions"][0]
    print(
        f"wrote {args.output_json}: "
        f"{output[0]['meta']['room_layout_reference']['room_count']} rooms, "
        f"{output[0]['meta']['room_layout_reference']['opening_count']} openings, "
        f"{len(prediction['result'])} results"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
