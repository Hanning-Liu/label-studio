import copy
import unittest

from shapely.geometry import MultiPolygon, Polygon

from .geometry import (
    FRONT_EDGE_BOUNDARY_EPS_PX,
    VALIDATION_PIXEL_EPS,
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


def vector(control, label, vertices, *, original_width=100, original_height=100):
    return {
        'id': f'{control}-1',
        'from_name': control,
        'to_name': 'image',
        'type': 'vectorlabels',
        'original_width': original_width,
        'original_height': original_height,
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
        string_dimensions = vector('furniture_front_edge', 'front_edge', [(1, 0), (9, 0)])
        string_dimensions['original_width'] = '100'
        with self.assertRaisesRegex(ValueError, '有效原图尺寸'):
            orientation_from_results([], [string_dimensions], geometry)
        outside = vector('furniture_front_direction', 'front_direction', [(20, 20), (21, 20)])
        with self.assertRaisesRegex(ValueError, '内部或边界'):
            orientation_from_results([outside], [], geometry)

    def test_front_edge_tolerance_is_source_pixel_based_and_does_not_rewrite_evidence(self):
        geometry = Polygon([(10, 10), (90, 90), (90, 10)])
        percent_per_pixel = 100 / 1000
        accepted_offset = FRONT_EDGE_BOUNDARY_EPS_PX * 0.5 * percent_per_pixel
        accepted = vector(
            'furniture_front_edge',
            'front_edge',
            [(30, 30 + accepted_offset), (70, 70 + accepted_offset)],
            original_width=1000,
            original_height=1000,
        )
        before = copy.deepcopy(accepted)
        self.assertEqual(orientation_from_results([], [accepted], geometry)['status'], 'front_edge')
        self.assertEqual(accepted, before, 'boundary validation must not snap or rewrite raw evidence')

        rejected_offset = FRONT_EDGE_BOUNDARY_EPS_PX * 3 * percent_per_pixel
        rejected = vector(
            'furniture_front_edge',
            'front_edge',
            [(30, 30 + rejected_offset), (70, 70 + rejected_offset)],
            original_width=1000,
            original_height=1000,
        )
        with self.assertRaisesRegex(ValueError, '精确边界'):
            orientation_from_results([], [rejected], geometry)

        normalization_offset = FRONT_EDGE_BOUNDARY_EPS_PX * 0.9
        near_integer_geometry = Polygon(
            [
                (10 + normalization_offset, 10 - normalization_offset),
                (90 + normalization_offset, 90 - normalization_offset),
                (90, 10),
            ]
        )
        raw_boundary_edge = vector(
            'furniture_front_edge',
            'front_edge',
            [
                (30.5, 30.5 - normalization_offset * 2),
                (70.5, 70.5 - normalization_offset * 2),
            ],
        )
        with self.assertRaisesRegex(ValueError, '精确边界'):
            orientation_from_results([], [raw_boundary_edge], near_integer_geometry)

        normalized_coincident = vector(
            'furniture_front_edge',
            'front_edge',
            [(20 - VALIDATION_PIXEL_EPS * 0.9, 10), (20 + VALIDATION_PIXEL_EPS * 0.9, 10)],
        )
        with self.assertRaisesRegex(ValueError, '像素校验后不能重合'):
            orientation_from_results(
                [],
                [normalized_coincident],
                Polygon([(10, 10), (90, 10), (90, 90), (10, 90)]),
            )

    def test_front_edge_uses_exact_corner_capsules_consistent_with_frontend(self):
        geometry = Polygon(
            [
                (10.12345, 20.23456),
                (90.12345, 20.23456),
                (90.12345, 90.23456),
                (10.12345, 90.23456),
            ]
        )
        tolerance_shell_edge = vector(
            'furniture_front_edge',
            'front_edge',
            [
                (10.123444122735263, 20.234551910639073),
                (10.123444408630158, 20.23455171045331),
            ],
        )
        self.assertEqual(orientation_from_results([], [tolerance_shell_edge], geometry)['status'], 'front_edge')

    def test_front_edge_preserves_raw_valid_notch_if_pixel_normalization_invalidates_it(self):
        geometry = Polygon(
            [
                (0, 0),
                (20, 0),
                (20, 20),
                (10.000009, 20),
                (10.000009, 5),
                (9.999991, 5),
                (9.999991, 20),
                (0, 20),
            ]
        )
        notch_edge = vector(
            'furniture_front_edge',
            'front_edge',
            [(10.000009, 6), (10.000009, 15)],
        )
        self.assertEqual(
            orientation_from_results([], [notch_edge], geometry)['outward_normal'],
            {'dx': -1.0, 'dy': 0.0},
        )

    def test_front_edge_keeps_valid_normalization_after_consecutive_vertices_collapse(self):
        geometry = Polygon(
            [
                (0, 0),
                (10, 0),
                (10.000009, 10.000009),
                (10.000008, 10.000008),
                (0, 10),
            ]
        )
        raw_only_edge = vector(
            'furniture_front_edge',
            'front_edge',
            [(10.00001219999352, 7.9999999999955), (10.00001309999271, 8.9999999999955)],
        )
        with self.assertRaisesRegex(ValueError, '精确边界'):
            orientation_from_results([], [raw_only_edge], geometry)

    def test_front_edge_uses_every_multipolygon_and_hole_boundary_without_bridging_gaps(self):
        geometry = MultiPolygon(
            [
                Polygon([(0, 0), (40, 0), (40, 40), (0, 40)], [[(10, 10), (20, 10), (20, 20), (10, 20)]]),
                Polygon([(60, 0), (100, 0), (100, 40), (60, 40)]),
            ]
        )
        hole = vector('furniture_front_edge', 'front_edge', [(10, 10), (20, 10)])
        self.assertEqual(
            orientation_from_results([], [hole], geometry)['outward_normal'],
            {'dx': 0.0, 'dy': 1.0},
        )
        bridge = vector('furniture_front_edge', 'front_edge', [(20, 0), (80, 0)])
        with self.assertRaisesRegex(ValueError, '精确边界'):
            orientation_from_results([], [bridge], geometry)


if __name__ == '__main__':
    unittest.main()
