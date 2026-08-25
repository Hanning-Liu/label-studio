from __future__ import annotations

import sys
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from function_zone_v3_migration import convert as convert_zones  # noqa: E402
from room_v3_migration import convert as convert_rooms  # noqa: E402
from room_v3_to_graphml import convert as convert_graph  # noqa: E402


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
        **({"meta": meta} if meta else {}),
    }


class RoomV3PipelineTests(unittest.TestCase):
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
        room_task = {"id": 101, "annotations": [{"id": 201, "result": [room_a, room_b, portal]}]}
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
        connection = next(item for item in bundle["annotation_result"] if item["id"] == "connection-a")
        self.assertEqual(connection["meta"]["geometry_review"]["status"], "pending")

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
        graph = convert_graph(task)
        self.assertEqual({node["id"] for node in graph["nodes"]}, {"room-a", "Exterior"})
        self.assertEqual(graph["edges"][0]["target"], "Exterior")


if __name__ == "__main__":
    unittest.main()
