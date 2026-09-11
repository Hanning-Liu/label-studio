"""Append catalog additions without rebuilding a user's L4 template."""

import hashlib
from collections import Counter
from xml.parsers import expat

from lxml import etree

ADDITIONS = (('dressing_table', '梳妆台'), ('bar_counter', '吧台/餐吧台'), ('potted_plant', '绿植盆栽'))


def config_sha256(config):
    return hashlib.sha256(config.encode('utf-8')).hexdigest()


def _append_choices(config, missing):
    """Locate the validated control in the original bytes, preserving all existing XML."""
    source = config.encode('utf-8')
    parser = expat.ParserCreate()
    stack = []
    location = {}

    def start(name, attrs):
        selected = name == 'Choices' and attrs.get('name') == 'furniture_instance_type'
        stack.append(selected)
        if selected:
            location['start'] = parser.CurrentByteIndex

    def end(name):
        if stack.pop():
            location['end'] = parser.CurrentByteIndex

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.Parse(source, True)
    position = location['end']
    additions = [etree.tostring(etree.Element('Choice', value=label, alias=alias), encoding='utf-8')
                 for alias, label in missing]
    if source[position:position + 9] != b'</Choices':
        # Expat reports the byte after a self-closing empty control.
        opening = source[location['start']:position]
        if not opening.endswith(b'/>'):
            raise ValueError('无法安全定位家具类别控件结束位置')
        return (source[:position - 2] + b'>' + b''.join(additions) + b'</Choices>' + source[position:]).decode('utf-8')
    line_start = source.rfind(b'\n', 0, position) + 1
    indentation = source[line_start:position]
    if not indentation.strip():
        newline = b'\r\n' if b'\r\n' in source else b'\n'
        insertion = b''.join(indentation + b'  ' + addition + newline for addition in additions)
        position = line_start
    else:
        insertion = b''.join(additions)
    return (source[:position] + insertion + source[position:]).decode('utf-8')


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
    return _append_choices(config, missing), [alias for alias, _ in missing]
