import { TextEncoder } from "util";
import { area, equivalent, fingerprint, resultGeometry, storageParts, union } from "../geometry";
import {
  baseContext,
  classifyLogical,
  confirmParents,
  generateRemainder,
  logicalExport,
  logicalRegions,
  mergeGroups,
  parents,
  resultsForGeometry,
  validateOccupancy,
  localCorrection,
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
