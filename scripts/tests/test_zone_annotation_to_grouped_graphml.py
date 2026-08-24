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


def connection(result_id, vertices, *, from_name="connection_vector", label_value="Open passage"):
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


def room_config_xml(bedroom_color="#F99", polygon_bedroom_color=None):
    polygon_bedroom_color = polygon_bedroom_color or bedroom_color
    labels = {
        "Bedroom": bedroom_color,
        "Living room": "#389E0D",
        "Hallway": "#AD8B00",
        "Bathroom": "#FFC069",
    }
    polygon_labels = {**labels, "Bedroom": polygon_bedroom_color}

    def controls(name, tag, colors):
        values = "".join(
            f'<Label value="{label}" background="{color}"/>'
            for label, color in colors.items()
        )
        return f'<{tag} name="{name}" toName="image">{values}</{tag}>'

    return (
        "<View>"
        + controls("label", "RectangleLabels", labels)
        + controls("polygon_label", "PolygonLabels", polygon_labels)
        + "</View>"
    )


def zone_config_xml(sleeping_color="#EF9A9A"):
    return f"""<View><Labels name="function_zone" toName="image">
      <Label value="Sleeping" background="{sleeping_color}"/>
      <Label value="Study/work" background="#9575CD"/>
      <Label value="Living/social" background="#66BB6A"/>
      <Label value="Dining" background="#64B5F6"/>
    </Labels></View>"""


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
                "connection_vectors": 2,
                "visual_connection_vectors": 0,
                "direct_boundary_edges": 2,
                "visual_boundary_edges": 0,
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

    def test_visual_only_edge_is_counted_and_has_no_movement_aliases(self):
        task = synthetic_task()
        result = task["annotations"][0]["result"]
        movement = next(item for item in result if item.get("id") == "connection-a")
        movement["from_name"] = "visual_connection_vector"
        movement["value"]["vectorlabels"] = ["Visual only"]
        converted = MODULE.convert(task, prefix="floorplan")
        self.assertEqual(converted.report["counts"]["connection_vectors"], 1)
        self.assertEqual(converted.report["counts"]["visual_connection_vectors"], 1)
        self.assertEqual(converted.report["counts"]["direct_boundary_edges"], 1)
        self.assertEqual(converted.report["counts"]["visual_boundary_edges"], 1)
        visual = next(
            edge for edge in converted.report["internal_edges"]
            if edge["edge_kind"] == "visual_boundary"
        )
        self.assertEqual(visual["movement_length_px"], 0.0)
        self.assertGreater(visual["visual_length_px"], 0.0)
        self.assertNotIn("opening_length_px", visual)
        self.assertIn(visual["edge_result_id"], converted.manifest["groups"][0]["visual_boundary_edges"])

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

    def test_loads_xml_and_project_json_palettes_and_writes_colors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            room_path = root / "room-project.json"
            zone_path = root / "zone.xml"
            room_path.write_text(
                json.dumps({"id": 5, "label_config": room_config_xml()}),
                encoding="utf-8",
            )
            zone_path.write_text(zone_config_xml(), encoding="utf-8")
            palette = MODULE.load_label_palette(room_path, zone_path)

            self.assertEqual(palette.room_labels["Bedroom"], "#FF9999")
            self.assertEqual(palette.zone_labels["Sleeping"], "#EF9A9A")
            self.assertEqual(len(palette.room_config_sha256), 64)
            converted = MODULE.convert(synthetic_task(), label_palette=palette)
            self.assertEqual(
                converted.manifest["label_palette"]["room_labels"]["Bedroom"],
                "#FF9999",
            )
            bedroom_group = next(
                group for group in converted.manifest["groups"]
                if group["parent_room_id"] == "room-a"
            )
            self.assertEqual(
                bedroom_group["parent_node_attributes"]["label_studio_color"],
                "#FF9999",
            )
            graphml = ET.tostring(converted.graphml.getroot(), encoding="unicode")
            self.assertIn("label_studio_color", graphml)
            self.assertIn("#EF9A9A", graphml)
            self.assertTrue(converted.report["validation"]["label_palette_complete"])

    def test_rejects_room_control_color_conflicts_and_invalid_colors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            room_path = root / "room.xml"
            zone_path = root / "zone.xml"
            zone_path.write_text(zone_config_xml(), encoding="utf-8")
            room_path.write_text(
                room_config_xml("#FFA39E", "#000000"), encoding="utf-8"
            )
            with self.assertRaisesRegex(MODULE.base.ConversionError, "inconsistent colors"):
                MODULE.load_label_palette(room_path, zone_path)

            room_path.write_text(room_config_xml(), encoding="utf-8")
            zone_path.write_text(zone_config_xml("red"), encoding="utf-8")
            with self.assertRaisesRegex(MODULE.base.ConversionError, "unsupported color"):
                MODULE.load_label_palette(room_path, zone_path)

    def test_rejects_palette_missing_a_used_label(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            room_path = root / "room.xml"
            zone_path = root / "zone.xml"
            room_path.write_text(room_config_xml(), encoding="utf-8")
            zone_path.write_text(
                zone_config_xml().replace(
                    '<Label value="Dining" background="#64B5F6"/>', ""
                ),
                encoding="utf-8",
            )
            palette = MODULE.load_label_palette(room_path, zone_path)
            with self.assertRaisesRegex(MODULE.base.ConversionError, "zone labels: Dining"):
                MODULE.convert(synthetic_task(), label_palette=palette)

    def test_cli_requires_both_palette_inputs_and_keeps_paths_private(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "task.json"
            room_path = root / "room.xml"
            zone_path = root / "zone.xml"
            output_dir = root / "out"
            input_path.write_text(json.dumps([synthetic_task()]), encoding="utf-8")
            room_path.write_text(room_config_xml(), encoding="utf-8")
            zone_path.write_text(zone_config_xml(), encoding="utf-8")

            missing_pair = MODULE.main(
                [
                    "--input-json", str(input_path),
                    "--output-dir", str(output_dir),
                    "--room-label-config", str(room_path),
                ]
            )
            self.assertEqual(missing_pair, 2)

            exit_code = MODULE.main(
                [
                    "--input-json", str(input_path),
                    "--output-dir", str(output_dir),
                    "--room-label-config", str(room_path),
                    "--zone-label-config", str(zone_path),
                    "--overwrite",
                ]
            )
            self.assertEqual(exit_code, 0)
            manifest = json.loads(
                (output_dir / "floorplan-group-manifest.json").read_text(encoding="utf-8")
            )
            report = json.loads(
                (output_dir / "floorplan-multilevel-report.json").read_text(encoding="utf-8")
            )
            self.assertNotIn(str(room_path), json.dumps(manifest))
            self.assertNotIn(str(room_path), json.dumps(report))
            self.assertEqual(manifest["label_palette"]["source"], "label_studio")


if __name__ == "__main__":
    unittest.main()
