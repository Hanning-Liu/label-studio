import { TextEncoder } from "util";
import { area, difference, equivalent, resultGeometry, union } from "@hanning/frontend/domain/occupancy/geometry";
import {
  baseContext,
  logicalRegions,
  mergeGroups,
  parents,
  resultsForGeometry,
  generateWalkableArea,
  validateOccupancy,
} from "@hanning/frontend/domain/occupancy/domain";
import { duplicateGroup, translateGroup } from "@hanning/frontend/domain/occupancy/groupOperations";
global.TextEncoder = TextEncoder;
let sequence;
const id = () => `copy-test-${++sequence}`;
beforeEach(() => {
  sequence = 0;
});
const rectangle = (x, y, width, height, rotation = 0) => ({
  id: id(),
  from_name: "occupancy_rectangle",
  to_name: "image",
  type: "rectangle",
  original_width: 200,
  original_height: 100,
  value: { x, y, width, height, rotation },
});
const setup = () => [
  {
    ...rectangle(0, 0, 100, 100),
    from_name: "zone_rectangle",
    meta: { partition_context: { parent_room_id: "room" } },
  },
];
const add = (data, geometry, preserve = [], type = "study_work") => {
  const parent = parents(data)[0];
  const groupId = id();
  data.push(
    ...resultsForGeometry(
      geometry,
      "furniture_group",
      {
        ...baseContext(parent, "v1", "manual", groupId),
        group_id: groupId,
        group_type: type,
        group_note: "办公",
      },
      parent.result,
      id,
      preserve,
    ),
  );
  return groupId;
};
const addRect = (data, ...dimensions) => {
  const r = rectangle(...dimensions);
  return add(data, resultGeometry(r), [r]);
};

test.each([0, 30, 90])("copy preserves rectangle and rotation %s with independent identity", (rotation) => {
  const data = setup();
  const sourceId = addRect(data, 30, 30, 10, 12, rotation);
  const before = JSON.stringify(data);
  const copied = duplicateGroup(data, sourceId, id);
  expect(JSON.stringify(data)).toBe(before);
  expect(copied.results.slice(0, data.length)).toEqual(data);
  expect(copied.offset).toEqual([4, 4]);
  const original = logicalRegions(data)[0];
  const duplicate = logicalRegions(copied.results).find((r) => r.id === copied.logicalId);
  expect(duplicate.parts).toHaveLength(1);
  expect(duplicate.parts[0].from_name).toBe("occupancy_rectangle");
  expect(duplicate.parts[0].value).toEqual({ ...original.parts[0].value, x: 32, y: 34 });
  expect(duplicate.context).toMatchObject({
    logical_id: copied.logicalId,
    group_id: copied.logicalId,
    group_type: "study_work",
    group_note: "办公",
    parent_zone_id: original.context.parent_zone_id,
    source_version: "v1",
    review_status: "pending",
    review_fingerprint: null,
  });
  expect(duplicate.id).not.toBe(sourceId);
  expect(duplicate.parts[0].id).not.toBe(original.parts[0].id);
  expect(area(duplicate.geometry)).toBeCloseTo(area(original.geometry), 8);
  expect(copied.results.filter((r) => r.id === duplicate.parts[0].id).map((r) => r.from_name)).toEqual([
    "occupancy_rectangle",
    "occupancy_type",
  ]);
});

test("copy near a parent edge tries a different direction without clipping", () => {
  const data = setup();
  const sourceId = addRect(data, 90, 90, 10, 10);
  const copied = duplicateGroup(data, sourceId, id);
  expect(copied.offset).toEqual([-4, -4]);
  const duplicate = logicalRegions(copied.results).at(-1);
  expect(area(duplicate.geometry)).toBeCloseTo(100, 8);
  expect(area(difference(duplicate.geometry, parents(data)[0].geometry))).toBe(0);
});

test("copy filling its parent stays in place without shrinking", () => {
  const data = setup();
  const sourceId = addRect(data, 0, 0, 100, 100);
  const copied = duplicateGroup(data, sourceId, id);
  expect(copied.offset).toEqual([0, 0]);
  expect(logicalRegions(copied.results).at(-1).parts[0].value).toEqual(logicalRegions(data)[0].parts[0].value);
});

test("copy and whole-group translation preserve every component and hole", () => {
  const data = setup();
  const outer = resultGeometry(rectangle(10, 10, 30, 30))[0][0];
  const hole = resultGeometry(rectangle(20, 20, 10, 10))[0][0];
  const island = resultGeometry(rectangle(60, 10, 10, 10))[0];
  const sourceId = add(data, [[outer, hole], island]);
  const original = logicalRegions(data)[0];
  const copied = duplicateGroup(data, sourceId, id);
  const duplicate = logicalRegions(copied.results).at(-1);
  expect(duplicate.parts).toHaveLength(original.parts.length);
  expect(duplicate.geometry).toHaveLength(2);
  expect(duplicate.geometry.some((p) => p.length === 2)).toBe(true);
  expect(area(duplicate.geometry)).toBeCloseTo(area(original.geometry), 8);
  const translated = translateGroup(copied.results, copied.logicalId, 5, 10);
  const moved = logicalRegions(translated).at(-1);
  expect(moved.parts.map((part) => part.id)).toEqual(duplicate.parts.map((part) => part.id));
  expect(
    equivalent(
      moved.geometry,
      duplicate.geometry.map((p) => p.map((ring) => ring.map(([x, y]) => [x + 5, y + 10]))),
    ),
  ).toBe(true);
  expect(translated.slice(0, data.length)).toEqual(data);
  expect(() => translateGroup(translated, copied.logicalId, 100, 0)).toThrow("不能移出");
});

test("two chairs touching a desk form one concave polygon, without filling the gap", () => {
  const data = setup();
  const ids = [addRect(data, 10, 10, 20, 20), addRect(data, 50, 10, 20, 20), addRect(data, 0, 30, 90, 20)];
  const expected = union(...logicalRegions(data).map((r) => r.geometry));
  const merged = mergeGroups(data, ids, "study_work", "办公", id);
  const logicals = logicalRegions(merged);
  expect(logicals).toHaveLength(1);
  expect(logicals[0].parts).toHaveLength(1);
  expect(logicals[0].geometry).toHaveLength(1);
  expect(equivalent(logicals[0].geometry, expected)).toBe(true);
  expect(area(logicals[0].geometry)).toBe(2600);
  expect(logicals[0].context.group_type).toBe("study_work");
  expect(merged[0]).toEqual(data[0]);
  expect(() =>
    mergeGroups(
      [...data, { type: "relation", from_id: logicalRegions(data)[0].parts[0].id, to_id: "target" }],
      ids,
      "study_work",
      "",
      id,
    ),
  ).toThrow("Relations");
});

test("merging disconnected groups keeps separate components within one logical group", () => {
  const data = setup();
  const ids = [addRect(data, 10, 10, 10, 10), addRect(data, 50, 10, 10, 10)];
  const region = logicalRegions(mergeGroups(data, ids, "study_work", "", id))[0];
  expect(region.geometry).toHaveLength(2);
  expect(area(region.geometry)).toBe(200);
});

test("copy leaves existing Relations untouched and makes generated walkable stale", () => {
  let data = setup();
  const sourceId = addRect(data, 10, 10, 10, 10);
  const originalPart = data.find((r) => r.from_name === "occupancy_rectangle");
  originalPart.meta.window_projection_state = { status: "current", target_fingerprint: "original-target" };
  originalPart.meta.window_projections = [{ id: "original-window-relation" }];
  const relation = { type: "relation", from_id: logicalRegions(data)[0].parts[0].id, to_id: "target" };
  data.push(relation);
  data = generateWalkableArea(data, data[0].id, "v1", id).results;
  const copied = duplicateGroup(data, sourceId, id);
  const copiedPart = logicalRegions(copied.results).find((r) => r.id === copied.logicalId).parts[0];
  expect(copiedPart.meta.window_projection_state).toBeUndefined();
  expect(copiedPart.meta.window_projections).toBeUndefined();
  expect(copied.results.filter((r) => r.type === "relation")).toEqual([relation]);
  expect(validateOccupancy(copied.results, "v1").some((issue) => issue.code === "stale")).toBe(true);
});

test.each(["readonly", "unfinished", "automatic", "missing-parent"])(
  "copy rejects %s groups without mutation",
  (mode) => {
    const data = setup();
    const sourceId = addRect(data, 10, 10, 10, 10);
    const part = data.find((r) => r.from_name === "occupancy_rectangle");
    if (mode === "readonly") part.readonly = true;
    if (mode === "unfinished") part.value.closed = false;
    if (mode === "automatic") part.meta.occupancy_context.generation = "remainder";
    if (mode === "missing-parent") data.shift();
    const before = JSON.stringify(data);
    expect(() => duplicateGroup(data, sourceId, id)).toThrow();
    expect(JSON.stringify(data)).toBe(before);
  },
);
