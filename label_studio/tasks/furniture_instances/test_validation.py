import copy
import unittest

from tasks.occupancy.validation import content_fingerprint
from tasks.occupancy.validation import source_fingerprint as zone_fingerprint

from .geometry import orientation_from_results, parent_fingerprint, review_fingerprint, union_result_geometry
from .validation import furniture_groups, validate

SOURCE_VERSION = 'd' * 64


def reference_results():
    room = {
        'id': 'room-r',
        'from_name': 'room_rectangle',
        'to_name': 'image',
        'type': 'rectanglelabels',
        'original_width': 100,
        'original_height': 100,
        'value': {
            'x': 0,
            'y': 0,
            'width': 100,
            'height': 100,
            'rotation': 0,
            'rectanglelabels': ['Study'],
        },
        'meta': {'room_graph_node': {'schema_version': 3}},
    }
    zone = {
        'id': 'zone-z',
        'from_name': 'zone_rectangle',
        'to_name': 'image',
        'type': 'rectangle',
        'original_width': 100,
        'original_height': 100,
        'value': {'x': 0, 'y': 0, 'width': 100, 'height': 100, 'rotation': 0},
        'meta': {'partition_context': {'parent_room_id': room['id']}},
    }
    zone_label = {
        'id': zone['id'],
        'from_name': 'function_zone',
        'to_name': 'image',
        'type': 'labels',
        'value': {'labels': ['Study/work']},
    }
    results = [room, zone, zone_label]
    parent = zone_fingerprint(zone, results)
    for group_id, x, group_type in (
        ('group-a', 0, 'study_work'),
        ('group-b', 50, 'storage'),
    ):
        geometry_id = f'{group_id}-geometry'
        results.extend(
            [
                {
                    'id': geometry_id,
                    'from_name': 'occupancy_rectangle',
                    'to_name': 'image',
                    'type': 'rectangle',
                    'original_width': 100,
                    'original_height': 100,
                    'value': {'x': x, 'y': 0, 'width': 50, 'height': 100, 'rotation': 0},
                    'meta': {
                        'occupancy_context': {
                            'schema_version': 1,
                            'logical_id': group_id,
                            'group_id': group_id,
                            'group_type': group_type,
                            'group_note': '',
                            'parent_zone_id': zone['id'],
                            'parent_room_id': room['id'],
                            'source_version': 'l2-version',
                            'parent_fingerprint': parent,
                            'generation': 'manual',
                            'review_status': 'reviewed',
                            'review_fingerprint': 'e' * 64,
                        }
                    },
                },
                {
                    'id': geometry_id,
                    'from_name': 'occupancy_type',
                    'to_name': 'image',
                    'type': 'labels',
                    'value': {'labels': ['furniture_group']},
                },
            ]
        )
    review = content_fingerprint(results, zone['id'])
    for result in results:
        group_context = result.get('meta', {}).get('occupancy_context')
        if group_context:
            group_context['review_fingerprint'] = review
    return results


def instance_results(refs, *, x=10, y=10, width=20, height=20, instance_type='desk'):
    group = furniture_groups(refs)['group-a']
    base = {
        'schema_version': 1,
        'instance_id': 'instance-a',
        'instance_type': instance_type,
        'note': '',
        'room_id': group['room_id'],
        'zone_id': group['zone_id'],
        'group_id': group['group_id'],
        'source_version': SOURCE_VERSION,
        'parent_fingerprint': group['fingerprint'],
        'review_status': 'pending',
        'review_fingerprint': None,
    }
    geometry = {
        'id': 'instance-a-geometry',
        'from_name': 'furniture_instance_rectangle',
        'to_name': 'image',
        'type': 'rectangle',
        'original_width': 100,
        'original_height': 100,
        'value': {'x': x, 'y': y, 'width': width, 'height': height, 'rotation': 0},
        'meta': {'furniture_instance_context': {**base, 'role': 'geometry'}},
    }
    category = {
        'id': 'instance-a-geometry',
        'from_name': 'furniture_instance_type',
        'to_name': 'image',
        'type': 'choices',
        'original_width': 100,
        'original_height': 100,
        'value': {'choices': [instance_type]},
        'meta': {'furniture_instance_context': {**base, 'role': 'category'}},
    }
    results = [geometry, category]
    mark_reviewed(results)
    return results


def orientation(control, label, vertices, common):
    return {
        'id': f'instance-a-{label}',
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
        'meta': {'furniture_instance_context': {**common, 'role': label}},
    }


def mark_reviewed(results):
    geometry_results = [result for result in results if result['from_name'] in {
        'furniture_instance_rectangle', 'furniture_instance_polygon'
    }]
    direction = [result for result in results if result['from_name'] == 'furniture_front_direction']
    edge = [result for result in results if result['from_name'] == 'furniture_front_edge']
    geometry = union_result_geometry(geometry_results)
    value = copy.deepcopy(results[0]['meta']['furniture_instance_context'])
    value['review_status'] = 'reviewed'
    value['review_fingerprint'] = None
    orientation_value = orientation_from_results(direction, edge, geometry)
    stamp = review_fingerprint(value, geometry, orientation_value)
    for result in results:
        result['meta']['furniture_instance_context']['review_status'] = 'reviewed'
        result['meta']['furniture_instance_context']['review_fingerprint'] = stamp


class FurnitureInstanceValidationTests(unittest.TestCase):
    def test_valid_rectangle_and_polygon_parts_have_complete_parent_chain(self):
        refs = reference_results()
        results = instance_results(refs)
        self.assertEqual(validate(refs + results, SOURCE_VERSION), [])
        polygon = copy.deepcopy(results[0])
        polygon.update(id='instance-a-polygon', from_name='furniture_instance_polygon', type='polygon')
        polygon['value'] = {'points': [[35, 10], [45, 10], [45, 20], [35, 20]]}
        polygon_category = copy.deepcopy(results[1])
        polygon_category['id'] = polygon['id']
        results.extend([polygon, polygon_category])
        mark_reviewed(results)
        self.assertEqual(validate(refs + results, SOURCE_VERSION), [])

    def test_polygon_multipolygon_all_parts_and_hole_validate_without_rewrite(self):
        refs = reference_results()
        group = furniture_groups(refs)['group-a']
        base = instance_results(refs)[0]['meta']['furniture_instance_context']
        bars = []
        for result_id, x, y, width, height in (
            ('top', 5, 5, 20, 2),
            ('bottom', 5, 23, 20, 2),
            ('left', 5, 7, 2, 16),
            ('right', 23, 7, 2, 16),
            ('island', 35, 5, 5, 5),
        ):
            bars.append(
                {
                    'id': result_id,
                    'from_name': 'furniture_instance_rectangle',
                    'to_name': 'image',
                    'type': 'rectangle',
                    'original_width': 100,
                    'original_height': 100,
                    'value': {'x': x, 'y': y, 'width': width, 'height': height, 'rotation': 0},
                    'meta': {'furniture_instance_context': {**base, 'role': 'geometry'}},
                }
            )
        categories = []
        for bar in bars:
            category = copy.deepcopy(instance_results(refs)[1])
            category['id'] = bar['id']
            categories.append(category)
        results = bars + categories
        mark_reviewed(results)
        before = copy.deepcopy(results)
        geometry = union_result_geometry(bars)
        self.assertEqual(geometry.geom_type, 'MultiPolygon')
        self.assertEqual(sum(len(part.interiors) for part in geometry.geoms), 1)
        self.assertEqual(validate(refs + results, SOURCE_VERSION), [])
        self.assertEqual(results, before)
        self.assertEqual(group['fingerprint'], parent_fingerprint(group, group['geometry']))

    def test_outside_and_cross_group_are_both_explicit(self):
        refs = reference_results()
        results = instance_results(refs, x=45, width=15)
        codes = {error['code'] for error in validate(refs + results, SOURCE_VERSION)}
        self.assertIn('outside', codes)
        self.assertIn('cross_group', codes)

    def test_missing_changed_or_reassigned_parent_never_silently_migrates(self):
        refs = reference_results()
        results = instance_results(refs)
        changed = copy.deepcopy(results)
        for result in changed:
            result['meta']['furniture_instance_context']['parent_fingerprint'] = '0' * 64
            result['meta']['furniture_instance_context']['review_status'] = 'stale'
        self.assertIn('parent_stale', {error['code'] for error in validate(refs + changed, SOURCE_VERSION)})
        wrong_source = copy.deepcopy(results)
        for result in wrong_source:
            result['meta']['furniture_instance_context']['source_version'] = 'f' * 64
            result['meta']['furniture_instance_context']['review_status'] = 'stale'
        wrong_source_codes = {error['code'] for error in validate(refs + wrong_source, SOURCE_VERSION)}
        self.assertNotIn('parent_stale', wrong_source_codes)
        self.assertIn('review', wrong_source_codes)
        deleted = [result for result in refs if result.get('meta', {}).get('occupancy_context', {}).get('group_id') != 'group-a']
        self.assertIn('parent_missing', {error['code'] for error in validate(deleted + results, SOURCE_VERSION)})
        reassigned = copy.deepcopy(results)
        for result in reassigned:
            result['meta']['furniture_instance_context']['group_id'] = 'group-b'
        codes = {error['code'] for error in validate(refs + reassigned, SOURCE_VERSION)}
        self.assertTrue({'parent_chain', 'parent_stale', 'outside'} & codes)

    def test_unknown_direction_and_front_edge_review_fingerprints(self):
        refs = reference_results()
        unknown = instance_results(refs)
        self.assertEqual(validate(refs + unknown, SOURCE_VERSION), [])

        direction = instance_results(refs)
        common = direction[0]['meta']['furniture_instance_context']
        direction.append(
            orientation(
                'furniture_front_direction',
                'front_direction',
                [(20, 20), (23, 24)],
                common,
            )
        )
        mark_reviewed(direction)
        self.assertEqual(validate(refs + direction, SOURCE_VERSION), [])

        edge = instance_results(refs)
        common = edge[0]['meta']['furniture_instance_context']
        edge.append(orientation('furniture_front_edge', 'front_edge', [(10, 10), (30, 10)], common))
        mark_reviewed(edge)
        self.assertEqual(validate(refs + edge, SOURCE_VERSION), [])

    def test_invalid_pair_orientation_and_review_are_blocked(self):
        refs = reference_results()
        missing_category = instance_results(refs)[:1]
        self.assertIn('pair', {error['code'] for error in validate(refs + missing_category, SOURCE_VERSION)})
        invalid_direction = instance_results(refs)
        common = invalid_direction[0]['meta']['furniture_instance_context']
        invalid_direction.append(
            orientation('furniture_front_direction', 'front_direction', [(90, 90), (91, 90)], common)
        )
        self.assertIn('orientation', {error['code'] for error in validate(refs + invalid_direction, SOURCE_VERSION)})
        stale_review = instance_results(refs)
        stale_review[0]['value']['width'] = 21
        self.assertIn('review', {error['code'] for error in validate(refs + stale_review, SOURCE_VERSION)})

    def test_result_ids_are_nonempty_and_control_pairs_are_task_unique(self):
        refs = reference_results()
        missing = instance_results(refs)
        for result in missing:
            result['id'] = None
        self.assertIn('pair', {error['code'] for error in validate(refs + missing, SOURCE_VERSION)})

        first = instance_results(refs)
        second = copy.deepcopy(first)
        for result in second:
            result['meta']['furniture_instance_context']['instance_id'] = 'instance-b'
        mark_reviewed(second)
        self.assertIn('pair', {error['code'] for error in validate(refs + first + second, SOURCE_VERSION)})


if __name__ == '__main__':
    unittest.main()
