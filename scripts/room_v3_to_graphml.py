#!/usr/bin/env python3
"""Convert a validated Room v3 annotation to GraphML and audit JSON."""

from __future__ import annotations

import argparse
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from room_v3_common import RoomV3Error, load_single_task, select_annotation


ROOM_CONTROLS = {"room_rectangle", "room_polygon"}
PORTAL_CONTROLS = {"portal_rectangle", "portal_vector"}
GRAPHML_NS = "http://graphml.graphdrawing.org/xmlns"


def convert(task: dict[str, Any], annotation_id: int | None = None) -> dict[str, Any]:
    annotation = select_annotation(task, annotation_id)
    results = annotation.get("result")
    if not isinstance(results, list):
        raise RoomV3Error("Room v3 annotation result must be a list")
    nodes: dict[str, dict[str, Any]] = {}
    portals: list[dict[str, Any]] = []
    needs_exterior = False
    for result in results:
        if not isinstance(result, dict) or not isinstance(result.get("id"), str):
            continue
        control = result.get("from_name")
        if control in ROOM_CONTROLS:
            node = result.get("meta", {}).get("room_graph_node")
            if not isinstance(node, dict) or node.get("schema_version") != 3:
                raise RoomV3Error(f"room {result['id']} lacks schema-v3 room_graph_node metadata")
            if result["id"] in nodes:
                raise RoomV3Error(f"duplicate room node id: {result['id']}")
            nodes[result["id"]] = {
                "id": result["id"],
                "room_type": str(node.get("room_type") or "Unclear/other"),
                "geometry_type": str(node.get("geometry_type") or "unknown"),
                "result_id": result["id"],
            }
        elif control in PORTAL_CONTROLS:
            edge = result.get("meta", {}).get("room_graph_edge")
            if not isinstance(edge, dict) or edge.get("schema_version") != 3:
                raise RoomV3Error(f"portal {result['id']} lacks schema-v3 room_graph_edge metadata")
            room_ids = [str(value) for value in edge.get("connected_room_ids") or edge.get("room_ids") or []]
            if len(room_ids) == 1 and edge.get("connects_to_exterior"):
                endpoints = [room_ids[0], "Exterior"]
                needs_exterior = True
            elif len(room_ids) == 2 and not edge.get("connects_to_exterior"):
                endpoints = room_ids
            else:
                raise RoomV3Error(
                    f"portal {result['id']} must connect two rooms or one room plus Exterior"
                )
            portals.append(
                {
                    "id": result["id"],
                    "source": endpoints[0],
                    "target": endpoints[1],
                    "opening_type": str(edge.get("opening_type") or "unknown"),
                    "geometry_type": str(edge.get("geometry_type") or "unknown"),
                    "clear_width_percent": float(edge.get("clear_width_percent") or 0),
                    "depth_percent": float(edge.get("depth_percent") or 0),
                    "clear_width_px": float(edge.get("clear_width_px") or 0),
                    "depth_px": float(edge.get("depth_px") or 0),
                    "centerline": edge.get("centerline") or [],
                    "boundary_segments": edge.get("boundary_segments") or {},
                    "connects_to_exterior": bool(edge.get("connects_to_exterior")),
                    "result_id": result["id"],
                }
            )
    if not nodes:
        raise RoomV3Error("Room v3 annotation has no room nodes")
    if needs_exterior:
        nodes["Exterior"] = {
            "id": "Exterior",
            "room_type": "Exterior",
            "geometry_type": "synthetic",
            "result_id": "",
        }
    for edge in portals:
        if edge["source"] not in nodes or edge["target"] not in nodes:
            raise RoomV3Error(
                f"portal {edge['id']} has missing endpoint(s): {edge['source']}, {edge['target']}"
            )
    return {
        "schema_version": 3,
        "source_task_id": task.get("id"),
        "source_annotation_id": annotation.get("id"),
        "nodes": [nodes[key] for key in sorted(nodes)],
        "edges": sorted(portals, key=lambda edge: edge["id"]),
    }


def to_graphml(graph: dict[str, Any]) -> ET.ElementTree:
    ET.register_namespace("", GRAPHML_NS)
    root = ET.Element(f"{{{GRAPHML_NS}}}graphml")
    node_fields = {
        "room_type": "string",
        "geometry_type": "string",
        "result_id": "string",
    }
    edge_fields = {
        "opening_type": "string",
        "geometry_type": "string",
        "clear_width_percent": "double",
        "depth_percent": "double",
        "clear_width_px": "double",
        "depth_px": "double",
        "centerline": "string",
        "boundary_segments": "string",
        "connects_to_exterior": "boolean",
        "result_id": "string",
    }
    for name, kind in node_fields.items():
        ET.SubElement(
            root,
            f"{{{GRAPHML_NS}}}key",
            {"id": f"node_{name}", "for": "node", "attr.name": name, "attr.type": kind},
        )
    for name, kind in edge_fields.items():
        ET.SubElement(
            root,
            f"{{{GRAPHML_NS}}}key",
            {"id": f"edge_{name}", "for": "edge", "attr.name": name, "attr.type": kind},
        )
    graph_element = ET.SubElement(root, f"{{{GRAPHML_NS}}}graph", {"id": "RoomV3", "edgedefault": "undirected"})
    for node in graph["nodes"]:
        element = ET.SubElement(graph_element, f"{{{GRAPHML_NS}}}node", {"id": node["id"]})
        for name in node_fields:
            ET.SubElement(element, f"{{{GRAPHML_NS}}}data", {"key": f"node_{name}"}).text = str(
                node.get(name, "")
            )
    for edge in graph["edges"]:
        element = ET.SubElement(
            graph_element,
            f"{{{GRAPHML_NS}}}edge",
            {"id": edge["id"], "source": edge["source"], "target": edge["target"]},
        )
        for name in edge_fields:
            value = edge.get(name, "")
            if isinstance(value, bool):
                rendered = "true" if value else "false"
            elif isinstance(value, (dict, list)):
                rendered = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            else:
                rendered = str(value)
            ET.SubElement(element, f"{{{GRAPHML_NS}}}data", {"key": f"edge_{name}"}).text = rendered
    return ET.ElementTree(root)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert Room v3 Label Studio JSON to GraphML.")
    parser.add_argument("--input-json", required=True, type=Path)
    parser.add_argument("--annotation-id", type=int)
    parser.add_argument("--output-graphml", required=True, type=Path)
    parser.add_argument("--output-json", type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        graph = convert(load_single_task(args.input_json), args.annotation_id)
        args.output_graphml.parent.mkdir(parents=True, exist_ok=True)
        tree = to_graphml(graph)
        ET.indent(tree, space="  ")
        tree.write(args.output_graphml, encoding="utf-8", xml_declaration=True)
        if args.output_json:
            args.output_json.parent.mkdir(parents=True, exist_ok=True)
            args.output_json.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except RoomV3Error as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(f"wrote {args.output_graphml}: {len(graph['nodes'])} nodes, {len(graph['edges'])} portals")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
