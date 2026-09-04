import { windowFingerprint } from "./fingerprint";

const EPS = 1e-9;
const MAX_BEZIER_DEPTH = 20;

const finitePoint = (point) =>
  point && Number.isFinite(Number(point.x ?? point[0])) && Number.isFinite(Number(point.y ?? point[1]));

const pointObject = (point) => ({
  x: Number(point.x ?? point[0]),
  y: Number(point.y ?? point[1]),
});

const distance = (first, second) => Math.hypot(second.x - first.x, second.y - first.y);

const cross = (first, second, third) =>
  (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);

const onSegment = (start, end, point) =>
  Math.abs(cross(start, end, point)) <= EPS &&
  point.x >= Math.min(start.x, end.x) - EPS &&
  point.x <= Math.max(start.x, end.x) + EPS &&
  point.y >= Math.min(start.y, end.y) - EPS &&
  point.y <= Math.max(start.y, end.y) + EPS;

const segmentsIntersect = (first, second) => {
  const c1 = cross(first.start, first.end, second.start);
  const c2 = cross(first.start, first.end, second.end);
  const c3 = cross(second.start, second.end, first.start);
  const c4 = cross(second.start, second.end, first.end);
  return (
    (c1 * c2 < -EPS && c3 * c4 < -EPS) ||
    onSegment(first.start, first.end, second.start) ||
    onSegment(first.start, first.end, second.end) ||
    onSegment(second.start, second.end, first.start) ||
    onSegment(second.start, second.end, first.end)
  );
};

const midpoint = (first, second) => ({ x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 });

const pointLineDistance = (point, start, end) => {
  const length = distance(start, end);
  if (length <= EPS) return distance(point, start);
  return Math.abs((end.x - start.x) * (start.y - point.y) - (start.x - point.x) * (end.y - start.y)) / length;
};

export function orderWindowVertices(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 2) throw new Error("至少需要两个顶点");
  if (vertices.some((vertex) => !finitePoint(vertex))) throw new Error("顶点坐标无效");
  if (vertices.some((vertex) => vertex.disconnected || vertex.isBranching)) throw new Error("窗线必须是单条连续路径");

  const identifiers = vertices.map((vertex) => vertex.id);
  if (identifiers.every((identifier) => identifier == null)) return vertices.slice();
  if (identifiers.some((identifier) => typeof identifier !== "string" || !identifier)) {
    throw new Error("顶点 ID 不完整");
  }

  const byId = new Map();
  for (const vertex of vertices) {
    if (byId.has(vertex.id)) throw new Error(`顶点 ID 重复：${vertex.id}`);
    byId.set(vertex.id, vertex);
  }
  const children = new Map();
  for (const vertex of vertices) {
    if (!vertex.prevPointId) continue;
    if (!byId.has(vertex.prevPointId)) throw new Error(`找不到前一顶点：${vertex.prevPointId}`);
    if (children.has(vertex.prevPointId)) throw new Error("窗线存在分支");
    children.set(vertex.prevPointId, vertex);
  }
  const starts = vertices.filter((vertex) => !vertex.prevPointId);
  if (starts.length !== 1) throw new Error("窗线必须只有一个起点");
  const ordered = [];
  const seen = new Set();
  let current = starts[0];
  while (current) {
    if (seen.has(current.id)) throw new Error("窗线存在闭环");
    seen.add(current.id);
    ordered.push(current);
    current = children.get(current.id);
  }
  if (ordered.length !== vertices.length) throw new Error("窗线包含不连续的顶点链");
  return ordered;
}

const percentPointToPixels = (point, width, height) => ({
  x: (Number(point.x ?? point[0]) * width) / 100,
  y: (Number(point.y ?? point[1]) * height) / 100,
});

function cubicControls(from, to, width, height) {
  const start = percentPointToPixels(from, width, height);
  const end = percentPointToPixels(to, width, height);
  let first =
    from.isBezier && finitePoint(from.controlPoint2) ? percentPointToPixels(from.controlPoint2, width, height) : null;
  let second =
    to.isBezier && finitePoint(to.controlPoint1) ? percentPointToPixels(to.controlPoint1, width, height) : null;
  if (!first && !second) return null;
  if (!first) first = { x: start.x + (end.x - start.x) * 0.3, y: start.y + (end.y - start.y) * 0.3 };
  if (!second) second = { x: end.x - (end.x - start.x) * 0.3, y: end.y - (end.y - start.y) * 0.3 };
  return [start, first, second, end];
}

function flattenCubic(points, t0, t1, tolerance, depth, output) {
  const [start, first, second, end] = points;
  if (
    depth >= MAX_BEZIER_DEPTH ||
    Math.max(pointLineDistance(first, start, end), pointLineDistance(second, start, end)) <= tolerance
  ) {
    output.push({ point: end, t: t1 });
    return;
  }
  const a = midpoint(start, first);
  const b = midpoint(first, second);
  const c = midpoint(second, end);
  const d = midpoint(a, b);
  const e = midpoint(b, c);
  const middle = midpoint(d, e);
  const tm = (t0 + t1) / 2;
  flattenCubic([start, a, d, middle], t0, tm, tolerance, depth + 1, output);
  flattenCubic([middle, e, c, end], tm, t1, tolerance, depth + 1, output);
}

export function flattenWindowPath(result, flatteningTolerancePx = 0.25) {
  const value = result?.value || {};
  if (value.closed !== false) throw new Error("窗户必须使用开放式 Vector");
  const width = Number(result?.original_width);
  const height = Number(result?.original_height);
  if (!(width > 0 && height > 0)) throw new Error("缺少原图尺寸");
  const tolerance = Number(flatteningTolerancePx);
  if (!(tolerance > 0)) throw new Error("Bezier 折线化容差必须大于 0");
  const vertices = orderWindowVertices(value.vertices);
  const segments = [];
  let pathLength = 0;
  let hasBezier = false;
  for (let index = 0; index < vertices.length - 1; index++) {
    const from = vertices[index];
    const to = vertices[index + 1];
    const startPoint = percentPointToPixels(from, width, height);
    const endPoint = percentPointToPixels(to, width, height);
    // Keep the editor aligned with formal server validation: control handles
    // cannot turn coincident path vertices into an accepted window segment.
    if (distance(startPoint, endPoint) <= EPS) throw new Error(`第 ${index + 1} 段长度为 0`);
    const controls = cubicControls(from, to, width, height);
    const samples = [{ point: startPoint, t: 0 }];
    if (controls) {
      hasBezier = true;
      flattenCubic(controls, 0, 1, tolerance, 0, samples);
    } else {
      samples.push({ point: endPoint, t: 1 });
    }
    for (let sample = 0; sample < samples.length - 1; sample++) {
      const start = samples[sample];
      const end = samples[sample + 1];
      const length = distance(start.point, end.point);
      if (length <= EPS) continue;
      segments.push({
        start: start.point,
        end: end.point,
        length,
        pathStart: pathLength,
        pathEnd: pathLength + length,
        sourceSegmentIndex: index,
        sourceT0: start.t,
        sourceT1: end.t,
      });
      pathLength += length;
    }
  }
  if (pathLength <= EPS) throw new Error("窗线长度必须大于 0");
  for (let first = 0; first < segments.length; first++) {
    for (let second = first + 2; second < segments.length; second++) {
      if (segmentsIntersect(segments[first], segments[second])) throw new Error("窗线不得自交");
    }
  }
  return {
    kind: hasBezier ? "bezier" : vertices.length === 2 ? "line" : "polyline",
    length: pathLength,
    segments,
  };
}

function collectRings(value) {
  const rings = [];
  const visit = (node) => {
    if (!Array.isArray(node) || !node.length) return;
    if (node.every(finitePoint)) {
      rings.push(node.map(pointObject));
      return;
    }
    node.forEach(visit);
  };
  if (Array.isArray(value.points)) visit(value.points);
  else if (Array.isArray(value.coordinates)) visit(value.coordinates);
  else if (Array.isArray(value.polygons)) visit(value.polygons);
  return rings;
}

function rectangleRing(result) {
  const value = result.value || {};
  const width = Number(result.original_width);
  const height = Number(result.original_height);
  if (!(width > 0 && height > 0) || !(Number(value.width) > 0 && Number(value.height) > 0)) {
    throw new Error("房间矩形尺寸无效");
  }
  const origin = { x: (Number(value.x) * width) / 100, y: (Number(value.y) * height) / 100 };
  const rectangleWidth = (Number(value.width) * width) / 100;
  const rectangleHeight = (Number(value.height) * height) / 100;
  const angle = (Number(value.rotation || 0) * Math.PI) / 180;
  return [
    [0, 0],
    [rectangleWidth, 0],
    [rectangleWidth, rectangleHeight],
    [0, rectangleHeight],
  ].map(([x, y]) => ({
    x: origin.x + x * Math.cos(angle) - y * Math.sin(angle),
    y: origin.y + x * Math.sin(angle) + y * Math.cos(angle),
  }));
}

export function roomPixelRings(result) {
  const value = result?.value || {};
  const width = Number(result?.original_width);
  const height = Number(result?.original_height);
  if (!(width > 0 && height > 0)) throw new Error("房间缺少原图尺寸");
  const rings =
    Number.isFinite(Number(value.width)) && Number.isFinite(Number(value.height))
      ? [rectangleRing(result)]
      : collectRings(value).map((ring) => ring.map((point) => percentPointToPixels(point, width, height)));
  if (!rings.length) throw new Error("不支持的房间几何");
  return rings;
}

export function roomBoundarySegments(result, roomId) {
  const rings = roomPixelRings(result);
  const segments = [];
  rings.forEach((input, ringIndex) => {
    const ring = input.slice();
    if (ring.length > 1 && distance(ring[0], ring.at(-1)) <= EPS) ring.pop();
    if (ring.length < 3) throw new Error("房间轮廓至少需要三个顶点");
    const signedArea = ring.reduce((total, point, index) => {
      const next = ring[(index + 1) % ring.length];
      return total + point.x * next.y - next.x * point.y;
    }, 0);
    if (Math.abs(signedArea) <= EPS) throw new Error("房间轮廓面积必须大于 0");
    for (let edgeIndex = 0; edgeIndex < ring.length; edgeIndex++) {
      const start = ring[edgeIndex];
      const end = ring[(edgeIndex + 1) % ring.length];
      const length = distance(start, end);
      if (length <= EPS) continue;
      const orderedEndpoints = [start, end]
        .map((point) => [Number(point.x.toFixed(6)), Number(point.y.toFixed(6))])
        .sort((first, second) => first[0] - second[0] || first[1] - second[1]);
      const token = windowFingerprint({ room_id: roomId, endpoints_px: orderedEndpoints }).slice(0, 16);
      const direction = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
      const left = { x: -direction.y, y: direction.x };
      segments.push({
        id: `room-segment:${roomId}:${token}`,
        ringIndex,
        edgeIndex,
        start,
        end,
        length,
        inwardNormal: signedArea > 0 ? left : { x: -left.x, y: -left.y },
      });
    }
  });
  if (!segments.length) throw new Error("房间轮廓没有正长度边");
  return segments;
}

function linearRange(base, slope, minimum, maximum) {
  if (Math.abs(slope) <= EPS) return base >= minimum - EPS && base <= maximum + EPS ? [0, 1] : null;
  const first = (minimum - base) / slope;
  const second = (maximum - base) / slope;
  return [Math.max(0, Math.min(first, second)), Math.min(1, Math.max(first, second))];
}

function intersectRanges(...ranges) {
  if (ranges.some((range) => !range)) return null;
  const start = Math.max(...ranges.map((range) => range[0]));
  const end = Math.min(...ranges.map((range) => range[1]));
  return end - start > EPS ? [start, end] : null;
}

function supportingInterval(trace, boundary, tolerance, maximumTangentDeltaDeg) {
  const tx = trace.end.x - trace.start.x;
  const ty = trace.end.y - trace.start.y;
  const bx = boundary.end.x - boundary.start.x;
  const by = boundary.end.y - boundary.start.y;
  const cosine = Math.min(1, Math.abs((tx * bx + ty * by) / (trace.length * boundary.length)));
  const angle = (Math.acos(cosine) * 180) / Math.PI;
  if (angle > maximumTangentDeltaDeg + EPS) return null;

  const ux = bx / boundary.length;
  const uy = by / boundary.length;
  const nx = -uy;
  const ny = ux;
  const dx = trace.start.x - boundary.start.x;
  const dy = trace.start.y - boundary.start.y;
  const along = dx * ux + dy * uy;
  const alongSlope = tx * ux + ty * uy;
  const perpendicular = dx * nx + dy * ny;
  const perpendicularSlope = tx * nx + ty * ny;
  const range = intersectRanges(
    [0, 1],
    linearRange(along, alongSlope, 0, boundary.length),
    linearRange(perpendicular, perpendicularSlope, -tolerance, tolerance),
  );
  if (!range) return null;
  return [trace.pathStart + range[0] * trace.length, trace.pathStart + range[1] * trace.length];
}

function unionIntervals(intervals) {
  const sorted = intervals
    .filter(([start, end]) => end - start > EPS)
    .sort((first, second) => first[0] - second[0] || first[1] - second[1]);
  const union = [];
  for (const interval of sorted) {
    const previous = union.at(-1);
    if (!previous || interval[0] > previous[1] + EPS) union.push(interval.slice());
    else previous[1] = Math.max(previous[1], interval[1]);
  }
  return union;
}

export function boundaryOverlap(path, boundarySegments, options = {}) {
  const tolerance = Number(options.boundaryMatchTolerancePx ?? 2);
  const maximumTangentDeltaDeg = Number(options.maximumTangentDeltaDeg ?? 10);
  if (!(tolerance > 0)) throw new Error("房间边界匹配容差必须大于 0");
  if (!(maximumTangentDeltaDeg >= 0 && maximumTangentDeltaDeg <= 90))
    throw new Error("切线角阈值必须在 0 到 90 度之间");
  const intervals = [];
  const segmentIds = new Set();
  for (const trace of path.segments) {
    for (const boundary of boundarySegments) {
      const interval = supportingInterval(trace, boundary, tolerance, maximumTangentDeltaDeg);
      if (!interval) continue;
      intervals.push(interval);
      segmentIds.add(boundary.id);
    }
  }
  const merged = unionIntervals(intervals);
  const overlapLength = merged.reduce((total, [start, end]) => total + end - start, 0);
  const coverageEpsilon = Math.max(1e-6, tolerance * 0.01);
  return {
    intervals: merged,
    overlapLength,
    full: overlapLength > EPS && path.length - overlapLength <= coverageEpsilon,
    roomBoundarySegmentIds: [...segmentIds].sort(),
  };
}
