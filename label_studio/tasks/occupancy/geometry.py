"""Independent Shapely validation. Never repair, simplify, buffer or drop slivers."""
import hashlib
import json
import math

from shapely.geometry import Polygon

EPS_AREA = 1e-8


def canonical(value):
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (float, int)):
        if not math.isfinite(value):
            raise ValueError('Non-finite fingerprint input')
        fixed = format(value, '.10f')
        return '0.0000000000' if fixed == '-0.0000000000' else fixed
    if isinstance(value, list):
        return [canonical(v) for v in value]
    if isinstance(value, dict):
        return {k: canonical(value[k]) for k in sorted(value)}
    return value


def fingerprint(value):
    return hashlib.sha256(json.dumps(canonical(value), ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def result_geometry(result):
    v = result.get('value', {})
    if 'points' in v:
        points = v['points']
    elif 'width' in v and 'height' in v:
        w, h = result.get('original_width', 0), result.get('original_height', 0)
        if min(w, h, v['width'], v['height']) <= 0:
            raise ValueError('矩形尺寸或原图尺寸无效')
        a = math.radians(v.get('rotation', 0))
        points = [[v['x'] + x * math.cos(a) - y * h / w * math.sin(a),
                   v['y'] + x * w / h * math.sin(a) + y * math.cos(a)]
                  for x, y in [(0, 0), (v['width'], 0), (v['width'], v['height']), (0, v['height'])]]
    else:
        raise ValueError('区域没有有效几何')
    if len(points) < 3 or any(len(p) != 2 or not all(isinstance(n, (int, float)) and math.isfinite(n) for n in p) for p in points):
        raise ValueError('轮廓坐标无效')
    geometry = Polygon(points)
    if geometry.is_empty or not geometry.is_valid or geometry.area == 0:
        raise ValueError('轮廓自交或面积为零')
    return geometry
