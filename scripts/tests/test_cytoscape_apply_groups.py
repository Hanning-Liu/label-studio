import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "cytoscape_apply_groups.py"
SPEC = importlib.util.spec_from_file_location("cytoscape_apply_groups", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def manifest():
    return {
        "schema_version": 1,
        "network_name": "floorplan-multilevel",
        "expected_counts": {"total_data_nodes": 6, "total_edges": 5},
        "groups": [
            {
                "group_name": "Bedroom · room-a",
                "group_canonical_id": "room::room-a",
                "parent_room_id": "room-a",
                "parent_node_attributes": {
                    "name": "room::room-a",
                    "canonical_id": "room::room-a",
                    "display_name": "Bedroom · room-a",
                    "node_kind": "room_group",
                    "hierarchy_level": "room",
                    "room_result_id": "room-a",
                },
                "member_canonical_ids": ["zone::zone-a1", "zone::zone-a2"],
                "expected_internal_edge_ids": ["connection-a"],
                "expected_external_opening_ids": ["opening-ab"],
            },
            {
                "group_name": "Living room · room-b",
                "group_canonical_id": "room::room-b",
                "parent_room_id": "room-b",
                "parent_node_attributes": {
                    "name": "room::room-b",
                    "canonical_id": "room::room-b",
                    "display_name": "Living room · room-b",
                    "node_kind": "room_group",
                    "hierarchy_level": "room",
                    "room_result_id": "room-b",
                },
                "member_canonical_ids": ["zone::zone-b1", "zone::zone-b2"],
                "expected_internal_edge_ids": ["connection-b"],
                "expected_external_opening_ids": ["opening-ab", "opening-bc"],
            },
        ],
    }


class FakeClient:
    base_url = "http://127.0.0.1:1234/v1"

    def __init__(self, session_path, collision=False, compound=True):
        self.session_path = session_path
        self.collision = collision
        self.compound = compound
        self.imported = False
        self.created = []
        self.attributes = {}
        self.collapsed = []
        self.deleted = []
        self.styles = {}
        self.style_dependencies = {}
        self.applied_style = None
        self.visual_bypasses = []
        self.renamed = []
        self.imported_network_name = "floorplan-multilevel (1)"

    def version(self):
        return {"cytoscapeVersion": "3.10.4"}

    def command_namespace(self, namespace):
        return "create collapse expand get list"

    def network_suids(self):
        values = {99} if self.collision and 99 not in self.deleted else set()
        if self.imported and 101 not in self.deleted:
            values.add(101)
        return values

    def network_name(self, network_suid):
        if network_suid == 99:
            return "floorplan-multilevel"
        return self.imported_network_name

    def delete_network(self, network_suid):
        self.deleted.append(network_suid)

    def rename_network(self, network_suid, name):
        self.renamed.append((network_suid, name))
        self.imported_network_name = name

    def import_graphml(self, graphml_path, before):
        self.imported = True
        return 101

    def network_payload(self, network_suid):
        nodes = [
            (1, "zone::zone-a1", "Entry/transition", "functional_zone"),
            (2, "zone::zone-a2", "Sleeping", "functional_zone"),
            (3, "zone::zone-b1", "Living/social", "functional_zone"),
            (4, "zone::zone-b2", "Balcony/leisure", "functional_zone"),
            (5, "room::room-c", "Bathroom · room-c", "room"),
            (6, "room::room-d", "Entryway · room-d", "room"),
        ]
        edges = [
            {
                "SUID": 11,
                "edge_kind": "direct_boundary",
                "name": "connection-a",
            },
            {
                "SUID": 12,
                "edge_kind": "direct_boundary",
                "name": "connection-b",
            },
            {
                "SUID": 13,
                "edge_kind": "zone_external_opening",
                "opening_result_id": "opening-ab",
            },
            {
                "SUID": 14,
                "edge_kind": "zone_external_opening",
                "opening_result_id": "opening-bc",
            },
            {"SUID": 15, "edge_kind": "room_opening", "opening_result_id": "opening-cd"},
        ]
        node_payloads = [
            {
                "data": {
                    "SUID": suid,
                    "canonical_id": canonical_id,
                    "display_name": display_name,
                    "node_kind": node_kind,
                }
            }
            for suid, canonical_id, display_name, node_kind in nodes
        ]
        if self.compound:
            node_payloads.extend(
                {"data": {"SUID": suid, "canonical_id": f"pending::{suid}"}}
                for suid, _group_name, _members in self.created
            )
        return {
            "data": {"name": "floorplan-multilevel"},
            "elements": {
                "nodes": node_payloads,
                "edges": [{"data": edge} for edge in edges],
            },
        }

    def create_group(self, network_suid, group_name, member_canonical_ids):
        suid = 201 + len(self.created)
        self.created.append((suid, group_name, member_canonical_ids))
        return suid

    def set_group_attributes(self, network_suid, group_suid, attributes):
        self.attributes[group_suid] = attributes

    def set_node_rows(self, network_suid, rows):
        for row in rows:
            suid = row["SUID"]
            self.attributes.setdefault(suid, {}).update(
                {key: value for key, value in row.items() if key != "SUID"}
            )

    def group_info(self, network_suid, group_suid):
        index = group_suid - 201
        if index == 0:
            nodes, internal, external = [1, 2], [11], [13]
        else:
            nodes, internal, external = [3, 4], [12], [13, 14]
        return {
            "data": {
                "group": group_suid,
                "nodes": nodes,
                "internalEdges": internal,
                "externalEdges": external,
                "collapsed": group_suid in self.collapsed,
            }
        }

    def collapse_group(self, network_suid, group_suid):
        self.collapsed.append(group_suid)

    def expand_group(self, network_suid, group_suid):
        if group_suid in self.collapsed:
            self.collapsed.remove(group_suid)

    def node_row(self, network_suid, node_suid):
        return self.attributes[node_suid]

    def list_groups(self, network_suid):
        return {"groups": [value[0] for value in self.created]}

    def save_session(self, path):
        path.write_bytes(b"synthetic session")

    def style_names(self):
        return list(self.styles)

    def visual_style(self, name):
        return self.styles[name]

    def create_visual_style(self, style):
        payload = json.loads(json.dumps(style))
        self.styles[payload["title"]] = payload
        self.style_dependencies[payload["title"]] = [
            {
                "visualPropertyDependency": "nodeSizeLocked",
                "enabled": True,
            }
        ]
        return payload["title"]

    def delete_visual_style(self, name):
        self.styles.pop(name, None)
        self.style_dependencies.pop(name, None)

    def update_visual_style_defaults(self, name, defaults):
        self.styles[name]["defaults"] = json.loads(json.dumps(defaults))

    def visual_style_dependencies(self, name):
        return self.style_dependencies[name]

    def update_visual_style_dependencies(self, name, dependencies):
        values = {
            value["visualPropertyDependency"]: value["enabled"]
            for value in self.style_dependencies[name]
        }
        values.update(
            {
                value["visualPropertyDependency"]: value["enabled"]
                for value in dependencies
            }
        )
        self.style_dependencies[name] = [
            {"visualPropertyDependency": key, "enabled": value}
            for key, value in values.items()
        ]

    def apply_visual_style(self, name, network_suid):
        self.applied_style = (name, network_suid)

    def network_view_suids(self, network_suid):
        return [301]

    def node_visual_properties(self, network_suid, view_suid, node_suid):
        return {
            "COMPOUND_NODE_PADDING": 24.0,
            "COMPOUND_NODE_SHAPE": "ROUND_RECTANGLE",
            "NODE_FILL_COLOR": "#8B5CF6",
            "NODE_TRANSPARENCY": 31,
            "NODE_BORDER_PAINT": "#6D28D9",
            "NODE_BORDER_WIDTH": 3.0,
            "NODE_BORDER_STROKE": "LONG_DASH",
            "NODE_BORDER_TRANSPARENCY": 255,
            "NODE_LABEL": self.attributes[node_suid]["display_name"],
            "NODE_LABEL_TRANSPARENCY": 255,
            "NODE_SHAPE": "ROUND_RECTANGLE",
            "NODE_WIDTH": self.attributes[node_suid]["display_width"],
            "NODE_HEIGHT": self.attributes[node_suid]["display_height"],
        }

    def set_node_visual_property_bypass(
        self, network_suid, view_suid, node_suid, visual_property, value
    ):
        self.visual_bypasses.append(
            (network_suid, view_suid, node_suid, visual_property, value)
        )


class CytoscapeApplyGroupsTests(unittest.TestCase):
    def test_applies_all_groups_and_saves_session(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            graphml = root / "floorplan-multilevel.graphml"
            graphml.write_text("<graphml/>", encoding="utf-8")
            session = root / "floorplan-multilevel.cys"
            client = FakeClient(session)
            style = MODULE.load_visual_style(MODULE.DEFAULT_VISUAL_STYLE)
            report = MODULE.apply_groups(
                client, graphml, manifest(), session, visual_style=style
            )
            self.assertEqual(report["imported_counts"], {"nodes": 6, "edges": 5})
            self.assertEqual(len(report["groups"]), 2)
            self.assertEqual(client.collapsed, [201, 202])
            self.assertEqual(client.attributes[201]["canonical_id"], "room::room-a")
            self.assertEqual(
                client.attributes[201]["display_name"],
                "Bedroom · room-a ⊞ 2 zones",
            )
            self.assertTrue(client.attributes[201]["is_expandable_group"])
            self.assertNotIn("name", client.attributes[201])
            self.assertEqual(
                report["groups"][0]["verified_external_opening_ids"], ["opening-ab"]
            )
            self.assertEqual(
                report["visual_style"],
                {"title": "Floorplan Multilevel Groups v1", "action": "created"},
            )
            self.assertTrue(report["compound_group_view_verified"])
            self.assertEqual(
                report["adaptive_node_sizing"],
                {
                    "label_column": "display_name",
                    "width_column": "display_width",
                    "height_column": "display_height",
                    "data_node_count": 6,
                    "group_node_count": 2,
                },
            )
            self.assertGreater(client.attributes[5]["display_width"], 100)
            self.assertGreater(
                client.attributes[201]["display_width"],
                client.attributes[5]["display_width"],
            )
            self.assertEqual(report["preexisting_visual_container_node_count"], 0)
            self.assertEqual(client.renamed, [(101, "floorplan-multilevel")])
            self.assertIn(
                (101, 301, 201, "NODE_TRANSPARENCY", 31),
                client.visual_bypasses,
            )
            self.assertTrue(session.exists())

    def test_refuses_existing_network_without_replace_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            graphml = root / "floorplan-multilevel.graphml"
            graphml.write_text("<graphml/>", encoding="utf-8")
            client = FakeClient(root / "out.cys", collision=True)
            with self.assertRaisesRegex(MODULE.CytoscapeError, "already exists"):
                MODULE.apply_groups(client, graphml, manifest(), root / "out.cys")

    def test_replace_existing_deletes_only_colliding_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            graphml = root / "floorplan-multilevel.graphml"
            graphml.write_text("<graphml/>", encoding="utf-8")
            client = FakeClient(root / "out.cys", collision=True)
            MODULE.apply_groups(
                client,
                graphml,
                manifest(),
                root / "out.cys",
                replace_existing=True,
            )
            self.assertEqual(client.deleted, [99])

    def test_requires_compound_group_preference_and_preserves_collision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            graphml = root / "floorplan-multilevel.graphml"
            graphml.write_text("<graphml/>", encoding="utf-8")
            client = FakeClient(root / "out.cys", collision=True, compound=False)
            with self.assertRaisesRegex(MODULE.CytoscapeError, "Group Preferences"):
                MODULE.apply_groups(
                    client,
                    graphml,
                    manifest(),
                    root / "out.cys",
                    replace_existing=True,
                )
            self.assertIn(101, client.deleted)
            self.assertNotIn(99, client.deleted)

    def test_visual_style_reuse_conflict_and_explicit_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            client = FakeClient(Path(directory) / "out.cys")
            style = MODULE.load_visual_style(MODULE.DEFAULT_VISUAL_STYLE)
            created = MODULE.ensure_visual_style(client, style)
            self.assertEqual(created["action"], "created")
            reused = MODULE.ensure_visual_style(client, style)
            self.assertEqual(reused["action"], "reused")
            client.styles[style["title"]]["defaults"][0]["value"] = 9.0
            with self.assertRaisesRegex(MODULE.CytoscapeError, "--replace-style"):
                MODULE.ensure_visual_style(client, style)
            replaced = MODULE.ensure_visual_style(client, style, replace_style=True)
            self.assertEqual(replaced["action"], "replaced")

    def test_manifest_requires_at_least_two_members(self):
        payload = manifest()
        payload["groups"][0]["member_canonical_ids"] = ["zone::only"]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(MODULE.CytoscapeError, "at least two members"):
                MODULE.load_manifest(path)

    def test_label_dimensions_expand_for_long_wide_and_multiline_text(self):
        short = MODULE._label_dimensions("Room", "room")
        long = MODULE._label_dimensions("A much longer room name", "room")
        wide = MODULE._label_dimensions("卧室分区", "functional_zone")
        multiline = MODULE._label_dimensions("First line\nSecond line", "room")
        self.assertGreater(long["display_width"], short["display_width"])
        self.assertGreater(wide["display_width"], short["display_width"])
        self.assertGreater(multiline["display_height"], short["display_height"])

    def test_visual_style_uses_numeric_passthrough_node_dimensions(self):
        style = MODULE.load_visual_style(MODULE.DEFAULT_VISUAL_STYLE)
        mappings = {
            value["visualProperty"]: value for value in style["mappings"]
        }
        self.assertEqual(mappings["NODE_WIDTH"]["mappingType"], "passthrough")
        self.assertEqual(mappings["NODE_WIDTH"]["mappingColumn"], "display_width")
        self.assertEqual(mappings["NODE_HEIGHT"]["mappingType"], "passthrough")
        self.assertEqual(mappings["NODE_HEIGHT"]["mappingColumn"], "display_height")
        self.assertEqual(
            style["dependencies"],
            [{"visualPropertyDependency": "nodeSizeLocked", "enabled": False}],
        )


if __name__ == "__main__":
    unittest.main()
