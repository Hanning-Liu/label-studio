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

    def __init__(self, session_path, collision=False):
        self.session_path = session_path
        self.collision = collision
        self.created = []
        self.attributes = {}
        self.collapsed = []
        self.deleted = []

    def version(self):
        return {"cytoscapeVersion": "3.10.4"}

    def command_namespace(self, namespace):
        return "create collapse get list"

    def network_suids(self):
        return {99} if self.collision else set()

    def network_name(self, network_suid):
        return "floorplan-multilevel"

    def delete_network(self, network_suid):
        self.deleted.append(network_suid)

    def import_graphml(self, graphml_path, before):
        return 101

    def network_payload(self, network_suid):
        nodes = [
            (1, "zone::zone-a1"),
            (2, "zone::zone-a2"),
            (3, "zone::zone-b1"),
            (4, "zone::zone-b2"),
            (5, "room::room-c"),
            (6, "room::room-d"),
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
        return {
            "data": {"name": "floorplan-multilevel"},
            "elements": {
                "nodes": [
                    {"data": {"SUID": suid, "canonical_id": canonical_id}}
                    for suid, canonical_id in nodes
                ],
                "edges": [{"data": edge} for edge in edges],
            },
        }

    def create_group(self, network_suid, group_name, member_canonical_ids):
        suid = 201 + len(self.created)
        self.created.append((suid, group_name, member_canonical_ids))
        return suid

    def set_group_attributes(self, network_suid, group_suid, attributes):
        self.attributes[group_suid] = attributes

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

    def node_row(self, network_suid, node_suid):
        return self.attributes[node_suid]

    def list_groups(self, network_suid):
        return {"groups": [value[0] for value in self.created]}

    def save_session(self, path):
        path.write_bytes(b"synthetic session")


class CytoscapeApplyGroupsTests(unittest.TestCase):
    def test_applies_all_groups_and_saves_session(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            graphml = root / "floorplan-multilevel.graphml"
            graphml.write_text("<graphml/>", encoding="utf-8")
            session = root / "floorplan-multilevel.cys"
            client = FakeClient(session)
            report = MODULE.apply_groups(client, graphml, manifest(), session)
            self.assertEqual(report["imported_counts"], {"nodes": 6, "edges": 5})
            self.assertEqual(len(report["groups"]), 2)
            self.assertEqual(client.collapsed, [201, 202])
            self.assertEqual(client.attributes[201]["canonical_id"], "room::room-a")
            self.assertNotIn("name", client.attributes[201])
            self.assertEqual(
                report["groups"][0]["verified_external_opening_ids"], ["opening-ab"]
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

    def test_manifest_requires_at_least_two_members(self):
        payload = manifest()
        payload["groups"][0]["member_canonical_ids"] = ["zone::only"]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(MODULE.CytoscapeError, "at least two members"):
                MODULE.load_manifest(path)


if __name__ == "__main__":
    unittest.main()
