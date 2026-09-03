import { resultGeometry, union } from "./geometry";

export const BARRIER_CONTROL = "occupancy_barrier_vector";
export const BARRIER_LABEL = "wall_barrier";
export const BARRIER_GRID_PX = 1e-6;
export const BARRIER_MIN_OVERLAP_PX = 1e-7;

const GEOMETRY = new Set(["occupancy_rectangle", "occupancy_polygon"]);
const roundGrid = (value) => Math.round(value / BARRIER_GRID_PX) * BARRIER_GRID_PX;
const point = ([x, y]) => ({ x: roundGrid(x), y: roundGrid(y) });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b, scale = 1) => ({ x: a.x + b.x * scale, y: a.y + b.y * scale });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const cross = (a, b) => a.x * b.y - a.y * b.x;
const length = (a) => Math.hypot(a.x, a.y);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const controlName = (result) => result?.from_name?.name || result?.from_name;
const context = (result) => result?.meta?.occupancy_barrier_context || {};
const occupancyContext = (result) => result?.meta?.occupancy_context || {};

export const isOccupancyBarrierRegion = (region) =>
  !!region?.results?.some((result) => controlName(result) === BARRIER_CONTROL);

export const partitionOccupancyBarrierRegions = (regions) => {
  const foreground = [];
  const background = [];

  for (const region of regions) {
    (isOccupancyBarrierRegion(region) ? foreground : background).push(region);
  }

  return { foreground, background };
};
const labelOf = (results, id) =>
  results.find((result) => result.id === id && result.from_name === "occupancy_type")?.value?.labels?.[0];

const canonicalPair = (source, target) => (source < target ? [source, target] : [target, source]);
const pairKey = (source, target) => canonicalPair(source, target).join("\u0000");

const pixelGeometry = (geometry, width, height) =>
  geometry.map((polygon) =>
    polygon.map((ring) => ring.map(([x, y]) => [roundGrid((x * width) / 100), roundGrid((y * height) / 100)])),
  );

const ringSegments = (geometry) =>
  geometry.flatMap((polygon) =>
    polygon.flatMap((ring) => {
      const points = ring.map(point);
      if (points.length > 1 && distance(points[0], points.at(-1)) <= BARRIER_GRID_PX) points.pop();
      return points.map((start, index) => ({ start, end: points[(index + 1) % points.length] }));
    }),
  );

function overlappingSegment(first, second) {
  const direction = sub(first.end, first.start);
  const firstLength = length(direction);
  const otherDirection = sub(second.end, second.start);
  const otherLength = length(otherDirection);
  if (firstLength <= BARRIER_MIN_OVERLAP_PX || otherLength <= BARRIER_MIN_OVERLAP_PX) return null;
  const unit = { x: direction.x / firstLength, y: direction.y / firstLength };
  const normal = { x: -unit.y, y: unit.x };
  if (Math.abs(cross(unit, { x: otherDirection.x / otherLength, y: otherDirection.y / otherLength })) > 1e-8)
    return null;
  if (
    Math.abs(dot(sub(second.start, first.start), normal)) > BARRIER_GRID_PX * 2 ||
    Math.abs(dot(sub(second.end, first.start), normal)) > BARRIER_GRID_PX * 2
  )
    return null;
  const firstStart = 0;
  const firstEnd = firstLength;
  const secondStart = dot(sub(second.start, first.start), unit);
  const secondEnd = dot(sub(second.end, first.start), unit);
  const low = Math.max(firstStart, Math.min(secondStart, secondEnd));
  const high = Math.min(firstEnd, Math.max(secondStart, secondEnd));
  if (high - low <= BARRIER_MIN_OVERLAP_PX) return null;
  return { start: add(first.start, unit, low), end: add(first.start, unit, high), length: high - low };
}

function furnitureGroups(results, parentId, width, height) {
  const groups = new Map();
  for (const result of results) {
    if (!GEOMETRY.has(result.from_name) || labelOf(results, result.id) !== "furniture_group") continue;
    const c = occupancyContext(result);
    if (c.parent_zone_id !== parentId || !c.logical_id) continue;
    if (!groups.has(c.logical_id)) groups.set(c.logical_id, { id: c.logical_id, type: c.group_type, parts: [] });
    groups.get(c.logical_id).parts.push(resultGeometry(result));
  }
  return [...groups.values()]
    .map((group) => ({ ...group, geometry: pixelGeometry(union(...group.parts), width, height) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function sharedFurnitureBoundaries(results, parentId, width, height) {
  const groups = furnitureGroups(results, parentId, width, height);
  const segments = [];
  for (let index = 0; index < groups.length; index++) {
    for (const target of groups.slice(index + 1)) {
      const source = groups[index];
      const [sourceId, targetId] = canonicalPair(source.id, target.id);
      for (const first of ringSegments(source.geometry)) {
        for (const second of ringSegments(target.geometry)) {
          const overlap = overlappingSegment(first, second);
          if (overlap)
            segments.push({
              ...overlap,
              source_group_id: sourceId,
              target_group_id: targetId,
              source_group_type: source.id === sourceId ? source.type : target.type,
              target_group_type: source.id === sourceId ? target.type : source.type,
              pair_key: pairKey(sourceId, targetId),
            });
        }
      }
    }
  }
  return segments;
}

const supportCoordinates = (segment) => {
  let direction = sub(segment.end, segment.start);
  const size = length(direction);
  direction = { x: direction.x / size, y: direction.y / size };
  if (direction.x < -1e-12 || (Math.abs(direction.x) <= 1e-12 && direction.y < 0))
    direction = { x: -direction.x, y: -direction.y };
  const normal = { x: -direction.y, y: direction.x };
  const offset = dot(segment.start, normal);
  return { direction, normal, offset };
};

const sameSupport = (left, right) => {
  const a = supportCoordinates(left);
  const b = supportCoordinates(right);
  return Math.abs(cross(a.direction, b.direction)) <= 1e-8 && Math.abs(a.offset - b.offset) <= BARRIER_GRID_PX * 3;
};

function supportClusters(segments) {
  const remaining = [...segments];
  const clusters = [];
  while (remaining.length) {
    const seed = remaining.shift();
    const support = supportCoordinates(seed);
    const collinear = [seed];
    for (let index = remaining.length - 1; index >= 0; index--) {
      if (sameSupport(seed, remaining[index])) collinear.push(...remaining.splice(index, 1));
    }
    const intervals = collinear
      .map((segment) => ({
        low: Math.min(dot(segment.start, support.direction), dot(segment.end, support.direction)),
        high: Math.max(dot(segment.start, support.direction), dot(segment.end, support.direction)),
        segment,
      }))
      .sort((a, b) => a.low - b.low || a.high - b.high);
    let current = null;
    for (const interval of intervals) {
      if (!current || interval.low > current.high + BARRIER_GRID_PX * 3) {
        current = { ...support, low: interval.low, high: interval.high, intervals: [interval] };
        clusters.push(current);
      } else {
        current.high = Math.max(current.high, interval.high);
        current.intervals.push(interval);
      }
    }
  }
  return clusters;
}

const vectorVertices = (result, width, height) => {
  const vertices = result?.value?.vertices;
  if (!Array.isArray(vertices) || vertices.length !== 2) return [];
  if (vertices.some((vertex) => !Number.isFinite(vertex?.x) || !Number.isFinite(vertex?.y) || vertex?.isBezier)) return [];
  return vertices.map((vertex) => ({ x: (vertex.x * width) / 100, y: (vertex.y * height) / 100 }));
};

const projectToSupport = (p, support) => add(p, support.normal, support.offset - dot(p, support.normal));
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const fromSupport = (support, coordinate) =>
  add({ x: support.normal.x * support.offset, y: support.normal.y * support.offset }, support.direction, coordinate);

export function matchOccupancyBarrier(results, barrierResult, metrics = {}) {
  const width = barrierResult?.original_width || metrics.width;
  const height = barrierResult?.original_height || metrics.height;
  const c = context(barrierResult);
  const parentId = metrics.parentId || c.parent_zone_id;
  const parent = results.find((result) => result.id === parentId && ["zone_rectangle", "zone_polygon"].includes(result.from_name));
  const raw = vectorVertices(barrierResult, width, height);
  if (!(width > 0 && height > 0) || !parent || raw.length !== 2 || distance(raw[0], raw[1]) <= BARRIER_MIN_OVERLAP_PX)
    return { matchedPairs: [], snappedVertices: null, reason: "隔墙 Vector 必须包含两个有效端点，并且所属功能分区必须存在" };

  const screenWidth = metrics.screenWidth || width;
  const screenHeight = metrics.screenHeight || height;
  const threshold = metrics.threshold ?? 10;
  const screenDistance = (a, b) =>
    Math.hypot(((a.x - b.x) * screenWidth) / width, ((a.y - b.y) * screenHeight) / height);
  const rawDirection = sub(raw[1], raw[0]);
  const rawLength = length(rawDirection);
  const sharedBoundaries = sharedFurnitureBoundaries(results, parentId, width, height);
  const candidates = [];
  for (const support of supportClusters(sharedBoundaries)) {
    const parallel = Math.abs(cross({ x: rawDirection.x / rawLength, y: rawDirection.y / rawLength }, support.direction));
    if (parallel > Math.sin(Math.PI / 12)) continue;
    const projected = raw.map((p) => projectToSupport(p, support));
    const distances = raw.map((p, index) => screenDistance(p, projected[index]));
    if (distances.some((value) => value > threshold)) continue;
    const coordinates = projected.map((p) => clamp(dot(p, support.direction), support.low, support.high));
    if (Math.abs(coordinates[1] - coordinates[0]) <= BARRIER_MIN_OVERLAP_PX) continue;
    const low = Math.min(...coordinates);
    const high = Math.max(...coordinates);
    const matched = new Map();
    for (const interval of support.intervals) {
      const overlap = Math.min(high, interval.high) - Math.max(low, interval.low);
      if (overlap <= BARRIER_MIN_OVERLAP_PX) continue;
      const key = interval.segment.pair_key;
      const record = matched.get(key) || {
        source_group_id: interval.segment.source_group_id,
        target_group_id: interval.segment.target_group_id,
        source_group_type: interval.segment.source_group_type,
        target_group_type: interval.segment.target_group_type,
        shared_boundary_length_px: 0,
        barrier_overlap_length_px: 0,
      };
      record.barrier_overlap_length_px += overlap;
      matched.set(key, record);
    }
    if (!matched.size) continue;
    const totals = new Map();
    for (const segment of sharedBoundaries)
      totals.set(segment.pair_key, (totals.get(segment.pair_key) || 0) + segment.length);
    for (const [key, record] of matched) record.shared_boundary_length_px = totals.get(key) || 0;
    candidates.push({
      score: distances[0] + distances[1],
      snapped: coordinates.map((coordinate) => fromSupport(support, coordinate)),
      matched: [...matched.values()].sort((a, b) => pairKey(a.source_group_id, a.target_group_id).localeCompare(pairKey(b.source_group_id, b.target_group_id))),
    });
  }
  const selected = candidates.sort((a, b) => a.score - b.score)[0];
  if (!selected)
    return { matchedPairs: [], snappedVertices: null, reason: "未命中当前 Focus 内任何家具组团的正长度公共边界" };

  return {
    matchedPairs: selected.matched,
    snappedVertices: selected.snapped.map((p) => ({ x: (p.x * 100) / width, y: (p.y * 100) / height })),
    reason: "",
  };
}

export const barrierResults = (results) => results.filter((result) => result.from_name === BARRIER_CONTROL);

export function barrierSemantic(result) {
  const c = context(result);
  return {
    id: result.id,
    control: result.from_name,
    value: result.value,
    width: result.original_width,
    height: result.original_height,
    barrier_type: c.barrier_type,
    parent_zone_id: c.parent_zone_id,
    parent_room_id: c.parent_room_id,
    source_version: c.source_version,
    parent_fingerprint: c.parent_fingerprint,
    match_rule: c.match_rule,
    matched_pairs: c.matched_pairs || [],
  };
}

export const normalizedBarrierPairs = (pairs = []) =>
  pairs
    .map((pair) => ({
      source_group_id: canonicalPair(pair.source_group_id, pair.target_group_id)[0],
      target_group_id: canonicalPair(pair.source_group_id, pair.target_group_id)[1],
      shared_boundary_length_px: Number(pair.shared_boundary_length_px),
      barrier_overlap_length_px: Number(pair.barrier_overlap_length_px),
    }))
    .sort((a, b) => pairKey(a.source_group_id, a.target_group_id).localeCompare(pairKey(b.source_group_id, b.target_group_id)));

export function barrierPairsEqual(left, right, tolerance = 1e-5) {
  const a = normalizedBarrierPairs(left), b = normalizedBarrierPairs(right);
  return a.length === b.length && a.every((pair, index) => {
    const other = b[index];
    return pair.source_group_id === other.source_group_id &&
      pair.target_group_id === other.target_group_id &&
      Number.isFinite(pair.shared_boundary_length_px) && Number.isFinite(pair.barrier_overlap_length_px) &&
      Math.abs(pair.shared_boundary_length_px - other.shared_boundary_length_px) <= tolerance &&
      Math.abs(pair.barrier_overlap_length_px - other.barrier_overlap_length_px) <= tolerance;
  });
}

export function barrierContextFor(result, parent, sourceVersion, matchedPairs) {
  return {
    schema_version: 1,
    barrier_id: result.id,
    barrier_type: "wall",
    parent_zone_id: parent.id,
    parent_room_id: parent.roomId,
    source_version: sourceVersion,
    parent_fingerprint: parent.fingerprint,
    match_rule: "shared_boundary_overlap",
    matched_pairs: matchedPairs,
  };
}

export const barrierControlName = controlName;
export const occupancyBarrierContext = context;
