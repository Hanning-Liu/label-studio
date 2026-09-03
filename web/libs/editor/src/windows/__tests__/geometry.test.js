import { TextEncoder } from "util";

global.TextEncoder = TextEncoder;
if (!globalThis.structuredClone) globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));

import { boundaryOverlap, flattenWindowPath, roomBoundarySegments } from "../geometry";

const result = (vertices, extra = {}) => ({
  id: "window-a",
  from_name: "window_vector",
  type: "vectorlabels",
  original_width: 100,
  original_height: 100,
  value: { closed: false, vectorlabels: ["Window"], vertices },
  ...extra,
});

const room = (id = "room-a") => ({
  id,
  from_name: "room_rectangle",
  type: "rectanglelabels",
  original_width: 100,
  original_height: 100,
  image_rotation: 0,
  value: { x: 10, y: 10, width: 40, height: 30, rotation: 0, rectanglelabels: ["Bedroom"] },
});

const overlap = (windowResult, roomResult = room()) => {
  const path = flattenWindowPath(windowResult, 0.5);
  return {
    path,
    match: boundaryOverlap(path, roomBoundarySegments(roomResult, roomResult.id), {
      boundaryMatchTolerancePx: 2,
      maximumTangentDeltaDeg: 10,
    }),
  };
};

test("straight and polyline windows require complete positive-length boundary support", () => {
  const straight = overlap(
    result([
      { x: 15, y: 10 },
      { x: 45, y: 10 },
    ]),
  );
  expect(straight.path.kind).toBe("line");
  expect(straight.match.full).toBe(true);
  expect(straight.match.overlapLength).toBeCloseTo(30);

  const corner = overlap(
    result([
      { x: 15, y: 10 },
      { x: 50, y: 10 },
      { x: 50, y: 30 },
    ]),
  );
  expect(corner.path.kind).toBe("polyline");
  expect(corner.match.full).toBe(true);
  expect(corner.match.roomBoundarySegmentIds).toHaveLength(2);

  const pointOnly = overlap(
    result([
      { x: 50, y: 10 },
      { x: 60, y: 10 },
    ]),
  );
  expect(pointOnly.match.overlapLength).toBe(0);
  expect(pointOnly.match.full).toBe(false);
});

test("Bezier flattening is computation-only and preserves every raw control point", () => {
  const vertices = [
    {
      id: "a",
      x: 15,
      y: 10,
      isBezier: true,
      controlPoint1: { x: 14, y: 10 },
      controlPoint2: { x: 24, y: 10 },
    },
    {
      id: "b",
      prevPointId: "a",
      x: 45,
      y: 10,
      isBezier: true,
      controlPoint1: { x: 36, y: 10 },
      controlPoint2: { x: 46, y: 10 },
    },
  ];
  const windowResult = result(vertices);
  const before = structuredClone(windowResult.value);
  const { path, match } = overlap(windowResult);
  expect(path.kind).toBe("bezier");
  expect(match.full).toBe(true);
  expect(windowResult.value).toEqual(before);
});

test("Bezier handles cannot make coincident path vertices valid", () => {
  const vertices = [
    {
      id: "a",
      x: 20,
      y: 10,
      isBezier: true,
      controlPoint1: { x: 20, y: 10 },
      controlPoint2: { x: 30, y: 5 },
    },
    {
      id: "b",
      prevPointId: "a",
      x: 20,
      y: 10,
      isBezier: true,
      controlPoint1: { x: 30, y: 15 },
      controlPoint2: { x: 20, y: 10 },
    },
  ];
  expect(() => flattenWindowPath(result(vertices), 0.5)).toThrow("第 1 段长度为 0");
});

test("vertex chain order is honored without rewriting the source array", () => {
  const vertices = [
    { id: "c", prevPointId: "b", x: 50, y: 30, isBezier: false },
    { id: "a", x: 15, y: 10, isBezier: false },
    { id: "b", prevPointId: "a", x: 50, y: 10, isBezier: false },
  ];
  const before = structuredClone(vertices);
  expect(overlap(result(vertices)).match.full).toBe(true);
  expect(vertices).toEqual(before);
});
