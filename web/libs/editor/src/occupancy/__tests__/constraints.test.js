import { constraintSpace, constrainRectangle, constrainPolygon, snapOccupancyPoint } from "../constraints";
import { area, difference, resultGeometry } from "../geometry";
import { constrainOccupancyBox } from "../transform";

const square = [
  [
    [
      [10.23, 10.13],
      [90.27, 10.13],
      [90.27, 90.17],
      [10.23, 90.17],
      [10.23, 10.13],
    ],
  ],
];
const metrics = { width: 1000, height: 500, screenWidth: 1000, screenHeight: 500 };
const rect = { x: 30, y: 30, width: 20, height: 20, rotation: 0 };
const space = (options = {}, geometry = square) => constraintSpace(geometry, { ...metrics, ...options });
const inside = (value, parent = square) =>
  expect(
    area(difference(resultGeometry({ value, original_width: 1000, original_height: 500 }), parent)),
  ).toBeLessThanOrEqual(1e-8);

test("pending and manual rectangles clamp translation without changing size", () => {
  const out = constrainRectangle(rect, { ...rect, x: 120, y: 35 }, space());
  inside(out);
  expect(out.x + out.width).toBeCloseTo(90.27, 7);
  expect(out.width).toBe(rect.width);
  expect(out.height).toBe(rect.height);
});
test("resizing a moving edge snaps to exact parent coordinates, not rounded pixels", () => {
  const out = constrainRectangle(rect, { ...rect, width: 59.8 }, space());
  expect(out.x).toBe(30);
  expect(out.y).toBe(30);
  expect(out.x + out.width).toBeCloseTo(90.27, 10);
  inside(out);
});
test("interior pixel snapping uses original resolution, independent of zoom", () => {
  for (const screenWidth of [500, 1000, 4000]) {
    const out = constrainRectangle(
      rect,
      { ...rect, x: 33.234, y: 32.346 },
      space({ screenWidth, screenHeight: screenWidth / 2 }),
    );
    expect(out.x).toBeCloseTo(33.2);
    expect(out.y).toBeCloseTo(32.4);
    expect(out.width).toBe(20);
  }
});
test("boundary snap radius is ten SCREEN pixels and has priority over pixel grid", () => {
  expect(snapOccupancyPoint({ x: 10.8, y: 40 }, space()).x).toBeCloseTo(10.23, 10);
  expect(snapOccupancyPoint({ x: 10.8, y: 40 }, space({ screenWidth: 4000, screenHeight: 2000 })).x).toBeCloseTo(
    10.8,
    10,
  );
  expect(snapOccupancyPoint({ x: 10.4, y: 10.6 }, space())).toEqual({ x: 10.23, y: 10.13 });
});
test("turning off both snaps does not turn off parent containment", () => {
  const out = constrainRectangle(rect, { ...rect, x: 99 }, space({ boundary: false, pixel: false }));
  inside(out);
  expect(out.x + out.width).toBeCloseTo(90.27, 7);
});
test("rectangles starting at zero size can grow but not through a concave parent", () => {
  const concave = [
    [
      [
        [0, 0],
        [80, 0],
        [80, 30],
        [30, 30],
        [30, 80],
        [0, 80],
        [0, 0],
      ],
    ],
  ];
  const out = constrainRectangle(
    { x: 10, y: 10, width: 0, height: 0, rotation: 0 },
    { x: 10, y: 10, width: 60, height: 60, rotation: 0 },
    space({}, concave),
  );
  expect(out.width).toBeGreaterThan(0);
  inside(out, concave);
});
test("rotation and non-square images use true corners, not percent-space rotation or bbox", () => {
  const old = { ...rect, width: 12, height: 15, rotation: 35 };
  const out = constrainRectangle(old, { ...old, x: 88 }, space());
  inside(out);
  expect(out.rotation).toBe(35);
  expect(out.width).toBeCloseTo(12);
  expect(out.height).toBeCloseTo(15);
});
test("rotated resize keeps the stationary corner", () => {
  const old = { ...rect, width: 12, height: 15, rotation: 35 };
  const out = constrainRectangle(old, { ...old, width: 100 }, space());
  inside(out);
  expect(out.x).toBeCloseTo(old.x);
  expect(out.y).toBeCloseTo(old.y);
});
test("polygon translation preserves shape while clamping and snapping", () => {
  const old = [
    { x: 30.1, y: 30.2 },
    { x: 45.3, y: 32.8 },
    { x: 38.2, y: 45.1 },
  ];
  const out = constrainPolygon(
    old,
    old.map((p) => ({ x: p.x + 100, y: p.y })),
    space(),
  );
  inside({ points: out.map((p) => [p.x, p.y]) });
  for (let i = 1; i < old.length; i++) {
    expect(out[i].x - out[0].x).toBeCloseTo(old[i].x - old[0].x, 10);
    expect(out[i].y - out[0].y).toBeCloseTo(old[i].y - old[0].y, 10);
  }
});
test("vertex editing clamps to parent and leaves other vertices untouched", () => {
  const old = [
    { x: 30, y: 30 },
    { x: 50, y: 30 },
    { x: 40, y: 50 },
  ];
  const out = constrainPolygon(old, [old[0], { x: 98, y: 30 }, old[2]], space());
  expect(out[0]).toEqual(old[0]);
  expect(out[2]).toEqual(old[2]);
  inside({ points: out.map((p) => [p.x, p.y]) });
  expect(out[1].x).toBeCloseTo(90.27, 7);
});
test("parent and legacy invalid geometry are not silently rewritten", () => {
  const before = JSON.stringify(square),
    old = { ...rect, x: 95 };
  expect(constrainRectangle(old, { ...old, x: 98 }, space({ pixel: false, boundary: false }))).toEqual(old);
  expect(constrainRectangle(old, rect, space())).toEqual(rect);
  expect(JSON.stringify(square)).toBe(before);
});
test.each([0, 90, 180, 270])("live rectangle transformer respects pan, zoom and image rotation %s", (rotation) => {
  const a = (rotation * Math.PI) / 180,
    scale = 3;
  const image = {
    occupancyConstrains: () => true,
    canvasToInternalX: (n) => n / 10,
    canvasToInternalY: (n) => n / 5,
    internalToCanvasX: (n) => n * 10,
    internalToCanvasY: (n) => n * 5,
    fixZoomedCoords: ([x, y]) => [
      ((x - 123) * Math.cos(a) + (y - 77) * Math.sin(a)) / scale,
      (-(x - 123) * Math.sin(a) + (y - 77) * Math.cos(a)) / scale,
    ],
    zoomOriginalCoords: ([x, y]) => [
      123 + scale * (x * Math.cos(a) - y * Math.sin(a)),
      77 + scale * (x * Math.sin(a) + y * Math.cos(a)),
    ],
    constrainOccupancyRectangle: (_r, old, target) => constrainRectangle(old, target, space()),
  };
  const [x, y] = image.zoomOriginalCoords([300, 150]);
  const oldBox = { x, y, width: 600, height: 300, rotation: a };
  const out = constrainOccupancyBox(image, { ...rect, type: "rectangleregion" }, oldBox, { ...oldBox, width: 2400 });
  expect(out.width / scale / 10 + rect.x).toBeCloseTo(90.27, 7);
  expect(out.x).toBeCloseTo(x);
  expect(out.y).toBeCloseTo(y);
});
