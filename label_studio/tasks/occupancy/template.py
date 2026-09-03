"""Build a compatible L3 template from an explicit L2 config, keeping names/labels."""
import copy
import xml.etree.ElementTree as ET
from .validation import BARRIER_CONTROL, BARRIER_LABEL, REFERENCES


BARRIER_ATTRIBUTES = {
    'name': BARRIER_CONTROL,
    'choice': 'single',
    'closable': 'false',
    'curves': 'false',
    'minPoints': '2',
    'maxPoints': '2',
    'snap': 'pixel',
    'strokeWidth': '5',
    'pointSize': 'medium',
    'showInline': 'true',
}


def _barrier_control(image_name):
    control = ET.Element('VectorLabels', {**BARRIER_ATTRIBUTES, 'toName': image_name})
    ET.SubElement(control, 'Label', {'value': BARRIER_LABEL, 'background': '#374151'})
    return control


def _hidden_reference_container(root):
    return next(
        (
            element
            for element in root.iter('View')
            if 'occupancy-reference-controls' in (element.get('className') or '').split()
        ),
        None,
    )


def ensure_barrier_control(config):
    """Add the L3 wall-barrier control once without changing existing control identities."""
    root = ET.fromstring(config)
    images = [element for element in root.iter('Image')]
    if len(images) != 1 or not images[0].get('name'):
        raise ValueError('L3 配置必须包含唯一且具名的 Image')
    hidden = _hidden_reference_container(root)
    parent_by_child = {child: parent for parent in root.iter() for child in parent}
    named = [element for element in root.iter() if element.get('name') == BARRIER_CONTROL]
    if named:
        labels = list(named[0].findall('Label'))
        parent = parent_by_child.get(named[0])
        if (len(named) != 1 or named[0].tag != 'VectorLabels'
                or named[0].get('toName') != images[0].get('name')
                or len(labels) != 1 or labels[0].get('value') != BARRIER_LABEL
                or parent is None):
            raise ValueError(f'控件名 {BARRIER_CONTROL} 已被不兼容配置占用')
        if hidden is not None and parent is not hidden:
            if parent is not root:
                raise ValueError(f'控件名 {BARRIER_CONTROL} 位于不兼容容器')
            root.remove(named[0])
            hidden.append(named[0])
            ET.indent(root, space='  ')
            return ET.tostring(root, encoding='unicode')
        return config
    if hidden is not None:
        hidden.append(_barrier_control(images[0].get('name')))
    else:
        insertion = next((index for index, child in enumerate(root) if child.tag == 'Header'), len(root))
        root.insert(insertion, _barrier_control(images[0].get('name')))
    ET.indent(root, space='  ')
    return ET.tostring(root, encoding='unicode')


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
    hidden.append(_barrier_control(source_image.get('name')))
    ET.SubElement(root, 'Header', {'value': 'L3：选择 Focus 功能分区 → 创建并绘制家具组团或标注隔墙 → 预览组团 → 生成可通行区域 → 复核。', 'size': '5'})
    ET.SubElement(root, 'Header', {'value': '轮廓闭合后会直接进入草稿，可继续精细调整。家具间空隙不要填满；地毯通常不贡献障碍占地。', 'size': '5'})
    ET.indent(root, space='  ')
    return ET.tostring(root, encoding='unicode')
