import copy
import unittest

from shapely.geometry import MultiPolygon, Polygon

from .geometry import (
    canonicalize_parent_geometry,
    orientation_from_results,
    parent_fingerprint,
    review_fingerprint,
    union_result_geometry,
)


def rectangle(result_id, x, y, width, height):
    return {
        'id': result_id,
        'from_name': 'furniture_instance_rectangle',
        'to_name': 'image',
        'type': 'rectangle',
        'original_width': 100,
        'original_height': 100,
        'value': {'x': x, 'y': y, 'width': width, 'height': height, 'rotation': 0},
    }


def vector(control, label, vertices):
    return {
        'id': f'{control}-1',
        'from_name': control,
        'to_name': 'image',
        'type': 'vectorlabels',
        'original_width': 100,
        'original_height': 100,
        'value': {
            'closed': False,
            'vertices': [{'x': x, 'y': y} for x, y in vertices],
            'vectorlabels': [label],
        },
    }


class FurnitureInstanceGeometryTests(unittest.TestCase):
    def test_parent_fingerprint_is_cross_language_fixed_and_order_independent(self):
        polygon = Polygon(
            [(0, 0), (0, 10), (10, 10), (10, 0)],
            [[(2, 2), (8, 2), (8, 8), (2, 8)]],
        )
        second = Polygon([(20, 0), (25, 0), (25, 5), (20, 5)])
        group = {
            'room_id': 'room-r',
            'zone_id': 'zone-z',
            'group_id': 'group-g',
            'group_type': 'study_work',
            'group_note': 'desk alcove',
            'zone_parent_fingerprint': 'a' * 64,
        }
        expected = 'dfffaf6f7467a730f94c7b4499ca7613f292078ceb8c609042839d3b50f61296'
        self.assertEqual(parent_fingerprint(group, MultiPolygon([polygon, second])), expected)
        self.assertEqual(parent_fingerprint(group, MultiPolygon([second, polygon])), expected)
        self.assertEqual(
            canonicalize_parent_geometry(MultiPolygon([polygon])),
            canonicalize_parent_geometry(polygon),
        )
        for key, value in (
            ('room_id', 'room-other'),
            ('zone_id', 'zone-other'),
            ('group_type', 'storage'),
            ('group_note', 'changed'),
            ('zone_parent_fingerprint', 'b' * 64),
        ):
            changed = {**group, key: value}
            self.assertNotEqual(parent_fingerprint(changed, MultiPolygon([polygon, second])), expected)

    def test_review_fingerprint_is_cross_language_fixed(self):
        geometry = Polygon([(1, 1), (3, 1), (3, 2), (1, 2)])
        instance = {
            'instance_id': 'instance-i',
            'instance_type': 'desk',
            'note': '',
            'room_id': 'room-r',
            'zone_id': 'zone-z',
            'group_id': 'group-g',
            'source_version': 'b' * 64,
            'parent_fingerprint': 'c' * 64,
        }
        orientation = {
            'status': 'front_direction',
            'origin': {'x': 1, 'y': 1.5},
            'direction_vector': {'dx': 1, 'dy': 0},
        }
        self.assertEqual(
            review_fingerprint(instance, geometry, orientation),
            '3d8654893d8bb870d79cbfa9ebe2394ecf3ec1bdde6897c649f35070b6d1daf9',
        )

    def test_union_retains_every_part_and_hole(self):
        parts = [
            rectangle('top', 0, 0, 10, 2),
            rectangle('bottom', 0, 8, 10, 2),
            rectangle('left', 0, 2, 2, 6),
            rectangle('right', 8, 2, 2, 6),
            rectangle('island', 20, 0, 5, 5),
        ]
        before = copy.deepcopy(parts)
        geometry = union_result_geometry(parts)
        self.assertEqual(geometry.geom_type, 'MultiPolygon')
        self.assertEqual(len(geometry.geoms), 2)
        self.assertEqual(sum(len(part.interiors) for part in geometry.geoms), 1)
        canonical = canonicalize_parent_geometry(geometry)
        self.assertEqual(canonical['type'], 'MultiPolygon')
        self.assertEqual(sorted(len(polygon) for polygon in canonical['coordinates']), [1, 2])
        self.assertEqual(parts, before, 'geometry helpers must never rewrite raw results')

    def test_unknown_direction_and_boundary_edge_are_explicit_only(self):
        geometry = Polygon([(0, 0), (5, 0), (10, 0), (10, 10), (0, 10)])
        self.assertEqual(orientation_from_results([], [], geometry), {'status': 'unknown'})
        rotated = rectangle('rotated', 20, 20, 10, 5)
        rotated['value']['rotation'] = 37
        self.assertEqual(
            orientation_from_results([], [], union_result_geometry([rotated])),
            {'status': 'unknown'},
        )
        direction = vector('furniture_front_direction', 'front_direction', [(5, 5), (8, 9)])
        self.assertEqual(
            orientation_from_results([direction], [], geometry),
            {
                'status': 'front_direction',
                'origin': {'x': 5.0, 'y': 5.0},
                'direction_vector': {'dx': 0.6, 'dy': 0.8},
            },
        )
        edge = vector('furniture_front_edge', 'front_edge', [(1, 0), (9, 0)])
        self.assertEqual(
            orientation_from_results([], [edge], geometry),
            {
                'status': 'front_edge',
                'start': {'x': 1.0, 'y': 0.0},
                'end': {'x': 9.0, 'y': 0.0},
                'outward_normal': {'dx': 0.0, 'dy': -1.0},
            },
        )

    def test_rejects_inferred_or_invalid_orientation_evidence(self):
        geometry = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
        zero = vector('furniture_front_direction', 'front_direction', [(5, 5), (5, 5)])
        with self.assertRaisesRegex(ValueError, '长度'):
            orientation_from_results([zero], [], geometry)
        inside = vector('furniture_front_edge', 'front_edge', [(1, 5), (9, 5)])
        with self.assertRaisesRegex(ValueError, '精确边界'):
            orientation_from_results([], [inside], geometry)
        extended = vector('furniture_front_edge', 'front_edge', [(0, 0), (11, 0)])
        with self.assertRaisesRegex(ValueError, '精确边界'):
            orientation_from_results([], [extended], geometry)
        direction = vector('furniture_front_direction', 'front_direction', [(5, 5), (6, 5)])
        edge = vector('furniture_front_edge', 'front_edge', [(1, 0), (9, 0)])
        with self.assertRaisesRegex(ValueError, '不能同时'):
            orientation_from_results([direction], [edge], geometry)
        outside = vector('furniture_front_direction', 'front_direction', [(20, 20), (21, 20)])
        with self.assertRaisesRegex(ValueError, '内部或边界'):
            orientation_from_results([outside], [], geometry)


if __name__ == '__main__':
    unittest.main()
