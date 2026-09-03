from __future__ import annotations

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator

SCRIPTS = Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from furniture_instances_to_unified import (  # noqa: E402
    FurnitureAggregationError,
    aggregate_furniture_instances,
    document_fingerprint,
    main,
    orientation_from_results,
    parent_fingerprint,
    reimport_annotation_envelope,
    review_fingerprint,
    union_result_geometry,
)
from shapely.geometry import MultiPolygon, Polygon  # noqa: E402

PROJECT_ID = 14
TASK_ID = 24
ANNOTATION_ID = 104
ZONE_PARENT_FINGERPRINT = "a" * 64


def raw_rectangle(result_id, x, y, width, height, rotation=0, *, control="furniture_instance_rectangle"):
    return {
        "id": result_id,
        "from_name": control,
        "to_name": "image",
        "type": "rectangle",
        "value": {
            "x": x,
            "y": y,
            "width": width,
            "height": height,
            "rotation": rotation,
        },
        "original_width": 1000,
        "original_height": 1000,
    }


def base_document(*, full_parent=True):
    parent_raw = raw_rectangle(
        "l3-group-part",
        0,
        0,
        50,
        50,
        control="occupancy_rectangle",
    )
    parent_geometry = union_result_geometry([parent_raw])
    group = {
        "room_id": "room-a",
        "zone_id": "zone-a",
        "group_id": "group-a",
        "group_type": "study_work",
        "group_note": "",
        "zone_parent_fingerprint": ZONE_PARENT_FINGERPRINT,
    }
    accepted_parent_fingerprint = parent_fingerprint(group, parent_geometry)
    region = {
        "id": "occupancy:group-a",
        "logical_id": "group-a",
        "category": "furniture_group",
        "group_id": "group-a",
        "group_type": "study_work",
        "group_note": "",
        "parent_zone_id": "zone-a",
        "parent_room_id": "room-a",
        "generation": "manual",
        "review_status": "confirmed",
        "source_version": "l3-source-v1",
        "parts": [{"result_id": parent_raw["id"], "raw": parent_raw}],
    }
    if full_parent:
        region["parent_fingerprint"] = ZONE_PARENT_FINGERPRINT
    base = {
        "schema": "floorplan-unified/4",
        "created_at": "2026-09-03T12:00:00Z",
        "floorplan": {"id": "floorplan:test", "image_id": "test.png", "width": 1000, "height": 1000},
        "sources": {"format": "label-studio"},
        "raw_inputs": {},
        "nodes": [
            {"id": "room-a", "kind": "room", "label": "Room", "code": "R", "color": "#000000"},
            {
                "id": "zone-a",
                "kind": "zone",
                "label": "Zone",
                "code": "Z",
                "color": "#000000",
                "parent_room_id": "room-a",
            },
            {
                "id": "group-a",
                "kind": "furniture_group",
                "label": "Group",
                "code": "G",
                "color": "#000000",
                "parent_room_id": "room-a",
                "parent_zone_id": "zone-a",
            },
        ],
        "connections": [],
        "analysis_relations": [],
        "occupancy_relations": [],
        "occupancy_regions": [region],
        "occupancy_barriers": [],
        "window_matching_policy": {"sentinel": "matching-policy-must-not-change"},
        "window_traces": [{"sentinel": "traces-must-not-change"}],
        "window_connections": [{"sentinel": "connections-must-not-change"}],
        "furniture_instances": [],
        "window_projections": [],
        "identity_corrections": [],
        "algorithm": {"name": "fixture"},
        "capabilities": {},
        "warnings": [],
        "fingerprint": "0" * 64,
    }
    return base, accepted_parent_fingerprint


def context(instance_id, instance_type, role, parent_value, *, note="", status="pending", review=None):
    return {
        "schema_version": 1,
        "instance_id": instance_id,
        "instance_type": instance_type,
        "note": note,
        "room_id": "room-a",
        "zone_id": "zone-a",
        "group_id": "group-a",
        "source_version": "l3-source-v1",
        "parent_fingerprint": parent_value,
        "review_status": status,
        "review_fingerprint": review,
        "role": role,
    }


def stamp(result_id):
    return {
        "schema_version": 1,
        "project_id": PROJECT_ID,
        "task_id": TASK_ID,
        "annotation_id": ANNOTATION_ID,
        "result_id": result_id,
    }


def add_metadata(result, result_context):
    result["meta"] = {
        "furniture_instance_context": copy.deepcopy(result_context),
        "furniture_instance_provenance": stamp(result["id"]),
    }
    return result


def rectangle_result(instance_id, result_id, instance_type, parent_value, x, y, width, height, rotation=0):
    result = raw_rectangle(result_id, x, y, width, height, rotation)
    return add_metadata(result, context(instance_id, instance_type, "geometry", parent_value))


def polygon_result(instance_id, result_id, instance_type, parent_value, points):
    return add_metadata(
        {
            "id": result_id,
            "from_name": "furniture_instance_polygon",
            "to_name": "image",
            "type": "polygon",
            "value": {"points": points},
            "original_width": 1000,
            "original_height": 1000,
        },
        context(instance_id, instance_type, "geometry", parent_value),
    )


def category_result(instance_id, result_id, instance_type, parent_value):
    return add_metadata(
        {
            "id": result_id,
            "from_name": "furniture_instance_type",
            "to_name": "image",
            "type": "choices",
            "value": {"choices": [instance_type]},
        },
        context(instance_id, instance_type, "category", parent_value),
    )


def vector_result(instance_id, result_id, instance_type, parent_value, role, start, end):
    control = "furniture_front_direction" if role == "front_direction" else "furniture_front_edge"
    return add_metadata(
        {
            "id": result_id,
            "from_name": control,
            "to_name": "image",
            "type": "vectorlabels",
            "value": {
                "vertices": [
                    {"x": start[0], "y": start[1], "isBezier": False},
                    {"x": end[0], "y": end[1], "isBezier": False},
                ],
                "closed": False,
                "vectorlabels": [role],
            },
            "original_width": 1000,
            "original_height": 1000,
        },
        context(instance_id, instance_type, role, parent_value),
    )


def mark_reviewed(results):
    geometry = union_result_geometry(
        [result for result in results if result["from_name"] in {"furniture_instance_rectangle", "furniture_instance_polygon"}]
    )
    directions = [result for result in results if result["from_name"] == "furniture_front_direction"]
    edges = [result for result in results if result["from_name"] == "furniture_front_edge"]
    orientation = orientation_from_results(directions, edges, geometry)
    representative = results[0]["meta"]["furniture_instance_context"]
    review = review_fingerprint(representative, geometry, orientation)
    for result in results:
        saved = result["meta"]["furniture_instance_context"]
        saved["review_status"] = "reviewed"
        saved["review_fingerprint"] = review
    return results


def envelope(results):
    return {
        "id": ANNOTATION_ID,
        "project": PROJECT_ID,
        "task": TASK_ID,
        "updated_at": "2026-09-03T12:30:00Z",
        "result": results,
    }


def aggregate(base, results):
    return aggregate_furniture_instances(
        base,
        envelope(results),
        project_id=PROJECT_ID,
        task_id=TASK_ID,
        annotation_id=ANNOTATION_ID,
    )


class FurnitureInstancesToUnifiedTests(unittest.TestCase):
    def test_real_foundation_example_output_validates_against_v4_schema(self):
        foundation = SCRIPTS.parent / "examples" / "occupancy-schema-foundation"
        base = json.loads((foundation / "example.json").read_text(encoding="utf-8"))
        schema = json.loads((foundation / "multilevel-occupancy.schema.json").read_text(encoding="utf-8"))
        original_windows = {name: copy.deepcopy(base[name]) for name in (
            "window_matching_policy",
            "window_traces",
            "window_connections",
            "window_projections",
        )}
        saved_parent = "ab" * 32
        common = {
            "schema_version": 1,
            "instance_id": "furniture-instance:desk-1",
            "instance_type": "desk",
            "note": "",
            "room_id": "room:study",
            "zone_id": "zone:study-work",
            "group_id": "group:desk",
            "source_version": "33" * 32,
            "parent_fingerprint": saved_parent,
            "review_status": "pending",
            "review_fingerprint": None,
        }

        def example_meta(role, result_id):
            return {
                "furniture_instance_context": {**common, "role": role},
                "furniture_instance_provenance": stamp(result_id),
            }

        geometry = {
            "id": "ls:l4:desk-1:geometry",
            "from_name": "furniture_instance_polygon",
            "to_name": "image",
            "type": "polygon",
            "value": {"points": [[64, 32], [72, 32], [72, 38], [64, 38]]},
            "original_width": 1000,
            "original_height": 800,
        }
        geometry["meta"] = example_meta("geometry", geometry["id"])
        category = {
            "id": "ls:l4:desk-1:category",
            "from_name": "furniture_instance_type",
            "to_name": "image",
            "type": "choices",
            "value": {"choices": ["desk"]},
        }
        category["id"] = geometry["id"]
        category["meta"] = example_meta("category", category["id"])
        output = aggregate(base, [geometry, category])

        Draft202012Validator.check_schema(schema)
        Draft202012Validator(schema).validate(output)
        self.assertEqual(output["sources"]["furniture_instance"]["parent_validation"]["level"], "structural_legacy")
        for name, value in original_windows.items():
            self.assertEqual(output[name], value)

        shown = base["furniture_instances"][0]
        shown_geometry = Polygon(
            [(point["x"], point["y"]) for point in shown["geometry"]["coordinates"][0]]
        )
        self.assertEqual(
            shown["review_fingerprint"],
            review_fingerprint(
                {
                    "instance_id": shown["id"],
                    "instance_type": shown["instance_type"],
                    "note": shown.get("note", ""),
                    **shown["parent"],
                    "source_version": shown["source_version"],
                    "parent_fingerprint": shown["parent_fingerprint"],
                },
                shown_geometry,
                shown["orientation"],
            ),
        )

    def test_shared_parent_fingerprint_fixture_is_fixed(self):
        first = Polygon(
            [(0, 0), (0, 10), (10, 10), (10, 0)],
            [[(2, 2), (8, 2), (8, 8), (2, 8)]],
        )
        second = Polygon([(20, 0), (25, 0), (25, 5), (20, 5)])
        fixture = {
            "room_id": "room-r",
            "zone_id": "zone-z",
            "group_id": "group-g",
            "group_type": "study_work",
            "group_note": "desk alcove",
            "zone_parent_fingerprint": "a" * 64,
        }
        self.assertEqual(
            parent_fingerprint(fixture, MultiPolygon([first, second])),
            "dfffaf6f7467a730f94c7b4499ca7613f292078ceb8c609042839d3b50f61296",
        )
        review_instance = {
            "instance_id": "instance-i",
            "instance_type": "desk",
            "note": "",
            "room_id": "room-r",
            "zone_id": "zone-z",
            "group_id": "group-g",
            "source_version": "b" * 64,
            "parent_fingerprint": "c" * 64,
        }
        review_orientation = {
            "status": "front_direction",
            "origin": {"x": 1, "y": 1.5},
            "direction_vector": {"dx": 1, "dy": 0},
        }
        self.assertEqual(
            review_fingerprint(review_instance, Polygon([(1, 1), (3, 1), (3, 2), (1, 2)]), review_orientation),
            "3d8654893d8bb870d79cbfa9ebe2394ecf3ec1bdde6897c649f35070b6d1daf9",
        )

    def test_rectangle_multipart_hole_provenance_and_window_fields(self):
        base, parent_value = base_document()
        original_base = copy.deepcopy(base)
        protected = {name: copy.deepcopy(base[name]) for name in (
            "window_matching_policy",
            "window_traces",
            "window_connections",
            "window_projections",
        )}

        desk = mark_reviewed(
            [
                rectangle_result("furniture:desk", "desk-geometry", "desk", parent_value, 32, 10, 10, 8, 17),
                category_result("furniture:desk", "desk-geometry", "desk", parent_value),
            ]
        )
        frame_parts = [
            [(5, 5), (25, 5), (25, 8), (5, 8)],
            [(5, 22), (25, 22), (25, 25), (5, 25)],
            [(5, 8), (8, 8), (8, 22), (5, 22)],
            [(22, 8), (25, 8), (25, 22), (22, 22)],
            [(30, 5), (35, 5), (35, 10), (30, 10)],
        ]
        cabinet = [
            polygon_result("furniture:cabinet", f"cabinet-part-{index}", "cabinet", parent_value, points)
            for index, points in enumerate(frame_parts, 1)
        ]
        cabinet.extend(
            [
                *[
                    category_result("furniture:cabinet", f"cabinet-part-{index}", "cabinet", parent_value)
                    for index in range(1, 6)
                ],
                vector_result(
                    "furniture:cabinet",
                    "cabinet-front",
                    "cabinet",
                    parent_value,
                    "front_edge",
                    (5, 5),
                    (25, 5),
                ),
            ]
        )
        mark_reviewed(cabinet)

        output = aggregate(base, [*cabinet, {"id": "readonly-l3", "from_name": "occupancy_polygon"}, *desk])

        self.assertEqual(base, original_base)
        for name, value in protected.items():
            self.assertEqual(output[name], value)
        self.assertEqual([item["id"] for item in output["furniture_instances"]], ["furniture:cabinet", "furniture:desk"])
        cabinet_output, desk_output = output["furniture_instances"]
        self.assertEqual(cabinet_output["geometry"]["type"], "MultiPolygon")
        self.assertEqual(len(cabinet_output["geometry"]["coordinates"]), 2)
        self.assertIn(2, [len(polygon) for polygon in cabinet_output["geometry"]["coordinates"]])
        self.assertEqual(cabinet_output["orientation"]["status"], "front_edge")
        self.assertEqual(cabinet_output["orientation"]["outward_normal"], {"dx": 0.0, "dy": -1.0})
        self.assertEqual(len([row for row in cabinet_output["source_results"] if row["role"] == "geometry"]), 5)
        self.assertEqual(len([row for row in cabinet_output["source_results"] if row["role"] == "category"]), 5)
        self.assertEqual(desk_output["geometry"]["type"], "Polygon")
        self.assertEqual(desk_output["orientation"], {"status": "unknown"})
        self.assertEqual(desk_output["provenance"]["result_id"], "desk-geometry")
        for instance in output["furniture_instances"]:
            for source in instance["source_results"]:
                self.assertEqual(source["provenance"]["result_id"], source["raw"]["id"])
                saved_stamp = source["raw"]["meta"]["furniture_instance_provenance"]
                self.assertEqual(source["provenance"], {key: saved_stamp[key] for key in source["provenance"]})
        descriptor = output["sources"]["furniture_instance"]
        self.assertEqual(descriptor["parent_validation"]["level"], "full")
        self.assertEqual({row["level"] for row in descriptor["parent_validation"]["instances"]}, {"full"})
        self.assertEqual(output["fingerprint"], document_fingerprint(output))
        self.assertNotEqual(output["fingerprint"], original_base["fingerprint"])

    def test_orientation_requires_explicit_evidence_and_never_uses_rectangle_rotation(self):
        base, parent_value = base_document()
        unknown = [
            rectangle_result("furniture:chair", "chair-geometry", "office_chair", parent_value, 5, 30, 6, 6, 45),
            category_result("furniture:chair", "chair-geometry", "office_chair", parent_value),
        ]
        directed = [
            rectangle_result("furniture:sofa", "sofa-geometry", "sofa", parent_value, 15, 30, 12, 6),
            category_result("furniture:sofa", "sofa-geometry", "sofa", parent_value),
            vector_result(
                "furniture:sofa",
                "sofa-front",
                "sofa",
                parent_value,
                "front_direction",
                (20, 33),
                (23, 37),
            ),
        ]
        output = aggregate(base, [*unknown, *directed])
        by_id = {item["id"]: item for item in output["furniture_instances"]}
        self.assertEqual(by_id["furniture:chair"]["orientation"], {"status": "unknown"})
        self.assertEqual(
            by_id["furniture:sofa"]["orientation"],
            {
                "status": "front_direction",
                "origin": {"x": 20.0, "y": 33.0},
                "direction_vector": {"dx": 0.6, "dy": 0.8},
            },
        )

    def test_export_reimport_export_is_lossless(self):
        base, parent_value = base_document()
        results = mark_reviewed(
            [
                polygon_result(
                    "furniture:desk",
                    "desk-geometry",
                    "desk",
                    parent_value,
                    [(10, 10), (20, 10), (20, 20), (10, 20)],
                ),
                category_result("furniture:desk", "desk-geometry", "desk", parent_value),
                vector_result(
                    "furniture:desk",
                    "desk-front",
                    "desk",
                    parent_value,
                    "front_direction",
                    (10, 15),
                    (8, 15),
                ),
            ]
        )
        first = aggregate(base, list(reversed(results)))
        restored = reimport_annotation_envelope(first)
        second = aggregate_furniture_instances(
            base,
            restored,
            project_id=PROJECT_ID,
            task_id=TASK_ID,
            annotation_id=ANNOTATION_ID,
        )
        self.assertEqual(second, first)

    def test_reimport_rejects_a_tampered_primary_provenance_pointer(self):
        base, parent_value = base_document()
        results = mark_reviewed(
            [
                polygon_result(
                    "furniture:desk",
                    "desk-geometry",
                    "desk",
                    parent_value,
                    [(10, 10), (20, 10), (20, 20), (10, 20)],
                ),
                category_result("furniture:desk", "desk-geometry", "desk", parent_value),
            ]
        )
        output = aggregate(base, results)
        output["furniture_instances"][0]["provenance"]["result_id"] = "different-result"
        with self.assertRaisesRegex(FurnitureAggregationError, "primary geometry source"):
            reimport_annotation_envelope(output)

        output = aggregate(base, results)
        output["furniture_instances"][0]["source_results"][0]["provenance"]["schema_version"] = 1
        with self.assertRaisesRegex(FurnitureAggregationError, "non-schema source provenance"):
            reimport_annotation_envelope(output)

    def test_cli_writes_the_same_atomic_unified_output(self):
        base, parent_value = base_document()
        results = [
            rectangle_result("furniture:desk", "desk-geometry", "desk", parent_value, 10, 10, 10, 10),
            category_result("furniture:desk", "desk-geometry", "desk", parent_value),
        ]
        expected = aggregate(base, results)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base_path = root / "base.json"
            annotation_path = root / "annotation.json"
            output_path = root / "nested" / "output.json"
            base_path.write_text(json.dumps(base), encoding="utf-8")
            annotation_path.write_text(json.dumps(envelope(results)), encoding="utf-8")
            exit_code = main(
                [
                    "--base-json",
                    str(base_path),
                    "--annotation-json",
                    str(annotation_path),
                    "--project-id",
                    str(PROJECT_ID),
                    "--task-id",
                    str(TASK_ID),
                    "--annotation-id",
                    str(ANNOTATION_ID),
                    "--output-json",
                    str(output_path),
                ]
            )
            self.assertEqual(exit_code, 0)
            self.assertEqual(json.loads(output_path.read_text(encoding="utf-8")), expected)

    def test_legacy_parent_is_structural_but_not_fabricated(self):
        base, _ = base_document(full_parent=False)
        saved = "b" * 64
        results = [
            rectangle_result("furniture:desk", "desk-geometry", "desk", saved, 10, 10, 10, 10),
            category_result("furniture:desk", "desk-geometry", "desk", saved),
        ]
        output = aggregate(base, results)
        instance = output["furniture_instances"][0]
        self.assertEqual(instance["parent_fingerprint"], saved)
        self.assertEqual(output["sources"]["furniture_instance"]["parent_validation"]["level"], "structural_legacy")

    def test_parent_mismatch_requires_and_retains_explicit_stale_state(self):
        base, _ = base_document()
        old_parent = "c" * 64
        results = [
            rectangle_result("furniture:desk", "desk-geometry", "desk", old_parent, 10, 10, 10, 10),
            category_result("furniture:desk", "desk-geometry", "desk", old_parent),
        ]
        with self.assertRaisesRegex(FurnitureAggregationError, "explicit stale"):
            aggregate(base, results)
        for result in results:
            saved = result["meta"]["furniture_instance_context"]
            saved["review_status"] = "stale"
            saved["review_fingerprint"] = "d" * 64
        output = aggregate(base, results)
        self.assertEqual(output["furniture_instances"][0]["parent_fingerprint"], old_parent)
        self.assertEqual(output["furniture_instances"][0]["review_status"], "stale")
        self.assertEqual(output["sources"]["furniture_instance"]["parent_validation"]["level"], "stale")

    def test_current_instance_cannot_cross_or_silently_switch_group(self):
        base, parent_value = base_document()
        outside = [
            rectangle_result("furniture:desk", "desk-geometry", "desk", parent_value, 45, 10, 10, 10),
            category_result("furniture:desk", "desk-geometry", "desk", parent_value),
        ]
        with self.assertRaisesRegex(FurnitureAggregationError, "crosses its saved furniture-group boundary"):
            aggregate(base, outside)

        reassigned = copy.deepcopy(outside)
        for result in reassigned:
            saved = result["meta"]["furniture_instance_context"]
            saved["group_id"] = "group-b"
            saved["parent_fingerprint"] = "e" * 64
        with self.assertRaisesRegex(FurnitureAggregationError, "parent is outdated"):
            aggregate(base, reassigned)

    def test_instance_inside_owner_cannot_overlap_another_furniture_group(self):
        base, parent_value = base_document()
        base["nodes"].append(
            {
                "id": "group-b",
                "kind": "furniture_group",
                "label": "Group B",
                "code": "GB",
                "color": "#000000",
                "parent_room_id": "room-a",
                "parent_zone_id": "zone-a",
            }
        )
        other_raw = raw_rectangle(
            "l3-group-b-part",
            40,
            0,
            30,
            50,
            control="occupancy_rectangle",
        )
        base["occupancy_regions"].append(
            {
                "id": "occupancy:group-b",
                "logical_id": "group-b",
                "category": "furniture_group",
                "group_id": "group-b",
                "group_type": "storage",
                "group_note": "",
                "parent_zone_id": "zone-a",
                "parent_room_id": "room-a",
                "generation": "manual",
                "review_status": "confirmed",
                "parts": [{"result_id": other_raw["id"], "raw": other_raw}],
            }
        )
        results = [
            rectangle_result("furniture:desk", "desk-geometry", "desk", parent_value, 45, 10, 3, 3),
            category_result("furniture:desk", "desk-geometry", "desk", parent_value),
        ]

        with self.assertRaisesRegex(FurnitureAggregationError, "overlaps another furniture group 'group-b'"):
            aggregate(base, results)

        for result in results:
            result["meta"]["furniture_instance_context"]["review_status"] = "stale"
        output = aggregate(base, results)
        validation = output["sources"]["furniture_instance"]["parent_validation"]
        self.assertEqual(validation["level"], "stale")
        self.assertIn("group-b", validation["instances"][0]["detail"])

    def test_relative_local_files_task_image_url_is_preserved(self):
        base, parent_value = base_document()
        image_url = "/data/local-files/?d=qa/floorplans/plan%2001.png"
        base["floorplan"]["image_id"] = image_url
        base["raw_inputs"]["task_image"] = {
            "role": "task_data",
            "name": "image",
            "sha256": "f" * 64,
            "text": image_url,
        }
        base["extensions"] = {"label_studio_task": {"data": {"image": image_url}}}
        results = [
            rectangle_result("furniture:desk", "desk-geometry", "desk", parent_value, 10, 10, 10, 10),
            category_result("furniture:desk", "desk-geometry", "desk", parent_value),
        ]
        task_envelope = {
            "id": TASK_ID,
            "data": {"image": image_url},
            "annotations": [envelope(results)],
        }
        original_base_fields = {
            name: copy.deepcopy(base[name])
            for name in ("floorplan", "raw_inputs", "extensions")
        }
        original_envelope = copy.deepcopy(task_envelope)

        output = aggregate_furniture_instances(
            base,
            task_envelope,
            project_id=PROJECT_ID,
            task_id=TASK_ID,
            annotation_id=ANNOTATION_ID,
        )

        self.assertEqual(task_envelope, original_envelope)
        for name, value in original_base_fields.items():
            self.assertEqual(output[name], value)
        self.assertEqual(output["floorplan"]["image_id"], image_url)

    def test_server_provenance_is_mandatory_and_must_match_envelope(self):
        base, parent_value = base_document()
        results = [
            rectangle_result("furniture:desk", "desk-geometry", "desk", parent_value, 10, 10, 10, 10),
            category_result("furniture:desk", "desk-geometry", "desk", parent_value),
        ]
        del results[0]["meta"]["furniture_instance_provenance"]
        with self.assertRaisesRegex(FurnitureAggregationError, "server-owned"):
            aggregate(base, results)
        results[0]["meta"]["furniture_instance_provenance"] = stamp(results[0]["id"])
        results[0]["meta"]["furniture_instance_provenance"]["annotation_id"] = 999
        with self.assertRaisesRegex(FurnitureAggregationError, "does not match envelope"):
            aggregate(base, results)

    def test_existing_l4_window_projection_target_cannot_be_redefined(self):
        base, parent_value = base_document()
        base["window_projections"] = [
            {
                "id": "window-projection:l4",
                "target": {"level": "L4", "entity_id": "furniture:desk", "room_id": "room-a"},
                "sentinel": "unchanged",
            }
        ]
        base["furniture_instances"] = [
            {
                "id": "furniture:desk",
                "instance_type": "sofa",
                "parent": {"room_id": "room-a", "zone_id": "zone-a", "group_id": "group-a"},
            }
        ]
        results = [
            rectangle_result("furniture:desk", "desk-geometry", "desk", parent_value, 10, 10, 10, 10),
            category_result("furniture:desk", "desk-geometry", "desk", parent_value),
        ]
        with self.assertRaisesRegex(FurnitureAggregationError, "was redefined"):
            aggregate(base, results)
        base["furniture_instances"][0]["instance_type"] = "desk"
        base["furniture_instances"][0]["geometry"] = {
            "type": "Polygon",
            "coordinates": [[
                {"x": 1, "y": 1},
                {"x": 2, "y": 1},
                {"x": 2, "y": 2},
                {"x": 1, "y": 2},
                {"x": 1, "y": 1},
            ]],
        }
        with self.assertRaisesRegex(FurnitureAggregationError, "geometry was redefined"):
            aggregate(base, results)

    def test_v3_base_is_rejected_without_mutation_or_output(self):
        base, parent_value = base_document()
        base["schema"] = "floorplan-unified/3"
        original = copy.deepcopy(base)
        results = [
            rectangle_result("furniture:desk", "desk-geometry", "desk", parent_value, 10, 10, 10, 10),
            category_result("furniture:desk", "desk-geometry", "desk", parent_value),
        ]
        with self.assertRaisesRegex(FurnitureAggregationError, "existing window pipeline"):
            aggregate(base, results)
        self.assertEqual(base, original)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base_path = root / "base.json"
            annotation_path = root / "annotation.json"
            output_path = root / "output.json"
            base_path.write_text(json.dumps(base), encoding="utf-8")
            annotation_path.write_text(json.dumps(envelope(results)), encoding="utf-8")
            exit_code = main(
                [
                    "--base",
                    str(base_path),
                    "--annotation",
                    str(annotation_path),
                    "--project-id",
                    str(PROJECT_ID),
                    "--task-id",
                    str(TASK_ID),
                    "--annotation-id",
                    str(ANNOTATION_ID),
                    "--output",
                    str(output_path),
                ]
            )
            self.assertEqual(exit_code, 2)
            self.assertFalse(output_path.exists())


if __name__ == "__main__":
    unittest.main()
