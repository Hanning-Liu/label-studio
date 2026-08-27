import copy
import json
import unittest
from pathlib import Path
from shapely.geometry import Polygon, shape
from shapely import union_all
from .geometry import EPS_AREA, fingerprint, result_geometry
from .validation import validate, source_fingerprint, content_fingerprint, GEOMETRY

FIXTURES = Path(__file__).resolve().parents[3] / 'examples/occupancy-v1/frontend-fixtures.json'


class GeometryParityTests(unittest.TestCase):
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
