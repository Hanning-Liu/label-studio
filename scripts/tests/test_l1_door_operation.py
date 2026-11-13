import copy
import json
import unittest

from hanning.backend.reference_sync.room_metadata import RoomV3MetadataError, refresh_room_v3_metadata
from hanning.scripts.room_v3_to_graphml import GRAPHML_NS, convert, to_graphml


def rectangle(identifier, control, label, bounds):
    x, y, w, h = bounds
    return {
        "id": identifier, "from_name": control, "to_name": "image", "type": "rectanglelabels",
        "original_width": 1000, "original_height": 800,
        "value": {"x": x, "y": y, "width": w, "height": h, "rotation": 0, "rectanglelabels": [label]},
    }


class DoorOperationTest(unittest.TestCase):
    def setUp(self):
        self.results = [
            rectangle("a", "room_rectangle", "Bedroom", (10, 10, 40, 25)),
            rectangle("b", "room_rectangle", "Hallway", (10, 37, 40, 30)),
            rectangle("opening", "portal_rectangle", "Door", (20, 35, 14, 2)),
        ]

    def test_legacy_and_swing(self):
        legacy, _ = refresh_room_v3_metadata(self.results)
        self.assertNotIn("door_operation", legacy[-1]["meta"])
        self.results[-1]["meta"] = {
            "door_operation": {"version": 1, "kind": "swing", "hinge_edge": 1, "swing_edge": 0},
        }
        refreshed, _ = refresh_room_v3_metadata(self.results)
        self.assertEqual(refreshed[-1]["value"], legacy[-1]["value"])
        self.assertEqual(refreshed[-1]["meta"]["room_graph_edge"], legacy[-1]["meta"]["room_graph_edge"])
        self.assertEqual(refreshed[-1]["meta"]["door_operation"], self.results[-1]["meta"]["door_operation"])
        for invalid in ({"hinge_edge": 0}, {"swing_edge": 1}, {"hinge_edge": True}, {"kind": "sliding"}):
            candidate = copy.deepcopy(self.results)
            candidate[-1]["meta"]["door_operation"].update(invalid)
            with self.subTest(invalid=invalid), self.assertRaises(RoomV3MetadataError):
                refresh_room_v3_metadata(candidate)

    def test_sliding_width_export_and_clear(self):
        operation = {
            "version": 1, "kind": "sliding", "clear_span": [0.25, 0.75], "group_leaf_counts": [2, 2],
            "clear_span_points_px": [[305, 288], [235, 288]],
        }
        self.results[-1]["value"]["rectanglelabels"] = ["Sliding door"]
        self.results[-1]["meta"] = {"door_operation": operation}
        refreshed, _ = refresh_room_v3_metadata(self.results)
        graph = convert({"id": 5, "annotations": [{"id": 1, "result": refreshed}]})
        edge = graph["edges"][0]
        self.assertEqual(edge["clear_width_px"], 140)
        self.assertEqual(edge["effective_clear_width_px"], 70)
        self.assertEqual(edge["door_operation"], operation)
        xml = to_graphml(graph)
        ns = {"g": GRAPHML_NS}
        width = xml.find(".//g:edge/g:data[@key='edge_effective_clear_width_px']", ns)
        spec = xml.find(".//g:edge/g:data[@key='edge_door_operation']", ns)
        self.assertEqual(float(width.text), 70)
        self.assertEqual(json.loads(spec.text), operation)
        del refreshed[-1]["meta"]["door_operation"]
        cleared, _ = refresh_room_v3_metadata(refreshed)
        self.assertNotIn("effective_clear_width_px", cleared[-1]["meta"]["room_graph_edge"])
        for invalid in (
            {"clear_span": [0.75, 0.25]}, {"clear_span": [-0.1, 1]}, {"group_leaf_counts": [0, 2]},
            {"clear_span_points_px": [[305.5, 288], [235, 288]]},
            {"clear_span_points_px": [[305, 278], [235, 288]]},
            {"clear_span_points_px": [[300, 288], [235, 288]]},
        ):
            candidate = copy.deepcopy(self.results)
            candidate[-1]["meta"]["door_operation"].update(invalid)
            with self.subTest(invalid=invalid), self.assertRaises(RoomV3MetadataError):
                refresh_room_v3_metadata(candidate)
        del self.results[-1]["meta"]["door_operation"]["clear_span_points_px"]
        legacy, _ = refresh_room_v3_metadata(self.results)
        self.assertEqual(legacy[-1]["meta"]["room_graph_edge"]["effective_clear_width_px"], 70)
