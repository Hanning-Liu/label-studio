import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "room_layout_predictions.py"
SPEC = importlib.util.spec_from_file_location("room_layout_predictions", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


ROOM_RECT = {
    "id": "room-a",
    "from_name": "label",
    "to_name": "image",
    "type": "rectanglelabels",
    "original_width": 100,
    "original_height": 100,
    "image_rotation": 0,
    "value": {
        "x": 0,
        "y": 0,
        "width": 50,
        "height": 100,
        "rotation": 0,
        "rectanglelabels": ["Room A"],
    },
}

ROOM_POLYGON = {
    "id": "room-b",
    "from_name": "polygon_label",
    "to_name": "image",
    "type": "polygonlabels",
    "original_width": 100,
    "original_height": 100,
    "image_rotation": 0,
    "value": {
        "points": [[50, 0], [100, 0], [100, 100], [50, 100]],
        "closed": True,
        "polygonlabels": ["Room B"],
    },
}

OPENING = {
    "id": "opening-1",
    "from_name": "opening_label",
    "to_name": "image",
    "type": "vectorlabels",
    "original_width": 100,
    "original_height": 100,
    "image_rotation": 0,
    "value": {
        "vertices": [{"x": 50, "y": 40}, {"x": 50, "y": 60}],
        "closed": False,
        "vectorlabels": ["Door"],
    },
}


def graphml(*, edge_id="opening-1"):
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  <key id="room_type" for="node" attr.name="room_type" attr.type="string"/>
  <key id="opening_type" for="edge" attr.name="opening_type" attr.type="string"/>
  <key id="walkable" for="edge" attr.name="walkable" attr.type="boolean"/>
  <graph id="G" edgedefault="undirected">
    <node id="room-a"><data key="room_type">Room A</data></node>
    <node id="room-b"><data key="room_type">Room B</data></node>
    <edge id="{edge_id}" source="room-a" target="room-b">
      <data key="opening_type">Door</data>
      <data key="walkable">true</data>
    </edge>
  </graph>
</graphml>
'''


class ConversionTests(unittest.TestCase):
    def setUp(self):
        self.task = {
            "id": 7,
            "data": {"image": "/data/local-files/?d=synthetic.png"},
            "annotations": [
                {
                    "id": 9,
                    "updated_at": "2026-08-20T00:00:00Z",
                    "was_cancelled": False,
                    "result": [ROOM_RECT, ROOM_POLYGON, OPENING],
                }
            ],
        }

    def load_graph(self, xml):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "room.graphml")
            path.write_text(xml, encoding="utf-8")
            return MODULE.load_graphml(path)

    def test_converts_all_reference_results_and_graph_metadata(self):
        nodes, edges = self.load_graph(graphml())
        output = MODULE.convert(
            self.task,
            nodes,
            edges,
            room_controls={"label", "polygon_label"},
            opening_controls={"opening_label"},
            model_version="room-layout-reference-v1",
        )

        prediction = output[0]["predictions"][0]
        results = {item["id"]: item for item in prediction["result"]}
        self.assertEqual(set(results), {"room-a", "room-b", "opening-1"})
        self.assertTrue(all(item["readonly"] for item in results.values()))
        self.assertEqual(results["room-a"]["meta"]["room_graph_node"]["room_type"], "Room A")
        self.assertEqual(
            results["opening-1"]["meta"]["room_graph_edge"]["room_ids"],
            ["room-a", "room-b"],
        )
        self.assertTrue(results["opening-1"]["meta"]["room_graph_edge"]["walkable"])
        self.assertEqual(output[0]["meta"]["room_layout_reference"]["room_count"], 2)
        self.assertNotIn("annotations", output[0])

    def test_rejects_graphml_id_mismatch(self):
        nodes, edges = self.load_graph(graphml(edge_id="wrong-opening"))
        with self.assertRaisesRegex(MODULE.ConversionError, "JSON/GraphML ID mismatch"):
            MODULE.convert(
                self.task,
                nodes,
                edges,
                room_controls={"label", "polygon_label"},
                opening_controls={"opening_label"},
                model_version="room-layout-reference-v1",
            )

    def test_rejects_duplicate_selected_result_ids(self):
        nodes, edges = self.load_graph(graphml())
        duplicate_task = json.loads(json.dumps(self.task))
        duplicate_task["annotations"][0]["result"].append(json.loads(json.dumps(ROOM_RECT)))
        with self.assertRaisesRegex(MODULE.ConversionError, "duplicate selected Label Studio result id"):
            MODULE.convert(
                duplicate_task,
                nodes,
                edges,
                room_controls={"label", "polygon_label"},
                opening_controls={"opening_label"},
                model_version="room-layout-reference-v1",
            )

    def test_cli_writes_valid_json(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_json = root / "rooms.json"
            input_graphml = root / "rooms.graphml"
            output_json = root / "predictions.json"
            input_json.write_text(json.dumps([self.task]), encoding="utf-8")
            input_graphml.write_text(graphml(), encoding="utf-8")

            exit_code = MODULE.main(
                [
                    "--input-json",
                    str(input_json),
                    "--input-graphml",
                    str(input_graphml),
                    "--output-json",
                    str(output_json),
                ]
            )

            self.assertEqual(exit_code, 0)
            payload = json.loads(output_json.read_text(encoding="utf-8"))
            self.assertEqual(len(payload[0]["predictions"][0]["result"]), 3)


if __name__ == "__main__":
    unittest.main()
