#!/usr/bin/env python3
"""Build a single Cytoscape network with collapsible room Groups.

Rooms without functional zones remain ordinary room nodes. A room with zones
is replaced by its zone nodes; its original room metadata is written to a
group manifest so ``cytoscape_apply_groups.py`` can create a Cytoscape Group.
Room openings are reconnected to the unique owning zone on every partitioned
side. This keeps cross-room connectivity real and analyzable after expansion.
Optional Label Studio room/zone configs add a strictly validated color palette
to the GraphML nodes and Group manifest without hard-coding project labels.
Movement ``connection_vector`` results imply visual connectivity. Additional
``visual_connection_vector`` results contribute only to the visual layer; the
two modalities are normalized independently inside each parent room.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
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


@dataclass(frozen=True)
class LabelPalette:
    room_labels: dict[str, str]
    zone_labels: dict[str, str]
    room_config_sha256: str
    zone_config_sha256: str

    def manifest_data(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "source": "label_studio",
            "room_labels": dict(sorted(self.room_labels.items())),
            "zone_labels": dict(sorted(self.zone_labels.items())),
            "room_config_sha256": self.room_config_sha256,
            "zone_config_sha256": self.zone_config_sha256,
        }


_HEX_COLOR = re.compile(r"^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$")


def _normalize_color(raw: str, context: str) -> str:
    value = raw.strip()
    if not _HEX_COLOR.fullmatch(value):
        raise base.ConversionError(
            f"{context} has unsupported color {raw!r}; expected #RGB or #RRGGBB"
        )
    if len(value) == 4:
        value = "#" + "".join(character * 2 for character in value[1:])
    return value.upper()


def _extract_label_config_text(raw: str, source_name: str) -> str:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return raw

    configs: list[str] = []

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            label_config = value.get("label_config")
            if isinstance(label_config, str) and label_config.strip():
                configs.append(label_config)
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(payload)
    distinct = list(dict.fromkeys(configs))
    if len(distinct) != 1:
        raise base.ConversionError(
            f"{source_name} project JSON must contain exactly one label_config, "
            f"found {len(distinct)}"
        )
    return distinct[0]


def _parse_label_config(raw: str, source_name: str) -> ET.Element:
    config = _extract_label_config_text(raw, source_name)
    try:
        return ET.fromstring(config)
    except ET.ParseError as exc:
        raise base.ConversionError(
            f"{source_name} label config is not valid XML: {exc}"
        ) from exc


def _control_palettes(
    root: ET.Element,
    control_names: Sequence[str],
    source_name: str,
) -> dict[str, dict[str, str]]:
    requested = set(control_names)
    controls: dict[str, dict[str, str]] = {}
    for element in root.iter():
        control_name = element.attrib.get("name")
        if control_name not in requested:
            continue
        mapping = controls.setdefault(control_name, {})
        for child in element.iter():
            if child.tag.rsplit("}", 1)[-1] != "Label":
                continue
            label = child.attrib.get("value", "").strip()
            color = child.attrib.get("background", "").strip()
            if not label:
                raise base.ConversionError(
                    f"{source_name} control {control_name} contains a Label without value"
                )
            if not color:
                raise base.ConversionError(
                    f"{source_name} control {control_name} label {label!r} has no background color"
                )
            normalized = _normalize_color(
                color, f"{source_name} control {control_name} label {label!r}"
            )
            previous = mapping.get(label)
            if previous is not None and previous != normalized:
                raise base.ConversionError(
                    f"{source_name} control {control_name} assigns conflicting colors "
                    f"to {label!r}: {previous} and {normalized}"
                )
            mapping[label] = normalized

    missing = [name for name in control_names if name not in controls]
    if missing:
        raise base.ConversionError(
            f"{source_name} label config is missing control(s): {', '.join(missing)}"
        )
    return controls


def load_label_palette(room_config: Path, zone_config: Path) -> LabelPalette:
    try:
        room_bytes = room_config.read_bytes()
        zone_bytes = zone_config.read_bytes()
    except OSError as exc:
        raise base.ConversionError(f"cannot read Label Studio label config: {exc}") from exc

    room_root = _parse_label_config(room_bytes.decode("utf-8-sig"), "room")
    zone_root = _parse_label_config(zone_bytes.decode("utf-8-sig"), "zone")
    room_controls = _control_palettes(
        room_root, ("label", "polygon_label"), "room"
    )
    room_labels: dict[str, str] = {}
    for control_name in ("label", "polygon_label"):
        for label, color in room_controls[control_name].items():
            previous = room_labels.get(label)
            if previous is not None and previous != color:
                raise base.ConversionError(
                    f"room label {label!r} has inconsistent colors between label and "
                    f"polygon_label: {previous} and {color}"
                )
            room_labels[label] = color

    zone_controls = _control_palettes(zone_root, ("function_zone",), "zone")
    return LabelPalette(
        room_labels=room_labels,
        zone_labels=zone_controls["function_zone"],
        room_config_sha256=hashlib.sha256(room_bytes).hexdigest(),
        zone_config_sha256=hashlib.sha256(zone_bytes).hexdigest(),
    )


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
        from_name = result.get("from_name")
        if from_name not in base.CONNECTION_CONTROLS or result.get("type") != "vectorlabels":
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
            modality=base.CONNECTION_CONTROLS[str(from_name)],
            control_name=str(from_name),
        )
    return [connections[result_id] for result_id in sorted(connections)]


def _internal_edge_models(
    zones: Sequence[base.Zone],
    connections: Sequence[base.Connection],
    epsilon: float,
    min_support_ratio: float,
    min_vector_length: float,
) -> tuple[
    list[dict[str, Any]],
    dict[str, dict[str, Any]],
    dict[str, dict[str, float]],
]:
    return base.connectivity_edge_models(
        zones,
        connections,
        epsilon,
        min_support_ratio,
        min_vector_length,
    )


def _room_node_row(
    result: dict[str, Any],
    room_colors: dict[str, str] | None = None,
) -> dict[str, Any]:
    result_id = str(result["id"])
    label = base._room_label(result)
    polygon = base.result_polygon(result)
    centroid = base.polygon_centroid(polygon)
    node_meta = result["meta"]["room_graph_node"]
    canonical = room_id(result_id)
    row = {
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
    if room_colors is not None:
        row["label_studio_color"] = room_colors[label]
    return row


def _zone_node_row(
    zone: base.Zone,
    metrics: dict[str, Any],
    zone_colors: dict[str, str] | None = None,
) -> dict[str, Any]:
    canonical = zone_id(zone.result_id)
    centroid = metrics["centroid_px"]
    row = {
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
    if zone_colors is not None:
        row["label_studio_color"] = zone_colors[zone.label]
    return row


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
    label_palette: LabelPalette | None = None,
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
    used_room_labels = sorted({base._room_label(result) for result in reference_rooms})
    used_zone_labels = sorted({zone.label for zone in zones})
    if label_palette is not None:
        missing_room_labels = sorted(set(used_room_labels) - set(label_palette.room_labels))
        missing_zone_labels = sorted(set(used_zone_labels) - set(label_palette.zone_labels))
        if missing_room_labels or missing_zone_labels:
            details: list[str] = []
            if missing_room_labels:
                details.append("room labels: " + ", ".join(missing_room_labels))
            if missing_zone_labels:
                details.append("zone labels: " + ", ".join(missing_zone_labels))
            raise base.ConversionError(
                "Label Studio palette is missing labels used by this task ("
                + "; ".join(details)
                + ")"
            )
    grouped_rooms: dict[str, list[base.Zone]] = {}
    for zone in zones:
        grouped_rooms.setdefault(
            str(zone.partition_context["parent_room_id"]), []
        ).append(zone)
    internal_models, zone_metrics, room_maxima = _internal_edge_models(
        zones,
        connections,
        resolved_epsilon,
        min_support_ratio,
        resolved_min_length,
    )
    base.assign_connectivity_edge_ids(internal_models)
    junction_models, junction_reports = base.derived_junction_models(
        zones, internal_models, resolved_epsilon
    )
    movement_connections = [
        connection for connection in connections if connection.modality == "movement"
    ]
    visual_only_connections = [
        connection for connection in connections if connection.modality == "visual_only"
    ]

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
            node_rows.append(
                (
                    room_id(result_id),
                    _room_node_row(
                        result,
                        label_palette.room_labels if label_palette is not None else None,
                    ),
                )
            )
    for zone in zones:
        node_rows.append(
            (
                zone_id(zone.result_id),
                _zone_node_row(
                    zone,
                    zone_metrics[zone.result_id],
                    label_palette.zone_labels if label_palette is not None else None,
                ),
            )
        )

    internal_edges: list[tuple[str, str, str, dict[str, Any]]] = []
    internal_report: list[dict[str, Any]] = []
    for model in internal_models:
        first, second = model["pair"]
        movement_items = model["movement_items"]
        visual_only_items = model["visual_only_items"]
        movement_ids = sorted(
            item["connection"].result_id for item in movement_items
        )
        visual_only_ids = sorted(
            item["connection"].result_id for item in visual_only_items
        )
        edge_result_id = str(model["edge_result_id"])
        minimum_support = min(
            ratio
            for item in model["items"]
            for ratio in item["support_ratios"].values()
        )
        labels = model["labels"]
        movement_geometry = [
            {
                "result_id": item["connection"].result_id,
                "label": item["connection"].label,
                "vertices_px": [
                    [base._round(point[0]), base._round(point[1])]
                    for point in item["connection"].vertices
                ],
            }
            for item in movement_items
        ]
        visual_only_geometry = [
            {
                "result_id": item["connection"].result_id,
                "label": item["connection"].label,
                "vertices_px": [
                    [base._round(point[0]), base._round(point[1])]
                    for point in item["connection"].vertices
                ],
            }
            for item in visual_only_items
        ]
        row = {
            "name": edge_result_id,
            "shared_name": " / ".join(labels),
            "display_name": " / ".join(labels),
            "edge_kind": model["edge_kind"],
            "interaction": model["edge_kind"],
            "connection_type": "+".join(base._snake_case(label) for label in labels),
            "connection_labels_json": base._json(labels),
            "connectivity_modalities_json": base._json(
                model["connectivity_modalities"]
            ),
            "movement_vector_result_ids_json": base._json(movement_ids),
            "visual_only_vector_result_ids_json": base._json(visual_only_ids),
            "movement_vector_geometry_px_json": base._json(movement_geometry),
            "visual_only_vector_geometry_px_json": base._json(
                visual_only_geometry
            ),
            "parent_room_id": model["parent_room_id"],
            "source_perimeter_px": base._round(zone_metrics[first]["perimeter_px"]),
            "target_perimeter_px": base._round(zone_metrics[second]["perimeter_px"]),
            "shared_boundary_length_px": base._round(
                model["shared_boundary_length_px"]
            ),
            "movement_length_px": base._round(model["movement_length_px"]),
            "movement_raw_strength": base._round(model["movement_raw_strength"]),
            "movement_relative_strength": base._round(
                model["movement_relative_strength"]
            ),
            "movement_interface_openness": base._round(
                model["movement_interface_openness"]
            ),
            "movement_room_max_raw_strength": base._round(
                model["movement_room_max_raw_strength"]
            ),
            "visual_length_px": base._round(model["visual_length_px"]),
            "visual_raw_strength": base._round(model["visual_raw_strength"]),
            "visual_relative_strength": base._round(
                model["visual_relative_strength"]
            ),
            "visual_interface_openness": base._round(
                model["visual_interface_openness"]
            ),
            "visual_room_max_raw_strength": base._round(
                model["visual_room_max_raw_strength"]
            ),
            "minimum_boundary_support_ratio": base._round(minimum_support),
            "source_canonical_id": zone_id(first),
            "target_canonical_id": zone_id(second),
        }
        if movement_ids:
            row.update(
                {
                    "vector_result_ids_json": base._json(movement_ids),
                    "vector_geometry_px_json": base._json(movement_geometry),
                    "opening_length_px": base._round(model["opening_length_px"]),
                    "raw_strength": base._round(model["raw_strength"]),
                    "relative_strength": base._round(model["relative_strength"]),
                    "interface_openness": base._round(model["interface_openness"]),
                    "room_max_raw_strength": base._round(
                        model["room_max_raw_strength"]
                    ),
                }
            )
        internal_edges.append((edge_result_id, zone_id(first), zone_id(second), row))
        internal_report.append(
            {
                "edge_result_id": edge_result_id,
                "source_zone_id": first,
                "target_zone_id": second,
                **row,
            }
        )

    for junction in junction_models:
        first, second = junction["pair"]
        edge_result_id = str(junction["edge_result_id"])
        row = base.derived_junction_edge_row(junction)
        row.update(
            {
                "source_canonical_id": zone_id(first),
                "target_canonical_id": zone_id(second),
            }
        )
        internal_edges.append(
            (edge_result_id, zone_id(first), zone_id(second), row)
        )
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
        parent_row = _room_node_row(
            parent_result,
            label_palette.room_labels if label_palette is not None else None,
        )
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
        visual_boundary_ids = sorted(
            edge_result_id
            for edge_result_id, _, _, row in internal_edges
            if row["parent_room_id"] == parent_id
            and row["edge_kind"] == "visual_boundary"
        )
        derived_junction_ids = sorted(
            edge_result_id
            for edge_result_id, _, _, row in internal_edges
            if row["parent_room_id"] == parent_id
            and row["edge_kind"] == "derived_junction"
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
                "visual_boundary_edges": visual_boundary_ids,
                "derived_junction_edges": derived_junction_ids,
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
        "connection_vectors": len(movement_connections),
        "visual_connection_vectors": len(visual_only_connections),
        "direct_boundary_edges": sum(
            row["edge_kind"] == "direct_boundary" for _, _, _, row in internal_edges
        ),
        "visual_boundary_edges": sum(
            row["edge_kind"] == "visual_boundary" for _, _, _, row in internal_edges
        ),
        "derived_junction_edges": len(junction_models),
        "movement_derived_junction_edges": sum(
            "movement" in model["modalities"] for model in junction_models
        ),
        "visual_derived_junction_edges": sum(
            "visual" in model["modalities"] for model in junction_models
        ),
        "total_data_nodes": len(node_rows),
        "total_edges": len(all_edges),
    }
    manifest = {
        "schema_version": 2,
        "connectivity_schema_version": 2,
        "task_id": task.get("id"),
        "annotation_id": annotation.get("id"),
        "network_name": network_name,
        "expected_counts": counts,
        "groups": manifest_groups,
    }
    if label_palette is not None:
        manifest["label_palette"] = label_palette.manifest_data()
    report = {
        "schema_version": 2,
        "connectivity_schema_version": 2,
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
            "all_visual_connection_vectors_have_exactly_two_same_room_zone_endpoints": True,
            "movement_and_visual_only_vectors_do_not_overlap": True,
            "movement_implies_visual": True,
            "movement_and_visual_strengths_normalized_independently": True,
            "derived_junctions_use_best_harmonic_path": True,
            "derived_junctions_excluded_from_direct_normalization": True,
            "every_partitioned_opening_has_exactly_one_owner_per_partitioned_side": True,
            "every_reference_opening_emitted_once": True,
            "connected_room_ids_match_opening_endpoints": True,
            "no_dangling_canonical_endpoints": True,
            "label_palette_complete": label_palette is not None,
        },
        "groups": manifest_groups,
        "external_edges": external_edge_report,
        "internal_edges": internal_report,
        "junctions": junction_reports,
        "room_max_raw_strengths": {
            parent_id: {
                "movement": base._round(values["movement"]),
                "visual": base._round(values["visual"]),
            }
            for parent_id, values in sorted(room_maxima.items())
        },
    }
    if label_palette is not None:
        report["label_palette"] = {
            **label_palette.manifest_data(),
            "room_label_count": len(label_palette.room_labels),
            "zone_label_count": len(label_palette.zone_labels),
            "used_room_labels": {
                label: label_palette.room_labels[label] for label in used_room_labels
            },
            "used_zone_labels": {
                label: label_palette.zone_labels[label] for label in used_zone_labels
            },
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
    parser.add_argument(
        "--room-label-config",
        type=Path,
        help="Room_Label_v2 XML or project JSON containing label and polygon_label",
    )
    parser.add_argument(
        "--zone-label-config",
        type=Path,
        help="Zone_Label XML or project JSON containing function_zone",
    )
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
        if bool(args.room_label_config) != bool(args.zone_label_config):
            raise base.ConversionError(
                "--room-label-config and --zone-label-config must be provided together"
            )
        label_palette = (
            load_label_palette(args.room_label_config, args.zone_label_config)
            if args.room_label_config is not None
            else None
        )
        payload = base.load_payload(args.input_json)
        task = base.select_task(payload, args.task_id)
        converted = convert(
            task,
            prefix=args.prefix,
            epsilon=args.epsilon_px,
            min_support_ratio=args.min_support_ratio,
            min_vector_length=args.min_vector_length_px,
            label_palette=label_palette,
        )
        output_dir.mkdir(parents=True, exist_ok=True)
        converted.graphml.write(graphml_path, encoding="utf-8", xml_declaration=True)
        manifest = {
            **converted.manifest,
            "graphml_file": graphml_path.name,
            "report_file": report_path.name,
        }
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        report = {
            **converted.report,
            "input_json_sha256": hashlib.sha256(args.input_json.read_bytes()).hexdigest(),
            "output_files": {
                "graphml": graphml_path.name,
                "group_manifest": manifest_path.name,
                "report": report_path.name,
            },
        }
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    except base.ConversionError as exc:
        output_dir.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(
                {
                    "schema_version": 2,
                    "connectivity_schema_version": 2,
                    "status": "error",
                    "error": str(exc),
                },
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
