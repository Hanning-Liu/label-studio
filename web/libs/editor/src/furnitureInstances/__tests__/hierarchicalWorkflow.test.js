import { makeOccupancy, makeInstance, square, SOURCE, resetIds } from "./helpers";
import { groupCreationState, groupInstanceResults, createGroupInstance } from "../creation";
import { furnitureInstances, furnitureGroups, CONTROLS, context } from "../domain";
import { area, difference, equivalent, resultGeometry } from "../../occupancy/geometry";
import { rectanglePreview, rectanglePixelCenter, parentEdgeAngles } from "../rectanglePreview";
import { buildFurnitureScope, connectionZoneIds, referenceInScope, instanceInScope } from "../scope";
import { orientationForInstance } from "../constraints";

global.TextEncoder = TextEncoder;
beforeEach(resetIds);

test("outline creation retains holes, components and existing instances without copying parent metadata", () => {
  const geometry = [[square(10, 10, 60, 80)[0], square(20, 20, 30, 40)[0]], square(70, 20, 90, 70)];
  const refs = makeOccupancy([{ id: "group-g", type: "study_work", geometry }]);
  const original = makeInstance(refs, { geometry: [square(35, 30, 45, 40)] });
  const before = JSON.stringify([...refs, ...original]);
  const created = groupInstanceResults([...refs, ...original], "group-g", "desk", "v1");
  const instance = furnitureInstances(created.results)[0];
  expect(equivalent(instance.geometry, geometry)).toBe(true);
  expect(instance.parts.length).toBeGreaterThan(1);
  expect(instance.id).not.toBe("instance-i");
  expect(orientationForInstance(instance).status).toBe("unknown");
  for (const result of created.results) {
    expect(context(result)).toMatchObject({
      group_id: "group-g",
      room_id: "room-r",
      zone_id: "zone-z",
      instance_type: "desk",
      review_status: "pending",
    });
    expect(result.meta.occupancy_context).toBeUndefined();
    expect(result.meta.furniture_instance_provenance).toBeUndefined();
  }
  expect(JSON.stringify([...refs, ...original])).toBe(before);
  expect(() => groupInstanceResults([...refs, ...created.results], "group-g", "desk", "v1")).toThrow("同轮廓");
  expect(() => groupInstanceResults([...refs, ...created.results], "group-g", "office_chair", "v1")).not.toThrow();
});

test("full rotated rectangle is retained instead of an axis-aligned bounding box", () => {
  const rectangle = {
    ...SOURCE,
    id: "parent-rect",
    from_name: "occupancy_rectangle",
    type: "rectangle",
    value: { x: 30, y: 20, width: 20, height: 25, rotation: 30 },
  };
  const refs = makeOccupancy([{ id: "group-g", type: "study_work", geometry: resultGeometry(rectangle) }]);
  const geometryPart = refs.find((r) => r.from_name === "occupancy_polygon");
  const label = refs.find((r) => r.id === geometryPart.id && r.from_name === "occupancy_type");
  const replaced = refs.filter((r) => r.id !== geometryPart.id);
  replaced.push({ ...rectangle, meta: geometryPart.meta }, { ...label, id: rectangle.id });
  const created = groupInstanceResults(replaced, "group-g", "desk", "v1");
  expect(created.results.find((r) => r.from_name === CONTROLS.rectangle).value).toEqual(rectangle.value);
});

test.each(["focus", "parent", "version", "category"])(
  "outline creation cancels on asynchronous %s change",
  async (changed) => {
    const refs = makeOccupancy();
    const item = {
      furnitureInstanceData: refs,
      furnitureInstanceFocusId: "group-g",
      createFurnitureInstanceFromGroup: jest.fn(),
      annotation: {
        referenceVersion: "v1",
        store: { referenceSyncController: { checkFurnitureInstancesReference: jest.fn(async () => {}) } },
        saveDraftImmediatelyWithResults: jest.fn(async () => {
          if (changed === "focus") item.furnitureInstanceFocusId = "another";
          if (changed === "parent") refs.find((r) => r.from_name === "occupancy_polygon").value.points[0][0]++;
          if (changed === "version") item.annotation.referenceVersion = "v2";
        }),
      },
    };
    await expect(createGroupInstance(item, "desk", () => changed !== "category")).rejects.toThrow();
    expect(item.createFurnitureInstanceFromGroup).not.toHaveBeenCalled();
  },
);

test("scope follows explicit IDs and boundary-supported connections", () => {
  const refs = makeOccupancy();
  const first = refs.find((r) => r.from_name === "zone_polygon");
  first.value.points = square(0, 0, 50, 100)[0].slice(0, -1);
  refs.push({ ...first, id: "zone-other", value: { points: square(50, 0, 100, 100)[0].slice(0, -1) } });
  const scope = buildFurnitureScope(refs);
  const vector = {
    ...SOURCE,
    value: {
      vertices: [
        { x: 50, y: 20 },
        { x: 50, y: 80 },
      ],
    },
  };
  expect(connectionZoneIds(vector, scope.zones)).toEqual(["zone-z", "zone-other"]);
  expect(() =>
    connectionZoneIds(
      {
        ...vector,
        value: {
          vertices: [
            { x: 40, y: 20 },
            { x: 40, y: 80 },
          ],
        },
      },
      scope.zones,
    ),
  ).toThrow();
  expect(() => connectionZoneIds(vector, [...scope.zones, { ...scope.zones[1], id: "ambiguous" }])).toThrow();
  const item = { furnitureInstanceRoomId: "room-r", furnitureInstanceZoneId: "zone-z" };
  expect(instanceInScope(item, { context: { room_id: "room-r", zone_id: "zone-other" } })).toBe(false);
  const entry = { control: "window_vector", zoneIds: [], roomIds: ["room-r"] };
  expect(referenceInScope(item, entry)).toBe(false);
  expect(referenceInScope({ ...item, furnitureInstanceRoomBackground: true }, entry)).toBe(true);
  expect(
    referenceInScope(
      { ...item, furnitureInstanceOverview: true, furnitureInstanceReferenceLayers: { windows: false } },
      entry,
    ),
  ).toBe(false);
});

test.each([
  [1000, 500],
  [500, 1000],
  [1000, 1000],
])("angle preview in %s x %s uses the pixel center and preserves the original", (W, H) => {
  const result = {
    ...SOURCE,
    original_width: W,
    original_height: H,
    value: { x: 20, y: 20, width: 25, height: 25, rotation: 0 },
  };
  const before = JSON.stringify(result),
    center = rectanglePixelCenter(result);
  const preview = rectanglePreview(result, [square(0, 0, 100, 100)], { angle: 390 });
  expect(preview.valid).toBe(true);
  expect(preview.angle).toBe(30);
  const actual = rectanglePixelCenter({ ...result, value: preview.value });
  expect(actual.x).toBeCloseTo(center.x, 8);
  expect(actual.y).toBeCloseTo(center.y, 8);
  expect(JSON.stringify(result)).toBe(before);
});

test("fit shrinks at fixed center, refuses holes and never returns degenerate storage", () => {
  const result = { ...SOURCE, value: { x: 20, y: 20, width: 60, height: 60, rotation: 0 } };
  const parent = [square(10, 10, 90, 90)];
  const fit = rectanglePreview(result, parent, { angle: 45, fit: true });
  expect(fit.valid).toBe(true);
  expect(fit.scale).toBeGreaterThan(0);
  expect(fit.scale).toBeLessThan(1);
  expect(area(difference(fit.geometry, parent))).toBeLessThan(1e-4);
  const hole = [[square(0, 0, 100, 100)[0], square(40, 40, 60, 60)[0]]];
  const failed = rectanglePreview(result, hole, { angle: 45, fit: true });
  expect(failed.valid).toBe(false);
  expect(failed.value.width).toBeGreaterThan(0);
  expect(rectanglePreview(result, parent, { centerX: -500, fit: true }).valid).toBe(false);
  expect(rectanglePreview(result, parent, { scale: 0.0001 }).valid).toBe(false);
});

test("preview accounts for same-instance siblings and parent edge angle uses image aspect", () => {
  const result = { ...SOURCE, value: { x: 20, y: 20, width: 20, height: 20, rotation: 0 } };
  const sibling = { ...SOURCE, value: { x: 40, y: 20, width: 20, height: 20, rotation: 0 } };
  expect(rectanglePreview(result, [square(0, 0, 100, 100)], { centerX: 450 }, [sibling]).valid).toBe(false);
  const edges = parentEdgeAngles(
    {
      geometry: [
        [
          [
            [0, 0],
            [50, 50],
            [80, 0],
            [0, 0],
          ],
        ],
      ],
    },
    1000,
    500,
  );
  expect(edges[0].angle).toBeCloseTo(26.565051, 5);
});
import { TextEncoder } from "util";
