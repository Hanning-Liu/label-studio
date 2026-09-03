import { TextEncoder } from "util";
import {
  area,
  difference,
  equivalent,
  fingerprint,
  resultGeometry,
  storageParts,
  union,
  VALIDATION_EPS_AREA,
  validationGeometry,
} from "../geometry";
import {
  baseContext,
  classifyLogical,
  confirmParents,
  context,
  deleteLogicalRegion,
  GEOMETRY,
  generateRemainder,
  generateWalkableArea,
  GROUP_TYPES,
  logicalExport,
  logicalRegions,
  mergeGroups,
  OCCUPANCY_GENERATION_BLOCKED,
  parentContentFingerprint,
  parents,
  resultsForGeometry,
  validateOccupancy,
  localCorrection,
  reclassifyGroup,
} from "../domain";

global.TextEncoder = TextEncoder;
let sequence;
const id = () => `id${++sequence}`;
const rect = (x, y, width, height, rotation = 0) => ({
  id: id(),
  from_name: "zone_rectangle",
  to_name: "image",
  type: "rectangle",
  original_width: 200,
  original_height: 100,
  value: { x, y, width, height, rotation },
  meta: { partition_context: { parent_room_id: "room" } },
});
const setup = () => {
  const p = rect(0, 0, 100, 100);
  return [
    p,
    { id: p.id, from_name: "function_zone", type: "labels", to_name: "image", value: { labels: ["Sanitary/general"] } },
  ];
};
const group = (results, geometry, groupId = id()) => {
  const p = parents(results)[0];
  return resultsForGeometry(
    geometry,
    "furniture_group",
    { ...baseContext(p, "v1", "manual", groupId), group_id: groupId, group_type: "sleeping" },
    p.result,
    id,
  );
};
beforeEach(() => {
  sequence = 0;
});
test("rotation uses image aspect ratio without rounding coordinates", () => {
  const r = rect(20, 20, 10, 20, 90);
  expect(area(resultGeometry(r))).toBeCloseTo(200, 10);
  expect(resultGeometry(r)[0][0][1][1]).toBeCloseTo(40, 10);
});
const pixelDriftData = () => {
  const parent = {
    id: "vktMIEcf62",
    from_name: "zone_polygon",
    to_name: "image",
    type: "polygon",
    original_width: 1080,
    original_height: 671,
    value: {
      points: [
        [30.462962962962965, 55.73770491803278],
        [49.44444438718535, 55.7377048258721],
        [49.44444444444444, 59.76154992548435],
        [46.48148148148148, 59.761549925484346],
        [46.48148148148148, 78.98658718330849],
        [30.462962962962965, 78.98658718330849],
      ],
    },
    meta: { partition_context: { parent_room_id: "living-room" } },
  };
  const results = [
    parent,
    { id: parent.id, from_name: "function_zone", to_name: "image", type: "labels", value: { labels: ["Living/social"] } },
  ];
  const p = parents(results)[0];
  const addGroup = (geometry, logicalId, groupType) => {
    geometry.meta = {
      occupancy_context: {
        ...baseContext(p, "v1", "manual", logicalId),
        group_id: logicalId,
        group_type: groupType,
      },
    };
    results.push(geometry, {
      id: geometry.id,
      from_name: "occupancy_type",
      to_name: "image",
      type: "labels",
      value: { labels: ["furniture_group"] },
    });
  };
  addGroup(
    {
      id: "kGO-x437jU",
      from_name: "occupancy_rectangle",
      to_name: "image",
      type: "rectangle",
      original_width: 1080,
      original_height: 671,
      value: { x: 30.462962983659022, y: 55.7377048180995, width: 2.5, height: 4.172876304023845, rotation: 0 },
    },
    "logical-plant",
    "plant_decor",
  );
  addGroup(
    {
      id: "8tNDYvWbvG",
      from_name: "occupancy_polygon",
      to_name: "image",
      type: "polygon",
      original_width: 1080,
      original_height: 671,
      value: {
        points: [
          [45.46296296296296, 55.73770491803279],
          [45.46296296296296, 78.98658718330847],
          [46.48148148148148, 78.98658718330847],
          [46.48148148148148, 59.76154992548435],
          [49.44444444444444, 59.76154992548435],
          [49.44444444444444, 55.73770491803279],
        ],
      },
    },
    "logical-storage",
    "storage",
  );
  return results;
};
test("pixel validation ignores percentage round-trip drift without mutating stored coordinates", () => {
  const data = pixelDriftData();
  const before = JSON.stringify(data);
  expect(area(difference(resultGeometry(data[2]), resultGeometry(data[0])))).toBeGreaterThan(1e-8);
  expect(area(difference(validationGeometry(data[2]), validationGeometry(data[0])))).toBe(0);
  expect(validateOccupancy(data, "v1", { partial: true })).toEqual([]);
  expect(JSON.stringify(data)).toBe(before);
});
test("pixel validation still rejects a real quarter-pixel overflow", () => {
  const data = pixelDriftData();
  data[2].value.y -= (0.25 * 100) / data[2].original_height;
  const outside = validateOccupancy(data, "v1", { partial: true }).find((error) => error.code === "outside");
  expect(outside.objectId).toBe("kGO-x437jU");
  expect(outside.outsideAreaPx).toBeGreaterThan(0);
});
test("pixel validation ignores cross-engine boolean area noise", () => {
  const data = pixelDriftData();
  data[2].value.y -= (0.00002 * 100) / data[2].original_height;
  const outsideArea = area(difference(validationGeometry(data[2]), validationGeometry(data[0])));
  expect(outsideArea).toBeGreaterThan(1e-8);
  expect(outsideArea).toBeLessThan(VALIDATION_EPS_AREA);
  expect(validateOccupancy(data, "v1", { partial: true })).toEqual([]);
});
test("holes survive non-overlapping storage decomposition and JSON round trip", () => {
  let data = setup();
  data.push(...group(data, resultGeometry(rect(30, 30, 40, 40))));
  const preview = generateRemainder(data, data[0].id, "v1", id);
  const logical = logicalRegions(JSON.parse(JSON.stringify(preview.results)));
  const free = logical.find((r) => r.type === "unclassified");
  expect(free.geometry[0]).toHaveLength(2);
  expect(area(free.geometry)).toBeCloseTo(8400, 8);
  expect(free.parts.length).toBeGreaterThan(1);
  expect(equivalent(union(...free.parts.map(resultGeometry)), free.geometry)).toBe(true);
});
test("disconnected bed and cabinet share group but gap is not filled", () => {
  const data = setup();
  const pieces = union(resultGeometry(rect(10, 10, 15, 30)), resultGeometry(rect(30, 10, 5, 5)));
  data.push(...group(data, pieces));
  const logical = logicalRegions(data);
  expect(logical).toHaveLength(1);
  expect(logical[0].geometry).toHaveLength(2);
  expect(area(logical[0].geometry)).toBeCloseTo(475);
  expect(new Set(logical[0].parts.map((r) => r.id)).size).toBe(logical[0].parts.length);
});
test("same group union, different groups report overlap and explicit merge resolves it", () => {
  let data = setup();
  data.push(...group(data, resultGeometry(rect(10, 10, 20, 20))));
  data.push(...group(data, resultGeometry(rect(20, 20, 20, 20))));
  expect(validateOccupancy(data, "v1", { partial: true }).some((e) => e.code === "overlap")).toBe(true);
  expect(() => generateRemainder(data, data[0].id, "v1", id)).toThrow();
  data = mergeGroups(
    data,
    logicalRegions(data).map((r) => r.id),
    "dining",
    "",
    id,
  );
  expect(area(logicalRegions(data)[0].geometry)).toBeCloseTo(700);
  expect(validateOccupancy(data, "v1", { partial: true })).toEqual([]);
});
test("empty parent needs explicit generation, classification and review", () => {
  let data = setup();
  expect(validateOccupancy(data, "v1").map((e) => e.code)).toContain("coverage");
  data = generateRemainder(data, data[0].id, "v1", id).results;
  expect(() => confirmParents(data, [data[0].id], "v1")).toThrow("未分类");
  data = classifyLogical(data, logicalRegions(data)[0].id, "walkable");
  expect(validateOccupancy(data, "v1").some((e) => e.code === "review")).toBe(true);
  data = confirmParents(data, [data[0].id], "v1");
  expect(validateOccupancy(data, "v1")).toEqual([]);
  const repeated = generateRemainder(data, data[0].id, "v1", id);
  expect(repeated.unchanged).toBe(true);
  expect(repeated.results).toBe(data);
});
test("walkable generation classifies the difference directly and stays idempotent", () => {
  let data = setup();
  data.push(...group(data, resultGeometry(rect(30, 30, 40, 40))));
  const generated = generateWalkableArea(data, data[0].id, "v1", id);
  const free = logicalRegions(generated.results).filter((r) => r.type === "walkable");
  expect(free).toHaveLength(1);
  expect(area(free[0].geometry)).toBeCloseTo(8400, 8);
  expect(logicalRegions(generated.results).some((r) => r.type === "unclassified")).toBe(false);
  const repeated = generateWalkableArea(generated.results, data[0].id, "v1", id);
  expect(repeated.unchanged).toBe(true);
  expect(repeated.results).toBe(generated.results);
});
test("walkable generation preserves structured blocking issues instead of collapsing them", () => {
  const data = setup();
  data.push(...group(data, resultGeometry(rect(30, 30, 40, 40))));
  data[1].value.labels = ["Study/work"];

  try {
    generateWalkableArea(data, data[0].id, "v1", id);
    throw new Error("expected generation to be blocked");
  } catch (error) {
    expect(error.code).toBe(OCCUPANCY_GENERATION_BLOCKED);
    expect(error.parentId).toBe(data[0].id);
    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "source",
          parentId: data[0].id,
          savedParentFingerprint: expect.any(String),
          currentParentFingerprint: expect.any(String),
        }),
      ]),
    );
  }
});
test("overlap errors identify both conflicting logical regions", () => {
  const data = setup();
  data.push(...group(data, resultGeometry(rect(10, 10, 30, 30))));
  data.push(...group(data, resultGeometry(rect(20, 20, 30, 30))));
  const regions = logicalRegions(data);
  const overlap = validateOccupancy(data, "v1", { partial: true }).find((error) => error.code === "overlap");

  expect(overlap).toMatchObject({
    objectId: regions[0].id,
    relatedObjectId: regions[1].id,
  });
});
test("group reclassification preserves geometry and invalidates review", () => {
  let data = setup();
  data.push(...group(data, resultGeometry(rect(10, 10, 20, 20))));
  const before = logicalRegions(data)[0];
  data = reclassifyGroup(data, before.id, "study_work", "desk");
  const after = logicalRegions(data)[0];
  expect(after.context.group_type).toBe("study_work");
  expect(after.context.group_note).toBe("desk");
  expect(after.context.review_status).toBe("pending");
  expect(equivalent(after.geometry, before.geometry)).toBe(true);
  expect(() => reclassifyGroup(data, after.id, "other", "")).toThrow("必须填写说明");
});
test("plant decor is a valid furniture group category and survives logical export", () => {
  let data = setup();
  data.push(...group(data, resultGeometry(rect(10, 10, 20, 20))));
  const before = logicalRegions(data)[0];

  expect(GROUP_TYPES.plant_decor).toBe("绿植装饰");
  data = reclassifyGroup(data, before.id, "plant_decor");

  const after = logicalRegions(data)[0];
  expect(after.context.group_type).toBe("plant_decor");
  expect(validateOccupancy(data, "v1", { partial: true })).toEqual([]);
  expect(logicalExport(data).regions[0].group_type).toBe("plant_decor");
});
test("bay window is a valid furniture group category and survives logical export", () => {
  let data = setup();
  data.push(...group(data, resultGeometry(rect(10, 10, 20, 20))));
  const before = logicalRegions(data)[0];

  expect(GROUP_TYPES.bay_window).toBe("飘窗");
  data = reclassifyGroup(data, before.id, "bay_window");

  const after = logicalRegions(data)[0];
  expect(after.context.group_type).toBe("bay_window");
  expect(validateOccupancy(data, "v1", { partial: true })).toEqual([]);
  expect(logicalExport(data).regions[0].group_type).toBe("bay_window");
});
test("leisure recreation is a valid furniture group category and survives logical export", () => {
  let data = setup();
  data.push(...group(data, resultGeometry(rect(10, 10, 20, 20))));
  const before = logicalRegions(data)[0];

  expect(GROUP_TYPES.leisure_recreation).toBe("休闲娱乐");
  data = reclassifyGroup(data, before.id, "leisure_recreation");

  const after = logicalRegions(data)[0];
  expect(after.context.group_type).toBe("leisure_recreation");
  expect(after.context.group_note).toBe("");
  expect(after.context.review_status).toBe("pending");
  expect(equivalent(after.geometry, before.geometry)).toBe(true);
  expect(validateOccupancy(data, "v1", { partial: true })).toEqual([]);
  expect(logicalExport(data).regions[0].group_type).toBe("leisure_recreation");
});
test("logical deletion removes every paired group part and makes retained automatic walkable stale", () => {
  let data = setup();
  const geometry = union(resultGeometry(rect(10, 10, 10, 20)), resultGeometry(rect(30, 10, 8, 8)));
  data.push(...group(data, geometry));
  const target = logicalRegions(data)[0];
  const removedStorageIds = target.parts.map((part) => part.id);
  data = generateWalkableArea(data, data[0].id, "v1", id).results;
  data = confirmParents(data, [data[0].id], "v1");

  const operation = deleteLogicalRegion(data, target.id);

  expect(operation).toMatchObject({
    logicalId: target.id,
    parentId: data[0].id,
    type: "furniture_group",
    deletedParts: removedStorageIds.length,
    staleRemainders: 1,
  });
  expect(operation.results.some((result) => removedStorageIds.includes(result.id))).toBe(false);
  expect(logicalRegions(operation.results).map((region) => region.type)).toEqual(["walkable"]);
  expect(validateOccupancy(operation.results, "v1").map((error) => error.code)).toEqual(
    expect.arrayContaining(["stale", "coverage", "review"]),
  );
});
test("logical deletion fails closed for manual Relations and automatic remainder", () => {
  let data = setup();
  data.push(...group(data, resultGeometry(rect(10, 10, 20, 20))));
  const target = logicalRegions(data)[0];
  const relation = { type: "relation", from_id: target.parts[0].id, to_id: "parent", direction: "right" };

  expect(() => deleteLogicalRegion([...data, relation], target.id)).toThrow("Relations");
  expect(logicalRegions([...data, relation])).toHaveLength(1);

  const generated = generateWalkableArea(data, data[0].id, "v1", id).results;
  const remainder = logicalRegions(generated).find((region) => region.context.generation === "remainder");
  expect(() => deleteLogicalRegion(generated, remainder.id)).toThrow("不能单独删除");
});
test("local free-space correction splits one connected area into two classes", () => {
  let data = setup();
  data = generateRemainder(data, data[0].id, "v1", id).results;
  data = classifyLogical(data, logicalRegions(data)[0].id, "walkable");
  data = localCorrection(data, logicalRegions(data)[0].id, resultGeometry(rect(0, 0, 1, 100)), "restricted_free", id);
  expect(
    logicalRegions(data)
      .map((r) => r.type)
      .sort(),
  ).toEqual(["restricted_free", "walkable"]);
  data = confirmParents(data, [data[0].id], "v1");
  expect(validateOccupancy(data, "v1")).toEqual([]);
  expect(generateRemainder(data, data[0].id, "v1", id).unchanged).toBe(true);
});
test("modified obstacles mark previous remainder stale; regeneration preserves manual free", () => {
  let data = setup();
  const p = parents(data)[0];
  const manual = resultsForGeometry(
    resultGeometry(rect(0, 0, 5, 100)),
    "restricted_free",
    baseContext(p, "v1", "manual", id()),
    p.result,
    id,
  );
  data.push(...manual);
  data = generateRemainder(data, p.id, "v1", id).results;
  data.push(...group(data, resultGeometry(rect(10, 10, 10, 10))));
  expect(validateOccupancy(data, "v1").some((e) => e.code === "stale")).toBe(true);
  data = generateRemainder(data, p.id, "v1", id).results;
  for (const r of manual) expect(data).toContainEqual(r);
});
test("source changes invalidate review and orphaned areas are retained", () => {
  let data = setup();
  data = generateRemainder(data, data[0].id, "v1", id).results;
  data = classifyLogical(data, logicalRegions(data)[0].id, "walkable");
  data = confirmParents(data, [data[0].id], "v1");
  expect(validateOccupancy(data, "v2-unrelated-source-change")).toEqual([]);
  data[1].value.labels = ["Toilet"];
  expect(validateOccupancy(data, "v1").some((e) => e.code === "source")).toBe(true);
  const orphan = data.slice(2);
  expect(validateOccupancy(orphan, "v1").some((e) => e.code === "parent_missing")).toBe(true);
  expect(logicalExport(orphan, "v1").regions).toHaveLength(1);
});
test("tiny disconnected components retained; concave parents and multiple holes", () => {
  const multi = [
    [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [6, 10],
        [6, 6],
        [0, 6],
        [0, 0],
      ],
      [
        [1, 1],
        [2, 1],
        [2, 2],
        [1, 2],
        [1, 1],
      ],
      [
        [3, 1],
        [4, 1],
        [4, 2],
        [3, 2],
        [3, 1],
      ],
    ],
    [
      [
        [20, 20],
        [20.0000001, 20],
        [20.0000001, 20.0000001],
        [20, 20.0000001],
        [20, 20],
      ],
    ],
  ];
  const parts = storageParts(multi);
  expect(parts.some((p) => p[0][0] === 20)).toBe(true);
  expect(equivalent(union(...parts.map((r) => [[r]])), multi)).toBe(true);
});
test("invalid rings fail closed rather than using bbox/convex hull", () => {
  expect(() =>
    resultGeometry({
      value: {
        points: [
          [0, 0],
          [10, 10],
          [0, 10],
          [10, 0],
        ],
      },
    }),
  ).toThrow("自交");
});
test("fingerprints ignore object key order but track numerical content", () => {
  expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }));
  expect(fingerprint({ a: 1.001 })).not.toBe(fingerprint({ a: 1 }));
});

test("content fingerprints use Python-compatible code-point ordering for mixed-case result IDs", () => {
  const results = setup();
  const parent = parents(results)[0];
  const add = (resultId, logicalId, x) => {
    const occupancyContext = {
      ...baseContext(parent, "v1", "manual", logicalId),
      group_id: logicalId,
      group_type: "storage",
    };
    return resultsForGeometry(
      [[[[x, 10], [x + 10, 10], [x + 10, 20], [x, 20]]]],
      "furniture_group",
      occupancyContext,
      parent.result,
      () => resultId,
    );
  };
  const data = [...results, ...add("a-region", "logical-a", 10), ...add("Z-region", "logical-Z", 30)];
  const semanticRegions = data
    .filter((result) => GEOMETRY.has(result.from_name))
    .map((result) => {
      const occupancyContext = context(result);
      return {
        id: result.id,
        control: result.from_name,
        value: result.value,
        width: result.original_width,
        height: result.original_height,
        type: "furniture_group",
        logical_id: occupancyContext.logical_id,
        group_id: occupancyContext.group_id || null,
        group_type: occupancyContext.group_type || null,
        group_note: occupancyContext.group_note || "",
        parent_zone_id: occupancyContext.parent_zone_id,
        parent_room_id: occupancyContext.parent_room_id,
        generation: occupancyContext.generation,
        parent_fingerprint: occupancyContext.parent_fingerprint,
        remainder_input_fingerprint: occupancyContext.remainder_input_fingerprint || null,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  expect(semanticRegions.map((region) => region.id)).toEqual(["Z-region", "a-region"]);
  expect(parentContentFingerprint(data, parent.id)).toBe(
    fingerprint({ parent: parent.fingerprint, regions: semanticRegions }),
  );
});
