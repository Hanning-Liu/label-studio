#!/usr/bin/env python3
"""Convert a validated Room v3 annotation to GraphML and audit JSON."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from room_v3_common import (
    RoomV3Error,
    load_single_task,
    result_label,
    result_polygon,
    result_segment,
    select_annotation,
)


ROOM_CONTROLS = {"room_rectangle", "room_polygon"}
PORTAL_CONTROLS = {"portal_rectangle", "portal_vector"}
GRAPHML_NS = "http://graphml.graphdrawing.org/xmlns"
EXTERIOR_COLOR = "#64748B"


def _rounded(value: float) -> float:
    return round(float(value), 6)


def _polygon_centroid(points: list[tuple[float, float]]) -> tuple[float, float]:
    twice_area = 0.0
    x_sum = 0.0
    y_sum = 0.0
    for index, point in enumerate(points):
        following = points[(index + 1) % len(points)]
        cross = point[0] * following[1] - following[0] * point[1]
        twice_area += cross
        x_sum += (point[0] + following[0]) * cross
        y_sum += (point[1] + following[1]) * cross
    if abs(twice_area) <= 1e-9:
        raise RoomV3Error("room geometry has zero area and no usable centroid")
    return x_sum / (3.0 * twice_area), y_sum / (3.0 * twice_area)


def _geometry_centroid(result: dict[str, Any]) -> tuple[float, float]:
    polygon = result_polygon(result)
    if polygon:
        return _polygon_centroid(polygon)
    segment = result_segment(result)
    if segment:
        return (
            (segment[0][0] + segment[1][0]) / 2.0,
            (segment[0][1] + segment[1][1]) / 2.0,
        )
    raise RoomV3Error(f"result {result.get('id')} has no supported geometry")


def _image_dimensions(results: list[dict[str, Any]]) -> tuple[float, float] | None:
    dimensions = {
        (float(result["original_width"]), float(result["original_height"]))
        for result in results
        if isinstance(result, dict)
        and isinstance(result.get("original_width"), (int, float))
        and isinstance(result.get("original_height"), (int, float))
        and float(result["original_width"]) > 0
        and float(result["original_height"]) > 0
    }
    if len(dimensions) > 1:
        raise RoomV3Error(f"Room v3 results disagree on image dimensions: {sorted(dimensions)!r}")
    return next(iter(dimensions)) if dimensions else None


def _control_colors(root: ET.Element, controls: set[str]) -> dict[str, str]:
    colors: dict[str, str] = {}
    for control in root.iter():
        if control.attrib.get("name") not in controls:
            continue
        for label in control:
            if label.tag.rsplit("}", 1)[-1] != "Label":
                continue
            value = label.attrib.get("value", "").strip()
            color = label.attrib.get("background", "").strip().upper()
            if not value or not color:
                continue
            previous = colors.get(value)
            if previous and previous != color:
                raise RoomV3Error(
                    f"label {value!r} has conflicting colors {previous} and {color}"
                )
            colors[value] = color
    return colors


def load_label_palette(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_bytes()
        root = ET.fromstring(raw)
    except (OSError, ET.ParseError) as exc:
        raise RoomV3Error(f"cannot read Room v3 label config {path}: {exc}") from exc
    room_colors = _control_colors(root, ROOM_CONTROLS)
    portal_colors = _control_colors(root, PORTAL_CONTROLS)
    if not room_colors:
        raise RoomV3Error("Room v3 label config has no room label colors")
    if not portal_colors:
        raise RoomV3Error("Room v3 label config has no portal label colors")
    return {
        "room": room_colors,
        "portal": portal_colors,
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def _color(palette: dict[str, Any] | None, kind: str, label: str) -> str:
    if palette is None:
        return ""
    value = str(palette.get(kind, {}).get(label) or "")
    if not value:
        raise RoomV3Error(f"Room v3 label config has no color for {kind} label {label!r}")
    return value


def convert(
    task: dict[str, Any],
    annotation_id: int | None = None,
    palette: dict[str, Any] | None = None,
) -> dict[str, Any]:
    annotation = select_annotation(task, annotation_id)
    results = annotation.get("result")
    if not isinstance(results, list):
        raise RoomV3Error("Room v3 annotation result must be a list")
    dimensions = _image_dimensions(results)
    nodes: dict[str, dict[str, Any]] = {}
    portals: list[dict[str, Any]] = []
    room_centroids: dict[str, tuple[float, float]] = {}
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
            room_type = str(node.get("room_type") or "Unclear/other")
            annotated_label = result_label(result)
            if annotated_label and annotated_label != room_type:
                raise RoomV3Error(
                    f"room {result['id']} metadata type {room_type!r} disagrees with label {annotated_label!r}"
                )
            centroid = _geometry_centroid(result)
            room_centroids[result["id"]] = centroid
            nodes[result["id"]] = {
                "id": result["id"],
                "room_type": room_type,
                "room_label": room_type,
                "geometry_type": str(node.get("geometry_type") or "unknown"),
                "result_id": result["id"],
                "display_name": f"{room_type} · {result['id'][:6]}",
                "hierarchy_level": "room",
                "centroid_x_percent": _rounded(centroid[0]),
                "centroid_y_percent": _rounded(centroid[1]),
                "centroid_x_px": _rounded(centroid[0] * dimensions[0] / 100.0) if dimensions else None,
                "centroid_y_px": _rounded(centroid[1] * dimensions[1] / 100.0) if dimensions else None,
                "label_studio_color": _color(palette, "room", room_type),
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
            opening_label = result_label(result)
            if not opening_label:
                raise RoomV3Error(f"portal {result['id']} has no annotation label")
            portals.append(
                {
                    "id": result["id"],
                    "source": endpoints[0],
                    "target": endpoints[1],
                    "edge_kind": "room_opening",
                    "display_name": opening_label,
                    "opening_type": str(edge.get("opening_type") or "unknown"),
                    "geometry_type": str(edge.get("geometry_type") or "unknown"),
                    "connected_room_ids": room_ids,
                    "clear_width_percent": float(edge.get("clear_width_percent") or 0),
                    "depth_percent": float(edge.get("depth_percent") or 0),
                    "clear_width_px": float(edge.get("clear_width_px") or 0),
                    "depth_px": float(edge.get("depth_px") or 0),
                    "centerline": edge.get("centerline") or [],
                    "boundary_segments": edge.get("boundary_segments") or {},
                    "connects_to_exterior": bool(edge.get("connects_to_exterior")),
                    "result_id": result["id"],
                    "label_studio_color": _color(palette, "portal", opening_label),
                    "_centroid_percent": _geometry_centroid(result),
                }
            )
    if not nodes:
        raise RoomV3Error("Room v3 annotation has no room nodes")
    if needs_exterior:
        candidates: list[tuple[float, float]] = []
        for portal in portals:
            if portal["target"] != "Exterior":
                continue
            room_centroid = room_centroids.get(portal["source"])
            portal_centroid = portal["_centroid_percent"]
            if room_centroid is None:
                continue
            if dimensions:
                room_px = (
                    room_centroid[0] * dimensions[0] / 100.0,
                    room_centroid[1] * dimensions[1] / 100.0,
                )
                portal_px = (
                    portal_centroid[0] * dimensions[0] / 100.0,
                    portal_centroid[1] * dimensions[1] / 100.0,
                )
                direction = (portal_px[0] - room_px[0], portal_px[1] - room_px[1])
                length = math.hypot(*direction)
                unit = (direction[0] / length, direction[1] / length) if length > 1e-6 else (0.0, 1.0)
                offset = max(80.0, float(portal.get("clear_width_px") or 0) * 1.5)
                candidates.append((portal_px[0] + unit[0] * offset, portal_px[1] + unit[1] * offset))
            else:
                direction = (
                    portal_centroid[0] - room_centroid[0],
                    portal_centroid[1] - room_centroid[1],
                )
                length = math.hypot(*direction)
                unit = (direction[0] / length, direction[1] / length) if length > 1e-6 else (0.0, 1.0)
                candidates.append((portal_centroid[0] + unit[0] * 8.0, portal_centroid[1] + unit[1] * 8.0))
        if not candidates:
            raise RoomV3Error("Exterior is required but no exterior portal position can be derived")
        exterior_x = sum(point[0] for point in candidates) / len(candidates)
        exterior_y = sum(point[1] for point in candidates) / len(candidates)
        exterior_percent = (
            exterior_x * 100.0 / dimensions[0],
            exterior_y * 100.0 / dimensions[1],
        ) if dimensions else (exterior_x, exterior_y)
        nodes["Exterior"] = {
            "id": "Exterior",
            "room_type": "Exterior",
            "room_label": "Exterior",
            "geometry_type": "synthetic",
            "result_id": "",
            "display_name": "Exterior",
            "hierarchy_level": "exterior",
            "centroid_x_percent": _rounded(exterior_percent[0]),
            "centroid_y_percent": _rounded(exterior_percent[1]),
            "centroid_x_px": _rounded(exterior_x) if dimensions else None,
            "centroid_y_px": _rounded(exterior_y) if dimensions else None,
            "label_studio_color": EXTERIOR_COLOR,
        }
    for edge in portals:
        edge.pop("_centroid_percent", None)
        if edge["source"] not in nodes or edge["target"] not in nodes:
            raise RoomV3Error(
                f"portal {edge['id']} has missing endpoint(s): {edge['source']}, {edge['target']}"
            )
    return {
        "schema_version": 3,
        "source_task_id": task.get("id"),
        "source_annotation_id": annotation.get("id"),
        "network_name": f"Room v3 Task {task.get('id')} Annotation {annotation.get('id')}",
        "image_width_px": dimensions[0] if dimensions else None,
        "image_height_px": dimensions[1] if dimensions else None,
        "room_config_sha256": str(palette.get("sha256") or "") if palette else "",
        "nodes": [nodes[key] for key in sorted(nodes)],
        "edges": sorted(portals, key=lambda edge: edge["id"]),
    }


def to_graphml(graph: dict[str, Any]) -> ET.ElementTree:
    ET.register_namespace("", GRAPHML_NS)
    root = ET.Element(f"{{{GRAPHML_NS}}}graphml")
    graph_fields = {
        "schema_version": "int",
        "source_task_id": "int",
        "source_annotation_id": "int",
        "network_name": "string",
        "image_width_px": "double",
        "image_height_px": "double",
        "room_config_sha256": "string",
    }
    node_fields = {
        "room_type": "string",
        "room_label": "string",
        "geometry_type": "string",
        "result_id": "string",
        "display_name": "string",
        "hierarchy_level": "string",
        "centroid_x_percent": "double",
        "centroid_y_percent": "double",
        "centroid_x_px": "double",
        "centroid_y_px": "double",
        "label_studio_color": "string",
    }
    edge_fields = {
        "edge_kind": "string",
        "display_name": "string",
        "opening_type": "string",
        "geometry_type": "string",
        "connected_room_ids": "string",
        "clear_width_percent": "double",
        "depth_percent": "double",
        "clear_width_px": "double",
        "depth_px": "double",
        "centerline": "string",
        "boundary_segments": "string",
        "connects_to_exterior": "boolean",
        "result_id": "string",
        "label_studio_color": "string",
    }
    for name, kind in graph_fields.items():
        ET.SubElement(
            root,
            f"{{{GRAPHML_NS}}}key",
            {"id": f"graph_{name}", "for": "graph", "attr.name": name, "attr.type": kind},
        )
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

    def add_data(element: ET.Element, prefix: str, name: str, value: Any) -> None:
        if value is None or value == "":
            return
        if isinstance(value, bool):
            rendered = "true" if value else "false"
        elif isinstance(value, (dict, list)):
            rendered = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        else:
            rendered = str(value)
        ET.SubElement(element, f"{{{GRAPHML_NS}}}data", {"key": f"{prefix}_{name}"}).text = rendered

    for name in graph_fields:
        add_data(graph_element, "graph", name, graph.get(name))
    for node in graph["nodes"]:
        element = ET.SubElement(graph_element, f"{{{GRAPHML_NS}}}node", {"id": node["id"]})
        for name in node_fields:
            add_data(element, "node", name, node.get(name))
    for edge in graph["edges"]:
        element = ET.SubElement(
            graph_element,
            f"{{{GRAPHML_NS}}}edge",
            {"id": edge["id"], "source": edge["source"], "target": edge["target"]},
        )
        for name in edge_fields:
            add_data(element, "edge", name, edge.get(name))
    return ET.ElementTree(root)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert Room v3 Label Studio JSON to GraphML.")
    parser.add_argument("--input-json", required=True, type=Path)
    parser.add_argument("--annotation-id", type=int)
    parser.add_argument("--output-graphml", required=True, type=Path)
    parser.add_argument("--output-json", type=Path)
    parser.add_argument("--room-label-config", type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        palette = load_label_palette(args.room_label_config) if args.room_label_config else None
        graph = convert(load_single_task(args.input_json), args.annotation_id, palette)
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
