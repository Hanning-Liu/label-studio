"""Released catalog resource shared with the frontend, templates and exporters."""
import json
from importlib.resources import files


def validate_catalog(catalog):
    categories, groups = catalog['categories'], catalog['groups']
    if not categories or not groups:
        raise ValueError('Furniture catalog must not be empty')
    for rows, key in [(categories, 'id'), (categories, 'label'), (categories, 'template_order'),
                      (groups, 'id'), (groups, 'order')]:
        values = [row[key] for row in rows]
        if len(values) != len(set(values)):
            raise ValueError(f'Duplicate catalog {key}')
    group_ids = {group['id'] for group in groups}
    category_ids = {category['id'] for category in categories}
    additions = []
    for category in categories:
        if category['group'] not in group_ids:
            raise ValueError(f'Unknown group: {category["group"]}')
        for key in ('template_order', 'display_order'):
            if type(category[key]) is not int or category[key] < 0:
                raise ValueError(f'Invalid catalog {key}')
        if not category['definition'] or not isinstance(category['aliases'], list):
            raise ValueError(f'Missing catalog description: {category["id"]}')
        if not set(category['confusable']) <= category_ids:
            raise ValueError(f'Unknown confusable category: {category["id"]}')
        if 'legacy_addition_order' in category:
            order = category['legacy_addition_order']
            if type(order) is not int or order < 0:
                raise ValueError('Invalid legacy addition order')
            additions.append(order)
    if len(additions) != len(set(additions)):
        raise ValueError('Duplicate legacy addition order')
    for group in groups:
        orders = [category['display_order'] for category in categories if category['group'] == group['id']]
        if not orders or len(orders) != len(set(orders)):
            raise ValueError(f'Empty group or duplicate display order: {group["id"]}')
    return catalog


CATALOG = validate_catalog(json.loads(files('hanning.catalog').joinpath('furniture.json').read_text(encoding='utf-8')))
FURNITURE_TYPE_CHOICES = tuple((row['id'], row['label']) for row in
                               sorted(CATALOG['categories'], key=lambda row: row['template_order']))
FURNITURE_TYPES = frozenset(value for value, _label in FURNITURE_TYPE_CHOICES)
# Explicitly marked historical additions only; never append the entire catalog.
ADDITIONS = tuple((row['id'], row['label']) for row in sorted(
    (row for row in CATALOG['categories'] if 'legacy_addition_order' in row),
    key=lambda row: row['legacy_addition_order'],
))
