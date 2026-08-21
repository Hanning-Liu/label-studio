import importlib.util
import json
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from copy import deepcopy
from pathlib import Path


SCRIPTS_DIR = Path(__file__).parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))
MODULE_PATH = SCRIPTS_DIR / "zone_annotation_to_grouped_graphml.py"
SPEC = importlib.util.spec_from_file_location("zone_annotation_to_grouped_graphml", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def room(result_id, label, x, width):
    return {
        "id": result_id,
        "from_name": "label",
        "to_name": "image",
        "type": "rectanglelabels",
        "original_width": 100,
        "original_height": 100,
        "image_rotation": 0,
        "value": {
            "x": x,
            "y": 0,
            "width": width,
            "height": 100,
            "rotation": 0,
            "rectanglelabels": [label],
        },
        "meta": {
            "room_graph_node": {
                "schema_version": 1,
                "node_id": result_id,
                "room_type": label,
            }
        },
    }


def opening(result_id, first_room, second_room, x):
    return {
        "id": result_id,
        "from_name": "opening_label",
        "to_name": "image",
        "type": "vectorlabels",
        "original_width": 100,
        "original_height": 100,
        "image_rotation": 0,
        "value": {
            "vertices": [{"x": x, "y": 20}, {"x": x, "y": 30}],
            "closed": False,
            "vectorlabels": ["Door"],
        },
        "meta": {
            "room_graph_edge": {
                "schema_version": 1,
                "edge_id": result_id,
                "room_ids": [first_room, second_room],
                "opening_type": "Door",
                "walkable": True,
                "width_pixels": 10,
                "midpoint_x": x,
                "midpoint_y": 25,
                "confidence": 1,
            }
        },
    }


def zone(result_id, parent, x, y, width, height, opening_ids=None, connected=None):
    return {
        "id": result_id,
        "from_name": "zone_rectangle",
        "to_name": "image",
        "type": "rectangle",
        "original_width": 100,
        "original_height": 100,
        "image_rotation": 0,
        "value": {"x": x, "y": y, "width": width, "height": height, "rotation": 0},
        "meta": {
            "partition_context": {
                "schema_version": 1,
                "parent_room_id": parent,
                "opening_ids": opening_ids or [],
                "connected_room_ids": connected or [],
            }
        },
    }


def zone_label(result_id, label):
    return {
        "id": result_id,
        "from_name": "function_zone",
        "to_name": "image",
        "type": "labels",
        "original_width": 100,
        "original_height": 100,
        "image_rotation": 0,
        "value": {"x": 0, "y": 0, "width": 1, "height": 1, "labels": [label]},
    }


def connection(result_id, vertices):
    return {
        "id": result_id,
        "from_name": "connection_vector",
        "to_name": "image",
        "type": "vectorlabels",
        "original_width": 100,
        "original_height": 100,
        "image_rotation": 0,
        "value": {
            "vertices": [{"x": x, "y": y} for x, y in vertices],
            "closed": False,
            "vectorlabels": ["Open passage"],
        },
    }


def synthetic_task():
    results = [
        room("room-a", "Bedroom", 0, 40),
        room("room-b", "Living room", 40, 40),
        room("room-c", "Hallway", 80, 10),
        room("room-d", "Bathroom", 90, 10),
        opening("opening-ab", "room-a", "room-b", 40),
        opening("opening-bc", "room-b", "room-c", 80),
        opening("opening-cd", "room-c", "room-d", 90),
        zone("zone-a1", "room-a", 0, 0, 40, 50, ["opening-ab"], ["room-b"]),
        zone_label("zone-a1", "Sleeping"),
        zone("zone-a2", "room-a", 0, 50, 40, 50),
        zone_label("zone-a2", "Study/work"),
        zone(
            "zone-b1",
            "room-b",
            40,
            0,
            40,
            50,
            ["opening-ab", "opening-bc"],
            ["room-a", "room-c"],
        ),
        zone_label("zone-b1", "Living/social"),
        zone("zone-b2", "room-b", 40, 50, 40, 50),
        zone_label("zone-b2", "Dining"),
        connection("connection-a", [(10, 50), (30, 50)]),
        connection("connection-b", [(50, 50), (70, 50)]),
    ]
    return {
        "id": 7,
        "data": {"image": "synthetic.png"},
        "annotations": [
            {
                "id": 6,
                "updated_at": "2026-08-20T00:00:00Z",
                "was_cancelled": False,
                "result": results,
            }
        ],
    }


class GroupedGraphMLConversionTests(unittest.TestCase):
    def test_builds_multiple_groups_and_all_endpoint_modes(self):
        converted = MODULE.convert(synthetic_task(), prefix="floorplan")
        self.assertEqual(
            converted.report["counts"],
            {
                "reference_rooms": 4,
                "reference_openings": 3,
                "grouped_rooms": 2,
                "unpartitioned_room_nodes": 2,
                "zone_nodes": 4,
                "room_opening_edges": 1,
                "zone_external_opening_edges": 2,
                "direct_boundary_edges": 2,
                "total_data_nodes": 6,
                "total_edges": 5,
            },
        )
        self.assertEqual(len(converted.manifest["groups"]), 2)
        external = {
            edge["opening_result_id"]: {edge["source"]["result_id"], edge["target"]["result_id"]}
            for edge in converted.report["external_edges"]
        }
        self.assertEqual(external["opening-ab"], {"zone-a1", "zone-b1"})
        self.assertEqual(external["opening-bc"], {"zone-b1", "room-c"})

        namespace = {"g": MODULE.base.GRAPHML_NS}
        root = converted.graphml.getroot()
        self.assertEqual(len(root.findall(".//g:node", namespace)), 6)
        self.assertEqual(len(root.findall(".//g:edge", namespace)), 5)

    def test_rejects_missing_opening_owner(self):
        task = synthetic_task()
        target = next(
            result
            for result in task["annotations"][0]["result"]
            if result.get("id") == "zone-b1" and result.get("from_name") == "zone_rectangle"
        )
        target["meta"]["partition_context"]["opening_ids"] = ["opening-bc"]
        target["meta"]["partition_context"]["connected_room_ids"] = ["room-c"]
        with self.assertRaisesRegex(MODULE.base.ConversionError, "exactly one owning zone"):
            MODULE.convert(task)

    def test_rejects_duplicate_opening_owner(self):
        task = synthetic_task()
        target = next(
            result
            for result in task["annotations"][0]["result"]
            if result.get("id") == "zone-a2" and result.get("from_name") == "zone_rectangle"
        )
        target["meta"]["partition_context"]["opening_ids"] = ["opening-ab"]
        target["meta"]["partition_context"]["connected_room_ids"] = ["room-b"]
        with self.assertRaisesRegex(MODULE.base.ConversionError, "exactly one owning zone"):
            MODULE.convert(task)

    def test_rejects_dangling_room_endpoint(self):
        task = synthetic_task()
        target = next(
            result
            for result in task["annotations"][0]["result"]
            if result.get("id") == "opening-cd"
        )
        target["meta"]["room_graph_edge"]["room_ids"][1] = "missing-room"
        with self.assertRaisesRegex(MODULE.base.ConversionError, "dangling room endpoint"):
            MODULE.convert(task)

    def test_cli_writes_graphml_manifest_and_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "task.json"
            output_dir = root / "out"
            input_path.write_text(json.dumps([synthetic_task()]), encoding="utf-8")
            exit_code = MODULE.main(
                [
                    "--input-json",
                    str(input_path),
                    "--output-dir",
                    str(output_dir),
                    "--task-id",
                    "7",
                    "--prefix",
                    "floorplan",
                ]
            )
            self.assertEqual(exit_code, 0)
            ET.parse(output_dir / "floorplan-multilevel.graphml")
            manifest = json.loads(
                (output_dir / "floorplan-group-manifest.json").read_text(encoding="utf-8")
            )
            report = json.loads(
                (output_dir / "floorplan-multilevel-report.json").read_text(encoding="utf-8")
            )
            self.assertEqual(len(manifest["groups"]), 2)
            self.assertEqual(report["status"], "ok")


if __name__ == "__main__":
    unittest.main()
