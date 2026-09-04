"""Build an isolated L4 template from an explicit L3 occupancy config."""

import copy
import xml.etree.ElementTree as ET

from . import FURNITURE_TYPE_CHOICES
from .geometry import (
    CATEGORY_CONTROL,
    FRONT_DIRECTION_CONTROL,
    FRONT_EDGE_CONTROL,
    MANUAL_CONTROLS,
)
from .validation import BARRIER_CONTROL, REFERENCE_CONTROLS


def _copy_reference_controls(source, container):
    found = set()
    for element in source.iter():
        name = element.get('name')
        if name not in REFERENCE_CONTROLS:
            continue
        if name in found:
            raise ValueError(f'L3 来源控件名重复: {name}')
        found.add(name)
        copied = copy.deepcopy(element)
        for node in copied.iter():
            node.attrib.pop('hotkey', None)
            node.attrib.pop('required', None)
        container.append(copied)
    required = REFERENCE_CONTROLS - {BARRIER_CONTROL}
    if not required <= found:
        raise ValueError(f'L3 来源缺少控件: {required - found}')


def build_template(source_config):
    source = ET.fromstring(source_config)
    images = list(source.iter('Image'))
    if len(images) != 1 or not images[0].get('name') or not images[0].get('value'):
        raise ValueError('L4 配置要求 L3 来源中只有一个具名 Image')
    source_names = [element.get('name') for element in source.iter() if element.get('name')]
    collisions = set(source_names) & MANUAL_CONTROLS
    if collisions:
        raise ValueError(f'L4 稳定控件名已被来源占用: {collisions}')

    image_name = images[0].get('name')
    root = ET.Element('View')
    ET.SubElement(
        root,
        'Image',
        {
            'name': image_name,
            'value': images[0].get('value'),
            'zoom': 'true',
            'smoothing': 'false',
            'furnitureInstancesV1': 'true',
            'furnitureInstanceOrientation': 'true',
        },
    )
    references = ET.SubElement(
        root,
        'View',
        {'className': 'furniture-instance-reference-controls', 'style': 'display: none;'},
    )
    _copy_reference_controls(source, references)

    ET.SubElement(
        root,
        'Rectangle',
        {'name': 'furniture_instance_rectangle', 'toName': image_name, 'canRotate': 'true'},
    )
    ET.SubElement(
        root,
        'Polygon',
        {'name': 'furniture_instance_polygon', 'toName': image_name, 'strokeWidth': '2'},
    )
    choices = ET.SubElement(
        root,
        'Choices',
        {
            'name': CATEGORY_CONTROL,
            'toName': image_name,
            'choice': 'single',
            'perRegion': 'true',
            'layout': 'select',
            'visibleWhen': 'region-selected',
        },
    )
    for value, chinese_name in FURNITURE_TYPE_CHOICES:
        ET.SubElement(choices, 'Choice', {'value': chinese_name, 'alias': value})

    orientation_controls = ET.SubElement(
        root,
        'View',
        {
            'className': 'furniture-instance-orientation-controls',
            'style': 'display: none;',
        },
    )
    for control_name, english_value, chinese_name, color in (
        (FRONT_DIRECTION_CONTROL, 'front_direction', '正面方向', '#2563eb'),
        (FRONT_EDGE_CONTROL, 'front_edge', '正面边', '#dc2626'),
    ):
        control = ET.SubElement(
            orientation_controls,
            'VectorLabels',
            {
                'name': control_name,
                'toName': image_name,
                'choice': 'single',
                'closable': 'false',
                'curves': 'false',
                'minPoints': '2',
                'maxPoints': '2',
                # FurnitureInstances performs source-pixel snapping itself.
                # A second canvas-level round can move a point off a diagonal
                # or hole boundary and is therefore deliberately disabled.
                'snap': 'none',
                'strokeWidth': '4',
                'pointSize': 'medium',
                'showInline': 'true',
            },
        )
        ET.SubElement(control, 'Label', {'value': chinese_name, 'alias': english_value, 'background': color})

    ET.SubElement(
        root,
        'Header',
        {
            'value': 'L4：选择 Focus 家具组团后创建家具实例；上级房间、功能分区和家具组团仅作只读边界参考。',
            'size': '5',
        },
    )
    ET.SubElement(
        root,
        'Header',
        {
            'value': '正面默认为未知；仅在明确绘制“正面方向”或“正面边”时记录朝向证据。',
            'size': '5',
        },
    )
    ET.indent(root, space='  ')
    return ET.tostring(root, encoding='unicode')
