#!/usr/bin/env python3
"""Build a single Cytoscape network with collapsible room Groups.

Rooms without functional zones remain ordinary room nodes. A room with zones
is replaced by its zone nodes; its original room metadata is written to a
group manifest so ``cytoscape_apply_groups.py`` can create a Cytoscape Group.
Room openings are reconnected to the unique owning zone on every partitioned
side. This keeps cross-room connectivity real and analyzable after expansion.
"""

from __future__ import annotations

import argparse
import json
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import zone_annotation_to_nested_graphml as base


@dataclass
class GroupedConversion:
    graphml: ET.ElementTree
    manifest: dict[str, Any]
    report: dict[str, Any]


def room_id(result_id: str) -> str:
    return f"room::{result_id}"


def zone_id(result_id: str) -> str:
    return f"zone::{result_id}"


def _partition_context(result: dict[str, Any]) -> dict[str, Any]:
    meta = result.get("meta")
    context = meta.get("partition_context") if isinstance(meta, dict) else None
    return context if isinstance(context, dict) else {}


def _collect_zones(
    annotation: dict[str, Any],
    rooms_by_id: dict[str, dict[str, Any]],
    epsilon: float,
) -> list[base.Zone]:
    results = annotation.get("result")
    if not isinstance(results, list):
        raise base.ConversionError("selected annotation result must be a list")

    geometries: dict[str, dict[str, Any]] = {}
    labels: dict[str, dict[str, Any]] = {}
    for result in results:
        if not isinstance(result, dict):
            continue
        result_id = result.get("id")
        if not isinstance(result_id, str) or not result_id:
            continue
        if result.get("from_name") in {"zone_rectangle", "zone_polygon"} and result.get(
            "type"
        ) in {"rectangle", "polygon"}:
            if result_id in geometries:
                raise base.ConversionError(f"zone {result_id} has more than one geometry result")
            geometries[result_id] = result
        elif result.get("from_name") == "function_zone" and result.get("type") == "labels":
            if result_id in labels:
                raise base.ConversionError(f"zone {result_id} has more than one function_zone result")
            labels[result_id] = result

    if not geometries:
        raise base.ConversionError("annotation does not contain functional-zone geometry")
    missing_labels = sorted(set(geometries) - set(labels))
    if missing_labels:
        raise base.ConversionError(
            "zone geometry is missing a matching function_zone label: "
            + ", ".join(missing_labels)
        )

    zones: list[base.Zone] = []
    for result_id, result in sorted(geometries.items()):
        context = _partition_context(result)
        parent_id = context.get("parent_room_id")
        if not isinstance(parent_id, str) or not parent_id:
            raise base.ConversionError(f"zone {result_id} is missing partition_context.parent_room_id")
        parent = rooms_by_id.get(parent_id)
        if parent is None:
            raise base.ConversionError(
                f"zone {result_id} references missing parent room {parent_id}"
            )
        polygon = base.result_polygon(result)
        if base.polygon_area(polygon) <= 1e-9:
            raise base.ConversionError(f"zone {result_id} has zero area")
        parent_polygon = base.result_polygon(parent)
        for segment in base.polygon_segments(polygon):
            for point in base._sample_polyline(segment, 21):
                if not base.point_in_polygon(point, parent_polygon, epsilon):
                    raise base.ConversionError(
                        f"zone {result_id} extends outside parent room {parent_id}"
                    )
        zones.append(
            base.Zone(
                result_id=result_id,
                label=base._single_label(labels[result_id], "labels"),
                geometry_type=str(result.get("type")),
                polygon=polygon,
                value=result.get("value", {}),
                partition_context=context,
            )
        )
    return zones


def _collect_connections(annotation: dict[str, Any]) -> list[base.Connection]:
    results = annotation.get("result")
    connections: dict[str, base.Connection] = {}
    for result in results if isinstance(results, list) else []:
        if not isinstance(result, dict):
            continue
        if result.get("from_name") != "connection_vector" or result.get("type") != "vectorlabels":
            continue
        result_id = result.get("id")
        if not isinstance(result_id, str) or not result_id:
            raise base.ConversionError("connection Vector without result ID")
        if result_id in connections:
            raise base.ConversionError(f"duplicate connection Vector result ID: {result_id}")
        connections[result_id] = base.Connection(
            result_id=result_id,
            label=base._single_label(result, "vectorlabels"),
            vertices=base.result_vector(result),
            value=result.get("value", {}),
        )
    return [connections[result_id] for result_id in sorted(connections)]


def _internal_edge_models(
    zones: Sequence[base.Zone],
    connections: Sequence[base.Connection],
    epsilon: float,
    min_support_ratio: float,
    min_vector_length: float,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    zone_by_id = {zone.result_id: zone for zone in zones}
    zone_metrics = {
        zone.result_id: {
            "area_px2": base.polygon_area(zone.polygon),
            "perimeter_px": base.polygon_perimeter(zone.polygon),
            "centroid_px": base.polygon_centroid(zone.polygon),
        }
        for zone in zones
    }
    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for connection in connections:
        length = base.polyline_length(connection.vertices)
        if length < min_vector_length:
            raise base.ConversionError(
                f"connection Vector {connection.result_id} is too short: "
                f"{length:.3f}px < {min_vector_length:.3f}px"
            )
        ratios = {
            zone.result_id: base.boundary_support_ratio(
                connection.vertices, zone.polygon, epsilon
            )
            for zone in zones
        }
        supported = sorted(
            zone_result_id
            for zone_result_id, ratio in ratios.items()
            if ratio >= min_support_ratio
        )
        if len(supported) != 2:
            details = ", ".join(
                f"{zone_by_id[result_id].label}/{result_id}={ratio:.3f}"
                for result_id, ratio in sorted(
                    ratios.items(), key=lambda item: item[1], reverse=True
                )
            )
            raise base.ConversionError(
                f"connection Vector {connection.result_id} must be supported by exactly two "
                f"zone boundaries, found {len(supported)} ({details})"
            )
        parents = {
            str(zone_by_id[result_id].partition_context.get("parent_room_id"))
            for result_id in supported
        }
        if len(parents) != 1:
            raise base.ConversionError(
                f"connection Vector {connection.result_id} crosses parent rooms: "
                + ", ".join(sorted(parents))
            )
        parent_id = next(iter(parents))
        key = parent_id, supported[0], supported[1]
        grouped.setdefault(key, []).append(
            {
                "connection": connection,
                "length": length,
                "support_ratios": {result_id: ratios[result_id] for result_id in supported},
            }
        )

    models: list[dict[str, Any]] = []
    room_max: dict[str, float] = {}
    for (parent_id, first, second), items in sorted(grouped.items()):
        segments = [
            segment
            for item in items
            for segment in base.polyline_segments(item["connection"].vertices)
        ]
        opening_length = base.union_segment_length(segments, epsilon)
        first_perimeter = zone_metrics[first]["perimeter_px"]
        second_perimeter = zone_metrics[second]["perimeter_px"]
        raw_strength = 0.5 * (
            opening_length / first_perimeter + opening_length / second_perimeter
        )
        shared_length = base.shared_boundary_length(
            zone_by_id[first].polygon, zone_by_id[second].polygon, epsilon
        )
        if shared_length <= 1e-9:
            raise base.ConversionError(
                f"zones {first} and {second} have a connection Vector but no shared boundary"
            )
        model = {
            "parent_room_id": parent_id,
            "pair": (first, second),
            "items": items,
            "labels": sorted({item["connection"].label for item in items}),
            "opening_length_px": opening_length,
            "shared_boundary_length_px": shared_length,
            "raw_strength": raw_strength,
            "interface_openness": opening_length / shared_length,
        }
        models.append(model)
        room_max[parent_id] = max(room_max.get(parent_id, 0.0), raw_strength)

    for model in models:
        maximum = room_max[model["parent_room_id"]]
        model["room_max_raw_strength"] = maximum
        model["relative_strength"] = model["raw_strength"] / maximum if maximum else 0.0
    return models, zone_metrics


def _room_node_row(result: dict[str, Any]) -> dict[str, Any]:
    result_id = str(result["id"])
    label = base._room_label(result)
    polygon = base.result_polygon(result)
    centroid = base.polygon_centroid(polygon)
    node_meta = result["meta"]["room_graph_node"]
    canonical = room_id(result_id)
    return {
        "name": canonical,
        "shared_name": label,
        "display_name": f"{label} · {result_id[:8]}",
        "canonical_id": canonical,
        "node_kind": "room",
        "hierarchy_level": "room",
        "room_label": label,
        "room_result_id": result_id,
        "geometry_type": str(result.get("type")),
        "geometry_percent_json": base._json(result.get("value", {})),
        "geometry_px_json": base._json(
            [[base._round(point[0]), base._round(point[1])] for point in polygon]
        ),
        "area_px2": base._round(base.polygon_area(polygon)),
        "perimeter_px": base._round(base.polygon_perimeter(polygon)),
        "centroid_x_px": base._round(centroid[0]),
        "centroid_y_px": base._round(centroid[1]),
        "room_graph_node_json": base._json(node_meta),
    }


def _zone_node_row(zone: base.Zone, metrics: dict[str, Any]) -> dict[str, Any]:
    canonical = zone_id(zone.result_id)
    centroid = metrics["centroid_px"]
    return {
        "name": canonical,
        "shared_name": zone.label,
        "display_name": zone.label,
        "canonical_id": canonical,
        "node_kind": "functional_zone",
        "hierarchy_level": "zone",
        "zone_label": zone.label,
        "zone_result_id": zone.result_id,
        "parent_room_id": str(zone.partition_context["parent_room_id"]),
        "geometry_type": zone.geometry_type,
        "geometry_percent_json": base._json(zone.value),
        "geometry_px_json": base._json(
            [[base._round(point[0]), base._round(point[1])] for point in zone.polygon]
        ),
        "area_px2": base._round(metrics["area_px2"]),
        "perimeter_px": base._round(metrics["perimeter_px"]),
        "centroid_x_px": base._round(centroid[0]),
        "centroid_y_px": base._round(centroid[1]),
        "opening_ids_json": base._json(zone.partition_context.get("opening_ids", [])),
        "connected_room_ids_json": base._json(
            zone.partition_context.get("connected_room_ids", [])
        ),
    }


def _opening_edge_row(result: dict[str, Any], edge_kind: str) -> dict[str, Any]:
    result_id = str(result["id"])
    edge_meta = result["meta"]["room_graph_edge"]
    label = base._single_label(result, "vectorlabels")
    vertices = base.result_vector(result)
    return {
        "name": result_id,
        "shared_name": label,
        "display_name": label,
        "edge_kind": edge_kind,
        "interaction": edge_kind,
        "opening_result_id": result_id,
        "opening_type": str(edge_meta.get("opening_type") or label),
        "walkable": bool(edge_meta.get("walkable", False)),
        "width_pixels": float(edge_meta.get("width_pixels") or base.polyline_length(vertices)),
        "midpoint_x_percent": float(edge_meta.get("midpoint_x", 0.0)),
        "midpoint_y_percent": float(edge_meta.get("midpoint_y", 0.0)),
        "confidence": float(edge_meta.get("confidence", 0.0)),
        "geometry_percent_json": base._json(result.get("value", {})),
        "geometry_px_json": base._json(
            [[base._round(point[0]), base._round(point[1])] for point in vertices]
        ),
        "room_graph_edge_json": base._json(edge_meta),
    }


def convert(
    task: dict[str, Any],
    prefix: str = "floorplan",
    epsilon: float | None = None,
    min_support_ratio: float = 0.95,
    min_vector_length: float | None = None,
) -> GroupedConversion:
    annotation = base.select_annotation(task)
    results = annotation.get("result")
    if not isinstance(results, list):
        raise base.ConversionError("selected annotation result must be a list")

    room_candidates = [
        result
        for result in results
        if isinstance(result, dict)
        and result.get("from_name") in {"label", "polygon_label"}
        and result.get("type") in {"rectanglelabels", "polygonlabels"}
    ]
    if not room_candidates:
        raise base.ConversionError("annotation does not contain room references")
    width, height = base._result_dimensions(room_candidates[0])
    resolved_epsilon = (
        float(epsilon) if epsilon is not None else float(max(2, round(0.001 * min(width, height))))
    )
    resolved_min_length = (
        float(min_vector_length)
        if min_vector_length is not None
        else max(4.0, 2.0 * resolved_epsilon)
    )
    if resolved_epsilon <= 0:
        raise base.ConversionError("epsilon must be positive")
    if not 0 < min_support_ratio <= 1:
        raise base.ConversionError("min_support_ratio must be in (0, 1]")
    if resolved_min_length <= 0:
        raise base.ConversionError("min_vector_length must be positive")

    reference_rooms, reference_openings = base._extract_room_reference_graph(
        annotation, str(room_candidates[0]["id"])
    )
    rooms_by_id = {str(result["id"]): result for result in reference_rooms}
    openings_by_id = {str(result["id"]): result for result in reference_openings}
    zones = _collect_zones(annotation, rooms_by_id, resolved_epsilon)
    connections = _collect_connections(annotation)
    grouped_rooms: dict[str, list[base.Zone]] = {}
    for zone in zones:
        grouped_rooms.setdefault(
            str(zone.partition_context["parent_room_id"]), []
        ).append(zone)
    internal_models, zone_metrics = _internal_edge_models(
        zones,
        connections,
        resolved_epsilon,
        min_support_ratio,
        resolved_min_length,
    )

    claims: dict[tuple[str, str], list[str]] = {}
    for zone in zones:
        parent_id = str(zone.partition_context["parent_room_id"])
        opening_ids = zone.partition_context.get("opening_ids", [])
        connected_ids = zone.partition_context.get("connected_room_ids", [])
        if not isinstance(opening_ids, list) or not all(
            isinstance(item, str) and item for item in opening_ids
        ):
            raise base.ConversionError(f"zone {zone.result_id} has invalid opening_ids")
        if not isinstance(connected_ids, list) or not all(
            isinstance(item, str) and item for item in connected_ids
        ):
            raise base.ConversionError(f"zone {zone.result_id} has invalid connected_room_ids")
        for opening_result_id in opening_ids:
            opening = openings_by_id.get(opening_result_id)
            if opening is None:
                raise base.ConversionError(
                    f"zone {zone.result_id} claims missing opening {opening_result_id}"
                )
            room_ids = opening["meta"]["room_graph_edge"]["room_ids"]
            if parent_id not in room_ids:
                raise base.ConversionError(
                    f"zone {zone.result_id} claims opening {opening_result_id}, which is not "
                    f"incident to parent room {parent_id}"
                )
            claims.setdefault((parent_id, opening_result_id), []).append(zone.result_id)

    expected_connected: dict[str, set[str]] = {zone.result_id: set() for zone in zones}
    opening_edges: list[tuple[str, str, str, dict[str, Any]]] = []
    external_edge_report: list[dict[str, Any]] = []
    room_edge_count = 0
    external_edge_count = 0
    seen_opening_ids: set[str] = set()
    for opening in reference_openings:
        opening_result_id = str(opening["id"])
        if opening_result_id in seen_opening_ids:
            raise base.ConversionError(f"duplicate opening reference ID: {opening_result_id}")
        seen_opening_ids.add(opening_result_id)
        room_ids = opening["meta"]["room_graph_edge"]["room_ids"]
        endpoints: list[str] = []
        endpoint_details: list[dict[str, str]] = []
        for index, parent_id in enumerate(room_ids):
            other_room_id = room_ids[1 - index]
            if parent_id in grouped_rooms:
                owners = claims.get((parent_id, opening_result_id), [])
                if len(owners) != 1:
                    raise base.ConversionError(
                        f"opening {opening_result_id} at partitioned room {parent_id} must have "
                        f"exactly one owning zone, found {len(owners)}"
                        + (f": {', '.join(sorted(owners))}" if owners else "")
                    )
                owner_id = owners[0]
                endpoints.append(zone_id(owner_id))
                endpoint_details.append(
                    {"kind": "zone", "result_id": owner_id, "parent_room_id": parent_id}
                )
                expected_connected[owner_id].add(other_room_id)
            else:
                endpoints.append(room_id(parent_id))
                endpoint_details.append({"kind": "room", "result_id": parent_id})
        edge_kind = (
            "zone_external_opening"
            if any(item["kind"] == "zone" for item in endpoint_details)
            else "room_opening"
        )
        if edge_kind == "room_opening":
            room_edge_count += 1
        else:
            external_edge_count += 1
        row = _opening_edge_row(opening, edge_kind)
        row["source_canonical_id"] = endpoints[0]
        row["target_canonical_id"] = endpoints[1]
        opening_edges.append((opening_result_id, endpoints[0], endpoints[1], row))
        if edge_kind == "zone_external_opening":
            external_edge_report.append(
                {
                    "opening_result_id": opening_result_id,
                    "opening_type": row["opening_type"],
                    "source": endpoint_details[0],
                    "target": endpoint_details[1],
                }
            )

    for zone in zones:
        connected = zone.partition_context.get("connected_room_ids", [])
        actual = set(connected if isinstance(connected, list) else [])
        expected = expected_connected[zone.result_id]
        if actual != expected:
            raise base.ConversionError(
                f"zone {zone.result_id} connected_room_ids mismatch: "
                f"expected {sorted(expected)}, got {sorted(actual)}"
            )

    if seen_opening_ids != set(openings_by_id):
        raise base.ConversionError("not every room opening was emitted exactly once")

    node_rows: list[tuple[str, dict[str, Any]]] = []
    for result in reference_rooms:
        result_id = str(result["id"])
        if result_id not in grouped_rooms:
            node_rows.append((room_id(result_id), _room_node_row(result)))
    for zone in zones:
        node_rows.append(
            (zone_id(zone.result_id), _zone_node_row(zone, zone_metrics[zone.result_id]))
        )

    internal_edges: list[tuple[str, str, str, dict[str, Any]]] = []
    internal_report: list[dict[str, Any]] = []
    for index, model in enumerate(internal_models, start=1):
        first, second = model["pair"]
        item_ids = sorted(item["connection"].result_id for item in model["items"])
        edge_result_id = item_ids[0] if len(item_ids) == 1 else f"zone-edge-{index}"
        minimum_support = min(
            ratio
            for item in model["items"]
            for ratio in item["support_ratios"].values()
        )
        labels = model["labels"]
        row = {
            "name": edge_result_id,
            "shared_name": " / ".join(labels),
            "display_name": " / ".join(labels),
            "edge_kind": "direct_boundary",
            "interaction": "direct_boundary",
            "connection_type": "+".join(base._snake_case(label) for label in labels),
            "connection_labels_json": base._json(labels),
            "vector_result_ids_json": base._json(item_ids),
            "parent_room_id": model["parent_room_id"],
            "opening_length_px": base._round(model["opening_length_px"]),
            "source_perimeter_px": base._round(zone_metrics[first]["perimeter_px"]),
            "target_perimeter_px": base._round(zone_metrics[second]["perimeter_px"]),
            "shared_boundary_length_px": base._round(
                model["shared_boundary_length_px"]
            ),
            "raw_strength": base._round(model["raw_strength"]),
            "relative_strength": base._round(model["relative_strength"]),
            "interface_openness": base._round(model["interface_openness"]),
            "minimum_boundary_support_ratio": base._round(minimum_support),
            "room_max_raw_strength": base._round(model["room_max_raw_strength"]),
            "source_canonical_id": zone_id(first),
            "target_canonical_id": zone_id(second),
        }
        internal_edges.append((edge_result_id, zone_id(first), zone_id(second), row))
        internal_report.append(
            {
                "edge_result_id": edge_result_id,
                "source_zone_id": first,
                "target_zone_id": second,
                **row,
            }
        )

    all_node_ids = {node_result_id for node_result_id, _ in node_rows}
    all_edges = [*opening_edges, *internal_edges]
    for edge_result_id, source, target, _ in all_edges:
        dangling = [endpoint for endpoint in (source, target) if endpoint not in all_node_ids]
        if dangling:
            raise base.ConversionError(
                f"edge {edge_result_id} has dangling canonical endpoint(s): "
                + ", ".join(dangling)
            )

    network_name = f"{prefix}-multilevel"
    manifest_groups: list[dict[str, Any]] = []
    for parent_id, room_zones in sorted(grouped_rooms.items()):
        parent_result = rooms_by_id[parent_id]
        parent_row = _room_node_row(parent_result)
        parent_row.update(
            {
                "node_kind": "room_group",
                "has_zone_group": True,
                "zone_count": len(room_zones),
            }
        )
        external_openings = sorted(
            opening_result_id
            for opening_result_id, source, target, row in opening_edges
            if row["edge_kind"] == "zone_external_opening"
            and any(zone_id(zone.result_id) in {source, target} for zone in room_zones)
        )
        internal_ids = sorted(
            edge_result_id
            for edge_result_id, _, _, row in internal_edges
            if row["parent_room_id"] == parent_id
        )
        room_label = base._room_label(parent_result)
        manifest_groups.append(
            {
                "group_name": f"{room_label} · {parent_id[:8]}",
                "group_canonical_id": room_id(parent_id),
                "parent_room_id": parent_id,
                "parent_node_attributes": parent_row,
                "member_canonical_ids": sorted(zone_id(zone.result_id) for zone in room_zones),
                "expected_internal_edge_ids": internal_ids,
                "expected_external_opening_ids": external_openings,
            }
        )

    graphml = base._graphml_tree(network_name, node_rows, all_edges)
    counts = {
        "reference_rooms": len(reference_rooms),
        "reference_openings": len(reference_openings),
        "grouped_rooms": len(grouped_rooms),
        "unpartitioned_room_nodes": len(reference_rooms) - len(grouped_rooms),
        "zone_nodes": len(zones),
        "room_opening_edges": room_edge_count,
        "zone_external_opening_edges": external_edge_count,
        "direct_boundary_edges": len(internal_edges),
        "total_data_nodes": len(node_rows),
        "total_edges": len(all_edges),
    }
    manifest = {
        "schema_version": 1,
        "task_id": task.get("id"),
        "annotation_id": annotation.get("id"),
        "network_name": network_name,
        "expected_counts": counts,
        "groups": manifest_groups,
    }
    report = {
        "schema_version": 1,
        "status": "ok",
        "task_id": task.get("id"),
        "annotation_id": annotation.get("id"),
        "network_name": network_name,
        "image_width": int(width) if width.is_integer() else width,
        "image_height": int(height) if height.is_integer() else height,
        "counts": counts,
        "validation": {
            "boundary_epsilon_px": resolved_epsilon,
            "minimum_boundary_support_ratio": min_support_ratio,
            "minimum_vector_length_px": resolved_min_length,
            "all_zones_inside_parent": True,
            "all_connection_vectors_have_exactly_two_same_room_zone_endpoints": True,
            "every_partitioned_opening_has_exactly_one_owner_per_partitioned_side": True,
            "every_reference_opening_emitted_once": True,
            "connected_room_ids_match_opening_endpoints": True,
            "no_dangling_canonical_endpoints": True,
        },
        "groups": manifest_groups,
        "external_edges": external_edge_report,
        "internal_edges": internal_report,
    }
    return GroupedConversion(graphml=graphml, manifest=manifest, report=report)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Convert Label Studio rooms, zones, and Vectors into one GraphML network "
            "plus a Cytoscape Group manifest."
        )
    )
    parser.add_argument("--input-json", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--task-id", type=int)
    parser.add_argument("--prefix", default="floorplan")
    parser.add_argument("--epsilon-px", type=float)
    parser.add_argument("--min-support-ratio", type=float, default=0.95)
    parser.add_argument("--min-vector-length-px", type=float)
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    output_dir: Path = args.output_dir
    graphml_path = output_dir / f"{args.prefix}-multilevel.graphml"
    manifest_path = output_dir / f"{args.prefix}-group-manifest.json"
    report_path = output_dir / f"{args.prefix}-multilevel-report.json"
    targets = [graphml_path, manifest_path, report_path]
    existing = [path for path in targets if path.exists()]
    if existing and not args.overwrite:
        print(
            "conversion failed: output file(s) already exist; pass --overwrite: "
            + ", ".join(str(path) for path in existing),
            file=sys.stderr,
        )
        return 2

    try:
        payload = base.load_payload(args.input_json)
        task = base.select_task(payload, args.task_id)
        converted = convert(
            task,
            prefix=args.prefix,
            epsilon=args.epsilon_px,
            min_support_ratio=args.min_support_ratio,
            min_vector_length=args.min_vector_length_px,
        )
        output_dir.mkdir(parents=True, exist_ok=True)
        converted.graphml.write(graphml_path, encoding="utf-8", xml_declaration=True)
        manifest = {
            **converted.manifest,
            "graphml_path": str(graphml_path.resolve()),
            "report_path": str(report_path.resolve()),
        }
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        report = {
            **converted.report,
            "input_json": str(args.input_json.resolve()),
            "outputs": {
                "graphml": str(graphml_path.resolve()),
                "group_manifest": str(manifest_path.resolve()),
                "report": str(report_path.resolve()),
            },
        }
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    except base.ConversionError as exc:
        output_dir.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(
                {"schema_version": 1, "status": "error", "error": str(exc)},
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"conversion failed: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"conversion failed while writing output: {exc}", file=sys.stderr)
        return 2

    counts = converted.report["counts"]
    print(
        f"wrote {counts['total_data_nodes']} nodes and {counts['total_edges']} edges "
        f"for {counts['grouped_rooms']} Cytoscape Group(s):\n"
        f"- {graphml_path}\n- {manifest_path}\n- {report_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
