from __future__ import annotations

import copy
import json
import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from function_zone_v3_migration import (  # noqa: E402
    _fingerprint,
    _room_fingerprint,
    _validate_window_references,
    _window_trace_fingerprint,
    convert as convert_zones,
)
from room_v3_common import RoomV3Error  # noqa: E402
from room_v3_migration import convert as convert_rooms  # noqa: E402
from room_v3_to_graphml import (  # noqa: E402
    convert as convert_graph,
    load_label_palette,
    to_graphml,
)


def rectangle(result_id, control, label, x, y, width, height, meta=None):
    return {
        "id": result_id,
        "from_name": control,
        "to_name": "image",
        "type": "rectanglelabels" if control != "zone_rectangle" else "rectangle",
        "value": {
            "x": x,
            "y": y,
            "width": width,
            "height": height,
            "rotation": 0,
            **({"rectanglelabels": [label]} if control != "zone_rectangle" else {}),
        },
        "original_width": 1000,
        "original_height": 800,
        **({"meta": meta} if meta else {}),
    }


def vector(result_id, control, label, start, end, meta=None):
    return {
        "id": result_id,
        "from_name": control,
        "to_name": "image",
        "type": "vectorlabels",
        "value": {
            "vertices": [{"x": start[0], "y": start[1]}, {"x": end[0], "y": end[1]}],
            "closed": False,
            "vectorlabels": [label],
        },
        "original_width": 1000,
        "original_height": 800,
        **({"meta": meta} if meta else {}),
    }


def bezier_window(result_id="window-a", parent_room=None):
    result = {
        "id": result_id,
        "from_name": "window_vector",
        "to_name": "image",
        "type": "vectorlabels",
        "value": {
            "vertices": [
                {
                    "id": f"{result_id}-1", "x": 40, "y": 22, "isBezier": True,
                    "controlPoint1": {"x": 40, "y": 22}, "controlPoint2": {"x": 40, "y": 25},
                },
                {
                    "id": f"{result_id}-2", "x": 40, "y": 30, "isBezier": True,
                    "prevPointId": f"{result_id}-1",
                    "controlPoint1": {"x": 40, "y": 27}, "controlPoint2": {"x": 40, "y": 30},
                },
            ],
            "closed": False,
            "vectorlabels": ["Window"],
        },
        "original_width": 1000,
        "original_height": 800,
    }
    if parent_room is None:
        return result
    trace_id = f"window-trace:{result_id}"
    trace_fingerprint = _window_trace_fingerprint(result)
    room_fingerprint = _room_fingerprint(parent_room)
    policy = {
        "pairing_rule": "mutual_outward_projection",
        "boundary_match_tolerance_px": 2.0,
        "pair_search_limit_px": 40.0,
        "minimum_projected_overlap_px": 8.0,
        "maximum_tangent_delta_deg": 10.0,
        "flattening_tolerance_px": 0.5,
        "lower_level_inward_projection_limit_px": 60.0,
    }
    connection_id = "window-connection:" + _fingerprint({"trace_ids": [trace_id]})[:24]
    result["meta"] = {
        "window_context": {
            "schema_version": 1,
            "parent_room_id": parent_room["id"],
            "source_trace_id": trace_id,
            "source_window_trace_fingerprint": trace_fingerprint,
            "source_room_fingerprint": room_fingerprint,
            "boundary_attachment": {
                "match_rule": "full_positive_length_room_boundary_overlap",
                "path_length_px": 64.0,
                "overlap_length_px": 64.0,
                "room_boundary_segment_ids": ["room-segment:room-a:test"],
            },
            "parent_derivation": {
                "algorithm_version": "window-parent-room/1",
                "source_window_trace_fingerprint": trace_fingerprint,
                "room_fingerprint": room_fingerprint,
                "boundary_match_tolerance_px": 2.0,
                "flattening_tolerance_px": 0.5,
            },
            "derivation_status": "current",
            "pairing_status": "exterior",
            "pairing_search": {
                "status": "complete",
                "candidate_count": 0,
                "candidate_trace_ids": [],
                "pair_search_limit_px": 40.0,
                "algorithm_version": "window-pairing/1",
            },
            "connection": {
                "kind": "window_connection",
                "id": connection_id,
                "connection_kind": "room_to_exterior",
                "trace_ids": [trace_id],
                "connected_room_ids": [parent_room["id"]],
                "connects_to_exterior": True,
                "review_status": "derived",
                "evidence": {
                    "match_rule": "no_opposite_window_trace_within_search_limit",
                    "pair_search_limit_px": 40.0,
                    "candidate_count": 0,
                    "automatically_classified": True,
                    "trace_fingerprints": [trace_fingerprint],
                    "algorithm_version": "window-pairing/1",
                },
                "read_only": True,
            },
            "window_matching_policy": policy,
        }
    }
    return result


def polygon(result_id, control, label, points, meta=None):
    return {
        "id": result_id,
        "from_name": control,
        "to_name": "image",
        "type": "polygonlabels",
        "value": {"points": points, "polygonlabels": [label]},
        "original_width": 1000,
        "original_height": 800,
        **({"meta": meta} if meta else {}),
    }


class RoomV3PipelineTests(unittest.TestCase):
    def test_room_label_config_uses_normal_room_opacity_only(self):
        root = ET.parse(SCRIPTS.parent / "examples" / "room-v3" / "room-v3.xml").getroot()
        controls = {element.get("name"): element for element in root.iter() if element.get("name")}
        rectangle = controls["room_rectangle"]
        polygon = controls["room_polygon"]
        self.assertEqual(rectangle.get("opacity"), "0.6")
        self.assertEqual(polygon.get("opacity"), "0.6")
        self.assertEqual(controls["portal_v2_reference"].get("opacity"), "0.35")
        self.assertIsNone(controls["portal_rectangle"].get("opacity"))
        rectangle_palette = {
            label.get("value"): label.get("background") for label in rectangle.findall("Label")
        }
        polygon_palette = {
            label.get("value"): label.get("background") for label in polygon.findall("Label")
        }
        self.assertEqual(len(rectangle_palette), 18)
        self.assertEqual(rectangle_palette, polygon_palette)

    def test_room_migration_separates_editable_and_reference_results(self):
        source = {
            "id": 13,
            "data": {"image": "/data/local-files/?d=floor.png"},
            "annotations": [
                {
                    "id": 41,
                    "result": [
                        rectangle("room-a", "label", "Bedroom", 0, 0, 40, 40),
                        vector("passage-a", "opening_label", "Open passage", (40, 10), (40, 20)),
                        vector("door-a", "opening_label", "Door", (0, 10), (0, 20)),
                        vector("sliding-a", "opening_label", "Sliding door", (10, 0), (20, 0)),
                    ],
                }
            ],
        }
        bundle = convert_rooms(
            source,
            expected_rooms=None,
            expected_open_passages=None,
            expected_references=None,
        )
        self.assertEqual([item["id"] for item in bundle["annotation_result"]], ["room-a", "passage-a"])
        self.assertEqual(
            [item["id"] for item in bundle["prediction"]["result"]],
            ["v2-ref-door-a", "v2-ref-sliding-a"],
        )
        room = bundle["annotation_result"][0]
        self.assertEqual(room["from_name"], "room_rectangle")
        self.assertEqual(room["meta"]["room_graph_node"]["schema_version"], 3)
        self.assertEqual(room["meta"]["migration_context"]["source_result_id"], "room-a")
        self.assertTrue(bundle["prediction"]["result"][0]["readonly"])

    def test_function_zone_migration_uses_only_approved_room_v3_references(self):
        room_a = rectangle(
            "room-a",
            "room_rectangle",
            "Bedroom",
            0,
            0,
            40,
            40,
            {"room_graph_node": {"schema_version": 3, "room_type": "Bedroom", "geometry_type": "rectangle"}},
        )
        room_b = rectangle(
            "room-b",
            "room_rectangle",
            "Living room",
            42,
            0,
            40,
            40,
            {
                "room_graph_node": {
                    "schema_version": 3,
                    "room_type": "Living room",
                    "geometry_type": "rectangle",
                }
            },
        )
        portal = rectangle(
            "portal-a",
            "portal_rectangle",
            "Door",
            40,
            10,
            2,
            10,
            {
                "room_graph_edge": {
                    "schema_version": 3,
                    "connected_room_ids": ["room-a", "room-b"],
                    "room_ids": ["room-a", "room-b"],
                    "boundary_segments": {
                        "room-a": [[{"x": 40, "y": 10}, {"x": 40, "y": 20}]],
                        "room-b": [[{"x": 42, "y": 10}, {"x": 42, "y": 20}]],
                    },
                }
            },
        )
        window = bezier_window(parent_room=room_a)
        room_task = {"id": 101, "annotations": [{"id": 201, "result": [room_a, room_b, portal, window]}]}
        zone_geometry = rectangle("zone-a", "zone_rectangle", "", 0, 0, 40, 40)
        zone_label = {
            "id": "zone-a",
            "from_name": "function_zone",
            "to_name": "image",
            "type": "labels",
            "value": {"labels": ["Sleeping"]},
        }
        old_room_reference = rectangle("old-room", "label", "Bedroom", 0, 0, 50, 50)
        zone_task = {
            "id": 7,
            "data": {"image": "/data/local-files/?d=floor.png"},
            "annotations": [
                {
                    "id": 301,
                    "result": [
                        zone_geometry,
                        zone_label,
                        vector("connection-a", "connection_vector", "Door", (40, 10), (42, 10)),
                        vector("visual-a", "visual_connection_vector", "Visual only", (5, 5), (10, 5)),
                        old_room_reference,
                    ],
                }
            ],
        }
        bundle = convert_zones(
            zone_task,
            room_task,
            approved_room_annotation_id=201,
            room_v3_project_id=12,
            expected_zones=None,
            expected_transport_vectors=None,
            expected_visual_vectors=None,
        )
        controls = {item["from_name"] for item in bundle["annotation_result"]}
        self.assertNotIn("label", controls)
        self.assertEqual(bundle["annotation_result"][0]["meta"]["partition_context"]["parent_room_id"], "room-a")
        self.assertEqual(bundle["manifest"]["room_reference_count"], 2)
        self.assertEqual(bundle["manifest"]["portal_reference_count"], 1)
        self.assertEqual(bundle["manifest"]["window_reference_count"], 1)
        copied_window = next(item for item in bundle["prediction"]["result"] if item["id"] == "window-a")
        self.assertTrue(copied_window["readonly"])
        self.assertEqual(copied_window["value"], window["value"])
        self.assertNotIn("room_graph_edge", copied_window["meta"])
        connection = next(item for item in bundle["annotation_result"] if item["id"] == "connection-a")
        self.assertEqual(connection["meta"]["geometry_review"]["status"], "pending")

        pending_room_task = copy.deepcopy(room_task)
        pending_room_task["annotations"][0]["result"][-1]["meta"]["window_context"]["pairing_status"] = "pending"
        with self.assertRaisesRegex(RoomV3Error, "pairing evidence"):
            convert_zones(
                zone_task,
                pending_room_task,
                approved_room_annotation_id=201,
                room_v3_project_id=12,
                expected_zones=None,
                expected_transport_vectors=None,
                expected_visual_vectors=None,
            )

    def test_function_zone_migration_rejects_pending_or_stale_windows_without_shapely(self):
        parent = rectangle(
            "room-a",
            "room_rectangle",
            "Bedroom",
            0,
            0,
            40,
            40,
            {"room_graph_node": {"schema_version": 3, "room_type": "Bedroom", "geometry_type": "rectangle"}},
        )
        current = bezier_window(parent_room=parent)
        self.assertEqual(
            _room_fingerprint(parent),
            "cb079aa8fd6720ebfc0d7a2a691fe152827785fe42ec4b9cfb9b95a721178275",
        )
        self.assertEqual(
            _window_trace_fingerprint(current),
            "f7c3606439d3ac3e5319c845e1e938d3a2efe4c0c4432b322844de777fa1c365",
        )
        _validate_window_references([parent, current])

        pending = copy.deepcopy(current)
        pending["meta"]["window_context"]["pairing_status"] = "pending"
        with self.assertRaisesRegex(RoomV3Error, "pairing evidence"):
            _validate_window_references([parent, pending])

        stale = copy.deepcopy(current)
        stale["value"]["vertices"][1]["y"] = 31
        with self.assertRaisesRegex(RoomV3Error, "stale or incomplete parent context"):
            _validate_window_references([parent, stale])

        stale_status = copy.deepcopy(current)
        stale_status["meta"]["window_context"]["derivation_status"] = "stale"
        with self.assertRaisesRegex(RoomV3Error, "stale or incomplete parent context"):
            _validate_window_references([parent, stale_status])

        incomplete = copy.deepcopy(current)
        incomplete["meta"]["window_context"]["pairing_search"]["status"] = "pending"
        with self.assertRaisesRegex(RoomV3Error, "pending or incomplete pairing-search"):
            _validate_window_references([parent, incomplete])

    def test_room_window_example_and_fixture_cover_contract(self):
        room_v3_root = ET.parse(SCRIPTS.parent / "examples" / "room-v3" / "room-v3.xml").getroot()
        root = ET.parse(SCRIPTS.parent / "examples" / "room-window-annotation" / "room-window-v1.xml").getroot()
        controls = {element.get("name"): element for element in root.iter() if element.get("name")}
        room_v3_controls = {
            element.get("name"): element for element in room_v3_root.iter() if element.get("name")
        }
        self.assertIn("room_rectangle", controls)
        self.assertIn("room_polygon", controls)
        self.assertIn("portal_rectangle", controls)
        self.assertIn("portal_vector", controls)
        self.assertIn("portal_v2_reference", controls)
        image = controls["image"]
        self.assertEqual(image.get("roomWindowV1"), "true")
        self.assertEqual(image.get("roomV3Controls"), "room_rectangle,room_polygon")
        self.assertEqual(image.get("windowControls"), "window_vector")
        self.assertEqual(image.get("windowBoundaryMatchTolerancePx"), "2")
        self.assertEqual(image.get("windowPairSearchLimitPx"), "40")
        self.assertEqual(image.get("windowMinimumProjectedOverlapPx"), "8")
        self.assertEqual(image.get("windowMaximumTangentDeltaDeg"), "10")
        self.assertEqual(image.get("windowFlatteningTolerancePx"), "0.5")
        self.assertEqual(image.get("windowInwardProjectionLimitPx"), "60")
        for name, original in room_v3_controls.items():
            copied = controls[name]
            for key, value in original.attrib.items():
                self.assertEqual(copied.get(key), value, f"{name}.{key}")
            self.assertEqual(
                [(child.tag, child.attrib) for child in copied],
                [(child.tag, child.attrib) for child in original],
                name,
            )
        window_control = controls["window_vector"]
        self.assertEqual(window_control.tag, "VectorLabels")
        self.assertEqual(window_control.get("closable"), "false")
        self.assertEqual(window_control.get("curves"), "true")
        self.assertEqual(window_control.get("minPoints"), "2")
        self.assertIsNone(window_control.get("maxPoints"))

        fixture = json.loads(
            (SCRIPTS.parent / "examples" / "room-window-annotation" / "fixtures" / "window-cases.json")
            .read_text(encoding="utf-8")
        )
        self.assertEqual(
            {case["window"]["path_kind"] for case in fixture["parent_assignment_cases"]},
            {"line", "polyline", "bezier"},
        )
        self.assertEqual(
            {case["expected"]["status"] for case in fixture["parent_assignment_cases"]},
            {"unique", "missing", "ambiguous"},
        )
        self.assertEqual({case["expected_kind"] for case in fixture["pairing_cases"]}, {"internal", "exterior"})

    def test_l2_l3_examples_accept_lossless_readonly_window_references(self):
        for relative_path in (
            ("room-v3", "function-zone-v3.xml"),
            ("occupancy-v1", "furniture-group-v1.xml"),
        ):
            root = ET.parse(SCRIPTS.parent / "examples" / relative_path[0] / relative_path[1]).getroot()
            controls = [
                element
                for element in root.iter("VectorLabels")
                if element.get("name") == "window_vector"
            ]
            self.assertEqual(len(controls), 1, relative_path)
            control = controls[0]
            self.assertEqual(control.get("toName"), "image")
            self.assertEqual(control.get("closable"), "false")
            self.assertEqual(control.get("curves"), "true")
            self.assertEqual(control.get("minPoints"), "2")
            self.assertIsNone(control.get("maxPoints"))
            self.assertEqual(
                [(label.get("value"), label.get("background")) for label in control.findall("Label")],
                [("Window", "#1677FF")],
            )

    def test_graph_converter_adds_exterior_and_keeps_rectangle_and_vector_portals(self):
        room = rectangle(
            "room-a",
            "room_rectangle",
            "Entryway",
            0,
            0,
            40,
            40,
            {"room_graph_node": {"schema_version": 3, "room_type": "Entryway", "geometry_type": "rectangle"}},
        )
        exterior_portal = rectangle(
            "door-exterior",
            "portal_rectangle",
            "Door",
            10,
            40,
            10,
            2,
            {
                "room_graph_edge": {
                    "schema_version": 3,
                    "opening_type": "door",
                    "geometry_type": "rectangle",
                    "connected_room_ids": ["room-a"],
                    "connects_to_exterior": True,
                    "clear_width_percent": 10,
                    "depth_percent": 2,
                }
            },
        )
        task = {"id": 101, "annotations": [{"id": 201, "result": [room, exterior_portal]}]}
        palette = load_label_palette(SCRIPTS.parent / "examples" / "room-v3" / "room-v3.xml")
        graph = convert_graph(task, palette=palette)
        self.assertEqual({node["id"] for node in graph["nodes"]}, {"room-a", "Exterior"})
        self.assertEqual(graph["edges"][0]["target"], "Exterior")
        room_node = next(node for node in graph["nodes"] if node["id"] == "room-a")
        exterior_node = next(node for node in graph["nodes"] if node["id"] == "Exterior")
        self.assertEqual(room_node["display_name"], "Entryway · room-a")
        self.assertEqual(room_node["centroid_x_percent"], 20)
        self.assertEqual(room_node["centroid_y_percent"], 20)
        self.assertEqual(room_node["centroid_x_px"], 200)
        self.assertEqual(room_node["centroid_y_px"], 160)
        self.assertEqual(room_node["label_studio_color"], "#FFC069")
        self.assertNotEqual(
            (exterior_node["centroid_x_px"], exterior_node["centroid_y_px"]),
            (room_node["centroid_x_px"], room_node["centroid_y_px"]),
        )
        self.assertEqual(graph["edges"][0]["edge_kind"], "room_opening")
        self.assertEqual(graph["edges"][0]["label_studio_color"], "#FF8C00")
        self.assertEqual(graph["image_width_px"], 1000)
        self.assertEqual(graph["image_height_px"], 800)
        xml_root = to_graphml(graph).getroot()
        graph_element = next(element for element in xml_root if element.tag.endswith("graph"))
        graph_values = {element.text for element in graph_element if element.tag.endswith("data")}
        self.assertIn("3", graph_values)
        self.assertIn("Room v3 Task 101 Annotation 201", graph_values)

    def test_graph_converter_uses_area_weighted_polygon_centroid(self):
        room = polygon(
            "room-l",
            "room_polygon",
            "Living room",
            [[0, 0], [40, 0], [40, 20], [20, 20], [20, 40], [0, 40]],
            {
                "room_graph_node": {
                    "schema_version": 3,
                    "room_type": "Living room",
                    "geometry_type": "polygon",
                }
            },
        )
        graph = convert_graph({"id": 102, "annotations": [{"id": 202, "result": [room]}]})
        node = graph["nodes"][0]
        self.assertAlmostEqual(node["centroid_x_percent"], 16.666667)
        self.assertAlmostEqual(node["centroid_y_percent"], 16.666667)
        self.assertAlmostEqual(node["centroid_x_px"], 166.666667)
        self.assertAlmostEqual(node["centroid_y_px"], 133.333333)


if __name__ == "__main__":
    unittest.main()
