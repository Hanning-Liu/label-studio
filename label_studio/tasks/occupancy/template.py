"""Build a compatible L3 template from an explicit L2 config, keeping names/labels."""
import copy
import xml.etree.ElementTree as ET
from .validation import REFERENCES


def build_template(source_config):
    source = ET.fromstring(source_config)
    source_image = next(e for e in source.iter('Image'))
    root = ET.Element('View')
    ET.SubElement(root, 'Image', {'name': source_image.get('name'), 'value': source_image.get('value'),
                                'zoom': 'true', 'smoothing': 'false', 'occupancyV1': 'true'})
    hidden = ET.SubElement(root, 'View', {'className': 'occupancy-reference-controls', 'style': 'display: none;'})
    found = set()
    for control in source.iter():
        name = control.get('name')
        if name not in REFERENCES:
            continue
        if name in found:
            raise ValueError('来源控件名重复')
        found.add(name)
        copied = copy.deepcopy(control)
        for attr in ('constrainTo', 'openingFrom', 'constraintMode', 'constraintSnapPx', 'hotkey', 'required'):
            copied.attrib.pop(attr, None)
        for child in copied.iter():
            child.attrib.pop('hotkey', None)
        hidden.append(copied)
    if found != REFERENCES:
        raise ValueError(f'来源缺少控件: {REFERENCES - found}')
    # Category selection is owned by logical-region UI; never expose per-storage-part edits.
    labels = ET.SubElement(hidden, 'Labels', {'name': 'occupancy_type', 'toName': source_image.get('name')})
    for value, color in [('furniture_group', '#b06e28'), ('walkable', '#249376'), ('restricted_free', '#5967b6'), ('unclassified', '#c36d94')]:
        ET.SubElement(labels, 'Label', {'value': value, 'background': color})
    ET.SubElement(root, 'Rectangle', {'name': 'occupancy_rectangle', 'toName': source_image.get('name'), 'canRotate': 'true'})
    ET.SubElement(root, 'Polygon', {'name': 'occupancy_polygon', 'toName': source_image.get('name'), 'strokeWidth': '2'})
    ET.SubElement(root, 'Header', {'value': 'L3：选择 Focus 功能分区 → 创建组团并绘制实际障碍占地 → 生成剩余空间 → 人工分类 → 复核。', 'size': '5'})
    ET.SubElement(root, 'Header', {'value': '新轮廓绘制后请点顶部“绘制预览”。家具间空隙不要填满；地毯通常不贡献障碍占地。未完成可保存草稿。', 'size': '5'})
    ET.indent(root, space='  ')
    return ET.tostring(root, encoding='unicode')
