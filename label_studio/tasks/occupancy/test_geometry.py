import copy
import json
import unittest
from pathlib import Path
from shapely.geometry import Polygon, shape
from shapely import union_all
from .geometry import EPS_AREA, VALIDATION_EPS_AREA, fingerprint, result_geometry, validation_geometry
from .validation import validate, source_fingerprint, content_fingerprint, GEOMETRY

FIXTURES = Path(__file__).resolve().parents[3] / 'examples/occupancy-v1/frontend-fixtures.json'


class GeometryParityTests(unittest.TestCase):
    def barrier_results(self):
        parent = {
            'id': 'zone-z', 'from_name': 'zone_rectangle', 'to_name': 'image', 'type': 'rectangle',
            'original_width': 100, 'original_height': 100,
            'value': {'x': 0, 'y': 0, 'width': 100, 'height': 100, 'rotation': 0},
            'meta': {'partition_context': {'parent_room_id': 'room-r'}},
        }
        results = [parent, {'id': parent['id'], 'from_name': 'function_zone', 'to_name': 'image',
                            'type': 'labels', 'value': {'labels': ['Sanitary/general']}}]
        parent_fingerprint = source_fingerprint(parent, results)
        for rid, logical_id, x, group_type in [('a', 'group-a', 0, 'washbasin'), ('b', 'group-b', 50, 'storage')]:
            geometry = {
                'id': rid, 'from_name': 'occupancy_rectangle', 'to_name': 'image', 'type': 'rectangle',
                'original_width': 100, 'original_height': 100,
                'value': {'x': x, 'y': 0, 'width': 50, 'height': 100, 'rotation': 0},
                'meta': {'occupancy_context': {
                    'schema_version': 1, 'logical_id': logical_id, 'group_id': logical_id,
                    'group_type': group_type, 'group_note': '', 'parent_zone_id': parent['id'],
                    'parent_room_id': 'room-r', 'source_version': 'v1',
                    'parent_fingerprint': parent_fingerprint, 'generation': 'manual',
                    'review_status': 'pending', 'review_fingerprint': None,
                }},
            }
            results.extend([geometry, {'id': rid, 'from_name': 'occupancy_type', 'to_name': 'image',
                                       'type': 'labels', 'value': {'labels': ['furniture_group']}}])
        barrier = {
            'id': 'wall', 'from_name': 'occupancy_barrier_vector', 'to_name': 'image', 'type': 'vectorlabels',
            'original_width': 100, 'original_height': 100,
            'value': {'closed': False, 'vectorlabels': ['wall_barrier'],
                      'vertices': [{'x': 50, 'y': 0}, {'x': 50, 'y': 100}]},
            'meta': {'occupancy_barrier_context': {
                'schema_version': 1, 'barrier_id': 'wall', 'barrier_type': 'wall',
                'parent_zone_id': parent['id'], 'parent_room_id': 'room-r',
                'source_version': 'v1', 'parent_fingerprint': parent_fingerprint,
                'match_rule': 'shared_boundary_overlap', 'matched_pairs': [{
                    'source_group_id': 'group-a', 'target_group_id': 'group-b',
                    'shared_boundary_length_px': 100, 'barrier_overlap_length_px': 100,
                }],
            }},
        }
        results.append(barrier)
        return results

    def test_valid_wall_barrier_has_no_barrier_validation_errors(self):
        errors = validate(self.barrier_results(), 'v1')
        self.assertFalse([error for error in errors if error['code'].startswith('barrier_')], errors)

    def test_wall_barrier_uses_same_pixel_grid_as_furniture_after_percentage_round_trip(self):
        results = self.barrier_results()
        boundary_percent = 569 * 100 / 1080
        for result in results:
            if result.get('from_name') in {'zone_rectangle', 'occupancy_rectangle', 'occupancy_barrier_vector'}:
                result['original_width'] = 1080
                result['original_height'] = 671
        results[2]['value']['width'] = boundary_percent
        results[4]['value']['x'] = boundary_percent
        results[4]['value']['width'] = 100 - boundary_percent
        results[-1]['value']['vertices'] = [
            {'x': boundary_percent, 'y': 0},
            {'x': boundary_percent, 'y': 100},
        ]
        parent_fingerprint = source_fingerprint(results[0], results)
        for result in results:
            occupancy_context = result.get('meta', {}).get('occupancy_context')
            if occupancy_context:
                occupancy_context['parent_fingerprint'] = parent_fingerprint
        results[-1]['meta']['occupancy_barrier_context']['parent_fingerprint'] = parent_fingerprint
        pair = results[-1]['meta']['occupancy_barrier_context']['matched_pairs'][0]
        pair['shared_boundary_length_px'] = 671
        pair['barrier_overlap_length_px'] = 671

        errors = validate(results, 'v1')

        self.assertFalse([error for error in errors if error['code'].startswith('barrier_')], errors)

    def test_barriers_affect_review_fingerprint_but_not_remainder_input_fingerprint(self):
        results = self.barrier_results()
        without_barrier = results[:-1]

        self.assertEqual(
            content_fingerprint(results, 'zone-z', remainder=True),
            content_fingerprint(without_barrier, 'zone-z', remainder=True),
        )
        self.assertNotEqual(content_fingerprint(results, 'zone-z'), content_fingerprint(without_barrier, 'zone-z'))

    def test_stale_or_unmatched_wall_barrier_is_explicit_but_draft_validation_allows_it(self):
        stale = self.barrier_results()
        stale[-1]['meta']['occupancy_barrier_context']['matched_pairs'][0]['barrier_overlap_length_px'] = 10
        self.assertIn('barrier_stale', [error['code'] for error in validate(stale, 'v1')])
        self.assertFalse([error for error in validate(stale, 'v1', partial=True) if error['code'].startswith('barrier_')])
        unmatched = self.barrier_results()
        unmatched[-1]['value']['vertices'] = [{'x': 20, 'y': 0}, {'x': 20, 'y': 100}]
        self.assertIn('barrier_unmatched', [error['code'] for error in validate(unmatched, 'v1')])

    def pixel_drift_results(self):
        parent = {
            'id': 'vktMIEcf62', 'from_name': 'zone_polygon', 'to_name': 'image', 'type': 'polygon',
            'original_width': 1080, 'original_height': 671,
            'value': {'points': [
                [30.462962962962965, 55.73770491803278], [49.44444438718535, 55.7377048258721],
                [49.44444444444444, 59.76154992548435], [46.48148148148148, 59.761549925484346],
                [46.48148148148148, 78.98658718330849], [30.462962962962965, 78.98658718330849],
            ]},
            'meta': {'partition_context': {'parent_room_id': 'living-room'}},
        }
        results = [parent, {'id': parent['id'], 'from_name': 'function_zone', 'to_name': 'image',
                            'type': 'labels', 'value': {'labels': ['Living/social']}}]
        parent_fingerprint = source_fingerprint(parent, results)

        def add_group(geometry, logical_id, group_type):
            geometry['meta'] = {'occupancy_context': {
                'schema_version': 1, 'logical_id': logical_id, 'group_id': logical_id,
                'group_type': group_type, 'group_note': '', 'parent_zone_id': parent['id'],
                'parent_room_id': 'living-room', 'source_version': 'v1',
                'parent_fingerprint': parent_fingerprint, 'generation': 'manual',
                'review_status': 'pending', 'review_fingerprint': None,
            }}
            results.extend([geometry, {'id': geometry['id'], 'from_name': 'occupancy_type', 'to_name': 'image',
                                       'type': 'labels', 'value': {'labels': ['furniture_group']}}])

        add_group({
            'id': 'kGO-x437jU', 'from_name': 'occupancy_rectangle', 'to_name': 'image', 'type': 'rectangle',
            'original_width': 1080, 'original_height': 671,
            'value': {'x': 30.462962983659022, 'y': 55.7377048180995, 'width': 2.5,
                      'height': 4.172876304023845, 'rotation': 0},
        }, 'logical-plant', 'plant_decor')
        add_group({
            'id': '8tNDYvWbvG', 'from_name': 'occupancy_polygon', 'to_name': 'image', 'type': 'polygon',
            'original_width': 1080, 'original_height': 671,
            'value': {'points': [
                [45.46296296296296, 55.73770491803279], [45.46296296296296, 78.98658718330847],
                [46.48148148148148, 78.98658718330847], [46.48148148148148, 59.76154992548435],
                [49.44444444444444, 59.76154992548435], [49.44444444444444, 55.73770491803279],
            ]},
        }, 'logical-storage', 'storage')
        return results

    def test_pixel_validation_ignores_percentage_round_trip_drift(self):
        results = self.pixel_drift_results()
        before = copy.deepcopy(results)
        self.assertGreater(result_geometry(results[2]).difference(result_geometry(results[0])).area, EPS_AREA)
        self.assertEqual(validation_geometry(results[2]).difference(validation_geometry(results[0])).area, 0)
        self.assertEqual(validate(results, 'v1', partial=True), [])
        self.assertEqual(results, before)

    def test_pixel_validation_rejects_real_quarter_pixel_overflow(self):
        results = self.pixel_drift_results()
        results[2]['value']['y'] -= 0.25 * 100 / results[2]['original_height']
        outside = [error for error in validate(results, 'v1', partial=True) if error['code'] == 'outside']
        self.assertEqual([error['objectId'] for error in outside], ['kGO-x437jU'])

    def test_pixel_validation_ignores_boolean_engine_area_noise(self):
        results = self.pixel_drift_results()
        results[2]['value']['y'] -= 0.00002 * 100 / results[2]['original_height']
        outside_area = validation_geometry(results[2]).difference(validation_geometry(results[0])).area
        self.assertGreater(outside_area, 1e-8)
        self.assertLess(outside_area, VALIDATION_EPS_AREA)
        self.assertFalse(any(error['code'] == 'outside' for error in validate(results, 'v1', partial=True)))

    def test_frontend_shapely_shared_fixtures(self):
        fixtures = json.loads(FIXTURES.read_text(encoding='utf-8'))
        for fixture in fixtures:
            with self.subTest(fixture['name']):
                results = fixture['results']
                self.assertEqual(validate(results, 'v1'), [])
                self.assertEqual(validate(results, 'v2-unrelated-change'), [])
                parent = results[0]
                self.assertEqual(source_fingerprint(parent, results), fixture['parent_fingerprint'])
                self.assertEqual(content_fingerprint(results, parent['id']), fixture['review_fingerprint'])
                source = fixture['input']
                remainder = Polygon(source['parent'][0]).difference(union_all([Polygon(p[0], p[1:]) for p in source['obstacles']]))
                free = []
                for logical in fixture['logical']['regions']:
                    ids = logical['storage_ids']
                    pieces = [result_geometry(r) for r in results if r['id'] in ids and r['from_name'] in GEOMETRY]
                    rebuilt = union_all(pieces)
                    self.assertLessEqual(rebuilt.symmetric_difference(shape(logical['geometry'])).area, EPS_AREA)
                    if logical['occupancy_type'] != 'furniture_group':
                        free.append(rebuilt)
                self.assertLessEqual(union_all(free).symmetric_difference(remainder).area, EPS_AREA)

    def test_reject_tampering_and_stale_review(self):
        fixture = json.loads(FIXTURES.read_text(encoding='utf-8'))[0]
        results = copy.deepcopy(fixture['results'])
        piece = next(r for r in results if r['from_name'] in GEOMETRY)
        piece['value']['points'][0][0] += 1
        self.assertTrue(any(e['code'] == 'review' for e in validate(results, 'v1')))
        piece['meta']['occupancy_context']['parent_zone_id'] = 'deleted'
        self.assertTrue(any(e['code'] == 'parent_missing' for e in validate(results, 'v1')))

    def test_rotated_rectangle_and_invalid_polygon(self):
        result = {'value': {'x': 20, 'y': 20, 'width': 10, 'height': 20, 'rotation': 90}, 'original_width': 200, 'original_height': 100}
        self.assertAlmostEqual(result_geometry(result).area, 200)
        with self.assertRaises(ValueError):
            result_geometry({'value': {'points': [[0, 0], [10, 10], [0, 10], [10, 0]]}})

    def test_coverage_checks_union_not_sum(self):
        fixtures = json.loads(FIXTURES.read_text(encoding='utf-8'))
        results = copy.deepcopy(next(f for f in fixtures if f['name'] == 'no-furniture')['results'])
        first = next(r for r in results if r['from_name'] in GEOMETRY)
        first['value']['points'] = [[0, 0], [50, 0], [50, 100], [0, 100]]
        other = copy.deepcopy(first)
        other['id'] = 'duplicateArea'
        other['meta']['occupancy_context']['logical_id'] = 'duplicateLogical'
        results += [other, {'id': other['id'], 'from_name': 'occupancy_type', 'value': {'labels': ['walkable']}}]
        errors = validate(results, 'v1')
        self.assertIn('coverage', [e['code'] for e in errors])
        self.assertIn('overlap', [e['code'] for e in errors])
