import copy
import unittest

from hanning.backend.catalog import ADDITIONS, CATALOG, FURNITURE_TYPE_CHOICES, FURNITURE_TYPES, validate_catalog


class CatalogTests(unittest.TestCase):
    def test_catalog_is_packaged_and_preserves_distinct_orders(self):
        self.assertEqual(FURNITURE_TYPES, {row['id'] for row in CATALOG['categories']})
        expected = sorted(CATALOG['categories'], key=lambda row: row['template_order'])
        self.assertEqual(FURNITURE_TYPE_CHOICES, tuple((row['id'], row['label']) for row in expected))
        self.assertEqual(ADDITIONS, tuple((row['id'], row['label']) for row in sorted(
            [row for row in CATALOG['categories'] if 'legacy_addition_order' in row],
            key=lambda row: row['legacy_addition_order'])))

    def test_rejects_duplicates_unknown_groups_and_order_collisions(self):
        for field, value in [('id', CATALOG['categories'][1]['id']),
                             ('label', CATALOG['categories'][1]['label']),
                             ('template_order', CATALOG['categories'][1]['template_order']),
                             ('group', 'missing'), ('display_order', -1),
                             ('confusable', ['missing'])]:
            with self.subTest(field=field):
                broken = copy.deepcopy(CATALOG)
                broken['categories'][0][field] = value
                with self.assertRaises(ValueError):
                    validate_catalog(broken)

    def test_unmarked_new_category_is_not_a_historical_addition(self):
        synthetic = copy.deepcopy(CATALOG)
        row = {**synthetic['categories'][-1], 'id': 'synthetic_fixture', 'label': 'Synthetic fixture',
               'display_order': 999, 'template_order': 999}
        row.pop('legacy_addition_order', None)
        synthetic['categories'].append(row)
        validate_catalog(synthetic)
        self.assertNotIn('synthetic_fixture', {item['id'] for item in synthetic['categories']
                                             if 'legacy_addition_order' in item})
