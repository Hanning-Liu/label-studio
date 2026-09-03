#!/usr/bin/env python3
"""Add a validated L4 furniture annotation to a floorplan-unified/4 document.

This is deliberately an L4-only aggregator.  It never upgrades a `/1`, `/2`,
or `/3` document and it never derives, edits, or removes window data.  Parent
validation is reported as either ``full`` (the L3 aggregate contained enough
data to recompute the shared parent fingerprint), ``structural_legacy`` (an
older `/4` supplied only the saved fingerprint), or ``stale`` (the saved
parent is missing or changed and the annotation explicitly says so).

All Label Studio source results are retained byte-for-byte at the JSON value
level. Shapely unions the geometry; no bounding box, convex hull, simplify,
repair, or buffer operation is used to create or alter exported geometry.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
LABEL_STUDIO_ROOT = REPOSITORY_ROOT / "label_studio"
if str(LABEL_STUDIO_ROOT) not in sys.path:
    sys.path.insert(0, str(LABEL_STUDIO_ROOT))

try:
    from shapely.geometry import MultiPolygon, Polygon
    from tasks.furniture_instances import FURNITURE_TYPES
    from tasks.furniture_instances.geometry import (
        canonicalize_parent_geometry,
        orientation_from_results,
        parent_fingerprint,
        review_fingerprint,
        union_result_geometry,
    )
    from tasks.occupancy.geometry import EPS_AREA
except ImportError as exc:  # pragma: no cover - exercised by the CLI environment check
    raise RuntimeError(
        "furniture_instances_to_unified.py requires the repository-declared dependency "
        "Shapely; run it in the Label Studio development environment"
    ) from exc


GEOMETRY_CONTROLS = {"furniture_instance_rectangle", "furniture_instance_polygon"}
CATEGORY_CONTROL = "furniture_instance_type"
FRONT_DIRECTION_CONTROL = "furniture_front_direction"
FRONT_EDGE_CONTROL = "furniture_front_edge"
CONTROL_ROLES = {
    **{control: "geometry" for control in GEOMETRY_CONTROLS},
    CATEGORY_CONTROL: "category",
    FRONT_DIRECTION_CONTROL: "front_direction",
    FRONT_EDGE_CONTROL: "front_edge",
}
ROLE_ORDER = {"geometry": 0, "category": 1, "front_direction": 2, "front_edge": 3}
WINDOW_FIELDS = (
    "window_matching_policy",
    "window_traces",
    "window_connections",
    "window_projections",
)
INSTANCE_TYPE_RE = re.compile(r"^[a-z][a-z0-9_]*$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
CONTEXT_FIELDS = (
    "schema_version",
    "instance_id",
    "instance_type",
    "note",
    "room_id",
    "zone_id",
    "group_id",
    "source_version",
    "parent_fingerprint",
    "review_status",
    "review_fingerprint",
)


class FurnitureAggregationError(ValueError):
    """Raised when L4 input cannot be aggregated without changing its meaning."""


def _canonical_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise FurnitureAggregationError(f"input is not finite canonical JSON: {exc}") from exc


def _sha256(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def document_fingerprint(document: dict[str, Any]) -> str:
    """Fingerprint the complete aggregate except for its fingerprint field."""
    payload = copy.deepcopy(document)
    payload.pop("fingerprint", None)
    return _sha256(payload)


def _require_positive_id(value: Any, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise FurnitureAggregationError(f"{name} must be a positive integer")
    return value


def _annotation_from_envelope(envelope: Any, annotation_id: int) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return the selected annotation and outer envelope without guessing an ID."""
    if not isinstance(envelope, dict):
        raise FurnitureAggregationError("L4 annotation envelope must be a JSON object")

    if isinstance(envelope.get("result"), list):
        annotation = envelope
    elif isinstance(envelope.get("annotation"), dict):
        annotation = envelope["annotation"]
    elif isinstance(envelope.get("annotations"), list):
        matches = [item for item in envelope["annotations"] if isinstance(item, dict) and item.get("id") == annotation_id]
        if len(matches) != 1:
            raise FurnitureAggregationError(
                f"L4 task envelope must contain exactly one annotation with id {annotation_id}; found {len(matches)}"
            )
        annotation = matches[0]
    else:
        raise FurnitureAggregationError(
            "L4 annotation envelope must be an annotation with result[], an annotation wrapper, or a task with annotations[]"
        )

    if annotation.get("id") is not None and annotation.get("id") != annotation_id:
        raise FurnitureAggregationError(
            f"annotation envelope id {annotation.get('id')!r} does not match --annotation-id {annotation_id}"
        )
    if not isinstance(annotation.get("result"), list):
        raise FurnitureAggregationError("selected L4 annotation result must be a list")
    return annotation, envelope


def _validate_envelope_identity(
    outer: dict[str, Any], annotation: dict[str, Any], project_id: int, task_id: int, annotation_id: int
) -> None:
    if isinstance(outer.get("annotations"), list) and outer.get("id") is not None and outer.get("id") != task_id:
        raise FurnitureAggregationError(f"task envelope id {outer.get('id')!r} does not match --task-id {task_id}")

    candidate_task_ids = [annotation.get("task")]
    if not isinstance(outer.get("annotations"), list):
        candidate_task_ids.append(outer.get("task"))
    for value in candidate_task_ids:
        if isinstance(value, dict):
            value = value.get("id")
        if value is not None and value != task_id:
            raise FurnitureAggregationError(f"annotation task id {value!r} does not match --task-id {task_id}")

    candidate_project_ids = [annotation.get("project"), outer.get("project")]
    for value in candidate_project_ids:
        if isinstance(value, dict):
            value = value.get("id")
        if value is not None and value != project_id:
            raise FurnitureAggregationError(f"annotation project id {value!r} does not match --project-id {project_id}")

    if annotation.get("id") not in (None, annotation_id):
        raise FurnitureAggregationError("annotation identity changed while selecting the envelope")


def _result_context(result: dict[str, Any], role: str) -> dict[str, Any]:
    metadata = result.get("meta")
    context = metadata.get("furniture_instance_context") if isinstance(metadata, dict) else None
    result_id = result.get("id")
    if not isinstance(context, dict):
        raise FurnitureAggregationError(f"L4 result {result_id!r} lacks meta.furniture_instance_context")
    missing = [field for field in CONTEXT_FIELDS if field not in context]
    if missing:
        raise FurnitureAggregationError(f"L4 result {result_id!r} context lacks {', '.join(missing)}")
    if context.get("schema_version") != 1:
        raise FurnitureAggregationError(f"L4 result {result_id!r} context schema_version must be 1")
    if context.get("role") != role:
        raise FurnitureAggregationError(
            f"L4 result {result_id!r} context role {context.get('role')!r} disagrees with control role {role!r}"
        )
    for name in ("instance_id", "instance_type", "room_id", "zone_id", "group_id", "source_version"):
        if not isinstance(context.get(name), str) or not context[name]:
            raise FurnitureAggregationError(f"L4 result {result_id!r} context {name} must be a non-empty string")
    if not INSTANCE_TYPE_RE.fullmatch(context["instance_type"]):
        raise FurnitureAggregationError(
            f"L4 result {result_id!r} instance_type must be a stable lower-case English value"
        )
    if context["instance_type"] not in FURNITURE_TYPES:
        raise FurnitureAggregationError(f"L4 result {result_id!r} uses unsupported furniture type")
    if not isinstance(context.get("note"), str):
        raise FurnitureAggregationError(f"L4 result {result_id!r} context note must be a string")
    if not isinstance(context.get("parent_fingerprint"), str) or not SHA256_RE.fullmatch(
        context["parent_fingerprint"]
    ):
        raise FurnitureAggregationError(f"L4 result {result_id!r} context parent_fingerprint must be canonical SHA-256")
    if context.get("review_status") not in {"pending", "reviewed", "stale"}:
        raise FurnitureAggregationError(f"L4 result {result_id!r} has invalid review_status")
    review = context.get("review_fingerprint")
    if review is not None and (not isinstance(review, str) or not SHA256_RE.fullmatch(review)):
        raise FurnitureAggregationError(f"L4 result {result_id!r} has invalid review_fingerprint")
    if context["review_status"] == "reviewed" and review is None:
        raise FurnitureAggregationError(f"reviewed L4 result {result_id!r} requires review_fingerprint")
    return context


def _role_and_context(result: Any) -> tuple[str, dict[str, Any]] | None:
    if not isinstance(result, dict):
        return None
    control = result.get("from_name")
    role = CONTROL_ROLES.get(control)
    metadata = result.get("meta")
    has_context = isinstance(metadata, dict) and "furniture_instance_context" in metadata
    if role is None:
        if has_context:
            raise FurnitureAggregationError(
                f"result {result.get('id')!r} has furniture_instance_context on unsupported control {control!r}"
            )
        return None
    if not isinstance(result.get("id"), str) or not result["id"]:
        raise FurnitureAggregationError(f"L4 {role} result must have a stable non-empty id")
    if not isinstance(result.get("value"), dict):
        raise FurnitureAggregationError(f"L4 result {result['id']!r} value must be an object")
    expected_type = {
        "furniture_instance_rectangle": "rectangle",
        "furniture_instance_polygon": "polygon",
        CATEGORY_CONTROL: "choices",
        FRONT_DIRECTION_CONTROL: "vectorlabels",
        FRONT_EDGE_CONTROL: "vectorlabels",
    }[control]
    if result.get("type") != expected_type:
        raise FurnitureAggregationError(
            f"L4 result {result['id']!r} control {control!r} requires result type {expected_type!r}"
        )
    return role, _result_context(result, role)


def _same_instance_context(instance_id: str, rows: list[tuple[str, dict[str, Any], dict[str, Any]]]) -> dict[str, Any]:
    reference = rows[0][2]
    for _, result, context in rows[1:]:
        differences = [field for field in CONTEXT_FIELDS if context.get(field) != reference.get(field)]
        if differences:
            raise FurnitureAggregationError(
                f"instance {instance_id!r} has inconsistent context on result {result.get('id')!r}: "
                f"{', '.join(differences)}"
            )
    return reference


def _category_value(result: dict[str, Any], context: dict[str, Any]) -> str:
    if result.get("from_name") != CATEGORY_CONTROL or result.get("type") != "choices":
        raise FurnitureAggregationError(f"category result {result.get('id')!r} must be a choices result")
    choices = result.get("value", {}).get("choices")
    if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], str):
        raise FurnitureAggregationError(f"category result {result.get('id')!r} must contain exactly one choice")
    category = choices[0]
    if not INSTANCE_TYPE_RE.fullmatch(category):
        raise FurnitureAggregationError(f"category {category!r} is not a stable lower-case English value")
    if category not in FURNITURE_TYPES:
        raise FurnitureAggregationError(f"category {category!r} is not in the stable furniture vocabulary")
    if category != context["instance_type"]:
        raise FurnitureAggregationError(
            f"category {category!r} disagrees with context instance_type {context['instance_type']!r}"
        )
    return category


def _point(value: tuple[float, float]) -> dict[str, float]:
    x, y = value
    if not all(isinstance(number, (int, float)) and not isinstance(number, bool) and math.isfinite(number) for number in (x, y)):
        raise FurnitureAggregationError("unified furniture geometry contains a non-finite coordinate")
    if not (0 <= x <= 100 and 0 <= y <= 100):
        raise FurnitureAggregationError("unified furniture geometry must remain in image-percent coordinates")
    return {"x": 0.0 if x == 0 else float(x), "y": 0.0 if y == 0 else float(y)}


def _ring(ring: Any) -> list[dict[str, float]]:
    coordinates = list(ring.coords)
    if len(coordinates) < 4 or coordinates[0] != coordinates[-1]:
        raise FurnitureAggregationError("Shapely produced an open or incomplete furniture ring")
    return [_point((x, y)) for x, y in coordinates]


def _polygon_coordinates(polygon: Polygon) -> list[list[dict[str, float]]]:
    return [_ring(polygon.exterior), *[_ring(interior) for interior in polygon.interiors]]


def _unified_geometry(geometry: Any) -> dict[str, Any]:
    """Serialize the exact Shapely union without applying hash-only canonicalization."""
    if isinstance(geometry, Polygon):
        return {"type": "Polygon", "coordinates": _polygon_coordinates(geometry)}
    if isinstance(geometry, MultiPolygon):
        return {"type": "MultiPolygon", "coordinates": [_polygon_coordinates(part) for part in geometry.geoms]}
    raise FurnitureAggregationError("furniture union must be a Polygon or MultiPolygon")


def _shape_from_unified_geometry(value: Any) -> Any:
    if not isinstance(value, dict) or value.get("type") not in {"Polygon", "MultiPolygon"}:
        raise FurnitureAggregationError("projected L4 target has invalid prior Polygon/MultiPolygon geometry")

    def coordinates(item: Any) -> Any:
        if isinstance(item, dict) and set(item) == {"x", "y"}:
            return (item["x"], item["y"])
        if isinstance(item, list):
            return [coordinates(child) for child in item]
        raise FurnitureAggregationError("projected L4 target has invalid prior geometry coordinates")

    converted = coordinates(value.get("coordinates"))
    try:
        geometry = Polygon(converted[0], converted[1:]) if value["type"] == "Polygon" else MultiPolygon(
            [Polygon(polygon[0], polygon[1:]) for polygon in converted]
        )
    except (IndexError, TypeError, ValueError) as exc:
        raise FurnitureAggregationError(f"projected L4 target prior geometry is invalid: {exc}") from exc
    if geometry.is_empty or not geometry.is_valid:
        raise FurnitureAggregationError("projected L4 target prior geometry is empty or invalid")
    return geometry


def _server_provenance(
    result: dict[str, Any], project_id: int, task_id: int, annotation_id: int
) -> dict[str, Any]:
    metadata = result.get("meta")
    stamp = metadata.get("furniture_instance_provenance") if isinstance(metadata, dict) else None
    if not isinstance(stamp, dict):
        raise FurnitureAggregationError(
            f"formal L4 result {result.get('id')!r} lacks server-owned meta.furniture_instance_provenance"
        )
    expected = {
        "schema_version": 1,
        "project_id": project_id,
        "task_id": task_id,
        "annotation_id": annotation_id,
        "result_id": result["id"],
    }
    if stamp != expected:
        raise FurnitureAggregationError(
            f"formal L4 result {result.get('id')!r} server provenance {stamp!r} does not match envelope {expected!r}"
        )
    return {key: stamp[key] for key in ("project_id", "task_id", "annotation_id", "result_id")}


def _source_result(
    role: str, result: dict[str, Any], project_id: int, task_id: int, annotation_id: int
) -> dict[str, Any]:
    return {
        "role": role,
        "provenance": _server_provenance(result, project_id, task_id, annotation_id),
        "raw": copy.deepcopy(result),
    }


def _source_sort_key(row: tuple[str, dict[str, Any], dict[str, Any]]) -> tuple[Any, ...]:
    role, result, _ = row
    return ROLE_ORDER[role], result["id"], _canonical_json(result)


def _find_node(base: dict[str, Any], node_id: str, kind: str) -> dict[str, Any] | None:
    matches = [
        node
        for node in base.get("nodes", [])
        if isinstance(node, dict) and node.get("id") == node_id and node.get("kind") == kind
    ]
    if len(matches) > 1:
        raise FurnitureAggregationError(f"base defines duplicate {kind} node {node_id!r}")
    return matches[0] if matches else None


def _matching_group(base: dict[str, Any], context: dict[str, Any]) -> dict[str, Any] | None:
    regions = base.get("occupancy_regions")
    if not isinstance(regions, list):
        raise FurnitureAggregationError("floorplan-unified/4 base must contain occupancy_regions[]")
    matches = [
        region
        for region in regions
        if isinstance(region, dict)
        and region.get("category") == "furniture_group"
        and context["group_id"] in {region.get("group_id"), region.get("logical_id")}
    ]
    if len(matches) > 1:
        raise FurnitureAggregationError(f"base defines duplicate furniture group {context['group_id']!r}")
    return matches[0] if matches else None


def _parent_part_results(base: dict[str, Any], group: dict[str, Any]) -> list[dict[str, Any]]:
    parts = group.get("parts")
    if not isinstance(parts, list) or not parts:
        raise FurnitureAggregationError(f"L3 group {group.get('group_id')!r} has no complete geometry parts")
    floorplan = base.get("floorplan") if isinstance(base.get("floorplan"), dict) else {}
    width, height = floorplan.get("width"), floorplan.get("height")
    results: list[dict[str, Any]] = []
    for part in parts:
        raw = part.get("raw") if isinstance(part, dict) else None
        if not isinstance(raw, dict):
            raise FurnitureAggregationError(f"L3 group {group.get('group_id')!r} has a part without raw geometry")
        copied = copy.deepcopy(raw)
        if copied.get("original_width") is None and isinstance(width, (int, float)):
            copied["original_width"] = width
        if copied.get("original_height") is None and isinstance(height, (int, float)):
            copied["original_height"] = height
        results.append(copied)
    return results


def _validate_parent(base: dict[str, Any], context: dict[str, Any], instance_geometry: Any) -> tuple[str, str]:
    """Validate a saved parent without silently changing it.

    The second tuple member is a human-readable detail included in source
    metadata.  A stale record is retained only when it was already explicitly
    marked stale by the annotation workflow.
    """
    room = _find_node(base, context["room_id"], "room")
    zone = _find_node(base, context["zone_id"], "zone")
    group_node = _find_node(base, context["group_id"], "furniture_group")
    group = _matching_group(base, context)

    structural_errors: list[str] = []
    if room is None:
        structural_errors.append("room node is missing")
    if zone is None:
        structural_errors.append("zone node is missing")
    elif zone.get("parent_room_id") != context["room_id"]:
        structural_errors.append("zone now belongs to another room")
    if group_node is None:
        structural_errors.append("furniture-group node is missing")
    else:
        if group_node.get("parent_room_id") != context["room_id"]:
            structural_errors.append("furniture-group node now belongs to another room")
        if group_node.get("parent_zone_id") != context["zone_id"]:
            structural_errors.append("furniture-group node now belongs to another zone")
    if group is None:
        structural_errors.append("furniture-group occupancy region is missing")
    else:
        if group.get("parent_room_id") != context["room_id"]:
            structural_errors.append("furniture-group region now belongs to another room")
        if group.get("parent_zone_id") != context["zone_id"]:
            structural_errors.append("furniture-group region now belongs to another zone")
    if structural_errors:
        if context["review_status"] != "stale":
            raise FurnitureAggregationError(
                f"instance {context['instance_id']!r} parent is outdated but review_status is not stale: "
                + "; ".join(structural_errors)
            )
        return "stale", "; ".join(structural_errors)

    try:
        group_geometry = union_result_geometry(_parent_part_results(base, group))
    except (KeyError, TypeError, ValueError) as exc:
        raise FurnitureAggregationError(
            f"L3 group {context['group_id']!r} geometry cannot be reconstructed for boundary validation: {exc}"
        ) from exc
    if not group_geometry.covers(instance_geometry):
        if context["review_status"] != "stale":
            raise FurnitureAggregationError(
                f"instance {context['instance_id']!r} crosses its saved furniture-group boundary"
            )
        return "stale", "instance geometry is outside the current saved furniture-group boundary"

    # The owning group may itself overlap another L3 group.  Being covered by
    # the owner is therefore not sufficient to prove that the instance stays
    # in one group.  Keep an already-stale record for review, but never accept
    # the overlap as a current/full parent validation.
    for other in base["occupancy_regions"]:
        if other is group or not isinstance(other, dict) or other.get("category") != "furniture_group":
            continue
        other_id = other.get("group_id") or other.get("logical_id")
        if not isinstance(other_id, str) or not other_id or other_id == context["group_id"]:
            continue
        try:
            other_geometry = union_result_geometry(_parent_part_results(base, other))
        except (KeyError, TypeError, ValueError) as exc:
            raise FurnitureAggregationError(
                f"other L3 group {other_id!r} geometry cannot be reconstructed for cross-group validation: {exc}"
            ) from exc
        if instance_geometry.intersection(other_geometry).area <= EPS_AREA:
            continue
        detail = f"instance geometry overlaps another furniture group {other_id!r}"
        if context["review_status"] != "stale":
            raise FurnitureAggregationError(f"instance {context['instance_id']!r} {detail}")
        return "stale", detail

    zone_parent_fingerprint = group.get("parent_fingerprint")
    if not isinstance(zone_parent_fingerprint, str) or not SHA256_RE.fullmatch(zone_parent_fingerprint):
        return "structural_legacy", "legacy /4 L3 group lacks its zone parent fingerprint"
    if group.get("group_type") is None:
        return "structural_legacy", "legacy /4 L3 group lacks group_type"

    parent_group = {
        "room_id": context["room_id"],
        "zone_id": context["zone_id"],
        "group_id": context["group_id"],
        "group_type": group["group_type"],
        "group_note": group.get("group_note") or "",
        "zone_parent_fingerprint": zone_parent_fingerprint,
    }
    current_fingerprint = parent_fingerprint(parent_group, group_geometry)

    if current_fingerprint != context["parent_fingerprint"]:
        if context["review_status"] != "stale":
            raise FurnitureAggregationError(
                f"instance {context['instance_id']!r} parent fingerprint is stale; explicit stale review state is required"
            )
        return "stale", "current L3 parent fingerprint differs from the retained accepted fingerprint"
    return "full", "parent chain and shared canonical parent fingerprint verified"


def _aggregate_instance(
    instance_id: str,
    rows: list[tuple[str, dict[str, Any], dict[str, Any]]],
    base: dict[str, Any],
    project_id: int,
    task_id: int,
    annotation_id: int,
) -> tuple[dict[str, Any], dict[str, str]]:
    rows = sorted(rows, key=_source_sort_key)
    context = _same_instance_context(instance_id, rows)
    by_role = {
        role: [result for current_role, result, _ in rows if current_role == role]
        for role in ROLE_ORDER
    }
    geometry_results = by_role["geometry"]
    category_results = by_role["category"]
    if not geometry_results:
        raise FurnitureAggregationError(f"instance {instance_id!r} has no geometry result")
    geometry_ids = [result["id"] for result in geometry_results]
    category_ids = [result["id"] for result in category_results]
    if len(set(geometry_ids)) != len(geometry_ids):
        raise FurnitureAggregationError(f"instance {instance_id!r} has duplicate geometry result IDs")
    if len(set(category_ids)) != len(category_ids) or sorted(category_ids) != sorted(geometry_ids):
        raise FurnitureAggregationError(
            f"instance {instance_id!r} requires exactly one same-ID category result for every geometry part"
        )
    categories = {_category_value(result, context) for result in category_results}
    if len(categories) != 1:
        raise FurnitureAggregationError(f"instance {instance_id!r} geometry parts disagree on category")
    category = next(iter(categories))

    try:
        geometry = union_result_geometry(geometry_results)
        orientation = orientation_from_results(
            by_role["front_direction"],
            by_role["front_edge"],
            geometry,
        )
    except (TypeError, ValueError) as exc:
        raise FurnitureAggregationError(f"instance {instance_id!r} geometry/orientation is invalid: {exc}") from exc

    expected_review = review_fingerprint(context, geometry, orientation)
    if context["review_status"] == "reviewed" and context["review_fingerprint"] != expected_review:
        raise FurnitureAggregationError(
            f"instance {instance_id!r} reviewed fingerprint does not match its geometry, category, parent and orientation"
        )

    validation_level, validation_detail = _validate_parent(base, context, geometry)
    source_results = [
        _source_result(role, result, project_id, task_id, annotation_id)
        for role, result, _ in rows
    ]
    primary_geometry = next(item for item in source_results if item["role"] == "geometry")
    instance = {
        "kind": "furniture_instance",
        "id": instance_id,
        "instance_type": category,
        "parent": {
            "room_id": context["room_id"],
            "zone_id": context["zone_id"],
            "group_id": context["group_id"],
        },
        "source_version": context["source_version"],
        "parent_fingerprint": context["parent_fingerprint"],
        "geometry": _unified_geometry(geometry),
        "orientation": orientation,
        "review_status": context["review_status"],
        "review_fingerprint": context["review_fingerprint"],
        "provenance": copy.deepcopy(primary_geometry["provenance"]),
        "source_results": source_results,
    }
    if context["note"]:
        instance["note"] = context["note"]
    return instance, {
        "instance_id": instance_id,
        "level": validation_level,
        "detail": validation_detail,
    }


def _validate_projection_targets(base: dict[str, Any], instances: list[dict[str, Any]]) -> None:
    """Guard existing L4 projection identity without recalculating any window relation."""
    instance_by_id = {instance["id"]: instance for instance in instances}
    existing_by_id = {
        instance.get("id"): instance
        for instance in base.get("furniture_instances", [])
        if isinstance(instance, dict) and isinstance(instance.get("id"), str)
    }
    for projection in base.get("window_projections", []):
        target = projection.get("target") if isinstance(projection, dict) else None
        if not isinstance(target, dict) or target.get("level") != "L4":
            continue
        entity_id = target.get("entity_id")
        current = instance_by_id.get(entity_id)
        if current is None:
            raise FurnitureAggregationError(
                f"existing L4 window projection {projection.get('id')!r} targets missing instance {entity_id!r}; "
                "this L4-only aggregator will not redefine the window target"
            )
        if target.get("room_id") != current["parent"]["room_id"]:
            raise FurnitureAggregationError(
                f"existing L4 window projection {projection.get('id')!r} room disagrees with instance {entity_id!r}"
            )
        previous = existing_by_id.get(entity_id)
        if previous is not None and (
            previous.get("instance_type") != current.get("instance_type")
            or previous.get("parent") != current.get("parent")
        ):
            raise FurnitureAggregationError(
                f"existing L4 window projection {projection.get('id')!r} target {entity_id!r} was redefined"
            )
        if previous is not None and previous.get("geometry") is not None:
            previous_geometry = canonicalize_parent_geometry(_shape_from_unified_geometry(previous["geometry"]))
            current_geometry = canonicalize_parent_geometry(_shape_from_unified_geometry(current["geometry"]))
            if previous_geometry != current_geometry:
                raise FurnitureAggregationError(
                    f"existing L4 window projection {projection.get('id')!r} target {entity_id!r} geometry was redefined"
                )


def _overall_validation_level(rows: list[dict[str, str]]) -> str:
    levels = {row["level"] for row in rows}
    if "stale" in levels:
        return "stale"
    if "structural_legacy" in levels:
        return "structural_legacy"
    return "full"


def aggregate_furniture_instances(
    base: dict[str, Any],
    annotation_envelope: dict[str, Any],
    *,
    project_id: int,
    task_id: int,
    annotation_id: int,
) -> dict[str, Any]:
    """Return a new unified document; neither input object is mutated."""
    _require_positive_id(project_id, "project_id")
    _require_positive_id(task_id, "task_id")
    _require_positive_id(annotation_id, "annotation_id")
    if not isinstance(base, dict):
        raise FurnitureAggregationError("base must be a floorplan-unified JSON object")
    schema = base.get("schema")
    if schema in {"floorplan-unified/1", "floorplan-unified/2", "floorplan-unified/3"}:
        raise FurnitureAggregationError(
            f"base schema {schema} is not accepted by this L4-only aggregator; "
            "first use the existing window pipeline to upgrade it to floorplan-unified/4"
        )
    if schema != "floorplan-unified/4":
        raise FurnitureAggregationError("base schema must be exactly floorplan-unified/4")
    for field in WINDOW_FIELDS:
        if field not in base:
            raise FurnitureAggregationError(f"floorplan-unified/4 base is missing required window field {field!r}")

    annotation, outer = _annotation_from_envelope(annotation_envelope, annotation_id)
    _validate_envelope_identity(outer, annotation, project_id, task_id, annotation_id)

    grouped: dict[str, list[tuple[str, dict[str, Any], dict[str, Any]]]] = {}
    for raw_result in annotation["result"]:
        parsed = _role_and_context(raw_result)
        if parsed is None:
            continue
        role, context = parsed
        grouped.setdefault(context["instance_id"], []).append((role, raw_result, context))

    instances: list[dict[str, Any]] = []
    parent_validation: list[dict[str, str]] = []
    for instance_id in sorted(grouped):
        instance, validation = _aggregate_instance(
            instance_id,
            grouped[instance_id],
            base,
            project_id,
            task_id,
            annotation_id,
        )
        instances.append(instance)
        parent_validation.append(validation)

    _validate_projection_targets(base, instances)

    output = copy.deepcopy(base)
    window_snapshot = {field: copy.deepcopy(base[field]) for field in WINDOW_FIELDS}
    output["furniture_instances"] = instances
    sources = output.get("sources")
    if not isinstance(sources, dict):
        raise FurnitureAggregationError("floorplan-unified/4 base sources must be an object")
    canonical_source_results = [
        source["raw"]
        for instance in instances
        for source in instance["source_results"]
    ]
    source_payload = {
        "project_id": project_id,
        "task_id": task_id,
        "annotation_id": annotation_id,
        "result": canonical_source_results,
    }
    descriptor: dict[str, Any] = {
        "project_id": project_id,
        "task_id": task_id,
        "annotation_id": annotation_id,
        "input_sha256": _sha256(source_payload),
        "parent_validation": {
            "level": _overall_validation_level(parent_validation),
            "instances": parent_validation,
        },
    }
    if isinstance(annotation.get("updated_at"), str) and annotation["updated_at"]:
        descriptor["updated_at"] = annotation["updated_at"]
    sources["furniture_instance"] = descriptor
    output["fingerprint"] = document_fingerprint(output)

    for field, original in window_snapshot.items():
        if output.get(field) != original:
            raise AssertionError(f"internal error: L4 aggregation changed protected window field {field}")
    return output


def _provenance_ids(document: dict[str, Any]) -> tuple[int, int, int]:
    provenance = [
        source.get("provenance")
        for instance in document.get("furniture_instances", [])
        if isinstance(instance, dict)
        for source in instance.get("source_results", [])
        if isinstance(source, dict)
    ]
    triples = {
        (item.get("project_id"), item.get("task_id"), item.get("annotation_id"))
        for item in provenance
        if isinstance(item, dict)
    }
    if not triples:
        sources = document.get("sources")
        descriptor = sources.get("furniture_instance") if isinstance(sources, dict) else None
        if isinstance(descriptor, dict):
            triples.add((descriptor.get("project_id"), descriptor.get("task_id"), descriptor.get("annotation_id")))
    if len(triples) != 1:
        raise FurnitureAggregationError("unified furniture source provenance does not identify one annotation envelope")
    project_id, task_id, annotation_id = next(iter(triples))
    return (
        _require_positive_id(project_id, "project_id"),
        _require_positive_id(task_id, "task_id"),
        _require_positive_id(annotation_id, "annotation_id"),
    )


def reimport_annotation_results(
    document: dict[str, Any],
    *,
    project_id: int | None = None,
    task_id: int | None = None,
    annotation_id: int | None = None,
) -> list[dict[str, Any]]:
    """Restore canonical Label Studio results from lossless source records."""
    if not isinstance(document, dict) or document.get("schema") != "floorplan-unified/4":
        raise FurnitureAggregationError("re-import requires a floorplan-unified/4 document")
    inferred = _provenance_ids(document)
    expected = (
        inferred[0] if project_id is None else _require_positive_id(project_id, "project_id"),
        inferred[1] if task_id is None else _require_positive_id(task_id, "task_id"),
        inferred[2] if annotation_id is None else _require_positive_id(annotation_id, "annotation_id"),
    )
    if expected != inferred:
        raise FurnitureAggregationError(f"requested re-import provenance {expected!r} differs from saved {inferred!r}")

    restored: list[tuple[str, int, str, dict[str, Any]]] = []
    for instance in sorted(document.get("furniture_instances", []), key=lambda item: item.get("id", "")):
        if not isinstance(instance, dict) or not isinstance(instance.get("source_results"), list):
            raise FurnitureAggregationError("furniture instance lacks lossless source_results")
        instance_id = instance.get("id")
        public_provenance_fields = {"project_id", "task_id", "annotation_id", "result_id"}
        instance_provenance = instance.get("provenance")
        geometry_sources = [
            source
            for source in instance["source_results"]
            if isinstance(source, dict) and source.get("role") == "geometry" and isinstance(source.get("raw"), dict)
        ]
        if not geometry_sources:
            raise FurnitureAggregationError(f"instance {instance_id!r} has no primary geometry source provenance")
        primary_geometry = min(
            geometry_sources,
            key=lambda source: (source["raw"].get("id", ""), _canonical_json(source["raw"])),
        )
        if not isinstance(instance_provenance, dict) or set(instance_provenance) != public_provenance_fields:
            raise FurnitureAggregationError(
                f"instance {instance_id!r} provenance does not match its primary geometry source"
            )
        for source in instance["source_results"]:
            if not isinstance(source, dict) or source.get("role") not in ROLE_ORDER:
                raise FurnitureAggregationError(f"instance {instance_id!r} has an invalid source result role")
            provenance = source.get("provenance")
            raw = source.get("raw")
            if not isinstance(provenance, dict) or not isinstance(raw, dict):
                raise FurnitureAggregationError(f"instance {instance_id!r} has incomplete source provenance")
            if set(provenance) != public_provenance_fields:
                raise FurnitureAggregationError(f"instance {instance_id!r} has non-schema source provenance fields")
            triple = (provenance.get("project_id"), provenance.get("task_id"), provenance.get("annotation_id"))
            if triple != inferred:
                raise FurnitureAggregationError(f"instance {instance_id!r} mixes source annotations")
            if provenance.get("result_id") != raw.get("id"):
                raise FurnitureAggregationError(f"instance {instance_id!r} raw result id disagrees with provenance")
            metadata = raw.get("meta")
            context = metadata.get("furniture_instance_context") if isinstance(metadata, dict) else None
            if not isinstance(context, dict) or context.get("instance_id") != instance_id:
                raise FurnitureAggregationError(f"instance {instance_id!r} source result has mismatched context")
            restored.append((instance_id, ROLE_ORDER[source["role"]], _canonical_json(raw), copy.deepcopy(raw)))
        if instance_provenance != primary_geometry.get("provenance"):
            raise FurnitureAggregationError(
                f"instance {instance_id!r} provenance does not match its primary geometry source"
            )
    restored.sort(key=lambda item: (item[0], item[1], item[2]))
    return [item[3] for item in restored]


def reimport_annotation_envelope(document: dict[str, Any]) -> dict[str, Any]:
    """Restore the annotation envelope accepted by :func:`aggregate_furniture_instances`."""
    project_id, task_id, annotation_id = _provenance_ids(document)
    envelope = {
        "id": annotation_id,
        "project": project_id,
        "task": task_id,
        "result": reimport_annotation_results(
            document,
            project_id=project_id,
            task_id=task_id,
            annotation_id=annotation_id,
        ),
    }
    sources = document.get("sources")
    descriptor = sources.get("furniture_instance") if isinstance(sources, dict) else None
    if isinstance(descriptor, dict) and isinstance(descriptor.get("updated_at"), str):
        envelope["updated_at"] = descriptor["updated_at"]
    return envelope


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FurnitureAggregationError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise FurnitureAggregationError(f"JSON root in {path} must be an object")
    return value


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as stream:
            temporary_name = stream.name
            stream.write(rendered)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, path)
    except OSError as exc:
        if temporary_name:
            try:
                os.unlink(temporary_name)
            except OSError:
                pass
        raise FurnitureAggregationError(f"cannot write JSON {path}: {exc}") from exc


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Add Label Studio L4 furniture instances to an existing floorplan-unified/4 document. "
            "This command never upgrades /1-/3 and never changes window matching or projections."
        )
    )
    parser.add_argument(
        "--base", "--base-json", dest="base", required=True, type=Path, help="existing floorplan-unified/4 JSON"
    )
    parser.add_argument(
        "--annotation",
        "--annotation-json",
        dest="annotation",
        required=True,
        type=Path,
        help="L4 Label Studio annotation envelope JSON",
    )
    parser.add_argument("--project-id", required=True, type=int)
    parser.add_argument("--task-id", required=True, type=int)
    parser.add_argument("--annotation-id", required=True, type=int)
    parser.add_argument("--output", "--output-json", dest="output", required=True, type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        output = aggregate_furniture_instances(
            _read_json(args.base),
            _read_json(args.annotation),
            project_id=args.project_id,
            task_id=args.task_id,
            annotation_id=args.annotation_id,
        )
        _write_json(args.output, output)
    except FurnitureAggregationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(f"wrote {len(output['furniture_instances'])} furniture instance(s): {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
