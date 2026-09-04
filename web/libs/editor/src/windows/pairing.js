const EPS = 1e-9;

const dot = (first, second) => first.x * second.x + first.y * second.y;
const vector = (from, to) => ({ x: to.x - from.x, y: to.y - from.y });
const length = (value) => Math.hypot(value.x, value.y);
const scale = (value, factor) => ({ x: value.x * factor, y: value.y * factor });
const add = (first, second) => ({ x: first.x + second.x, y: first.y + second.y });

const angleDeltaDeg = (first, second) => {
  const denominator = length(first) * length(second);
  if (denominator <= EPS) return 180;
  const cosine = Math.min(1, Math.abs(dot(first, second) / denominator));
  return (Math.acos(cosine) * 180) / Math.PI;
};

const pointSegmentDistance = (point, start, end) => {
  const direction = vector(start, end);
  const squared = dot(direction, direction);
  if (squared <= EPS) return length(vector(start, point));
  const parameter = Math.max(0, Math.min(1, dot(vector(start, point), direction) / squared));
  return length(vector(add(start, scale(direction, parameter)), point));
};

const orientation = (first, second, third) =>
  (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);

const pointOnSegment = (point, start, end) =>
  Math.abs(orientation(start, end, point)) <= EPS &&
  point.x >= Math.min(start.x, end.x) - EPS &&
  point.x <= Math.max(start.x, end.x) + EPS &&
  point.y >= Math.min(start.y, end.y) - EPS &&
  point.y <= Math.max(start.y, end.y) + EPS;

const lineSegmentsIntersect = (firstStart, firstEnd, secondStart, secondEnd) => {
  const a = orientation(firstStart, firstEnd, secondStart);
  const b = orientation(firstStart, firstEnd, secondEnd);
  const c = orientation(secondStart, secondEnd, firstStart);
  const d = orientation(secondStart, secondEnd, firstEnd);
  return (
    (a * b < -EPS && c * d < -EPS) ||
    pointOnSegment(secondStart, firstStart, firstEnd) ||
    pointOnSegment(secondEnd, firstStart, firstEnd) ||
    pointOnSegment(firstStart, secondStart, secondEnd) ||
    pointOnSegment(firstEnd, secondStart, secondEnd)
  );
};

const segmentDistance = (first, second) => {
  if (lineSegmentsIntersect(first.start, first.end, second.start, second.end)) return 0;
  return Math.min(
    pointSegmentDistance(first.start, second.start, second.end),
    pointSegmentDistance(first.end, second.start, second.end),
    pointSegmentDistance(second.start, first.start, first.end),
    pointSegmentDistance(second.end, first.start, first.end),
  );
};

const mergeIntervals = (intervals) => {
  const merged = [];
  for (const [rawStart, rawEnd] of intervals
    .map(([start, end]) => [Math.max(0, Math.min(start, end)), Math.min(1, Math.max(start, end))])
    .filter(([start, end]) => end - start > EPS)
    .sort((first, second) => first[0] - second[0] || first[1] - second[1])) {
    const previous = merged.at(-1);
    if (previous && rawStart <= previous[1] + EPS) previous[1] = Math.max(previous[1], rawEnd);
    else merged.push([rawStart, rawEnd]);
  }
  return merged;
};

function inwardNormal(room, traceSegment) {
  const tangent = vector(traceSegment.start, traceSegment.end);
  const midpoint = scale(add(traceSegment.start, traceSegment.end), 0.5);
  const boundary = room.segments
    .map((segment) => ({
      segment,
      angle: angleDeltaDeg(tangent, vector(segment.start, segment.end)),
      distance: pointSegmentDistance(midpoint, segment.start, segment.end),
    }))
    .sort((first, second) => first.angle - second.angle || first.distance - second.distance)[0]?.segment;
  return boundary?.inwardNormal || { x: 0, y: 0 };
}

function segmentCandidate(first, firstSegment, second, secondSegment, config) {
  const av = vector(firstSegment.start, firstSegment.end);
  const bv = vector(secondSegment.start, secondSegment.end);
  const al = length(av);
  const bl = length(bv);
  if (al <= EPS || bl <= EPS) return null;
  const angle = angleDeltaDeg(av, bv);
  if (angle > config.maximumTangentDeltaDeg) return null;
  const au = scale(av, 1 / al);
  const bu = scale(bv, 1 / bl);
  const aProjection = [
    dot(vector(firstSegment.start, secondSegment.start), au),
    dot(vector(firstSegment.start, secondSegment.end), au),
  ].sort((a, b) => a - b);
  const aStart = Math.max(0, aProjection[0]);
  const aEnd = Math.min(al, aProjection[1]);
  const bProjection = [
    dot(vector(secondSegment.start, firstSegment.start), bu),
    dot(vector(secondSegment.start, firstSegment.end), bu),
  ].sort((a, b) => a - b);
  const bStart = Math.max(0, bProjection[0]);
  const bEnd = Math.min(bl, bProjection[1]);
  const overlap = Math.min(aEnd - aStart, bEnd - bStart);
  if (overlap <= EPS) return null;
  const amid = add(firstSegment.start, scale(au, (aStart + aEnd) / 2));
  const bmid = add(secondSegment.start, scale(bu, (bStart + bEnd) / 2));
  const outwardFirst = scale(inwardNormal(first.assignment.room, firstSegment), -1);
  const outwardSecond = scale(inwardNormal(second.assignment.room, secondSegment), -1);
  const delta = vector(amid, bmid);
  if (dot(delta, outwardFirst) <= EPS || dot(scale(delta, -1), outwardSecond) <= EPS) return null;
  const separation = segmentDistance(firstSegment, secondSegment);
  if (separation > config.pairSearchLimitPx + EPS) return null;
  const samples = [0, 0.5, 1].map((fraction) =>
    pointSegmentDistance(add(amid, scale(au, overlap * (fraction - 0.5))), secondSegment.start, secondSegment.end),
  );
  const maximumSeparation = Math.max(...samples);
  if (maximumSeparation > config.pairSearchLimitPx + EPS) return null;
  return {
    overlap,
    meanSeparation: samples.reduce((total, value) => total + value, 0) / samples.length,
    maximumSeparation,
    angle,
    firstInterval: [
      (firstSegment.pathStart + aStart) / first.path.length,
      (firstSegment.pathStart + aEnd) / first.path.length,
    ],
    secondInterval: [
      (secondSegment.pathStart + bStart) / second.path.length,
      (secondSegment.pathStart + bEnd) / second.path.length,
    ],
  };
}

export function windowPairCandidate(first, second, config) {
  if (first.surfaceKey !== second.surfaceKey) return null;
  if (first.assignment.id === second.assignment.id) return null;
  const pieces = [];
  for (const firstSegment of first.path.segments) {
    for (const secondSegment of second.path.segments) {
      const piece = segmentCandidate(first, firstSegment, second, secondSegment, config);
      if (piece) pieces.push(piece);
    }
  }
  if (!pieces.length) return null;
  const firstIntervals = mergeIntervals(pieces.map((piece) => piece.firstInterval));
  const secondIntervals = mergeIntervals(pieces.map((piece) => piece.secondInterval));
  const firstOverlap = firstIntervals.reduce((total, [start, end]) => total + (end - start) * first.path.length, 0);
  const secondOverlap = secondIntervals.reduce((total, [start, end]) => total + (end - start) * second.path.length, 0);
  const projectedOverlapLengthPx = Math.min(firstOverlap, secondOverlap);
  if (projectedOverlapLengthPx + EPS < config.minimumProjectedOverlapPx) return null;
  const totalWeight = pieces.reduce((total, piece) => total + piece.overlap, 0);
  return {
    firstId: first.traceId,
    secondId: second.traceId,
    projectedOverlapLengthPx,
    meanSeparationPx: pieces.reduce((total, piece) => total + piece.meanSeparation * piece.overlap, 0) / totalWeight,
    maximumSeparationPx: Math.max(...pieces.map((piece) => piece.maximumSeparation)),
    maximumTangentDeltaDeg: Math.max(...pieces.map((piece) => piece.angle)),
    firstIntervals,
    secondIntervals,
  };
}

const otherId = (candidate, traceId) => (candidate.firstId === traceId ? candidate.secondId : candidate.firstId);
const rounded = (value) => Math.round(value * 1e9) / 1e9;
const compareRank = (first, second, traceId) => {
  const firstRank = [
    rounded(first.meanSeparationPx),
    rounded(first.maximumSeparationPx),
    -rounded(first.projectedOverlapLengthPx),
    rounded(first.maximumTangentDeltaDeg),
    otherId(first, traceId),
  ];
  const secondRank = [
    rounded(second.meanSeparationPx),
    rounded(second.maximumSeparationPx),
    -rounded(second.projectedOverlapLengthPx),
    rounded(second.maximumTangentDeltaDeg),
    otherId(second, traceId),
  ];
  for (let index = 0; index < firstRank.length; index++) {
    if (firstRank[index] < secondRank[index]) return -1;
    if (firstRank[index] > secondRank[index]) return 1;
  }
  return 0;
};

export function analyzeWindowPairing(traces, config) {
  const sorted = traces.slice().sort((first, second) => (first.traceId < second.traceId ? -1 : 1));
  const byId = new Map(sorted.map((trace) => [trace.traceId, trace]));
  const candidates = new Map(sorted.map((trace) => [trace.traceId, []]));
  for (let first = 0; first < sorted.length; first++) {
    for (let second = first + 1; second < sorted.length; second++) {
      const candidate = windowPairCandidate(sorted[first], sorted[second], config);
      if (!candidate) continue;
      candidates.get(sorted[first].traceId).push(candidate);
      candidates.get(sorted[second].traceId).push(candidate);
    }
  }
  const best = new Map();
  for (const trace of sorted) {
    const choices = candidates.get(trace.traceId);
    if (choices.length) best.set(trace.traceId, choices.slice().sort((a, b) => compareRank(a, b, trace.traceId))[0]);
  }
  const matched = new Set();
  const pairs = [];
  for (const trace of sorted) {
    if (matched.has(trace.traceId) || !best.has(trace.traceId)) continue;
    const candidate = best.get(trace.traceId);
    const other = otherId(candidate, trace.traceId);
    if (best.get(other) !== candidate) continue;
    matched.add(trace.traceId);
    matched.add(other);
    pairs.push(candidate);
  }
  const unresolved = sorted
    .filter((trace) => !matched.has(trace.traceId) && candidates.get(trace.traceId).length)
    .map((trace) => ({
      trace_id: trace.traceId,
      result_id: trace.result.id,
      room_ids: [
        ...new Set(
          candidates.get(trace.traceId).map((candidate) => byId.get(otherId(candidate, trace.traceId)).assignment.id),
        ),
      ].sort(),
      candidate_trace_ids: candidates
        .get(trace.traceId)
        .map((candidate) => otherId(candidate, trace.traceId))
        .sort(),
    }));
  return { candidates, pairs, unresolved };
}
