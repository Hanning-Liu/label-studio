import { constraintSpace, constrainRectangle, constrainPolygon, snapOccupancyPoint } from "../constraints";
import { area, difference, resultGeometry } from "../geometry";
import { constrainOccupancyBox, constrainOccupancyDragPosition, lockRectangleToActiveAnchor } from "../transform";

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
test("boundary snapping quantizes the position along axis-aligned edges to original image pixels", () => {
  const vertical = snapOccupancyPoint({ x: 10.8, y: 40.13 }, space());
  expect(vertical.x).toBeCloseTo(10.23, 10);
  expect(vertical.y).toBeCloseTo(40.2, 10);
  expect((vertical.y * metrics.height) / 100).toBeCloseTo(201, 10);

  const horizontal = snapOccupancyPoint({ x: 33.26, y: 10.8 }, space());
  expect(horizontal.x).toBeCloseTo(33.3, 10);
  expect(horizontal.y).toBeCloseTo(10.13, 10);
  expect((horizontal.x * metrics.width) / 100).toBeCloseTo(333, 10);
});
test("rectangle translation stays on the parent edge and moves in original-pixel steps along it", () => {
  const old = { x: 30.13, y: 30.13, width: 20, height: 20, rotation: 0 };
  const out = constrainRectangle(old, { ...old, x: 120 }, space());

  expect(out.x + out.width).toBeCloseTo(90.27, 10);
  expect(out.y).toBeCloseTo(30.2, 10);
  expect((out.y * metrics.height) / 100).toBeCloseTo(151, 10);
  inside(out);
});
test("diagonal boundary snapping remains on the edge while quantizing its dominant pixel axis", () => {
  const diagonal = [
    [
      [
        [10, 10],
        [90, 30],
        [90, 90],
        [10, 90],
        [10, 10],
      ],
    ],
  ];
  const out = snapOccupancyPoint({ x: 50.07, y: 19.8 }, space({}, diagonal));
  const pixel = { x: (out.x * metrics.width) / 100, y: (out.y * metrics.height) / 100 };

  expect(pixel.x).toBeCloseTo(Math.round(pixel.x), 10);
  expect(pixel.y).toBeCloseTo(50 + (pixel.x - 100) * 0.125, 10);
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

test("bottom-center resize preserves a right edge already snapped to the parent", () => {
  const old = { x: 70.27, y: 30, width: 20, height: 20, rotation: 0 };
  const targetWithRoundTripDrift = {
    x: old.x + 0.0001,
    y: old.y,
    width: old.width + 0.0001,
    height: 35,
    rotation: 0,
  };
  const anchored = lockRectangleToActiveAnchor(old, targetWithRoundTripDrift, "bottom-center");
  const out = constrainRectangle(old, anchored, space({ boundary: false, pixel: false }));

  expect(out.x).toBeCloseTo(old.x, 12);
  expect(out.x + out.width).toBeCloseTo(90.27, 12);
  expect(out.y).toBeCloseTo(old.y, 12);
  expect(out.height).toBeCloseTo(35, 12);
  inside(out);
});

test("top-right resize preserves left and bottom edges already snapped to the parent", () => {
  const old = { x: 10.23, y: 70.17, width: 20, height: 20, rotation: 0 };
  const targetWithRoundTripDrift = {
    x: old.x - 0.0001,
    y: 55,
    width: 35,
    height: 35.1702,
    rotation: 0,
  };
  const anchored = lockRectangleToActiveAnchor(old, targetWithRoundTripDrift, "top-right");
  const out = constrainRectangle(old, anchored, space({ boundary: false, pixel: false }));

  expect(out.x).toBeCloseTo(10.23, 12);
  expect(out.y + out.height).toBeCloseTo(90.17, 12);
  expect(out.y).toBeCloseTo(55, 12);
  expect(out.x + out.width).toBeCloseTo(targetWithRoundTripDrift.x + targetWithRoundTripDrift.width, 12);
  inside(out);
});

test.each([
  ["top-left", [true, false, true, false]],
  ["top-center", [false, false, true, false]],
  ["top-right", [false, true, true, false]],
  ["middle-left", [true, false, false, false]],
  ["middle-right", [false, true, false, false]],
  ["bottom-left", [true, false, false, true]],
  ["bottom-center", [false, false, false, true]],
  ["bottom-right", [false, true, false, true]],
])("%s changes only the sides controlled by that Transformer anchor", (anchor, moving) => {
  const old = { x: 30, y: 30, width: 20, height: 20, rotation: 0 };
  const target = { x: 25, y: 24, width: 32, height: 34, rotation: 0 };
  const out = lockRectangleToActiveAnchor(old, target, anchor);
  const before = [old.x, old.x + old.width, old.y, old.y + old.height];
  const after = [out.x, out.x + out.width, out.y, out.y + out.height];
  const desired = [target.x, target.x + target.width, target.y, target.y + target.height];

  for (let side = 0; side < before.length; side++) {
    expect(after[side]).toBeCloseTo(moving[side] ? desired[side] : before[side], 12);
  }
});

test.each([0, 90, 180, 270])(
  "live bottom-center resize preserves a snapped right edge under image rotation %s",
  (rotation) => {
    const a = (rotation * Math.PI) / 180;
    const scale = 3;
    const snapped = { x: 70.27, y: 30, width: 20, height: 20, rotation: 0 };
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
      constrainOccupancyRectangle: (_r, old, target) =>
        constrainRectangle(old, target, space({ boundary: false, pixel: false })),
    };
    const [x, y] = image.zoomOriginalCoords([image.internalToCanvasX(snapped.x), image.internalToCanvasY(snapped.y)]);
    const oldBox = {
      x,
      y,
      width: image.internalToCanvasX(snapped.width) * scale,
      height: image.internalToCanvasY(snapped.height) * scale,
      rotation: a,
    };
    const out = constrainOccupancyBox(
      image,
      { ...snapped, type: "rectangleregion" },
      oldBox,
      { ...oldBox, width: oldBox.width + 0.03, height: oldBox.height + 150 },
      "bottom-center",
    );

    expect(out.x).toBeCloseTo(oldBox.x, 8);
    expect(out.y).toBeCloseTo(oldBox.y, 8);
    expect(out.width).toBeCloseTo(oldBox.width, 8);
    expect(out.height / scale / 5).toBeCloseTo(30, 8);
  },
);

test.each([0, 90, 180, 270])(
  "selected rectangle drag clamps and snaps live under pan, zoom and image rotation %s",
  (rotation) => {
    const a = (rotation * Math.PI) / 180;
    const scale = 3;
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
    const toScreen = (x, y) => {
      const [screenX, screenY] = image.zoomOriginalCoords([image.internalToCanvasX(x), image.internalToCanvasY(y)]);

      return { x: screenX, y: screenY };
    };
    const toInternal = (p) => {
      const [x, y] = image.fixZoomedCoords([p.x, p.y]);

      return { x: image.canvasToInternalX(x), y: image.canvasToInternalY(y) };
    };
    const start = toScreen(5, 8);
    const proposed = toScreen(105, 8);
    const out = constrainOccupancyDragPosition(image, { ...rect, type: "rectangleregion" }, start, proposed);
    const startInternal = toInternal(start);
    const outInternal = toInternal(out);

    expect(outInternal.x - startInternal.x + rect.x + rect.width).toBeCloseTo(90.27, 7);
    expect(outInternal.y - startInternal.y).toBeCloseTo(0, 7);
  },
);
