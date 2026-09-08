"""Append the two catalog additions without rebuilding a user's L4 template."""

import hashlib
from collections import Counter

from lxml import etree

ADDITIONS = (('dressing_table', '梳妆台'), ('bar_counter', '吧台/餐吧台'))


def config_sha256(config):
    return hashlib.sha256(config.encode('utf-8')).hexdigest()


def upgrade_choices(config):
    parser = etree.XMLParser(resolve_entities=False, no_network=True, remove_blank_text=False)
    root = etree.fromstring(config.encode('utf-8'), parser)
    if root.getroottree().docinfo.doctype:
        raise ValueError('不支持包含 DTD 的标注配置')
    names = [node.get('name') for node in root.iter() if node.get('name')]
    duplicates = [name for name, count in Counter(names).items() if count > 1]
    if duplicates:
        raise ValueError(f'控件名称重复: {duplicates}')
    images = root.xpath('.//Image')
    if len(images) != 1 or images[0].get('furnitureInstancesV1', '').lower() != 'true':
        raise ValueError('目标必须是仅含一个 Image 的 L4 家具实例项目')
    controls = root.xpath('.//*[@name="furniture_instance_type"]')
    if len(controls) != 1:
        raise ValueError('缺少唯一的 furniture_instance_type 控件')
    control = controls[0]
    if (control.tag != 'Choices' or control.get('perRegion', '').lower() != 'true'
            or control.get('choice', 'single') not in ('single', 'single-radio')
            or control.get('toName') != images[0].get('name') or control.get('value')):
        raise ValueError('家具类别控件必须为静态、单选、perRegion Choices，且指向 L4 Image')
    choices = control.findall('Choice')
    if any(node.tag == 'Choice' and node.getparent() is not control for node in control.iter()):
        raise ValueError('不支持嵌套家具类别')
    values = [node.get('value') for node in choices]
    aliases = [node.get('alias') or node.get('value') for node in choices]
    if None in values or len(values) != len(set(values)) or len(aliases) != len(set(aliases)):
        raise ValueError('家具类别显示值或稳定别名重复/缺失')
    missing = []
    for alias, label in ADDITIONS:
        matches = [node for node in choices if (node.get('alias') or node.get('value')) == alias]
        if matches:
            if matches[0].get('value') != label or matches[0].get('alias') != alias:
                raise ValueError(f'新增类别别名冲突: {alias}')
        elif label in values or alias in values:
            raise ValueError(f'新增类别显示值冲突: {alias}')
        else:
            missing.append((alias, label))
    if not missing:
        return config, []
    for alias, label in missing:
        etree.SubElement(control, 'Choice', value=label, alias=alias)
    return etree.tostring(root, encoding='unicode'), [alias for alias, _ in missing]
