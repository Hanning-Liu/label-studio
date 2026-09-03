import {
  isSimplePolygon,
  nearestPointOnSegment,
  pointInPolygon,
  polygonInsidePolygon,
  rotatedRectanglePoints,
  segmentInsidePolygon,
} from "../utils/roomConstraintGeometry";
import { area, difference, EPS_AREA } from "./geometry";

const close = (a, b) => Math.abs(a - b) < 1e-8;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (value) => Math.max(0, Math.min(1, value));

// Quantize the position ALONG a parent edge while keeping the point exactly on
// that edge. Rounding both coordinates would push points off diagonal edges;
// quantizing the dominant edge axis gives one-original-pixel steps without
// weakening the parent-boundary constraint.
const snapBoundaryCandidateToPixel = ({ point, start, end, kind }) => {
  if (kind === "corner" || !start || !end) return point;
  const dx = end.x - start.x,
    dy = end.y - start.y;
  if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) > 1e-10) {
    const t = clamp01((Math.round(point.x) - start.x) / dx);
    return { x: start.x + dx * t, y: start.y + dy * t };
  }
  if (Math.abs(dy) > 1e-10) {
    const t = clamp01((Math.round(point.y) - start.y) / dy);
    return { x: start.x + dx * t, y: start.y + dy * t };
  }
  return point;
};

// Work in ORIGINAL image pixels (not percentages or zoomed canvas pixels).
// Parent coordinates are never rounded. Boundary hits are quantized along the
// parent edge when pixel snapping is enabled. Snapping uses a screen-pixel radius.
export function constraintSpace(geometry, metrics = {}) {
  const {
    width = 100,
    height = 100,
    screenWidth = width,
    screenHeight = height,
    boundary = true,
    pixel = true,
    threshold = 10,
  } = metrics;
  if (geometry?.length !== 1 || geometry[0].length !== 1) throw new Error("父分区轮廓不支持交互编辑，请检查参考");
  const toPixel = (p) => ({ x: (p.x * width) / 100, y: (p.y * height) / 100 });
  const fromPixel = (p) => ({ x: (p.x * 100) / width, y: (p.y * 100) / height });
  const ring = geometry[0][0].map(([x, y]) => toPixel({ x, y }));
  if (distance(ring[0], ring.at(-1)) < 1e-10) ring.pop();
  const screenDistance = (a, b) =>
    Math.hypot(((a.x - b.x) * screenWidth) / width, ((a.y - b.y) * screenHeight) / height);
  const inside = (points, closed = true) => {
    if (!points.length || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
    if (!points.every((p) => pointInPolygon(p, ring))) return false;
    if (!closed) return points.slice(1).every((p, i) => segmentInsidePolygon(points[i], p, ring));
    if (!isSimplePolygon(points) || !polygonInsidePolygon(points, ring)) return false;
    const percent = points.map(fromPixel).map(({ x, y }) => [x, y]);
    return area(difference([[percent]], geometry)) <= EPS_AREA;
  };
  const boundaryCandidates = (point) => {
    if (!boundary) return [];
    const corners = ring
      .filter((p) => screenDistance(point, p) <= threshold)
      .map((p) => ({ point: p, kind: "corner" }));
    const edges = ring
      .map((start, i) => {
        const end = ring[(i + 1) % ring.length];
        return { point: nearestPointOnSegment(point, start, end), start, end, kind: "edge" };
      })
      .filter((candidate) => screenDistance(point, candidate.point) <= threshold);
    return [
      ...corners.sort((a, b) => screenDistance(point, a.point) - screenDistance(point, b.point)),
      ...edges.sort((a, b) => screenDistance(point, a.point) - screenDistance(point, b.point)),
    ];
  };
  const boundaryPoints = (point) =>
    boundaryCandidates(point).map((candidate) =>
      pixel ? snapBoundaryCandidateToPixel(candidate) : candidate.point,
    );
  const snap = (p) => boundaryPoints(p)[0] || (pixel ? { x: Math.round(p.x), y: Math.round(p.y) } : p);
  return {
    toPixel,
    fromPixel,
    ring,
    inside,
    snap,
    boundaryPoints,
    screenDistance,
    boundary,
    pixel,
    threshold,
    width,
    height,
  };
}

// A previously invalid legacy drawing is preserved until the user moves it
// fully inside or explicitly applies its clipping preview; never rewrite on load.
function limit(previous, target, valid, interpolate) {
  if (valid(target)) return target;
  if (!valid(previous)) return previous;
  let low = 0,
    high = 1,
    accepted = previous;
  for (let i = 0; i < 40; i++) {
    const t = (low + high) / 2,
      candidate = interpolate(previous, target, t);
    if (valid(candidate)) {
      low = t;
      accepted = candidate;
    } else high = t;
  }
  return accepted;
}

export function snapOccupancyPoint(point, space) {
  const p = space.toPixel(point),
    snapped = space.snap(p);
  return space.fromPixel(pointInPolygon(snapped, space.ring) ? snapped : p);
}

export function constrainPolygon(previous, target, space, closed = true, snap = true) {
  const old = previous.map(space.toPixel),
    proposed = target.map(space.toPixel);
  const valid = (points) => space.inside(points, closed);
  const interpolate = (a, b, t) => a.map((p, i) => ({ x: mix(p.x, b[i].x, t), y: mix(p.y, b[i].y, t) }));
  let accepted = limit(old, proposed, valid, interpolate);
  if (!snap) return accepted.map(space.fromPixel);
  const translating =
    old.length === proposed.length &&
    old.every(
      (p, i) =>
        close(proposed[i].x - p.x, proposed[0].x - old[0].x) && close(proposed[i].y - p.y, proposed[0].y - old[0].y),
    );
  if (translating) {
    const offsets = accepted.flatMap((p) => space.boundaryPoints(p).map((q) => ({ x: q.x - p.x, y: q.y - p.y })));
    if (space.pixel)
      offsets.push({ x: Math.round(accepted[0].x) - accepted[0].x, y: Math.round(accepted[0].y) - accepted[0].y });
    for (const offset of offsets) {
      const candidate = accepted.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y }));
      if (valid(candidate)) {
        accepted = candidate;
        break;
      }
    }
  } else {
    // Do not round unchanged vertices or distort a translated polygon.
    accepted = accepted.map((p, i) => {
      if (close(proposed[i].x, old[i].x) && close(proposed[i].y, old[i].y)) return p;
      const candidate = [...accepted];
      candidate[i] = space.snap(p);
      if (valid(candidate)) {
        accepted = candidate;
        return candidate[i];
      }
      return p;
    });
  }
  return accepted.map(space.fromPixel);
}

export function constrainRectangle(previous, target, space) {
  const toRect = (r) => ({
    ...space.toPixel(r),
    width: (r.width * space.width) / 100,
    height: (r.height * space.height) / 100,
    rotation: r.rotation || 0,
  });
  const old = toRect(previous),
    proposed = toRect(target);
  const valid = (r) =>
    r.width >= 0 && r.height >= 0 && space.inside(rotatedRectanglePoints(r), r.width > 1e-10 && r.height > 1e-10);
  const interpolate = (a, b, t) => ({
    x: mix(a.x, b.x, t),
    y: mix(a.y, b.y, t),
    width: mix(a.width, b.width, t),
    height: mix(a.height, b.height, t),
    rotation: a.rotation + (((b.rotation - a.rotation + 540) % 360) - 180) * t,
  });
  let accepted = limit(old, proposed, valid, interpolate);
  const translating =
    close(old.width, proposed.width) && close(old.height, proposed.height) && close(old.rotation, proposed.rotation);
  if (translating) {
    const corners = rotatedRectanglePoints(accepted);
    const offsets = corners.flatMap((p) => space.boundaryPoints(p).map((q) => ({ x: q.x - p.x, y: q.y - p.y })));
    if (space.pixel) offsets.push({ x: Math.round(accepted.x) - accepted.x, y: Math.round(accepted.y) - accepted.y });
    for (const offset of offsets) {
      const candidate = { ...accepted, x: accepted.x + offset.x, y: accepted.y + offset.y };
      if (valid(candidate)) {
        accepted = candidate;
        break;
      }
    }
  } else if (close(old.rotation, proposed.rotation)) {
    // Snap only the moving sides, in the rectangle's local basis. This also
    // handles rotated rectangles without substituting an axis-aligned bbox.
    const radians = (accepted.rotation * Math.PI) / 180,
      c = Math.cos(radians),
      s = Math.sin(radians);
    const local = (p) => ({ x: p.x * c + p.y * s, y: -p.x * s + p.y * c });
    const world = (p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c });
    const bounds = (r) => {
      const p = local(r);
      return [p.x, p.x + r.width, p.y, p.y + r.height];
    };
    const before = bounds(old),
      desired = bounds(proposed);
    let edges = bounds(accepted);
    const parent = space.ring.map(local);
    const rectangle = (e) => ({
      ...world({ x: e[0], y: e[2] }),
      width: e[1] - e[0],
      height: e[3] - e[2],
      rotation: accepted.rotation,
    });
    for (let side = 0; side < 4; side++) {
      if (close(before[side], desired[side])) continue;
      const axis = side < 2 ? "x" : "y",
        other = axis === "x" ? "y" : "x";
      const ends = side < 2 ? [edges[2], edges[3]] : [edges[0], edges[1]];
      const candidates = [];
      if (space.boundary)
        for (const end of ends)
          for (let i = 0; i < parent.length; i++) {
            const a = parent[i],
              b = parent[(i + 1) % parent.length];
            if (close(a[other], b[other])) continue;
            const t = (end - a[other]) / (b[other] - a[other]);
            if (t < -1e-10 || t > 1 + 1e-10) continue;
            const value = mix(a[axis], b[axis], t);
            if (
              space.screenDistance(
                world({ [axis]: edges[side], [other]: end }),
                world({ [axis]: value, [other]: end }),
              ) <= space.threshold
            )
              candidates.push(value);
          }
      candidates.sort((a, b) => Math.abs(a - edges[side]) - Math.abs(b - edges[side]));
      if (space.pixel) candidates.push(Math.round(edges[side]));
      for (const value of candidates) {
        const candidate = [...edges];
        candidate[side] = value;
        if (valid(rectangle(candidate))) {
          edges = candidate;
          break;
        }
      }
    }
    accepted = rectangle(edges);
  }
  return {
    ...space.fromPixel(accepted),
    width: (accepted.width * 100) / space.width,
    height: (accepted.height * 100) / space.height,
    rotation: accepted.rotation,
  };
}
