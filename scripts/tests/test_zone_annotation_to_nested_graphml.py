import importlib.util
import json
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "zone_annotation_to_nested_graphml.py"
SPEC = importlib.util.spec_from_file_location("zone_annotation_to_nested_graphml", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def rectangle(result_id, from_name, x, y, width, height, *, parent=None):
    result = {
        "id": result_id,
        "from_name": from_name,
        "to_name": "image",
        "type": "rectangle",
        "original_width": 100,
        "original_height": 100,
        "image_rotation": 0,
        "value": {"x": x, "y": y, "width": width, "height": height, "rotation": 0},
    }
    if parent:
        result["meta"] = {
            "partition_context": {
                "schema_version": 1,
                "parent_room_id": parent,
                "opening_ids": [],
                "connected_room_ids": [],
            }
        }
    return result


def label(result_id, value):
    return {
        "id": result_id,
        "from_name": "function_zone",
        "to_name": "image",
        "type": "labels",
        "original_width": 100,
        "original_height": 100,
        "image_rotation": 0,
        "value": {"x": 0, "y": 0, "width": 1, "height": 1, "labels": [value]},
    }


def vector(result_id, vertices, *, from_name="connection_vector", label_value="Open passage"):
    return {
        "id": result_id,
        "from_name": from_name,
        "to_name": "image",
        "type": "vectorlabels",
        "original_width": 100,
        "original_height": 100,
        "image_rotation": 0,
        "value": {
            "vertices": [{"x": x, "y": y} for x, y in vertices],
            "closed": False,
            "vectorlabels": [label_value],
        },
    }


ROOM = {
    "id": "room-bedroom",
    "from_name": "label",
    "to_name": "image",
    "type": "rectanglelabels",
    "original_width": 100,
    "original_height": 100,
    "image_rotation": 0,
    "value": {
        "x": 0,
        "y": 0,
        "width": 100,
        "height": 100,
        "rotation": 0,
        "rectanglelabels": ["Bedroom"],
    },
    "meta": {
        "room_graph_node": {
            "schema_version": 1,
            "node_id": "room-bedroom",
            "room_type": "Bedroom",
        }
    },
}

OTHER_ROOM = {
    "id": "room-hallway",
    "from_name": "label",
    "to_name": "image",
    "type": "rectanglelabels",
    "original_width": 100,
    "original_height": 100,
    "image_rotation": 0,
    "value": {
        "x": 90,
        "y": 0,
        "width": 10,
        "height": 10,
        "rotation": 0,
        "rectanglelabels": ["Hallway"],
    },
    "meta": {
        "room_graph_node": {
            "schema_version": 1,
            "node_id": "room-hallway",
            "room_type": "Hallway",
        }
    },
}

ROOM_OPENING = {
    "id": "room-opening-1",
    "from_name": "opening_label",
    "to_name": "image",
    "type": "vectorlabels",
    "original_width": 100,
    "original_height": 100,
    "image_rotation": 0,
    "value": {
        "vertices": [{"x": 90, "y": 0}, {"x": 100, "y": 0}],
        "closed": False,
        "vectorlabels": ["Door"],
    },
    "meta": {
        "room_graph_edge": {
            "schema_version": 1,
            "edge_id": "room-opening-1",
            "room_ids": ["room-bedroom", "room-hallway"],
            "opening_type": "Door",
            "walkable": True,
            "width_pixels": 10,
            "midpoint_x": 95,
            "midpoint_y": 0,
            "confidence": 1,
        }
    },
}


def task(connection=None):
    connection = connection or vector("connection-1", [(50, 20), (50, 80)])
    return {
        "id": 7,
        "data": {"image": "synthetic.png"},
        "annotations": [
            {
                "id": 6,
                "updated_at": "2026-08-20T00:00:00Z",
                "was_cancelled": False,
                "result": [
                    ROOM,
                    OTHER_ROOM,
                    ROOM_OPENING,
                    rectangle("zone-left", "zone_rectangle", 0, 0, 50, 100, parent="room-bedroom"),
                    label("zone-left", "Sleeping"),
                    rectangle("zone-right", "zone_rectangle", 50, 0, 50, 100, parent="room-bedroom"),
                    label("zone-right", "Study/work"),
                    connection,
                ],
            }
        ],
    }


class NestedGraphMLConversionTests(unittest.TestCase):
    def test_builds_room_overview_and_zone_child_network(self):
        converted = MODULE.convert(task(), "room-bedroom", "bedroom")
        self.assertEqual(converted.report["counts"], {
            "rooms": 2,
            "room_openings": 1,
            "zones": 2,
            "connection_vectors": 1,
            "visual_connection_vectors": 0,
            "direct_boundary_edges": 1,
            "visual_boundary_edges": 0,
            "derived_junction_edges": 0,
            "movement_derived_junction_edges": 0,
            "visual_derived_junction_edges": 0,
            "zone_edges": 1,
        })
        edge = converted.report["edges"][0]
        self.assertEqual({edge["source_zone_id"], edge["target_zone_id"]}, {
            "zone-left", "zone-right"
        })
        self.assertAlmostEqual(edge["opening_length_px"], 60.0)
        self.assertAlmostEqual(edge["shared_boundary_length_px"], 100.0)
        self.assertAlmostEqual(edge["raw_strength"], 0.2)
        self.assertAlmostEqual(edge["relative_strength"], 1.0)
        self.assertAlmostEqual(edge["interface_openness"], 0.6)
        self.assertAlmostEqual(edge["movement_length_px"], 60.0)
        self.assertAlmostEqual(edge["visual_length_px"], 60.0)
        self.assertAlmostEqual(edge["movement_relative_strength"], 1.0)
        self.assertAlmostEqual(edge["visual_relative_strength"], 1.0)
        self.assertEqual(edge["edge_kind"], "direct_boundary")

        namespace = {"g": MODULE.GRAPHML_NS}
        overview_root = converted.overview.getroot()
        zones_root = converted.zones.getroot()
        self.assertEqual(len(overview_root.findall(".//g:node", namespace)), 2)
        self.assertEqual(len(overview_root.findall(".//g:edge", namespace)), 1)
        self.assertEqual(len(zones_root.findall(".//g:node", namespace)), 2)
        self.assertEqual(len(zones_root.findall(".//g:edge", namespace)), 1)

    def test_rejects_vector_supported_by_only_one_zone_boundary(self):
        invalid = vector("bad-connection", [(0, 20), (0, 80)])
        with self.assertRaisesRegex(MODULE.ConversionError, "exactly two zone boundaries"):
            MODULE.convert(task(invalid), "room-bedroom", "bedroom")

    def test_visual_only_vector_creates_visual_boundary_without_movement_aliases(self):
        visual = vector(
            "visual-1",
            [(50, 20), (50, 80)],
            from_name="visual_connection_vector",
            label_value="Visual only",
        )
        converted = MODULE.convert(task(visual), "room-bedroom", "bedroom")
        edge = converted.report["edges"][0]
        self.assertEqual(edge["edge_kind"], "visual_boundary")
        self.assertEqual(edge["connectivity_modalities_json"], '["visual"]')
        self.assertEqual(edge["movement_vector_result_ids_json"], "[]")
        self.assertEqual(edge["visual_only_vector_result_ids_json"], '["visual-1"]')
        self.assertEqual(edge["movement_length_px"], 0.0)
        self.assertEqual(edge["movement_relative_strength"], 0.0)
        self.assertEqual(edge["visual_length_px"], 60.0)
        self.assertNotIn("opening_length_px", edge)

    def test_non_overlapping_visual_segment_augments_visual_union_only(self):
        sample = task(vector("movement-1", [(50, 20), (50, 50)]))
        sample["annotations"][0]["result"].append(
            vector(
                "visual-1",
                [(50, 50), (50, 80)],
                from_name="visual_connection_vector",
                label_value="Visual only",
            )
        )
        converted = MODULE.convert(sample, "room-bedroom", "bedroom")
        edge = converted.report["edges"][0]
        self.assertEqual(edge["edge_kind"], "direct_boundary")
        self.assertEqual(edge["movement_length_px"], 30.0)
        self.assertEqual(edge["visual_length_px"], 60.0)
        self.assertAlmostEqual(edge["movement_raw_strength"], 0.1)
        self.assertAlmostEqual(edge["visual_raw_strength"], 0.2)
        self.assertEqual(edge["movement_vector_result_ids_json"], '["movement-1"]')
        self.assertEqual(edge["visual_only_vector_result_ids_json"], '["visual-1"]')

    def test_rejects_positive_overlap_between_movement_and_visual_only(self):
        sample = task(vector("movement-1", [(50, 20), (50, 60)]))
        sample["annotations"][0]["result"].append(
            vector(
                "visual-1",
                [(50, 50), (50, 80)],
                from_name="visual_connection_vector",
                label_value="Visual only",
            )
        )
        with self.assertRaisesRegex(
            MODULE.ConversionError, "VISUAL_VECTOR_OVERLAPS_MOVEMENT"
        ):
            MODULE.convert(sample, "room-bedroom", "bedroom")

    def test_cli_writes_three_valid_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "task.json"
            output_dir = root / "out"
            input_path.write_text(json.dumps([task()]), encoding="utf-8")
            exit_code = MODULE.main([
                "--input-json", str(input_path),
                "--output-dir", str(output_dir),
                "--task-id", "7",
                "--parent-room-id", "room-bedroom",
                "--prefix", "bedroom",
            ])
            self.assertEqual(exit_code, 0)
            ET.parse(output_dir / "bedroom-overview.graphml")
            ET.parse(output_dir / "bedroom-zones.graphml")
            report = json.loads((output_dir / "bedroom-conversion-report.json").read_text())
            self.assertEqual(report["status"], "ok")


if __name__ == "__main__":
    unittest.main()
