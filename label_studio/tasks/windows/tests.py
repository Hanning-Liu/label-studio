import copy
import importlib.util
import json
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from django.test import SimpleTestCase, TransactionTestCase
from jsonschema import validate as jsonschema_validate
from rest_framework.test import APIClient
from shapely.geometry import MultiPolygon, Polygon

from organizations.models import Organization
from projects.models import Project
from tasks.models import Annotation, AnnotationDraft, Prediction, Task
from tasks.reference_sync.models import ReferenceSyncBinding, ReferenceSyncMapping
from users.models import User

from .aggregate import augment_floorplan_aggregate
from .config import parse_window_config
from .downstream import (
    DownstreamWindowError,
    authoritative_window_domain,
    prepare_downstream_window_results,
    validate_persisted_projection_state,
)
from .geometry import attach_parent, boundary_attachment, fingerprint, geometry_digest, parse_room, parse_window
from .pairing import derive_window_connections, pair_candidate
from .projections import derive_window_projections, projection_is_stale
from .service import WindowValidationError, prepare_formal_results


CONFIG = '''<View>
<Image name="image" value="$image" roomWindowV1="true"
 roomV3Controls="room_rectangle,room_polygon" windowControls="window_vector"
 windowBoundaryMatchTolerancePx="2" windowPairSearchLimitPx="40"
 windowMinimumProjectedOverlapPx="8" windowMaximumTangentDeltaDeg="10"
 windowFlatteningTolerancePx="0.5" windowInwardProjectionLimitPx="60"/>
<RectangleLabels name="room_rectangle" toName="image"><Label value="Room"/></RectangleLabels>
<PolygonLabels name="room_polygon" toName="image"><Label value="Room"/></PolygonLabels>
<VectorLabels name="window_vector" toName="image" closable="false" curves="true" minPoints="2"><Label value="Window"/></VectorLabels>
</View>'''

DOWNSTREAM_CONFIG = CONFIG.replace(
    "</View>",
    '''<Rectangle name="zone_rectangle" toName="image"/>
<Polygon name="zone_polygon" toName="image"/>
<Labels name="function_zone" toName="image"><Label value="Zone"/></Labels>
<Rectangle name="occupancy_rectangle" toName="image"/>
<Polygon name="occupancy_polygon" toName="image"/>
<Labels name="occupancy_type" toName="image"><Label value="furniture_group"/></Labels>
</View>''',
)


def room(identifier, x, width, *, image_width=1000, image_height=1000):
    return {
        "id": identifier,
        "from_name": "room_rectangle",
        "to_name": "image",
        "type": "rectanglelabels",
        "original_width": image_width,
        "original_height": image_height,
        "image_rotation": 0,
        "value": {"x": x, "y": 0, "width": width, "height": 100, "rotation": 0, "rectanglelabels": ["Room"]},
        "meta": {"room_graph_node": {"schema_version": 3, "node_id": identifier, "room_type": "Room", "geometry_type": "rectangle"}},
    }


def vertex(identifier, x, y, previous=None, *, bezier=False, cp1=None, cp2=None):
    output = {"id": identifier, "x": x, "y": y, "isBezier": bezier}
    if previous:
        output["prevPointId"] = previous
    if cp1 is not None:
        output["controlPoint1"] = {"x": cp1[0], "y": cp1[1]}
    if cp2 is not None:
        output["controlPoint2"] = {"x": cp2[0], "y": cp2[1]}
    return output


def window(identifier, x, ys=(20, 40), *, vertices=None, image_width=1000, image_height=1000):
    vertices = vertices or [
        vertex(f"{identifier}:1", x, ys[0]),
        vertex(f"{identifier}:2", x, ys[1], f"{identifier}:1"),
    ]
    return {
        "id": identifier,
        "from_name": "window_vector",
        "to_name": "image",
        "type": "vectorlabels",
        "original_width": image_width,
        "original_height": image_height,
        "image_rotation": 0,
        "value": {"closed": False, "vectorlabels": ["Window"], "vertices": vertices},
    }


class WindowDomainTests(SimpleTestCase):
    def setUp(self):
        self.config = parse_window_config(CONFIG)

    def prepared_pair(self):
        results = [room("left", 0, 48), room("right", 52, 48), window("left-window", 48), window("right-window", 52)]
        _, changes = prepare_formal_results(CONFIG, results)
        return changes["window_traces"], changes["window_connections"]

    def test_fingerprint_matches_javascript_fixed_decimal_fixture(self):
        # Expected value was generated with the editor's canonical()+SHA-256.
        self.assertEqual(
            fingerprint({"x": 1, "n": -0.0, "nested": [2.5, True, None]}),
            "1290fe796bb5ed7df51a0dbd319b24e0e2c1e4f0d31f43a311ecbdd57733a6e6",
        )

    def test_line_polyline_and_bezier_preserve_raw_geometry(self):
        polyline = window("poly", 48, vertices=[
            vertex("p1", 48, 20), vertex("p2", 48, 30, "p1"), vertex("p3", 48, 40, "p2"),
        ])
        bezier = window("curve", 48, vertices=[
            vertex("b1", 48, 20, bezier=True, cp1=(48, 20), cp2=(48, 26)),
            vertex("b2", 48, 40, "b1", bezier=True, cp1=(48, 34), cp2=(48, 40)),
        ])
        results = [room("left", 0, 48), window("line", 48), polyline, bezier]
        before = copy.deepcopy(results)
        refreshed, changes = prepare_formal_results(CONFIG, results)
        self.assertEqual(geometry_digest(before), geometry_digest(refreshed))
        self.assertEqual({trace.path_kind for trace in changes["window_traces"]}, {"bezier", "line", "polyline"})
        self.assertEqual(bezier["value"]["vertices"], before[-1]["value"]["vertices"])

    def test_bezier_requires_both_original_control_points(self):
        invalid = window("curve", 48, vertices=[
            vertex("b1", 48, 20, bezier=True, cp1=(48, 20), cp2=(48, 26)),
            vertex("b2", 48, 40, "b1", bezier=True, cp1=(48, 34)),
        ])
        with self.assertRaisesRegex(WindowValidationError, "controlPoint1 和 controlPoint2"):
            prepare_formal_results(CONFIG, [room("left", 0, 48), invalid])

    def test_vertices_and_all_supplied_control_points_stay_in_percentage_bounds(self):
        invalid_vertex = window("outside", 48)
        invalid_vertex["value"]["vertices"][1]["y"] = 100.01
        with self.assertRaisesRegex(WindowValidationError, "0 和 100"):
            prepare_formal_results(CONFIG, [room("left", 0, 48), invalid_vertex])

        legacy_handle = window("legacy-handle", 48)
        legacy_handle["value"]["vertices"][0]["controlPoint1"] = {"x": -0.01, "y": 20}
        with self.assertRaisesRegex(WindowValidationError, "0 和 100"):
            prepare_formal_results(CONFIG, [room("left", 0, 48), legacy_handle])

    def test_window_control_rejects_non_vector_result_type(self):
        invalid = window("wrong-type", 48)
        invalid["type"] = "polygonlabels"
        with self.assertRaisesRegex(WindowValidationError, "type=vectorlabels"):
            prepare_formal_results(CONFIG, [room("left", 0, 48), invalid])

    def test_unique_parent_no_parent_and_ambiguous_parent(self):
        refreshed, _ = prepare_formal_results(CONFIG, [room("left", 0, 48), window("w", 48)])
        self.assertEqual(refreshed[-1]["meta"]["window_context"]["parent_room_id"], "left")
        with self.assertRaises(WindowValidationError) as missing:
            prepare_formal_results(CONFIG, [room("left", 0, 48), window("w", 47)])
        self.assertEqual(missing.exception.issues[0]["code"], "window_parent_room_not_found")
        self.assertEqual(missing.exception.issues[0]["result_id"], "w")
        self.assertEqual(len(missing.exception.issues[0]["bbox"]), 4)
        with self.assertRaises(WindowValidationError) as ambiguous:
            prepare_formal_results(CONFIG, [room("left", 0, 50), room("right", 50, 50), window("w", 50)])
        self.assertEqual(ambiguous.exception.issues[0]["code"], "window_parent_room_ambiguous")
        self.assertEqual(ambiguous.exception.issues[0]["room_ids"], ["left", "right"])

    def test_parent_identity_prefers_room_graph_node_id(self):
        semantic_room = room("ls-region-17", 0, 48)
        semantic_room["meta"]["room_graph_node"]["node_id"] = "room-semantic-17"
        parsed = parse_room(semantic_room)
        self.assertEqual(parsed.result_id, "room-semantic-17")
        refreshed, _ = prepare_formal_results(CONFIG, [semantic_room, window("w", 48)])
        context = refreshed[-1]["meta"]["window_context"]
        self.assertEqual(context["parent_room_id"], "room-semantic-17")
        self.assertTrue(all("room-semantic-17" in item for item in context["boundary_attachment"]["room_boundary_segment_ids"]))

    def test_parent_and_pairing_are_isolated_by_item_surface(self):
        overlapping_room_a = room("room-item-a", 0, 48)
        overlapping_room_b = room("room-item-b", 0, 48)
        overlapping_window_a = window("window-item-a", 48)
        overlapping_window_b = window("window-item-b", 48)
        for result in (overlapping_room_a, overlapping_window_a):
            result["item_index"] = 2
        for result in (overlapping_room_b, overlapping_window_b):
            result["item_index"] = 3
        refreshed, changes = prepare_formal_results(
            CONFIG,
            [overlapping_room_a, overlapping_room_b, overlapping_window_a, overlapping_window_b],
        )
        contexts = {
            item["id"]: item["meta"]["window_context"]
            for item in refreshed
            if item.get("from_name") == "window_vector"
        }
        self.assertEqual(contexts["window-item-a"]["parent_room_id"], "room-item-a")
        self.assertEqual(contexts["window-item-b"]["parent_room_id"], "room-item-b")
        self.assertTrue(all(connection["connects_to_exterior"] for connection in changes["window_connections"]))

        left_room, left_window = room("surface-left", 0, 48), window("surface-left-window", 48)
        right_room, right_window = room("surface-right", 52, 48), window("surface-right-window", 52)
        for result in (left_room, left_window):
            result["item_index"] = 10
        for result in (right_room, right_window):
            result["item_index"] = 11
        _, separated = prepare_formal_results(CONFIG, [left_room, right_room, left_window, right_window])
        self.assertEqual(len(separated["window_connections"]), 2)
        self.assertTrue(all(connection["connects_to_exterior"] for connection in separated["window_connections"]))

    def test_partial_boundary_coverage_does_not_count_as_parent(self):
        bent = window("bent", 48, vertices=[
            vertex("v1", 48, 20), vertex("v2", 48, 30, "v1"), vertex("v3", 47, 40, "v2"),
        ])
        with self.assertRaises(WindowValidationError) as raised:
            prepare_formal_results(CONFIG, [room("left", 0, 48), bent])
        self.assertEqual(raised.exception.issues[0]["code"], "window_parent_room_not_found")

    def test_mutual_pair_and_invalid_opposite_candidate(self):
        traces, connections = self.prepared_pair()
        self.assertEqual(len(connections), 1)
        self.assertEqual(connections[0]["connection_kind"], "room_to_room")
        self.assertTrue(connections[0]["evidence"]["mutual_nearest"])
        # Nearby traces whose outward directions do not face one another are not candidates.
        first = traces[0]
        far_room = parse_room(room("far", 30, 20))
        far_trace = parse_window(window("far-window", 50), self.config.flattening_tolerance_px)
        far_trace = attach_parent(far_trace, far_room, boundary_attachment(far_trace, far_room, 2, 10))
        self.assertIsNone(pair_candidate(first, far_trace, self.config))
        second = next(trace for trace in traces if trace.trace_id != first.trace_id)
        self.assertIsNone(pair_candidate(first, replace(second, surface_key=("image", "1")), self.config))

    def test_pair_search_limit_uses_maximum_not_minimum_separation(self):
        traces, _ = self.prepared_pair()
        first = next(trace for trace in traces if trace.result_id == "left-window")
        slanted_room_result = {
            "id": "slanted",
            "from_name": "room_polygon",
            "to_name": "image",
            "type": "polygonlabels",
            "original_width": 1000,
            "original_height": 1000,
            "image_rotation": 0,
            "value": {
                "points": [[49, 0], [100, 0], [100, 100], [64, 100]],
                "polygonlabels": ["Room"],
            },
            "meta": {"room_graph_node": {"schema_version": 3, "node_id": "slanted", "room_type": "Room"}},
        }
        slanted_result = window("slanted-window", 0, vertices=[
            vertex("slanted:1", 52, 20),
            vertex("slanted:2", 55, 40, "slanted:1"),
        ])
        opposite_room = parse_room(slanted_room_result)
        slanted = parse_window(slanted_result, self.config.flattening_tolerance_px)
        attachment = boundary_attachment(slanted, opposite_room, 2, 10)
        self.assertIsNotNone(attachment)
        slanted = attach_parent(slanted, opposite_room, attachment)
        # The nearest endpoints are within 40px, but separation grows beyond
        # 40px along the projected overlap, so this is not a valid candidate.
        self.assertLessEqual(first.line.distance(slanted.line), self.config.pair_search_limit_px)
        self.assertIsNone(pair_candidate(first, slanted, self.config))

    def test_exterior_only_after_complete_search(self):
        _, changes = prepare_formal_results(CONFIG, [room("left", 0, 48), window("outside", 48)])
        connection = changes["window_connections"][0]
        self.assertEqual(connection["connection_kind"], "room_to_exterior")
        self.assertEqual(connection["review_status"], "derived")
        self.assertEqual(connection["evidence"]["candidate_count"], 0)
        pending_connections, searches, _ = derive_window_connections(changes["window_traces"], self.config, search_complete=False)
        self.assertEqual(pending_connections, [])
        self.assertEqual(searches["window-trace:outside"]["status"], "pending")

    def test_l2_l3_l4_projection_and_stale_recompute(self):
        traces, connections = self.prepared_pair()
        trace = next(item for item in traces if item.result_id == "left-window")
        targets = [
            {"level": "L2", "entity_id": "zone", "room_id": "left", "geometry": Polygon([(0, 0), (480, 0), (480, 1000), (0, 1000)])},
            {"level": "L3", "entity_id": "group", "room_id": "left", "geometry": Polygon([(430, 240), (470, 240), (470, 310), (430, 310)])},
            {"level": "L4", "entity_id": "desk", "room_id": "left", "geometry": Polygon([(420, 320), (460, 320), (460, 380), (420, 380)])},
        ]
        projections = derive_window_projections([trace], connections, targets, self.config)
        self.assertEqual({item["target"]["level"] for item in projections}, {"L2", "L3", "L4"})
        l3 = next(item for item in projections if item["target"]["level"] == "L3")
        self.assertFalse(projection_is_stale(l3, trace, targets[1], self.config))
        changed = {**targets[1], "geometry": Polygon([(400, 240), (450, 240), (450, 310), (400, 310)])}
        self.assertTrue(projection_is_stale(l3, trace, changed, self.config))
        recomputed = derive_window_projections([trace], connections, [changed], self.config)
        self.assertEqual(len(recomputed), 1)
        self.assertNotEqual(l3["derivation"]["target_fingerprint"], recomputed[0]["derivation"]["target_fingerprint"])
        changed_room_result = room("left", 0, 48)
        changed_room_result["value"]["height"] = 90
        changed_room = parse_room(changed_room_result)
        raw_trace = parse_window(window("left-window", 48), self.config.flattening_tolerance_px)
        changed_trace = attach_parent(
            raw_trace,
            changed_room,
            boundary_attachment(raw_trace, changed_room, 2, 10),
        )
        # Public projection records intentionally fingerprint the raw window
        # trace. Room freshness is retained by downstream projection state.
        self.assertFalse(projection_is_stale(l3, changed_trace, targets[1], self.config))
        self.assertTrue(
            projection_is_stale(
                l3,
                trace,
                targets[1],
                self.config,
                current_connection_id="window-connection:replacement",
            )
        )

    def test_multipolygon_projection_keeps_disconnected_path_intervals(self):
        traces, connections = self.prepared_pair()
        trace = next(item for item in traces if item.result_id == "left-window")
        target = {
            "level": "L3",
            "entity_id": "two-pieces",
            "room_id": "left",
            "geometry": MultiPolygon([
                Polygon([(430, 210), (470, 210), (470, 250), (430, 250)]),
                Polygon([(430, 350), (470, 350), (470, 390), (430, 390)]),
            ]),
        }
        projection = derive_window_projections([trace], connections, [target], self.config)[0]
        self.assertEqual(len(projection["path_intervals"]), 2)
        self.assertLess(
            projection["path_intervals"][0]["path_parameter_end"],
            projection["path_intervals"][1]["path_parameter_start"],
        )

    def test_v3_adapter_is_deep_equal_and_v4_validates_public_schema(self):
        v3 = {"schema": "floorplan-unified/3", "nested": {"unchanged": [1, 2, 3]}}
        adapted = augment_floorplan_aggregate(v3, traces=[object()])
        self.assertEqual(adapted, v3)
        self.assertIsNot(adapted, v3)
        traces, connections = self.prepared_pair()
        root = Path(__file__).resolve().parents[3]
        example = json.loads((root / "examples/occupancy-schema-foundation/example.json").read_text(encoding="utf-8"))
        schema = json.loads((root / "examples/occupancy-schema-foundation/multilevel-occupancy.schema.json").read_text(encoding="utf-8"))
        output = augment_floorplan_aggregate(
            example,
            traces=traces,
            connections=connections,
            projections=derive_window_projections(
                traces,
                connections,
                [
                    {"level": "L2", "entity_id": "schema-zone", "room_id": "left", "geometry": Polygon([(0, 0), (480, 0), (480, 1000), (0, 1000)])},
                    {"level": "L3", "entity_id": "schema-group", "room_id": "left", "geometry": Polygon([(430, 240), (470, 240), (470, 310), (430, 310)])},
                    {"level": "L4", "entity_id": "schema-item", "room_id": "left", "geometry": Polygon([(420, 320), (460, 320), (460, 380), (420, 380)])},
                ],
                self.config,
            ),
            config=self.config,
            provenance={"project_id": 1, "task_id": 1, "annotation_id": 1},
        )
        jsonschema_validate(output, schema)

    def test_bare_v4_adapter_preserves_existing_window_data_exactly(self):
        base = {
            "schema": "floorplan-unified/4",
            "window_traces": [{"id": "legacy-trace"}],
            "window_connections": [{"id": "legacy-connection"}],
            "window_projections": [{"id": "legacy-projection"}],
            "fingerprint": "do-not-recompute-without-inputs",
        }
        self.assertEqual(augment_floorplan_aggregate(base), base)


class WindowDownstreamAdapterTests(SimpleTestCase):
    def prepared_references(self):
        refreshed, _ = prepare_formal_results(CONFIG, [room("left", 0, 48), window("outside", 48)])
        return refreshed

    @staticmethod
    def zone():
        return {
            "id": "zone-a",
            "from_name": "zone_rectangle",
            "to_name": "image",
            "type": "rectangle",
            "original_width": 1000,
            "original_height": 1000,
            "image_rotation": 0,
            "value": {"x": 0, "y": 10, "width": 48, "height": 40, "rotation": 0},
            "meta": {"partition_context": {"parent_room_id": "left"}},
        }

    @staticmethod
    def occupancy():
        return {
            "id": "occupancy-a",
            "from_name": "occupancy_rectangle",
            "to_name": "image",
            "type": "rectangle",
            "original_width": 1000,
            "original_height": 1000,
            "image_rotation": 0,
            "value": {"x": 43, "y": 25, "width": 4, "height": 10, "rotation": 0},
            "meta": {"occupancy_context": {"group_id": "group-a", "parent_room_id": "left"}},
        }

    def test_formal_l2_and_l3_derive_schema_records_without_geometry_change(self):
        references = self.prepared_references()
        for level, target in (("L2", self.zone()), ("L3", self.occupancy())):
            results = references + [target]
            before = geometry_digest(results)
            refreshed, changed = prepare_downstream_window_results(results, level=level, submission=True)
            self.assertEqual(geometry_digest(refreshed), before)
            self.assertEqual(changed, [target["id"]])
            meta = refreshed[-1]["meta"]
            self.assertEqual(meta["window_projection_state"]["status"], "current")
            self.assertEqual(len(meta["window_projections"]), 1)
            projection = meta["window_projections"][0]
            self.assertTrue(projection["read_only"])
            self.assertEqual(projection["target"]["level"], level)
            self.assertEqual(
                projection["derivation"]["source_window_trace_fingerprint"],
                references[-1]["meta"]["window_context"]["source_window_trace_fingerprint"],
            )
            self.assertTrue(validate_persisted_projection_state(refreshed, level=level))

    def test_draft_preserves_relations_and_marks_target_change_stale(self):
        formal, _ = prepare_downstream_window_results(
            self.prepared_references() + [self.occupancy()],
            level="L3",
            submission=True,
        )
        draft = copy.deepcopy(formal)
        draft[-1]["value"]["x"] = 42
        refreshed, changed = prepare_downstream_window_results(
            draft,
            level="L3",
            submission=False,
            prior_results=formal,
        )
        self.assertEqual(changed, ["occupancy-a"])
        self.assertEqual(refreshed[-1]["meta"]["window_projections"], formal[-1]["meta"]["window_projections"])
        state = refreshed[-1]["meta"]["window_projection_state"]
        self.assertEqual(state["status"], "stale")
        self.assertIn("target_geometry_changed", state["stale_reasons"])

    def test_legacy_without_window_provenance_is_a_strict_noop(self):
        target = self.zone()
        result, changed = prepare_downstream_window_results([target], level="L2", submission=True)
        self.assertEqual(result, [target])
        self.assertEqual(changed, [])
        self.assertTrue(validate_persisted_projection_state([target], level="L2"))

    def test_authoritative_policy_parent_threshold_and_pairing_status_are_strict(self):
        for mutate in (
            lambda context: context["window_matching_policy"].update(pairing_rule="nearest_only"),
            lambda context: context["parent_derivation"].update(boundary_match_tolerance_px=99),
            lambda context: context.update(pairing_status="pending"),
        ):
            references = self.prepared_references()
            mutate(references[-1]["meta"]["window_context"])
            with self.assertRaises(DownstreamWindowError):
                authoritative_window_domain(references)

    def test_offline_migration_uses_the_authoritative_window_validator(self):
        root = Path(__file__).resolve().parents[3]
        script_path = root / "scripts/function_zone_v3_migration.py"
        scripts_path = str(script_path.parent)
        import sys

        sys.path.insert(0, scripts_path)
        try:
            spec = importlib.util.spec_from_file_location("room_window_migration_test", script_path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        finally:
            sys.path.remove(scripts_path)
        references = self.prepared_references()
        module._validate_window_references(references)
        references[-1]["meta"]["window_context"]["pairing_search"]["status"] = "pending"
        with self.assertRaisesRegex(module.RoomV3Error, "pending or incomplete pairing-search"):
            module._validate_window_references(references)

    def test_hidden_downstream_control_still_requires_current_window_context(self):
        from tasks.reference_sync.results import validate_source

        hidden_config = DOWNSTREAM_CONFIG.replace('roomWindowV1="true"', 'roomWindowV1="false"')
        references = self.prepared_references()
        self.assertEqual(len(validate_source(references, hidden_config)), 2)
        references[-1]["meta"]["window_context"]["pairing_search"]["status"] = "pending"
        with self.assertRaises(DownstreamWindowError):
            validate_source(references, hidden_config)

    def test_l3_preserves_upstream_l2_projection_meta_and_reference_hash(self):
        from tasks.occupancy.reference import reference_hash

        l2, _ = prepare_downstream_window_results(
            self.prepared_references() + [self.zone()], level="L2", submission=True
        )
        original_zone = next(result for result in l2 if result.get("from_name") == "zone_rectangle")
        old_meta = copy.deepcopy(original_zone["meta"])
        old_reference_hash = reference_hash(l2)
        l3, _ = prepare_downstream_window_results(
            l2 + [self.occupancy()], level="L3", submission=True
        )
        copied_zone = next(result for result in l3 if result.get("from_name") == "zone_rectangle")
        self.assertEqual(copied_zone["meta"], old_meta)
        self.assertEqual(reference_hash(l3), old_reference_hash)
        occupancy = next(result for result in l3 if result.get("from_name") == "occupancy_rectangle")
        self.assertEqual(occupancy["meta"]["window_projection_state"]["status"], "current")

    def test_server_window_meta_is_excluded_from_manual_hashes(self):
        from tasks.occupancy.reference import manual_hash as occupancy_manual_hash
        from tasks.reference_sync.results import manual_hash as l2_manual_hash

        for target, digest_function in ((self.zone(), l2_manual_hash), (self.occupancy(), occupancy_manual_hash)):
            before = digest_function([target])
            enriched = copy.deepcopy(target)
            enriched["meta"]["window_projections"] = [{"id": "derived"}]
            enriched["meta"]["window_projection_state"] = {"status": "current"}
            self.assertEqual(digest_function([enriched]), before)

    def test_non_target_rows_cannot_inject_server_owned_projection_meta(self):
        results = self.prepared_references() + [self.zone(), {
            "id": "zone-label",
            "from_name": "function_zone",
            "to_name": "image",
            "type": "labels",
            "value": {"labels": ["Zone"]},
            "meta": {
                "window_projections": [{"id": "forged"}],
                "window_projection_state": {"status": "current"},
            },
        }]
        refreshed, changed = prepare_downstream_window_results(results, level="L2", submission=True)
        self.assertIn("zone-label", changed)
        self.assertNotIn("meta", refreshed[-1])


class WindowDownstreamPipelineTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        self.user = User.objects.create(email="window-pipeline@example.invalid")
        self.org = Organization.create_organization(created_by=self.user, title="Window projection pipeline")
        self.user.active_organization = self.org
        self.user.save()

    @staticmethod
    def authoritative_references(ys=(20, 40)):
        refreshed, _ = prepare_formal_results(
            CONFIG,
            [room("left", 0, 48), window("outside", 48, ys=ys)],
        )
        return refreshed

    @staticmethod
    def zone_and_label():
        zone = WindowDownstreamAdapterTests.zone()
        label = {
            "id": zone["id"],
            "from_name": "function_zone",
            "to_name": "image",
            "type": "labels",
            "original_width": 1000,
            "original_height": 1000,
            "image_rotation": 0,
            "value": {**copy.deepcopy(zone["value"]), "labels": ["Zone"]},
        }
        return zone, label

    def l2_pipeline(self):
        from tasks.reference_sync.results import reference_hash

        source_project = Project.objects.create(
            title="Window L1 source", label_config=CONFIG, organization=self.org, created_by=self.user
        )
        target_project = Project.objects.create(
            title="Window L2 target", label_config=DOWNSTREAM_CONFIG, organization=self.org, created_by=self.user
        )
        source_task = Task.objects.create(project=source_project, data={"image": "/window.png"}, overlap=1)
        source = Annotation.objects.create(
            task=source_task,
            project=source_project,
            completed_by=self.user,
            result=self.authoritative_references(),
        )
        target = Task.objects.create(project=target_project, data=copy.deepcopy(source_task.data), overlap=1)
        refs = [{**copy.deepcopy(result), "readonly": True} for result in source.result]
        prediction = Prediction.objects.create(task=target, project=target_project, result=refs)
        mapping = ReferenceSyncMapping.objects.create(
            source_project=source_project, target_project=target_project, enabled=True
        )
        revision = reference_hash(source.result)
        binding = ReferenceSyncBinding.objects.create(
            mapping=mapping,
            source_task_id=source_task.id,
            source_annotation_id=source.id,
            target_task=target,
            prediction_id=prediction.id,
            desired_hash=revision,
            applied_hash=revision,
            status="synced",
        )
        draft = AnnotationDraft.objects.create(
            task=target,
            user=self.user,
            result=refs + [WindowDownstreamAdapterTests.zone()],
        )
        return source, binding, draft

    def l3_pipeline(self):
        from tasks.occupancy.reference import reference_hash

        source_project = Project.objects.create(
            title="Window L2 source", label_config=DOWNSTREAM_CONFIG, organization=self.org, created_by=self.user
        )
        target_project = Project.objects.create(
            title="Window L3 target", label_config=DOWNSTREAM_CONFIG, organization=self.org, created_by=self.user
        )
        zone, label = self.zone_and_label()
        source_results = self.authoritative_references() + [zone, label]
        source_task = Task.objects.create(project=source_project, data={"image": "/window.png"}, overlap=1)
        source = Annotation.objects.create(
            task=source_task,
            project=source_project,
            completed_by=self.user,
            result=source_results,
        )
        target = Task.objects.create(project=target_project, data=copy.deepcopy(source_task.data), overlap=1)
        refs = [{**copy.deepcopy(result), "readonly": True} for result in source_results]
        prediction = Prediction.objects.create(task=target, project=target_project, result=refs)
        mapping = ReferenceSyncMapping.objects.create(
            source_project=source_project,
            target_project=target_project,
            enabled=True,
            sync_type="function_zone_to_occupancy",
            apply_policy="manual",
        )
        revision = reference_hash(source_results)
        binding = ReferenceSyncBinding.objects.create(
            mapping=mapping,
            source_task_id=source_task.id,
            source_annotation_id=source.id,
            target_task=target,
            prediction_id=prediction.id,
            desired_hash=revision,
            applied_hash=revision,
            status="synced",
        )
        occupancy = WindowDownstreamAdapterTests.occupancy()
        occupancy_type = {
            "id": occupancy["id"],
            "from_name": "occupancy_type",
            "to_name": "image",
            "type": "labels",
            "value": {"labels": ["furniture_group"]},
        }
        draft = AnnotationDraft.objects.create(
            task=target,
            user=self.user,
            result=refs + [occupancy, occupancy_type],
        )
        return source, binding, draft

    def test_l2_formal_prepare_write_derives_bounds_zone(self):
        from tasks.reference_sync.results import manual_hash, reference_hash
        from tasks.reference_sync.service import prepare_write

        _, _, draft = self.l2_pipeline()
        payload = {
            "result": copy.deepcopy(draft.result),
            "reference_version": reference_hash(draft.result),
            "base_manual_hash": manual_hash(draft.result),
            "expected_updated_at": draft.updated_at.isoformat(),
        }
        merged, _ = prepare_write(draft.task, payload, draft, submission=True)
        target = next(result for result in merged if result.get("from_name") == "zone_rectangle")
        self.assertEqual(target["meta"]["window_projection_state"]["status"], "current")
        self.assertEqual(target["meta"]["window_projections"][0]["relation"]["kind"], "bounds_zone")

    def test_l3_formal_prepare_write_derives_adjacent_to_window(self):
        from tasks.occupancy.reference import manual_hash, reference_hash
        from tasks.reference_sync.service import prepare_write

        _, _, draft = self.l3_pipeline()
        payload = {
            "result": copy.deepcopy(draft.result),
            "reference_version": reference_hash(draft.result),
            "base_manual_hash": manual_hash(draft.result),
            "expected_updated_at": draft.updated_at.isoformat(),
        }
        with patch("tasks.occupancy.reference.validate", return_value=[]):
            merged, _ = prepare_write(draft.task, payload, draft, submission=True)
        target = next(result for result in merged if result.get("from_name") == "occupancy_rectangle")
        self.assertEqual(target["meta"]["window_projection_state"]["status"], "current")
        self.assertEqual(target["meta"]["window_projections"][0]["relation"]["kind"], "adjacent_to_window")

    def test_l2_worker_marks_projection_stale_without_changing_manual_hash(self):
        from tasks.reference_sync.results import manual_hash
        from tasks.reference_sync.service import process_binding

        source, binding, draft = self.l2_pipeline()
        formal, _ = prepare_downstream_window_results(
            draft.result, level="L2", submission=True, prior_results=draft.result
        )
        draft.result = formal
        draft.save(update_fields=["result", "updated_at"])
        protected = manual_hash(draft.result)
        source.result = self.authoritative_references(ys=(25, 45))
        source.save(update_fields=["result", "updated_at"])
        self.assertTrue(process_binding(binding.id))
        draft.refresh_from_db()
        self.assertEqual(manual_hash(draft.result), protected)
        target = next(result for result in draft.result if result.get("from_name") == "zone_rectangle")
        self.assertEqual(target["meta"]["window_projection_state"]["status"], "stale")
        self.assertIn("source_window_geometry_changed", target["meta"]["window_projection_state"]["stale_reasons"])

    def test_l3_manual_apply_marks_projection_stale_without_changing_manual_hash(self):
        from tasks.occupancy.reference import apply_reference, manual_hash, reference_hash

        source, binding, draft = self.l3_pipeline()
        formal, _ = prepare_downstream_window_results(
            draft.result, level="L3", submission=True, prior_results=draft.result
        )
        draft.result = formal
        draft.save(update_fields=["result", "updated_at"])
        protected = manual_hash(draft.result)
        zone, label = self.zone_and_label()
        source.result = self.authoritative_references(ys=(25, 45)) + [zone, label]
        source.save(update_fields=["result", "updated_at"])
        payload = {
            "reference_version": reference_hash(draft.result),
            "base_manual_hash": manual_hash(draft.result),
            "expected_updated_at": draft.updated_at.isoformat(),
            "source_version": reference_hash(source.result),
        }
        apply_reference(binding, draft, payload, self.user)
        draft.refresh_from_db()
        self.assertEqual(manual_hash(draft.result), protected)
        target = next(result for result in draft.result if result.get("from_name") == "occupancy_rectangle")
        self.assertEqual(target["meta"]["window_projection_state"]["status"], "stale")
        self.assertIn("source_window_geometry_changed", target["meta"]["window_projection_state"]["stale_reasons"])


class WindowFormalSaveAPITests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create(email="window-formal@example.invalid")
        self.org = Organization.create_organization(created_by=self.user, title="Window formal API")
        self.user.active_organization = self.org
        self.user.save()
        self.project = Project.objects.create(
            title="L1 room windows",
            label_config=CONFIG,
            organization=self.org,
            created_by=self.user,
        )
        self.task = Task.objects.create(project=self.project, data={"image": "/test.png"}, overlap=1)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_formal_submit_without_mapping_refreshes_metadata(self):
        results = [room("left", 0, 48), window("outside", 48)]
        response = self.client.post(f"/api/tasks/{self.task.id}/annotations/", {"result": results}, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        saved = self.task.annotations.get()
        context = saved.result[1]["meta"]["window_context"]
        self.assertEqual(context["parent_room_id"], "left")
        self.assertEqual(context["pairing_status"], "exterior")
        self.assertEqual(context["pairing_search"]["status"], "complete")
        self.assertEqual(context["pairing_search"]["candidate_count"], 0)
        self.assertIn("room_graph_node", saved.result[0]["meta"])

    def test_formal_submit_reports_localizable_error_and_does_not_save(self):
        results = [room("left", 0, 48), window("missing", 47)]
        response = self.client.post(f"/api/tasks/{self.task.id}/annotations/", {"result": results}, format="json")
        self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(response.data["display_context"]["reason"], "WINDOW_VALIDATION")
        issue = response.data["display_context"]["issues"][0]
        self.assertEqual(issue["result_id"], "missing")
        self.assertEqual(len(issue["bbox"]), 4)
        self.assertFalse(self.task.annotations.exists())

    def test_formal_submit_rejects_out_of_range_vertex_and_control_point(self):
        invalid = window("outside", 48)
        invalid["value"]["vertices"][0]["controlPoint1"] = {"x": 48, "y": -1}
        response = self.client.post(
            f"/api/tasks/{self.task.id}/annotations/",
            {"result": [room("left", 0, 48), invalid]},
            format="json",
        )
        self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(response.data["display_context"]["reason"], "WINDOW_VALIDATION")
        self.assertEqual(response.data["display_context"]["issues"][0]["result_id"], "outside")
        self.assertIn("0 和 100", response.data["display_context"]["issues"][0]["message"])
        self.assertFalse(self.task.annotations.exists())

    def test_formal_submit_rejects_forged_window_result_type(self):
        invalid = window("wrong-type", 48)
        invalid["type"] = "polygonlabels"
        response = self.client.post(
            f"/api/tasks/{self.task.id}/annotations/",
            {"result": [room("left", 0, 48), invalid]},
            format="json",
        )
        self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(response.data["display_context"]["issues"][0]["result_id"], "wrong-type")
        self.assertFalse(self.task.annotations.exists())
