"""Insert a copied reference control while preserving every original XML byte."""

import copy
from xml.parsers import expat

from lxml import etree

from .lineage import WINDOW, controls, validate_window_config


def upgrade_window_control(config, source_config, windows):
    parser = etree.XMLParser(resolve_entities=False, no_network=True, remove_blank_text=False)
    root = etree.fromstring(config.encode('utf-8'), parser)
    source = etree.fromstring(source_config.encode('utf-8'), parser)
    if root.getroottree().docinfo.doctype or source.getroottree().docinfo.doctype:
        raise ValueError('不支持包含 DTD 的标注配置')
    named = controls(config)
    controls(source_config)
    if not windows or WINDOW in named:
        validate_window_config(config, windows)
        return config, []
    candidates = source.xpath('.//*[@name="window_vector"]')
    if len(candidates) != 1:
        raise ValueError('L1 缺少唯一的 window_vector 控件')
    hidden = etree.Element('View', style='display: none;', className='window-lineage-reference-controls')
    copied = copy.deepcopy(candidates[0])
    copied.tail = None
    for node in copied.iter():
        node.attrib.pop('hotkey', None)
        node.attrib.pop('required', None)
    hidden.append(copied)
    raw = config.encode('utf-8')
    locator = expat.ParserCreate()
    depth, end = 0, None

    def start(_name, _attrs):
        nonlocal depth
        depth += 1

    def finish(_name):
        nonlocal depth, end
        depth -= 1
        if depth == 0:
            end = locator.CurrentByteIndex

    locator.StartElementHandler, locator.EndElementHandler = start, finish
    locator.Parse(raw, True)
    if end is None or raw[end:end + 2] != b'</':
        raise ValueError('无法安全定位根 View 的结束位置')
    newline = b'\r\n' if b'\r\n' in raw else b'\n'
    updated = (raw[:end] + etree.tostring(hidden, encoding='utf-8') + newline + raw[end:]).decode('utf-8')
    validate_window_config(updated, windows)
    return updated, [WINDOW]
