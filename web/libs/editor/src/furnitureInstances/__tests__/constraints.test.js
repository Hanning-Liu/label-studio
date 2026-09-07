import { TextEncoder } from "util";
import { area, difference, resultGeometry } from "../../occupancy/geometry";
import { constrainOccupancyBox, lockRectangleToActiveAnchor } from "../../occupancy/transform";
import {
  FRONT_EDGE_BOUNDARY_EPS_PX,
  VALIDATION_PIXEL_EPS,
  assertFrontEdgeOnBoundary,
  confirmFurnitureInstances,
  constrainFurniturePolygon,
  constrainFurnitureRectangle,
  frontDirectionOrientation,
  frontEdgeOrientation,
  furnitureConstraintSpace,
  invalidateFurnitureReviews,
  orientationForInstance,
  snapFurniturePoint,
  validateFurnitureInstances,
} from "../constraints";
import { context, furnitureGroups, furnitureInstances, resultForOrientation } from "../domain";
import { id, makeInstance, makeOccupancy, resetIds, SOURCE, square } from "./helpers";

global.TextEncoder = TextEncoder;
if (!globalThis.structuredClone) globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));

beforeEach(resetIds);

test("rectangle and polygon instances validate inside their saved Focus group", () => {
  const occupancy = makeOccupancy();
  const polygon = makeInstance(occupancy);
  const rectangle = makeInstance(occupancy, {
    instanceId: "instance-rectangle",
    instanceType: "armchair",
    rectangle: { x: 45, y: 45, width: 10, height: 15, rotation: 20 },
  });
  expect(validateFurnitureInstances([...polygon, ...rectangle], occupancy, { review: false })).toEqual([]);
});

test("complete parent chain is mandatory and a saved instance is never rebound to another Focus group", () => {
  const occupancy = makeOccupancy([
    { id: "group-a", type: "study_work", geometry: [square(10, 10, 45, 90)] },
    { id: "group-b", type: "storage", geometry: [square(55, 10, 90, 90)] },
  ]);
  const results = makeInstance(occupancy, {
    groupId: "group-a",
    geometry: [square(60, 20, 70, 30)],
  });
  const outside = validateFurnitureInstances(results, occupancy, { review: false });
  expect(outside.some((issue) => issue.code === "outside")).toBe(true);
  expect(outside).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "cross_group", relatedGroupId: "group-b" })]),
  );
  expect(context(results[0]).group_id).toBe("group-a");

  const missing = results.map((result) => ({
    ...result,
    meta: { ...result.meta, furniture_instance_context: { ...context(result), zone_id: "" } },
  }));
  expect(
    validateFurnitureInstances(missing, occupancy, { review: false }).some((issue) => issue.code === "parent_chain"),
  ).toBe(true);
  expect(context(missing[0]).group_id).toBe("group-a");
});

test("changed parent semantics mark an instance stale without changing any saved parent ID or fingerprint", () => {
  const occupancy = makeOccupancy();
  const results = makeInstance(occupancy);
  const saved = { ...context(results[0]) };
  const changedParent = occupancy.map((result) =>
    result.meta?.occupancy_context?.group_id === "group-g"
      ? {
          ...result,
          meta: {
            ...result.meta,
            occupancy_context: { ...result.meta.occupancy_context, group_note: "parent changed" },
          },
        }
      : result,
  );
  const invalidated = invalidateFurnitureReviews(results, changedParent);
  expect(context(invalidated[0])).toMatchObject({
    room_id: saved.room_id,
    zone_id: saved.zone_id,
    group_id: saved.group_id,
    parent_fingerprint: saved.parent_fingerprint,
    review_status: "stale",
  });
  const issues = validateFurnitureInstances(invalidated, changedParent, { review: false });
  expect(issues.some((issue) => issue.code === "parent_stale")).toBe(true);
  expect(issues.some((issue) => issue.code === "stale_status")).toBe(false);
});

test("an unrelated L3 group update does not invalidate the owning-group scoped parent fingerprint", () => {
  const occupancy = makeOccupancy([
    { id: "group-a", type: "study_work", geometry: [square(10, 10, 45, 90)] },
    { id: "group-b", type: "storage", geometry: [square(55, 10, 90, 90)] },
  ]);
  const results = makeInstance(occupancy, { groupId: "group-a", geometry: [square(20, 20, 30, 30)] });
  const changedUnrelatedGroup = occupancy.map((result) =>
    result.meta?.occupancy_context?.group_id === "group-b"
      ? {
          ...result,
          meta: {
            ...result.meta,
            occupancy_context: { ...result.meta.occupancy_context, group_note: "unrelated edit" },
          },
        }
      : result,
  );
  const invalidated = invalidateFurnitureReviews(results, changedUnrelatedGroup);
  expect(invalidated).toBe(results);
  expect(context(invalidated[0]).review_status).toBe("pending");
  expect(validateFurnitureInstances(invalidated, changedUnrelatedGroup, { review: false })).toEqual([]);
});

test("missing parent marks stale and never adopts a same-shaped current group", () => {
  const original = makeOccupancy([{ id: "group-old", type: "study_work", geometry: [square(10, 10, 90, 90)] }]);
  const results = makeInstance(original, { groupId: "group-old" });
  const replacement = makeOccupancy([{ id: "group-new", type: "study_work", geometry: [square(10, 10, 90, 90)] }]);
  const invalidated = invalidateFurnitureReviews(results, replacement);
  expect(context(invalidated[0]).group_id).toBe("group-old");
  expect(context(invalidated[0]).review_status).toBe("stale");
  expect(
    validateFurnitureInstances(invalidated, replacement, { review: false }).some(
      (issue) => issue.code === "parent_missing",
    ),
  ).toBe(true);
});

test("confirm stamps content review and later geometry edits return it to pending", () => {
  const occupancy = makeOccupancy();
  let results = makeInstance(occupancy);
  results = confirmFurnitureInstances(results, occupancy, ["instance-i"]);
  expect(validateFurnitureInstances(results, occupancy)).toEqual([]);
  expect(context(results[0]).review_status).toBe("reviewed");
  expect(context(results[0]).review_fingerprint).toMatch(/^[0-9a-f]{64}$/);

  results = results.map((result) =>
    result.from_name === "furniture_instance_polygon"
      ? {
          ...result,
          value: {
            ...result.value,
            points: result.value.points.map(([x, y], index) => [x + (index === 1 ? 1 : 0), y]),
          },
        }
      : result,
  );
  results = invalidateFurnitureReviews(results, occupancy);
  expect(context(results[0]).review_status).toBe("pending");
  expect(validateFurnitureInstances(results, occupancy).some((issue) => issue.code === "review")).toBe(true);
});

test("geometry/category pairing and all multi-part contexts must stay consistent", () => {
  const occupancy = makeOccupancy();
  const results = makeInstance(occupancy, {
    geometry: [square(20, 20, 30, 30), square(40, 20, 50, 30)],
  });
  const withoutCategory = results.filter(
    (result) => !(result.id === results[0].id && result.from_name === "furniture_instance_type"),
  );
  expect(
    validateFurnitureInstances(withoutCategory, occupancy, { review: false }).some((issue) => issue.code === "pair"),
  ).toBe(true);

  const inconsistent = results.map((result, index) =>
    index === 1
      ? {
          ...result,
          meta: {
            ...result.meta,
            furniture_instance_context: { ...context(result), note: "different context" },
          },
        }
      : result,
  );
  expect(
    validateFurnitureInstances(inconsistent, occupancy, { review: false }).some((issue) => issue.code === "parts"),
  ).toBe(true);
});

test("frontend structural validation matches the formal backend contract", () => {
  const occupancy = makeOccupancy();
  const base = makeInstance(occupancy);

  const wrongTypes = base.map((result) =>
    result.from_name === "furniture_instance_polygon"
      ? { ...result, type: "rectangle" }
      : result.from_name === "furniture_instance_type"
        ? { ...result, type: "labels" }
        : result,
  );
  const typeCodes = new Set(
    validateFurnitureInstances(wrongTypes, occupancy, { review: false }).map((issue) => issue.code),
  );
  expect(typeCodes.has("geometry")).toBe(true);
  expect(typeCodes.has("category")).toBe(true);

  const missingNote = base.map((result) => {
    const furnitureContext = { ...context(result) };
    delete furnitureContext.note;
    return { ...result, meta: { ...result.meta, furniture_instance_context: furnitureContext } };
  });
  expect(
    validateFurnitureInstances(missingNote, occupancy, { review: false }).some((issue) => issue.code === "context"),
  ).toBe(true);

  const unknownControl = {
    id: "unexpected-result",
    from_name: "unexpected_control",
    to_name: "image",
    type: "choices",
    value: { choices: ["desk"] },
    meta: { furniture_instance_context: { ...context(base[0]), role: "category" } },
  };
  expect(
    validateFurnitureInstances([...base, unknownControl], occupancy, { review: false }).some(
      (issue) => issue.code === "control",
    ),
  ).toBe(true);

  const withDirection = makeInstance(occupancy, {
    instanceId: "instance-direction",
    orientation: {
      status: "front_direction",
      vertices: [
        { x: 25, y: 30 },
        { x: 35, y: 30 },
      ],
    },
  });
  const wrongDimensions = withDirection.map((result) =>
    result.from_name === "furniture_front_direction"
      ? { ...result, original_width: result.original_width + 1 }
      : result,
  );
  expect(
    validateFurnitureInstances(wrongDimensions, occupancy, { review: false }).some(
      (issue) => issue.code === "geometry",
    ),
  ).toBe(true);

  const duplicate = makeInstance(occupancy, { instanceId: "instance-duplicate" }).map((result) => ({
    ...result,
    id: base.find((candidate) => candidate.from_name === result.from_name)?.id || result.id,
  }));
  expect(
    validateFurnitureInstances([...base, ...duplicate], occupancy, { review: false }).some(
      (issue) => issue.code === "pair",
    ),
  ).toBe(true);
  const emptyIds = base.map((result) => ({ ...result, id: "" }));
  expect(
    validateFurnitureInstances(emptyIds, occupancy, { review: false }).some((issue) => issue.code === "pair"),
  ).toBe(true);
});

test("orientation is unknown unless exactly one explicit valid front_direction exists", () => {
  const occupancy = makeOccupancy();
  const unknown = furnitureInstances(makeInstance(occupancy))[0];
  expect(orientationForInstance(unknown)).toEqual({ status: "unknown" });

  const results = makeInstance(occupancy, {
    orientation: {
      status: "front_direction",
      vertices: [
        { x: 25, y: 30 },
        { x: 35, y: 30 },
      ],
    },
  });
  const instance = furnitureInstances(results)[0];
  expect(orientationForInstance(instance)).toEqual({
    status: "front_direction",
    origin: { x: 25, y: 30 },
    direction_vector: { dx: 1, dy: 0 },
  });
  expect(validateFurnitureInstances(results, occupancy, { review: false })).toEqual([]);

  const duplicate = [
    ...results,
    resultForOrientation(
      "front_edge",
      [
        { x: 20, y: 20 },
        { x: 40, y: 20 },
      ],
      context(results[0]),
      SOURCE,
      id,
    ),
  ];
  expect(
    validateFurnitureInstances(duplicate, occupancy, { review: false }).some((issue) => issue.code === "orientation"),
  ).toBe(true);
});

test("front_direction rejects zero vectors and origins outside the instance", () => {
  const occupancy = makeOccupancy();
  const instance = furnitureInstances(makeInstance(occupancy))[0];
  const outside = resultForOrientation(
    "front_direction",
    [
      { x: 70, y: 70 },
      { x: 80, y: 70 },
    ],
    instance.context,
    SOURCE,
    id,
  );
  expect(() => frontDirectionOrientation(outside, instance.geometry)).toThrow("起点");
  outside.value.vertices[1] = { ...outside.value.vertices[0] };
  expect(() => frontDirectionOrientation(outside, instance.geometry)).toThrow("不能重合");
});

test("front_edge must lie on the actual union boundary and exports a geometry-derived outward normal", () => {
  const occupancy = makeOccupancy();
  const instance = furnitureInstances(makeInstance(occupancy))[0];
  const top = resultForOrientation(
    "front_edge",
    [
      { x: 20, y: 20 },
      { x: 40, y: 20 },
    ],
    instance.context,
    SOURCE,
    id,
  );
  expect(assertFrontEdgeOnBoundary(top, instance.geometry)).toEqual([
    { x: 20, y: 20 },
    { x: 40, y: 20 },
  ]);
  expect(frontEdgeOrientation(top, instance.geometry)).toEqual({
    status: "front_edge",
    start: { x: 20, y: 20 },
    end: { x: 40, y: 20 },
    outward_normal: { dx: 0, dy: -1 },
  });
  expect(() => assertFrontEdgeOnBoundary({ ...top, original_width: "100" }, instance.geometry)).toThrow("缺少原图尺寸");
  const interior = {
    ...top,
    value: {
      ...top.value,
      vertices: [
        { x: 20, y: 30 },
        { x: 40, y: 30 },
      ],
    },
  };
  expect(() => frontEdgeOrientation(interior, instance.geometry)).toThrow("真实边界");
});

test("a hole edge points outward from furniture material into the preserved hole", () => {
  const occupancy = makeOccupancy();
  const geometry = [[square(20, 20, 60, 60)[0], square(30, 30, 40, 40)[0]]];
  const results = makeInstance(occupancy, { geometry });
  const instance = furnitureInstances(results)[0];
  const edge = resultForOrientation(
    "front_edge",
    [
      { x: 30, y: 30 },
      { x: 40, y: 30 },
    ],
    instance.context,
    SOURCE,
    id,
  );
  expect(frontEdgeOrientation(edge, instance.geometry).outward_normal).toEqual({ dx: 0, dy: 1 });
});

test("front_edge tolerance is measured in source pixels and never rewrites raw evidence", () => {
  const geometry = [
    [
      [10, 10],
      [90, 90],
      [90, 10],
      [10, 10],
    ],
  ];
  const percentPerPixel = 100 / 1000;
  const edge = {
    ...resultForOrientation(
      "front_edge",
      [
        { x: 30, y: 30 + FRONT_EDGE_BOUNDARY_EPS_PX * 0.5 * percentPerPixel },
        { x: 70, y: 70 + FRONT_EDGE_BOUNDARY_EPS_PX * 0.5 * percentPerPixel },
      ],
      { instance_id: "instance-i" },
      SOURCE,
      id,
    ),
    original_width: 1000,
    original_height: 1000,
  };
  const before = structuredClone(edge);
  expect(assertFrontEdgeOnBoundary(edge, [geometry])).toEqual(edge.value.vertices.map(({ x, y }) => ({ x, y })));
  expect(edge).toEqual(before);

  const rejected = structuredClone(edge);
  for (const vertex of rejected.value.vertices) {
    vertex.y += FRONT_EDGE_BOUNDARY_EPS_PX * 3 * percentPerPixel;
  }
  expect(() => assertFrontEdgeOnBoundary(rejected, [geometry])).toThrow("真实边界");

  const endpointOutsideTolerance = {
    ...resultForOrientation(
      "front_edge",
      [
        { x: 10 - FRONT_EDGE_BOUNDARY_EPS_PX * 1.5, y: 10 },
        { x: 40, y: 10 },
      ],
      { instance_id: "instance-i" },
      { ...SOURCE, original_width: 100, original_height: 100 },
      id,
    ),
    original_width: 100,
    original_height: 100,
  };
  expect(() => assertFrontEdgeOnBoundary(endpointOutsideTolerance, [geometry])).toThrow("真实边界");
});

test("front_edge applies the same near-integer pixel normalization as backend validation", () => {
  const offset = VALIDATION_PIXEL_EPS * 0.9;
  const geometry = [
    [
      [10 + offset, 10 - offset],
      [90 + offset, 90 - offset],
      [90, 10],
      [10 + offset, 10 - offset],
    ],
  ];
  const edge = {
    ...resultForOrientation(
      "front_edge",
      [
        { x: 30.5, y: 30.5 - offset * 2 },
        { x: 70.5, y: 70.5 - offset * 2 },
      ],
      { instance_id: "instance-i" },
      { ...SOURCE, original_width: 100, original_height: 100 },
      id,
    ),
    original_width: 100,
    original_height: 100,
  };
  expect(() => assertFrontEdgeOnBoundary(edge, [geometry])).toThrow("真实边界");

  const normalizedCoincident = {
    ...resultForOrientation(
      "front_edge",
      [
        { x: 20 - VALIDATION_PIXEL_EPS * 0.9, y: 10 },
        { x: 20 + VALIDATION_PIXEL_EPS * 0.9, y: 10 },
      ],
      { instance_id: "instance-i" },
      { ...SOURCE, original_width: 100, original_height: 100 },
      id,
    ),
    original_width: 100,
    original_height: 100,
  };
  const squareGeometry = [
    [
      [10, 10],
      [90, 10],
      [90, 90],
      [10, 90],
      [10, 10],
    ],
  ];
  expect(() => assertFrontEdgeOnBoundary(normalizedCoincident, squareGeometry)).toThrow("不能重合");
});

test("front_edge exact corner capsules agree with backend tolerance semantics", () => {
  const geometry = [
    [
      [10.12345, 20.23456],
      [90.12345, 20.23456],
      [90.12345, 90.23456],
      [10.12345, 90.23456],
      [10.12345, 20.23456],
    ],
  ];
  const toleranceShellEdge = {
    ...resultForOrientation(
      "front_edge",
      [
        { x: 10.123444122735263, y: 20.234551910639073 },
        { x: 10.123444408630158, y: 20.23455171045331 },
      ],
      { instance_id: "instance-i" },
      { ...SOURCE, original_width: 100, original_height: 100 },
      id,
    ),
    original_width: 100,
    original_height: 100,
  };
  expect(frontEdgeOrientation(toleranceShellEdge, [geometry])).toMatchObject({ status: "front_edge" });
});

test("front_edge preserves a raw valid notch when pixel normalization would invalidate it", () => {
  const geometry = [
    [
      [0, 0],
      [20, 0],
      [20, 20],
      [10.000009, 20],
      [10.000009, 5],
      [9.999991, 5],
      [9.999991, 20],
      [0, 20],
      [0, 0],
    ],
  ];
  const notchEdge = {
    ...resultForOrientation(
      "front_edge",
      [
        { x: 10.000009, y: 6 },
        { x: 10.000009, y: 15 },
      ],
      { instance_id: "instance-i" },
      { ...SOURCE, original_width: 100, original_height: 100 },
      id,
    ),
    original_width: 100,
    original_height: 100,
  };
  expect(frontEdgeOrientation(notchEdge, [geometry]).outward_normal).toEqual({ dx: -1, dy: 0 });
});

test("front_edge keeps valid normalization after collapsing consecutive vertices", () => {
  const geometry = [
    [
      [0, 0],
      [10, 0],
      [10.000009, 10.000009],
      [10.000008, 10.000008],
      [0, 10],
      [0, 0],
    ],
  ];
  const rawOnlyEdge = {
    ...resultForOrientation(
      "front_edge",
      [
        { x: 10.00001219999352, y: 7.9999999999955 },
        { x: 10.00001309999271, y: 8.9999999999955 },
      ],
      { instance_id: "instance-i" },
      { ...SOURCE, original_width: 100, original_height: 100 },
      id,
    ),
    original_width: 100,
    original_height: 100,
  };
  expect(() => frontEdgeOrientation(rawOnlyEdge, [geometry])).toThrow("真实边界");
});

test("front_edge accepts hole boundaries but rejects chords and gaps between MultiPolygon parts", () => {
  const occupancy = makeOccupancy();
  const geometry = [[square(0, 0, 40, 40)[0], square(10, 10, 20, 20)[0]], square(60, 0, 100, 40)];
  const instance = furnitureInstances(makeInstance(occupancy, { geometry }))[0];
  const evidence = (vertices) => resultForOrientation("front_edge", vertices, instance.context, SOURCE, id);

  expect(
    frontEdgeOrientation(
      evidence([
        { x: 10, y: 10 },
        { x: 20, y: 10 },
      ]),
      geometry,
    ).outward_normal,
  ).toEqual({ dx: 0, dy: 1 });
  expect(() =>
    assertFrontEdgeOnBoundary(
      evidence([
        { x: 20, y: 0 },
        { x: 80, y: 0 },
      ]),
      geometry,
    ),
  ).toThrow("真实边界");
  expect(() =>
    assertFrontEdgeOnBoundary(
      evidence([
        { x: 0, y: 20 },
        { x: 40, y: 20 },
      ]),
      geometry,
    ),
  ).toThrow("真实边界");
});

test("MultiPolygon constraint space respects components and holes for create, edit and snapping", () => {
  const geometry = [[square(0, 0, 40, 40)[0], square(10, 10, 20, 20)[0]], square(60, 0, 90, 30)];
  const metrics = { width: 1000, height: 500, screenWidth: 1000, screenHeight: 500 };
  const space = furnitureConstraintSpace(geometry, metrics);
  expect(space.containsPoint(space.toPixel({ x: 5, y: 5 }))).toBe(true);
  expect(space.containsPoint(space.toPixel({ x: 15, y: 15 }))).toBe(false);
  expect(space.containsPoint(space.toPixel({ x: 50, y: 5 }))).toBe(false);
  expect(space.segmentInside(space.toPixel({ x: 5, y: 15 }), space.toPixel({ x: 25, y: 15 }))).toBe(false);
  expect(space.containsPoint(space.toPixel({ x: 65, y: 5 }))).toBe(true);

  const snappedHole = snapFurniturePoint({ x: 10.4, y: 15.13 }, space, { boundaryOnly: true });
  expect(snappedHole.x).toBeCloseTo(10, 10);
  expect(snappedHole.y * 5).toBeCloseTo(Math.round(snappedHole.y * 5), 10);

  const before = { x: 2, y: 2, width: 5, height: 5, rotation: 0 };
  const rectangle = constrainFurnitureRectangle(before, { ...before, width: 25, height: 25 }, space);
  expect(area(difference(resultGeometry({ ...SOURCE, value: rectangle }), geometry))).toBeLessThanOrEqual(1e-8);

  const polygonBefore = [
    { x: 2, y: 25 },
    { x: 8, y: 25 },
    { x: 5, y: 35 },
  ];
  const polygon = constrainFurniturePolygon(
    polygonBefore,
    [polygonBefore[0], { x: 15, y: 15 }, polygonBefore[2]],
    space,
  );
  expect(
    area(
      difference(
        resultGeometry({ ...SOURCE, value: { points: polygon.map((candidate) => [candidate.x, candidate.y]) } }),
        geometry,
      ),
    ),
  ).toBeLessThanOrEqual(1e-8);
});

test("rectangle resize sticks to real MultiPolygon component and hole boundaries", () => {
  const geometry = [[square(0, 0, 40, 40)[0], square(10, 10, 20, 20)[0]], square(60, 0, 90, 30)];
  const space = furnitureConstraintSpace(geometry, {
    width: 1000,
    height: 500,
    screenWidth: 1000,
    screenHeight: 500,
  });

  const componentBefore = { x: 65, y: 5, width: 20, height: 10, rotation: 0 };
  const component = constrainFurnitureRectangle(componentBefore, { ...componentBefore, width: 24.5 }, space);
  expect(component.x + component.width).toBeCloseTo(90, 10);

  const holeBefore = { x: 12, y: 22, width: 5, height: 5, rotation: 0 };
  const hole = constrainFurnitureRectangle(holeBefore, { ...holeBefore, y: 20.5, height: 6.5 }, space);
  expect(hole.y).toBeCloseTo(20, 10);
  for (const value of [component, hole])
    expect(area(difference(resultGeometry({ ...SOURCE, value }), geometry))).toBeLessThanOrEqual(1e-8);
});

test("live rectangle Transformer sticks an L4 instance to its MultiPolygon boundary", () => {
  const geometry = [square(60, 0, 90, 30)];
  const space = furnitureConstraintSpace(geometry, {
    width: 1000,
    height: 500,
    screenWidth: 1000,
    screenHeight: 500,
  });
  const instance = { x: 65, y: 5, width: 20, height: 10, rotation: 0, type: "rectangleregion" };
  const image = {
    occupancyConstrains: () => true,
    canvasToInternalX: (value) => value / 10,
    canvasToInternalY: (value) => value / 5,
    internalToCanvasX: (value) => value * 10,
    internalToCanvasY: (value) => value * 5,
    fixZoomedCoords: (value) => value,
    zoomOriginalCoords: (value) => value,
    constrainOccupancyRectangle: (_region, previous, target) => constrainFurnitureRectangle(previous, target, space),
  };
  const oldBox = { x: 650, y: 25, width: 200, height: 50, rotation: 0 };
  const box = constrainOccupancyBox(image, instance, oldBox, { ...oldBox, width: 245 }, "middle-right");

  expect(box.x).toBeCloseTo(oldBox.x, 10);
  expect(box.width).toBeCloseTo(250, 10);
});

test("final L4 bottom-edge commit reaches a two-pixel parent boundary without moving the other edges", () => {
  // These are the dimensions of the small cabinet exercised in the Mac QA
  // recording. It already shares the parent's top, left and right edges; only
  // its bottom edge is two source pixels short of the parent boundary.
  const before = {
    x: 28.24074074074093,
    y: 89.26974664679582,
    width: 1.2037037037037706,
    height: 5.961251862891203,
    rotation: 0,
  };
  const parentHeight = 6.2593144560361065;
  const geometry = [square(before.x, before.y, before.x + before.width, before.y + parentHeight)];
  const space = furnitureConstraintSpace(geometry, {
    width: 1080,
    height: 671,
    screenWidth: 1080,
    screenHeight: 671,
  });
  const roundTripDrift = {
    ...before,
    x: before.x + 0.0001,
    width: before.width + 0.0001,
    height: before.height + 3,
  };
  const anchored = lockRectangleToActiveAnchor(before, roundTripDrift, "bottom-center");
  const accepted = constrainFurnitureRectangle(before, anchored, space);

  expect(accepted.x).toBeCloseTo(before.x, 12);
  expect(accepted.y).toBeCloseTo(before.y, 12);
  expect(accepted.width).toBeCloseTo(before.width, 12);
  expect(accepted.height).toBeCloseTo(parentHeight, 12);
  expect((accepted.height * 671) / 100).toBeCloseTo(42, 10);
});

test("parent group fingerprint includes hole/multipart geometry rather than a bbox or convex hull", () => {
  const geometry = [[square(10, 10, 50, 50)[0], square(20, 20, 30, 30)[0]], square(70, 10, 80, 20)];
  const groups = furnitureGroups(makeOccupancy([{ id: "group-g", type: "study_work", geometry }]));
  expect(groups[0].geometry).toHaveLength(2);
  expect(groups[0].geometry[0]).toHaveLength(2);
  expect(groups[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
});
