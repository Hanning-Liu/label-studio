"""Independent Shapely validation. Never repair, simplify, buffer or drop slivers."""
import hashlib
import json
import math

from shapely import union_all
from shapely.geometry import MultiPolygon, Polygon

EPS_AREA = 1e-8
VALIDATION_PIXEL_EPS = 1e-5
# Validation runs independently in Shapely and polygon-clipping. Boolean
# operations can leave different sub-pixel slivers even after coordinates have
# been canonicalized. Ignore only differences below one thousandth of a source
# pixel area; this does not alter stored geometry or remove storage components.
VALIDATION_EPS_AREA = 1e-3


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


def _validation_pixel_coordinate(value):
    integer = round(value)
    return integer if abs(value - integer) <= VALIDATION_PIXEL_EPS else value


def validation_geometry(result):
    """Return validation-only geometry in original image pixels.

    Percentage coordinates that are within 0.00001px of an integer source
    pixel are canonicalized to that pixel. The annotation JSON is not mutated.
    """
    width, height = result.get('original_width', 0), result.get('original_height', 0)
    if not (isinstance(width, (int, float)) and isinstance(height, (int, float))
            and math.isfinite(width) and math.isfinite(height) and width > 0 and height > 0):
        raise ValueError('缺少原图尺寸，无法进行像素级几何校验')
    return validation_shape(result_geometry(result), width, height)


def _validation_polygon(polygon, width, height):
    def ring_coordinates(ring, normalize):
        coordinates = []
        for x, y in list(ring.coords)[:-1]:
            x, y = x * width / 100, y * height / 100
            coordinates.append((_validation_pixel_coordinate(x), _validation_pixel_coordinate(y)) if normalize else (x, y))
        return coordinates

    scaled = Polygon(ring_coordinates(polygon.exterior, False), [ring_coordinates(ring, False) for ring in polygon.interiors])
    normalized = Polygon(ring_coordinates(polygon.exterior, True), [ring_coordinates(ring, True) for ring in polygon.interiors])
    # Never discard a genuine sub-pixel component or hole. Logical storage
    # pieces are unioned before this function is called, so falling back here
    # preserves semantic geometry rather than internal triangulation edges.
    if normalized.is_empty or not normalized.is_valid or normalized.area == 0:
        return scaled
    return normalized


def validation_shape(geometry, width, height):
    if not (isinstance(width, (int, float)) and isinstance(height, (int, float))
            and math.isfinite(width) and math.isfinite(height) and width > 0 and height > 0):
        raise ValueError('缺少原图尺寸，无法进行像素级几何校验')
    if isinstance(geometry, Polygon):
        return _validation_polygon(geometry, width, height)
    if isinstance(geometry, MultiPolygon):
        return union_all([_validation_polygon(polygon, width, height) for polygon in geometry.geoms])
    raise ValueError('不支持的逻辑区域几何')
