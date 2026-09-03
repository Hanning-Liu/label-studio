import {
  area,
  difference,
  EPS_AREA,
  fingerprint,
  intersection,
  resultGeometry,
  VALIDATION_EPS_AREA,
  validationMultiGeometry,
} from "../occupancy/geometry";
import { constrainPolygon as constrainBasePolygon } from "../occupancy/constraints";
import { nearestPointOnSegment, rotatedRectanglePoints } from "../utils/roomConstraintGeometry";
import {
  CONTROLS,
  context,
  controlName,
  FURNITURE_TYPES,
  furnitureGroups,
  furnitureInstances,
  furnitureResults,
  GEOMETRY_CONTROLS,
  instanceReviewFingerprint,
  ORIENTATION_CONTROLS,
  resultCategory,
  roleForResult,
  sharedContext,
} from "./domain";

export const VECTOR_EPS = 1e-7;
export const BOUNDARY_PIXEL_EPS = 1e-5;

const point = (value) => ({ x: value.x, y: value.y });
const sub = (left, right) => ({ x: left.x - right.x, y: left.y - right.y });
const add = (left, right, scale = 1) => ({ x: left.x + right.x * scale, y: left.y + right.y * scale });
const dot = (left, right) => left.x * right.x + left.y * right.y;
const cross = (left, right) => left.x * right.y - left.y * right.x;
const length = (value) => Math.hypot(value.x, value.y);
const distance = (left, right) => length(sub(left, right));
const mix = (left, right, amount) => left + (right - left) * amount;
const close = (left, right) => Math.abs(left - right) < 1e-8;
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const unit = (value) => {
  const size = length(value);
  if (!(size > VECTOR_EPS)) throw new Error("朝向证据的两个端点不能重合");
  return { x: value.x / size, y: value.y / size };
};

export function vectorEndpoints(result) {
  const vertices = result?.value?.vertices;
  if (
    result?.value?.closed !== false ||
    !Array.isArray(vertices) ||
    vertices.length !== 2 ||
    vertices.some(
      (vertex) =>
        !Number.isFinite(vertex?.x) ||
        !Number.isFinite(vertex?.y) ||
        vertex.isBezier === true ||
        vertex.x < 0 ||
        vertex.x > 100 ||
        vertex.y < 0 ||
        vertex.y > 100,
    )
  )
    throw new Error("朝向证据必须是两个有效端点组成的开放直线 Vector");
  const endpoints = vertices.map(point);
  unit(sub(endpoints[1], endpoints[0]));
  return endpoints;
}

const arrayPoint = (value) => ({ x: value[0], y: value[1] });

const onSegment = (candidate, start, end, tolerance = 1e-9) => {
  const direction = sub(end, start);
  const size = length(direction);
  if (size <= tolerance) return distance(candidate, start) <= tolerance;
  return (
    Math.abs(cross(direction, sub(candidate, start))) <= tolerance * size &&
    dot(sub(candidate, start), direction) >= -tolerance * size &&
    dot(sub(candidate, end), direction) <= tolerance * size
  );
};

function pointInRing(candidate, ring) {
  const points = ring.map(arrayPoint);
  if (points.some((start, index) => onSegment(candidate, start, points[(index + 1) % points.length]))) return false;
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index];
    const b = points[previous];
    if (
      a.y > candidate.y !== b.y > candidate.y &&
      candidate.x < ((b.x - a.x) * (candidate.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

export function pointOnGeometryBoundary(candidate, geometry, tolerance = 1e-9) {
  return geometry.some((polygon) =>
    polygon.some((ring) =>
      ring.some((start, index) =>
        onSegment(candidate, arrayPoint(start), arrayPoint(ring[(index + 1) % ring.length]), tolerance),
      ),
    ),
  );
}

export function pointInGeometry(candidate, geometry, includeBoundary = false) {
  if (includeBoundary && pointOnGeometryBoundary(candidate, geometry)) return true;
  return geometry.some(
    (polygon) => pointInRing(candidate, polygon[0]) && !polygon.slice(1).some((ring) => pointInRing(candidate, ring)),
  );
}

const snapBoundaryCandidateToPixel = ({ point: candidate, start, end, kind }) => {
  if (kind === "corner" || !start || !end) return candidate;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) > 1e-10) {
    const amount = clamp01((Math.round(candidate.x) - start.x) / dx);
    return { x: start.x + dx * amount, y: start.y + dy * amount };
  }
  if (Math.abs(dy) > 1e-10) {
    const amount = clamp01((Math.round(candidate.y) - start.y) / dy);
    return { x: start.x + dx * amount, y: start.y + dy * amount };
  }
  return candidate;
};

function segmentBoundaryParameters(start, end, boundaryStart, boundaryEnd) {
  const direction = sub(end, start);
  const boundaryDirection = sub(boundaryEnd, boundaryStart);
  const denominator = cross(direction, boundaryDirection);
  const relative = sub(boundaryStart, start);
  if (Math.abs(denominator) > 1e-10) {
    const amount = cross(relative, boundaryDirection) / denominator;
    const boundaryAmount = cross(relative, direction) / denominator;
    return amount >= -1e-10 && amount <= 1 + 1e-10 && boundaryAmount >= -1e-10 && boundaryAmount <= 1 + 1e-10
      ? [clamp01(amount)]
      : [];
  }
  if (Math.abs(cross(relative, direction)) > 1e-8) return [];
  const squared = dot(direction, direction);
  if (squared <= 1e-12) return [];
  return [
    clamp01(dot(sub(boundaryStart, start), direction) / squared),
    clamp01(dot(sub(boundaryEnd, start), direction) / squared),
  ];
}

// Unlike the L3 constraint helper, this space accepts every MultiPolygon
// component and every hole. It always works in original image pixels.
export function furnitureConstraintSpace(geometry, metrics = {}) {
  const {
    width = 100,
    height = 100,
    screenWidth = width,
    screenHeight = height,
    boundary = true,
    pixel = true,
    threshold = 10,
  } = metrics;
  if (!(width > 0 && height > 0) || !Array.isArray(geometry) || !geometry.length)
    throw new Error("Focus 家具组团缺少有效 MultiPolygon 几何");
  const toPixel = (candidate) => ({ x: (candidate.x * width) / 100, y: (candidate.y * height) / 100 });
  const fromPixel = (candidate) => ({ x: (candidate.x * 100) / width, y: (candidate.y * 100) / height });
  const rings = geometry.flatMap((polygon) =>
    polygon.map((ring) => {
      const converted = ring.map(([x, y]) => toPixel({ x, y }));
      if (converted.length > 1 && distance(converted[0], converted.at(-1)) <= 1e-10) converted.pop();
      return converted;
    }),
  );
  const screenDistance = (left, right) =>
    Math.hypot(((left.x - right.x) * screenWidth) / width, ((left.y - right.y) * screenHeight) / height);
  const containsPoint = (candidate) => pointInGeometry(fromPixel(candidate), geometry, true);
  const segmentInside = (start, end) => {
    if (!containsPoint(start) || !containsPoint(end)) return false;
    const parameters = [0, 1];
    for (const ring of rings) {
      for (let index = 0; index < ring.length; index++)
        parameters.push(...segmentBoundaryParameters(start, end, ring[index], ring[(index + 1) % ring.length]));
    }
    const ordered = [...new Set(parameters.map((value) => Number(value.toFixed(12))))].sort((a, b) => a - b);
    return ordered.slice(1).every((high, index) => {
      const low = ordered[index];
      const middle = (low + high) / 2;
      return containsPoint({ x: mix(start.x, end.x, middle), y: mix(start.y, end.y, middle) });
    });
  };
  const inside = (points, closed = true) => {
    if (!points.length || points.some((candidate) => !Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)))
      return false;
    if (!points.every(containsPoint)) return false;
    if (!closed) return points.slice(1).every((end, index) => segmentInside(points[index], end));
    try {
      const result = {
        value: { points: points.map(fromPixel).map((candidate) => [candidate.x, candidate.y]) },
        original_width: width,
        original_height: height,
      };
      const candidate = validationMultiGeometry(resultGeometry(result), width, height);
      const parent = validationMultiGeometry(geometry, width, height);
      return area(difference(candidate, parent)) <= VALIDATION_EPS_AREA;
    } catch {
      return false;
    }
  };
  const boundaryCandidates = (candidate) => {
    if (!boundary) return [];
    const corners = rings
      .flat()
      .filter((corner) => screenDistance(candidate, corner) <= threshold)
      .map((corner) => ({ point: corner, kind: "corner" }));
    const edges = rings
      .flatMap((ring) =>
        ring.map((start, index) => {
          const end = ring[(index + 1) % ring.length];
          return { point: nearestPointOnSegment(candidate, start, end), start, end, kind: "edge" };
        }),
      )
      .filter((entry) => screenDistance(candidate, entry.point) <= threshold);
    return [...corners, ...edges].sort(
      (left, right) => screenDistance(candidate, left.point) - screenDistance(candidate, right.point),
    );
  };
  const boundaryPoints = (candidate) =>
    boundaryCandidates(candidate).map((entry) => (pixel ? snapBoundaryCandidateToPixel(entry) : entry.point));
  const snap = (candidate) =>
    boundaryPoints(candidate)[0] || (pixel ? { x: Math.round(candidate.x), y: Math.round(candidate.y) } : candidate);
  return {
    geometry,
    rings,
    toPixel,
    fromPixel,
    inside,
    containsPoint,
    segmentInside,
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

export function snapFurniturePoint(candidate, space, { boundaryOnly = false } = {}) {
  const pixelPoint = space.toPixel(candidate);
  const snapped = boundaryOnly ? space.boundaryPoints(pixelPoint)[0] : space.snap(pixelPoint);
  if (!snapped || (!boundaryOnly && !space.containsPoint(snapped))) return candidate;
  return space.fromPixel(snapped);
}

function limit(previous, target, valid, interpolate) {
  if (valid(target)) return target;
  if (!valid(previous)) return previous;
  let low = 0;
  let high = 1;
  let accepted = previous;
  for (let index = 0; index < 40; index++) {
    const amount = (low + high) / 2;
    const candidate = interpolate(previous, target, amount);
    if (valid(candidate)) {
      low = amount;
      accepted = candidate;
    } else high = amount;
  }
  return accepted;
}

export const constrainFurniturePolygon = (previous, target, space, closed = true, snap = true) =>
  constrainBasePolygon(previous, target, space, closed, snap);

export function constrainFurnitureRectangle(previous, target, space) {
  const toRectangle = (rectangle) => ({
    ...space.toPixel(rectangle),
    width: (rectangle.width * space.width) / 100,
    height: (rectangle.height * space.height) / 100,
    rotation: rectangle.rotation || 0,
  });
  const before = toRectangle(previous);
  const proposed = toRectangle(target);
  const valid = (rectangle) =>
    rectangle.width >= 0 &&
    rectangle.height >= 0 &&
    space.inside(rotatedRectanglePoints(rectangle), rectangle.width > 1e-10 && rectangle.height > 1e-10);
  const interpolate = (left, right, amount) => ({
    x: mix(left.x, right.x, amount),
    y: mix(left.y, right.y, amount),
    width: mix(left.width, right.width, amount),
    height: mix(left.height, right.height, amount),
    rotation: left.rotation + (((right.rotation - left.rotation + 540) % 360) - 180) * amount,
  });
  let accepted = limit(before, proposed, valid, interpolate);
  const translating =
    close(before.width, proposed.width) &&
    close(before.height, proposed.height) &&
    close(before.rotation, proposed.rotation);
  if (translating) {
    const offsets = rotatedRectanglePoints(accepted).flatMap((corner) =>
      space.boundaryPoints(corner).map((candidate) => ({ x: candidate.x - corner.x, y: candidate.y - corner.y })),
    );
    if (space.pixel) offsets.push({ x: Math.round(accepted.x) - accepted.x, y: Math.round(accepted.y) - accepted.y });
    for (const offset of offsets) {
      const candidate = { ...accepted, x: accepted.x + offset.x, y: accepted.y + offset.y };
      if (valid(candidate)) {
        accepted = candidate;
        break;
      }
    }
  }
  return {
    ...space.fromPixel(accepted),
    width: (accepted.width * 100) / space.width,
    height: (accepted.height * 100) / space.height,
    rotation: accepted.rotation,
  };
}

const pixelPoint = (value, width, height) => ({ x: (value.x * width) / 100, y: (value.y * height) / 100 });

function boundaryIntervals(geometry, start, direction, width, height) {
  const intervals = [];
  for (const polygon of geometry) {
    for (const ring of polygon) {
      for (let index = 0; index < ring.length - 1; index++) {
        const first = pixelPoint(arrayPoint(ring[index]), width, height);
        const second = pixelPoint(arrayPoint(ring[index + 1]), width, height);
        const segment = sub(second, first);
        const size = length(segment);
        if (size <= BOUNDARY_PIXEL_EPS) continue;
        if (Math.abs(cross(direction, { x: segment.x / size, y: segment.y / size })) > 1e-8) continue;
        if (
          Math.abs(cross(direction, sub(first, start))) > BOUNDARY_PIXEL_EPS ||
          Math.abs(cross(direction, sub(second, start))) > BOUNDARY_PIXEL_EPS
        )
          continue;
        intervals.push([
          Math.min(dot(sub(first, start), direction), dot(sub(second, start), direction)),
          Math.max(dot(sub(first, start), direction), dot(sub(second, start), direction)),
        ]);
      }
    }
  }
  return intervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
}

export function assertFrontEdgeOnBoundary(result, geometry) {
  const [percentStart, percentEnd] = vectorEndpoints(result);
  const width = result.original_width;
  const height = result.original_height;
  if (!(width > 0 && height > 0)) throw new Error("front_edge 缺少原图尺寸");
  const start = pixelPoint(percentStart, width, height);
  const end = pixelPoint(percentEnd, width, height);
  const edge = sub(end, start);
  const edgeLength = length(edge);
  if (!(edgeLength > VECTOR_EPS)) throw new Error("front_edge 的两个端点不能重合");
  const direction = { x: edge.x / edgeLength, y: edge.y / edgeLength };
  const intervals = boundaryIntervals(geometry, start, direction, width, height)
    .map(([low, high]) => [Math.max(0, low), Math.min(edgeLength, high)])
    .filter(([low, high]) => high - low > BOUNDARY_PIXEL_EPS)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let covered = 0;
  for (const [low, high] of intervals) {
    if (low > covered + BOUNDARY_PIXEL_EPS) break;
    covered = Math.max(covered, high);
  }
  if (covered < edgeLength - BOUNDARY_PIXEL_EPS) throw new Error("front_edge 必须完整落在家具实例的真实边界上");
  return [percentStart, percentEnd];
}

function outwardNormal(start, end, geometry) {
  const direction = unit(sub(end, start));
  const left = { x: -direction.y, y: direction.x };
  const right = { x: direction.y, y: -direction.x };
  const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  for (const offset of [1e-7, 1e-6, 1e-5, 1e-4, 1e-3]) {
    const leftInside = pointInGeometry(add(middle, left, offset), geometry);
    const rightInside = pointInGeometry(add(middle, right, offset), geometry);
    if (leftInside !== rightInside) return leftInside ? right : left;
  }
  throw new Error("无法从实例实体边界确定 front_edge 外法向");
}

export function frontDirectionOrientation(result, geometry) {
  const [origin, end] = vectorEndpoints(result);
  if (!pointInGeometry(origin, geometry, true)) throw new Error("front_direction 起点必须位于家具实例内部或边界");
  const direction = unit(sub(end, origin));
  return {
    status: "front_direction",
    origin,
    direction_vector: { dx: direction.x, dy: direction.y },
  };
}

export function frontEdgeOrientation(result, geometry) {
  const [start, end] = assertFrontEdgeOnBoundary(result, geometry);
  const normal = outwardNormal(start, end, geometry);
  return {
    status: "front_edge",
    start,
    end,
    outward_normal: {
      dx: Object.is(normal.x, -0) ? 0 : normal.x,
      dy: Object.is(normal.y, -0) ? 0 : normal.y,
    },
  };
}

export function orientationForInstance(instance) {
  if (!instance.orientationResults.length) return { status: "unknown" };
  if (instance.orientationResults.length !== 1) throw new Error("同一家具实例只能有一种显式朝向证据");
  const result = instance.orientationResults[0];
  return controlName(result) === CONTROLS.frontDirection
    ? frontDirectionOrientation(result, instance.geometry)
    : frontEdgeOrientation(result, instance.geometry);
}

const sha256 = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const nonEmpty = (value) => typeof value === "string" && value.length > 0;
const validProvenance = (value, resultId) =>
  value?.schema_version === 1 &&
  value?.result_id === resultId &&
  [value?.project_id, value?.task_id, value?.annotation_id].every((id) => Number.isInteger(id) && id > 0);

export function validateFurnitureInstances(results, occupancyResults = results, { review = true } = {}) {
  const errors = [];
  const push = (code, instanceId, objectId, message, details = {}) =>
    errors.push({ code, instanceId, objectId, message, ...details });
  let groups = [];
  try {
    groups = furnitureGroups(occupancyResults);
  } catch (error) {
    push("parent_geometry", null, null, `无法读取 L3 家具组团：${error.message}`);
  }
  const groupMap = new Map();
  for (const group of groups) {
    if (!nonEmpty(group.id)) {
      push("parent_group", null, group.logicalId, "L3 家具组团缺少稳定 group_id");
      continue;
    }
    if (groupMap.has(group.id)) push("parent_group", null, group.id, "L3 group_id 不唯一，不能自动选择父组团");
    else groupMap.set(group.id, group);
  }

  for (const result of results) {
    if (!roleForResult(result) && Object.keys(context(result)).length)
      push("control", context(result).instance_id || null, result.id, "L4 上下文出现在未知控件结果上");
  }

  const allFurnitureResults = furnitureResults(results);
  const geometryResults = allFurnitureResults.filter((result) => GEOMETRY_CONTROLS.has(controlName(result)));
  const resultKeys = new Set();
  for (const result of allFurnitureResults) {
    const furnitureContext = context(result);
    const instanceId = furnitureContext.instance_id || null;
    const expectedRole = roleForResult(result);
    if (!nonEmpty(result.id)) push("pair", instanceId, result.id, "L4 人工结果必须包含非空稳定字符串 ID");
    const resultKey = `${result.id}\u0000${controlName(result)}`;
    if (resultKeys.has(resultKey)) push("pair", instanceId, result.id, "L4 人工结果 ID/控件配对必须在整个任务内唯一");
    resultKeys.add(resultKey);
    if (furnitureContext.schema_version !== 1 || !nonEmpty(instanceId))
      push("context", instanceId, result.id, "家具结果缺少 schema_version=1 或 instance_id");
    if (furnitureContext.role !== expectedRole)
      push("role", instanceId, result.id, `控件 ${controlName(result)} 与 role 不一致`);
    if (
      !nonEmpty(furnitureContext.room_id) ||
      !nonEmpty(furnitureContext.zone_id) ||
      !nonEmpty(furnitureContext.group_id)
    )
      push("parent_chain", instanceId, result.id, "家具实例必须保存完整 room_id → zone_id → group_id 父级链");
    if (!nonEmpty(furnitureContext.source_version) || !sha256(furnitureContext.parent_fingerprint))
      push("source", instanceId, result.id, "家具实例缺少 source_version 或有效 parent_fingerprint");
    if (!("note" in furnitureContext) || typeof furnitureContext.note !== "string")
      push("context", instanceId, result.id, "家具实例 note 必须存在且为字符串");
    if (!Object.hasOwn(FURNITURE_TYPES, furnitureContext.instance_type))
      push("category", instanceId, result.id, "家具实例类别必须使用稳定英文值");
    if (!["pending", "reviewed", "stale"].includes(furnitureContext.review_status))
      push("review", instanceId, result.id, "家具实例 review_status 无效");
    if (
      furnitureContext.review_fingerprint !== null &&
      furnitureContext.review_fingerprint !== undefined &&
      !sha256(furnitureContext.review_fingerprint)
    )
      push("review", instanceId, result.id, "家具实例 review_fingerprint 无效");
    const provenance = result.meta?.furniture_instance_provenance;
    if (provenance && !validProvenance(provenance, result.id))
      push("provenance", instanceId, result.id, "服务端 provenance 已损坏或与 result_id 不匹配");

    if (GEOMETRY_CONTROLS.has(controlName(result))) {
      const expectedType = controlName(result) === CONTROLS.rectangle ? "rectangle" : "polygon";
      if (result.type !== expectedType) push("geometry", instanceId, result.id, "家具几何结果类型与控件不匹配");
      const categories = allFurnitureResults.filter(
        (candidate) =>
          candidate.id === result.id &&
          controlName(candidate) === CONTROLS.type &&
          context(candidate).instance_id === instanceId,
      );
      if (categories.length !== 1) push("pair", instanceId, result.id, "每个几何必须恰好配对一个家具类别结果");
      else if (
        categories[0].type !== "choices" ||
        !Array.isArray(categories[0].value?.choices) ||
        categories[0].value.choices.length !== 1 ||
        resultCategory(categories[0]) !== furnitureContext.instance_type
      )
        push("category", instanceId, result.id, "配对类别必须是一个且与 instance_type 一致的稳定英文值");
    }
    if (controlName(result) === CONTROLS.type) {
      if (result.type !== "choices") push("category", instanceId, result.id, "家具类别结果类型必须是 choices");
      const geometries = geometryResults.filter(
        (candidate) => candidate.id === result.id && context(candidate).instance_id === instanceId,
      );
      if (geometries.length !== 1) push("pair", instanceId, result.id, "家具类别缺少唯一配对几何");
    }
    if (ORIENTATION_CONTROLS.has(controlName(result))) {
      const expected = roleForResult(result);
      if (
        result.type !== "vectorlabels" ||
        result.value?.vectorlabels?.length !== 1 ||
        result.value.vectorlabels[0] !== expected
      )
        push("orientation", instanceId, result.id, "朝向 VectorLabels 的显式标签与控件不一致");
      try {
        vectorEndpoints(result);
      } catch (error) {
        push("orientation", instanceId, result.id, error.message);
      }
    }
  }

  for (const instance of furnitureInstances(results)) {
    const furnitureContext = instance.context;
    if (instance.geometryError) push("geometry", instance.id, instance.parts[0]?.id, instance.geometryError.message);
    const shared = fingerprint(sharedContext(furnitureContext));
    if (instance.results.some((result) => fingerprint(sharedContext(context(result))) !== shared))
      push("parts", instance.id, instance.id, "同一 instance_id 的多部分结果上下文不一致");
    if (instance.categories.some((result) => resultCategory(result) !== furnitureContext.instance_type))
      push("parts", instance.id, instance.id, "同一 instance_id 的多部分类别不一致");
    if (
      instance.parts.some(
        (part) =>
          part.original_width !== instance.parts[0].original_width ||
          part.original_height !== instance.parts[0].original_height,
      )
    )
      push("parts", instance.id, instance.id, "同一家具实例的多部分原图尺寸不一致");
    if (
      instance.orientationResults.some(
        (result) =>
          result.original_width !== instance.parts[0].original_width ||
          result.original_height !== instance.parts[0].original_height,
      )
    )
      push("geometry", instance.id, instance.id, "家具实例几何与朝向证据的原图尺寸不一致");
    for (let left = 0; left < instance.parts.length; left++) {
      for (let right = left + 1; right < instance.parts.length; right++) {
        try {
          const width = instance.parts[0].original_width;
          const height = instance.parts[0].original_height;
          const first = validationMultiGeometry(resultGeometry(instance.parts[left]), width, height);
          const second = validationMultiGeometry(resultGeometry(instance.parts[right]), width, height);
          if (area(intersection(first, second)) > VALIDATION_EPS_AREA)
            push("parts_overlap", instance.id, instance.id, "同一家具实例的存储部分存在正面积重叠");
        } catch (error) {
          push("geometry", instance.id, instance.parts[left].id, error.message);
        }
      }
    }

    const group = groupMap.get(furnitureContext.group_id);
    let parentFresh = true;
    if (!group) {
      parentFresh = false;
      push("parent_missing", instance.id, instance.id, "原家具组团已删除；实例保持原父级链且必须进入 stale 状态");
    } else {
      if (furnitureContext.room_id !== group.roomId || furnitureContext.zone_id !== group.zoneId) {
        parentFresh = false;
        push("parent_chain", instance.id, instance.id, "实例保存的房间/分区与原家具组团不一致，禁止按当前 Focus 重绑");
      }
      if (furnitureContext.parent_fingerprint !== group.fingerprint) {
        parentFresh = false;
        push("parent_stale", instance.id, instance.id, "原家具组团语义或完整几何已变化，实例必须重新复核");
      }
      try {
        const source = instance.parts[0];
        const geometry = validationMultiGeometry(instance.geometry, source.original_width, source.original_height);
        const parent = validationMultiGeometry(group.geometry, source.original_width, source.original_height);
        const outsideArea = area(difference(geometry, parent));
        if (outsideArea > VALIDATION_EPS_AREA)
          push(
            "outside",
            instance.id,
            instance.id,
            `家具实例超出原家具组团（越界面积 ${outsideArea.toFixed(6)} px²）`,
            {
              outsideAreaPx: outsideArea,
            },
          );
      } catch (error) {
        push("geometry", instance.id, instance.id, error.message);
      }
    }
    try {
      const source = instance.parts[0];
      const geometry = validationMultiGeometry(instance.geometry, source.original_width, source.original_height);
      for (const other of groups.filter((candidate) => candidate.id !== furnitureContext.group_id)) {
        const otherGeometry = validationMultiGeometry(other.geometry, source.original_width, source.original_height);
        const overlapArea = area(intersection(geometry, otherGeometry));
        if (overlapArea > VALIDATION_EPS_AREA)
          push(
            "cross_group",
            instance.id,
            instance.id,
            `家具实例与其他家具组团 ${other.id} 存在正面积相交，禁止静默跨组团`,
            { overlapAreaPx: overlapArea, relatedGroupId: other.id },
          );
      }
    } catch {
      // The primary geometry error is reported above; do not invent a group.
    }

    let orientation;
    try {
      orientation = orientationForInstance(instance);
    } catch (error) {
      push("orientation", instance.id, instance.orientationResults[0]?.id || instance.id, error.message);
    }
    if (!parentFresh && furnitureContext.review_status !== "stale")
      push("stale_status", instance.id, instance.id, "父级变化后 review_status 必须显式标记为 stale");
    if (parentFresh && orientation) {
      const expectedReview = instanceReviewFingerprint(instance, orientation);
      if (
        review &&
        (furnitureContext.review_status !== "reviewed" || furnitureContext.review_fingerprint !== expectedReview)
      )
        push("review", instance.id, instance.id, "家具实例尚未复核，或内容修改后复核指纹已失效", {
          expectedReviewFingerprint: expectedReview,
        });
    }
  }

  const instanceIds = new Set(furnitureInstances(results).map((instance) => instance.id));
  for (const result of allFurnitureResults.filter((item) => !GEOMETRY_CONTROLS.has(controlName(item)))) {
    if (!instanceIds.has(context(result).instance_id))
      push("orphan", context(result).instance_id || null, result.id, "类别或朝向结果没有对应家具实例几何");
  }
  return [
    ...new Map(
      errors.map((error) => [
        `${error.code}:${error.instanceId || ""}:${error.objectId || ""}:${error.message}`,
        error,
      ]),
    ).values(),
  ];
}

export function confirmFurnitureInstances(results, occupancyResults, instanceIds) {
  const requested = new Set(instanceIds);
  const instances = furnitureInstances(results).filter((instance) => requested.has(instance.id));
  if (!requested.size || instances.length !== requested.size) throw new Error("待复核家具实例不存在");
  const blocking = validateFurnitureInstances(results, occupancyResults, { review: false }).filter(
    (error) => !error.instanceId || requested.has(error.instanceId),
  );
  if (blocking.length) throw new Error(blocking.map((error) => error.message).join("；"));
  const reviews = new Map(
    instances.map((instance) => [instance.id, instanceReviewFingerprint(instance, orientationForInstance(instance))]),
  );
  return results.map((result) => {
    const furnitureContext = context(result);
    if (!reviews.has(furnitureContext.instance_id)) return result;
    return {
      ...result,
      meta: {
        ...result.meta,
        furniture_instance_context: {
          ...furnitureContext,
          review_status: "reviewed",
          review_fingerprint: reviews.get(furnitureContext.instance_id),
        },
      },
    };
  });
}

// Parent changes are stale; content changes under the same parent are pending.
// Saved parent IDs/fingerprint are deliberately never replaced by current Focus.
export function invalidateFurnitureReviews(results, occupancyResults = results) {
  let groups = [];
  try {
    groups = furnitureGroups(occupancyResults);
  } catch {
    // Invalid/missing L3 reference makes every saved instance explicitly stale.
  }
  const groupMap = new Map();
  const ambiguousGroups = new Set();
  for (const group of groups) {
    if (groupMap.has(group.id)) {
      groupMap.delete(group.id);
      ambiguousGroups.add(group.id);
    } else if (!ambiguousGroups.has(group.id)) groupMap.set(group.id, group);
  }
  const status = new Map();
  for (const instance of furnitureInstances(results)) {
    const furnitureContext = instance.context;
    const group = groupMap.get(furnitureContext.group_id);
    if (
      !group ||
      furnitureContext.room_id !== group.roomId ||
      furnitureContext.zone_id !== group.zoneId ||
      furnitureContext.parent_fingerprint !== group.fingerprint
    ) {
      status.set(instance.id, "stale");
      continue;
    }
    try {
      if (
        furnitureContext.review_status === "reviewed" &&
        furnitureContext.review_fingerprint !== instanceReviewFingerprint(instance, orientationForInstance(instance))
      )
        status.set(instance.id, "pending");
    } catch {
      status.set(instance.id, "pending");
    }
  }
  if (!status.size) return results;
  return results.map((result) => {
    const furnitureContext = context(result);
    const next = status.get(furnitureContext.instance_id);
    return next
      ? {
          ...result,
          meta: {
            ...result.meta,
            furniture_instance_context: { ...furnitureContext, review_status: next },
          },
        }
      : result;
  });
}

export const geometryWithinGroup = (geometry, groupGeometry) => area(difference(geometry, groupGeometry)) <= EPS_AREA;
