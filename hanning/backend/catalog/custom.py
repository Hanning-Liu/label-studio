"""Portable custom furniture identities, also usable by offline exporters."""
import hashlib
import unicodedata
from . import CATALOG, FURNITURE_TYPES

GROUP_IDS = {group['id'] for group in CATALOG['groups']}

def normalize_name(value):
    if not isinstance(value, str):
        raise ValueError('类别名称必须是文字')
    value = ' '.join(unicodedata.normalize('NFKC', value).split())
    if not value or len(value) > 40 or any(unicodedata.category(c).startswith('C') for c in value):
        raise ValueError('类别名称须为 1–40 个可见字符')
    return value

def custom_entry(label, group):
    label = normalize_name(label)
    if group not in GROUP_IDS:
        raise ValueError('请选择有效大类')
    stable = hashlib.sha256((group + '\n' + label).encode('utf-8')).hexdigest()[:32]
    return {'id': 'custom_' + stable, 'label': label, 'group': group}

def valid_type(value, context):
    if isinstance(value, str) and value in FURNITURE_TYPES:
        return True
    entry = context.get('catalog_entry') if isinstance(context, dict) else None
    if not isinstance(entry, dict):
        return False
    try:
        return entry == custom_entry(entry.get('label'), entry.get('group')) and value == entry['id']
    except (TypeError, ValueError):
        return False
