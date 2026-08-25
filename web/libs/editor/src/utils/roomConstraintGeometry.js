const EPSILON = 1e-7;

const subtract = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (point, factor) => ({ x: point.x * factor, y: point.y * factor });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const cross = (a, b) => a.x * b.y - a.y * b.x;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export const pointOnSegment = (point, start, end, epsilon = EPSILON) => {
  const segment = subtract(end, start);
  const offset = subtract(point, start);
  if (Math.abs(cross(segment, offset)) > epsilon * Math.max(1, distance(start, end))) return false;
  const projection = dot(offset, segment);
  return projection >= -epsilon && projection <= dot(segment, segment) + epsilon;
};

export const pointInPolygon = (point, polygon, includeBoundary = true) => {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const start = polygon[previous];
    const end = polygon[index];
    if (pointOnSegment(point, start, end)) return includeBoundary;
    const crossesRay =
      start.y > point.y !== end.y > point.y &&
      point.x < ((end.x - start.x) * (point.y - start.y)) / (end.y - start.y) + start.x;
    if (crossesRay) inside = !inside;
  }
  return inside;
};

const segmentIntersectionParameters = (a, b, c, d) => {
  const first = subtract(b, a);
  const second = subtract(d, c);
  const denominator = cross(first, second);
  const offset = subtract(c, a);
  if (Math.abs(denominator) <= EPSILON) {
    if (Math.abs(cross(offset, first)) > EPSILON) return [];
    const lengthSquared = dot(first, first);
    if (lengthSquared <= EPSILON) return [];
    const start = dot(subtract(c, a), first) / lengthSquared;
    const end = dot(subtract(d, a), first) / lengthSquared;
    return [Math.max(0, Math.min(start, end)), Math.min(1, Math.max(start, end))].filter(
      (value) => value >= -EPSILON && value <= 1 + EPSILON,
    );
  }
  const firstParameter = cross(offset, second) / denominator;
  const secondParameter = cross(offset, first) / denominator;
  return firstParameter >= -EPSILON &&
    firstParameter <= 1 + EPSILON &&
    secondParameter >= -EPSILON &&
    secondParameter <= 1 + EPSILON
    ? [Math.max(0, Math.min(1, firstParameter))]
    : [];
};

export const segmentInsidePolygon = (start, end, polygon) => {
  if (!pointInPolygon(start, polygon) || !pointInPolygon(end, polygon)) return false;
  const parameters = [0, 1];
  for (let index = 0; index < polygon.length; index++) {
    parameters.push(
      ...segmentIntersectionParameters(start, end, polygon[index], polygon[(index + 1) % polygon.length]),
    );
  }
  const sorted = [...new Set(parameters.map((value) => Math.round(value / EPSILON) * EPSILON))].sort((a, b) => a - b);
  for (let index = 0; index < sorted.length - 1; index++) {
    const middle = (sorted[index] + sorted[index + 1]) / 2;
    const sample = add(start, scale(subtract(end, start), middle));
    if (!pointInPolygon(sample, polygon)) return false;
  }
  return true;
};

export const polygonInsidePolygon = (candidate, container) => {
  if (!Array.isArray(candidate) || candidate.length < 3) return false;
  for (let index = 0; index < candidate.length; index++) {
    if (!segmentInsidePolygon(candidate[index], candidate[(index + 1) % candidate.length], container)) {
      return false;
    }
  }
  return true;
};

const orientation = (a, b, c) => cross(subtract(b, a), subtract(c, a));

export const isSimplePolygon = (polygon) => {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  for (let first = 0; first < polygon.length; first++) {
    const a = polygon[first];
    const b = polygon[(first + 1) % polygon.length];
    if (distance(a, b) <= EPSILON) return false;
    for (let second = first + 1; second < polygon.length; second++) {
      if (
        second === first ||
        second === (first + 1) % polygon.length ||
        (first === 0 && second === polygon.length - 1)
      ) {
        continue;
      }
      const c = polygon[second];
      const d = polygon[(second + 1) % polygon.length];
      if (segmentIntersectionParameters(a, b, c, d).length > 0) return false;
    }
  }
  let doubledArea = 0;
  for (let index = 0; index < polygon.length; index++) {
    doubledArea += cross(polygon[index], polygon[(index + 1) % polygon.length]);
  }
  return Math.abs(doubledArea) > EPSILON;
};

export const rotatedRectanglePoints = ({ x, y, width, height, rotation = 0 }) => {
  const radians = (rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const rotate = (dx, dy) => ({ x: x + dx * cosine - dy * sine, y: y + dx * sine + dy * cosine });
  return [rotate(0, 0), rotate(width, 0), rotate(width, height), rotate(0, height)];
};

export const nearestPointOnSegment = (point, start, end) => {
  const segment = subtract(end, start);
  const lengthSquared = dot(segment, segment);
  if (lengthSquared <= EPSILON) return { ...start };
  const parameter = Math.max(0, Math.min(1, dot(subtract(point, start), segment) / lengthSquared));
  return add(start, scale(segment, parameter));
};

export const nearestPointOnPolygon = (point, polygon) => {
  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index++) {
    const candidate = nearestPointOnSegment(point, polygon[index], polygon[(index + 1) % polygon.length]);
    const candidateDistance = distance(point, candidate);
    if (candidateDistance < nearestDistance) {
      nearest = candidate;
      nearestDistance = candidateDistance;
    }
  }
  return nearest;
};

export const clampPointToPolygon = (previous, target, polygon, iterations = 28) => {
  if (pointInPolygon(target, polygon)) return target;
  if (!pointInPolygon(previous, polygon)) return nearestPointOnPolygon(target, polygon);
  let low = 0;
  let high = 1;
  for (let index = 0; index < iterations; index++) {
    const middle = (low + high) / 2;
    const candidate = add(previous, scale(subtract(target, previous), middle));
    if (pointInPolygon(candidate, polygon)) low = middle;
    else high = middle;
  }
  return add(previous, scale(subtract(target, previous), low));
};

export const clampPolygonTransform = (previous, target, container, iterations = 28) => {
  if (polygonInsidePolygon(target, container)) return target;
  if (previous.length !== target.length || !polygonInsidePolygon(previous, container)) return previous;
  let low = 0;
  let high = 1;
  let accepted = previous;
  for (let index = 0; index < iterations; index++) {
    const middle = (low + high) / 2;
    const candidate = previous.map((point, pointIndex) =>
      add(point, scale(subtract(target[pointIndex], point), middle)),
    );
    if (polygonInsidePolygon(candidate, container)) {
      accepted = candidate;
      low = middle;
    } else {
      high = middle;
    }
  }
  return accepted;
};

const interpolateAngle = (start, end, amount) => {
  let delta = ((end - start + 540) % 360) - 180;
  if (Math.abs(delta) < EPSILON) delta = 0;
  return start + delta * amount;
};

export const clampRectangleTransform = (previous, target, container, toPolygon, iterations = 28) => {
  if (polygonInsidePolygon(toPolygon(target), container)) return target;
  if (!polygonInsidePolygon(toPolygon(previous), container)) return previous;
  let low = 0;
  let high = 1;
  let accepted = previous;
  for (let index = 0; index < iterations; index++) {
    const amount = (low + high) / 2;
    const candidate = {
      x: previous.x + (target.x - previous.x) * amount,
      y: previous.y + (target.y - previous.y) * amount,
      width: previous.width + (target.width - previous.width) * amount,
      height: previous.height + (target.height - previous.height) * amount,
      rotation: interpolateAngle(previous.rotation, target.rotation, amount),
    };
    if (polygonInsidePolygon(toPolygon(candidate), container)) {
      accepted = candidate;
      low = amount;
    } else {
      high = amount;
    }
  }
  return accepted;
};

const undirectedAngleDifference = (first, second) => {
  let difference = Math.abs(first - second) % Math.PI;
  if (difference > Math.PI / 2) difference = Math.PI - difference;
  return difference;
};

const projectPointToLine = (point, start, end) => {
  const line = subtract(end, start);
  const lengthSquared = dot(line, line);
  if (lengthSquared <= EPSILON) return { ...start };
  return add(start, scale(line, dot(subtract(point, start), line) / lengthSquared));
};

export const snapSegmentToOpening = (segment, opening, distanceThreshold, angleThresholdDegrees) => {
  const [start, end] = segment;
  const [openingStart, openingEnd] = opening;
  const segmentAngle = Math.atan2(end.y - start.y, end.x - start.x);
  const openingAngle = Math.atan2(openingEnd.y - openingStart.y, openingEnd.x - openingStart.x);
  if (undirectedAngleDifference(segmentAngle, openingAngle) > (angleThresholdDegrees * Math.PI) / 180) {
    return null;
  }

  const endpointCandidates = [
    { pointIndex: 0, point: openingStart, distance: distance(start, openingStart) },
    { pointIndex: 0, point: openingEnd, distance: distance(start, openingEnd) },
    { pointIndex: 1, point: openingStart, distance: distance(end, openingStart) },
    { pointIndex: 1, point: openingEnd, distance: distance(end, openingEnd) },
  ]
    .filter((candidate) => candidate.distance <= distanceThreshold)
    .sort((first, second) => first.distance - second.distance);

  if (endpointCandidates.length > 0) {
    const snapped = [{ ...start }, { ...end }];
    const best = endpointCandidates[0];
    snapped[best.pointIndex] = { ...best.point };
    const otherIndex = best.pointIndex === 0 ? 1 : 0;
    snapped[otherIndex] = projectPointToLine(snapped[otherIndex], openingStart, openingEnd);
    return { segment: snapped, kind: "endpoint" };
  }

  const projectedStart = projectPointToLine(start, openingStart, openingEnd);
  const projectedEnd = projectPointToLine(end, openingStart, openingEnd);
  if (Math.max(distance(start, projectedStart), distance(end, projectedEnd)) > distanceThreshold) return null;
  return { segment: [projectedStart, projectedEnd], kind: "line" };
};

export const collinearPositiveOverlap = (first, second, tolerance = 1e-5) => {
  const [a, b] = first;
  const [c, d] = second;
  const firstDirection = subtract(b, a);
  if (distance(a, b) <= tolerance || distance(c, d) <= tolerance) return false;
  if (
    Math.abs(orientation(a, b, c)) > tolerance * distance(a, b) ||
    Math.abs(orientation(a, b, d)) > tolerance * distance(a, b)
  ) {
    return false;
  }
  const lengthSquared = dot(firstDirection, firstDirection);
  const start = dot(subtract(c, a), firstDirection) / lengthSquared;
  const end = dot(subtract(d, a), firstDirection) / lengthSquared;
  return Math.min(1, Math.max(start, end)) - Math.max(0, Math.min(start, end)) > tolerance;
};

export const polygonArea = (polygon) => {
  if (!Array.isArray(polygon) || polygon.length < 3) return 0;
  let doubledArea = 0;
  for (let index = 0; index < polygon.length; index++) {
    doubledArea += cross(polygon[index], polygon[(index + 1) % polygon.length]);
  }
  return Math.abs(doubledArea) / 2;
};

export const collinearOverlapSegment = (first, second, tolerance = 1e-5) => {
  const [a, b] = first;
  const [c, d] = second;
  const direction = subtract(b, a);
  const lengthSquared = dot(direction, direction);
  const length = Math.sqrt(lengthSquared);
  if (length <= tolerance || distance(c, d) <= tolerance) return null;
  if (Math.abs(orientation(a, b, c)) > tolerance * length || Math.abs(orientation(a, b, d)) > tolerance * length) {
    return null;
  }
  const cParameter = dot(subtract(c, a), direction) / lengthSquared;
  const dParameter = dot(subtract(d, a), direction) / lengthSquared;
  const startParameter = Math.max(0, Math.min(cParameter, dParameter));
  const endParameter = Math.min(1, Math.max(cParameter, dParameter));
  if ((endParameter - startParameter) * length <= tolerance) return null;
  const overlap = [add(a, scale(direction, startParameter)), add(a, scale(direction, endParameter))];
  return dot(subtract(overlap[1], overlap[0]), subtract(d, c)) < 0 ? overlap.reverse() : overlap;
};

const strictlyInsidePolygon = (point, polygon) =>
  pointInPolygon(point, polygon, true) &&
  !polygon.some((vertex, index) => pointOnSegment(point, vertex, polygon[(index + 1) % polygon.length]));

const segmentsProperlyCross = (a, b, c, d, tolerance = 1e-5) => {
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  return (
    ((first > tolerance && second < -tolerance) || (first < -tolerance && second > tolerance)) &&
    ((third > tolerance && fourth < -tolerance) || (third < -tolerance && fourth > tolerance))
  );
};

export const polygonsHavePositiveOverlap = (first, second, tolerance = 1e-5) => {
  if (!isSimplePolygon(first) || !isSimplePolygon(second)) return false;
  if (first.some((point) => strictlyInsidePolygon(point, second))) return true;
  if (second.some((point) => strictlyInsidePolygon(point, first))) return true;
  for (let firstIndex = 0; firstIndex < first.length; firstIndex++) {
    const a = first[firstIndex];
    const b = first[(firstIndex + 1) % first.length];
    const midpoint = scale(add(a, b), 0.5);
    if (strictlyInsidePolygon(midpoint, second)) return true;
    for (let secondIndex = 0; secondIndex < second.length; secondIndex++) {
      if (segmentsProperlyCross(a, b, second[secondIndex], second[(secondIndex + 1) % second.length], tolerance)) {
        return true;
      }
    }
  }
  if (second.every((point) => pointInPolygon(point, first, true))) return true;
  if (first.every((point) => pointInPolygon(point, second, true))) return true;
  return false;
};

export const polygonBoundaryOverlaps = (polygon, segment, tolerance = 1e-5) => {
  const overlaps = [];
  for (let index = 0; index < polygon.length; index++) {
    const overlap = collinearOverlapSegment(
      [polygon[index], polygon[(index + 1) % polygon.length]],
      segment,
      tolerance,
    );
    if (overlap) overlaps.push(overlap);
  }
  return overlaps;
};

const segmentLength = ([start, end]) => distance(start, end);
const midpoint = ([start, end]) => scale(add(start, end), 0.5);

export const rectanglePortalGeometry = (rectangle, tolerance = 1e-5) => {
  if (!Array.isArray(rectangle) || rectangle.length !== 4) return null;
  const edges = rectangle.map((point, index) => [point, rectangle[(index + 1) % rectangle.length]]);
  const lengths = edges.map(segmentLength);
  const firstPair = lengths[0] + lengths[2];
  const secondPair = lengths[1] + lengths[3];
  const longEdgeIndexes = firstPair >= secondPair ? [0, 2] : [1, 3];
  const shortEdgeIndexes = firstPair >= secondPair ? [1, 3] : [0, 2];
  const clearWidth = (lengths[longEdgeIndexes[0]] + lengths[longEdgeIndexes[1]]) / 2;
  const depth = (lengths[shortEdgeIndexes[0]] + lengths[shortEdgeIndexes[1]]) / 2;
  if (clearWidth <= tolerance || depth <= tolerance) return null;

  const firstLong = edges[longEdgeIndexes[0]];
  const oppositeLong = edges[longEdgeIndexes[1]];
  const centerline = [midpoint([firstLong[0], oppositeLong[1]]), midpoint([firstLong[1], oppositeLong[0]])];
  return {
    edges,
    longEdges: longEdgeIndexes.map((index) => edges[index]),
    shortEdges: shortEdgeIndexes.map((index) => edges[index]),
    clearWidth,
    depth,
    centerline,
  };
};

export const relatedOpenings = (polygon, openings, tolerance = 1e-5) => {
  const related = [];
  for (const opening of openings) {
    const hasOverlap = polygon.some((point, index) =>
      collinearPositiveOverlap([point, polygon[(index + 1) % polygon.length]], opening.points, tolerance),
    );
    if (hasOverlap) related.push(opening);
  }
  return related;
};

export const partitionContext = (polygon, parentRoomId, openings, tolerance = 1e-5, schemaVersion = 1) => {
  const matched = relatedOpenings(polygon, openings, tolerance);
  const connectedRoomIds = new Set();
  for (const opening of matched) {
    for (const roomId of opening.roomIds || []) {
      if (roomId !== parentRoomId) connectedRoomIds.add(roomId);
    }
  }
  return {
    schema_version: schemaVersion,
    parent_room_id: parentRoomId,
    opening_ids: matched.map((opening) => opening.id).sort(),
    connected_room_ids: [...connectedRoomIds].sort(),
  };
};

export const withAlpha = (color, alpha) => {
  if (!color) return `rgba(0, 0, 0, ${alpha})`;
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const expanded =
      hex.length === 3
        ? hex
            .split("")
            .map((value) => value + value)
            .join("")
        : hex;
    const red = Number.parseInt(expanded.slice(0, 2), 16);
    const green = Number.parseInt(expanded.slice(2, 4), 16);
    const blue = Number.parseInt(expanded.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }
  const rgb = color
    .match(/^rgba?\(([^)]+)\)$/i)?.[1]
    ?.split(",")
    .slice(0, 3);
  if (rgb?.length === 3) return `rgba(${rgb.map((value) => value.trim()).join(", ")}, ${alpha})`;
  return color;
};
