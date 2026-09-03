import fs from "fs";
import path from "path";
import { TextEncoder } from "util";
import { confirmFurnitureInstances } from "../constraints";
import { exportFurnitureInstances } from "../download";
import { makeInstance, makeOccupancy, resetIds, stampProvenance } from "./helpers";

global.TextEncoder = TextEncoder;

const AjvModule = require("ajv/dist/2020");
const Ajv2020 = AjvModule.default || AjvModule;
const fixtureDirectory = path.resolve(__dirname, "../../../../../../examples/occupancy-schema-foundation");
const schema = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, "multilevel-occupancy.schema.json"), "utf8"));
const example = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, "example.json"), "utf8"));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
const clone = (value) => JSON.parse(JSON.stringify(value));

beforeEach(resetIds);

test("the complete floorplan-unified/4 example passes the strict Draft 2020-12 contract", () => {
  expect(validate(example)).toBe(true);
  expect(validate.errors).toBeNull();
});

test("the same L1-L3 aggregate remains valid as floorplan-unified/3", () => {
  const legacy = clone(example);
  legacy.schema = "floorplan-unified/3";
  for (const field of [
    "occupancy_barriers",
    "window_matching_policy",
    "window_traces",
    "window_connections",
    "furniture_instances",
    "window_projections",
  ])
    delete legacy[field];
  expect(validate(legacy)).toBe(true);
  expect(validate.errors).toBeNull();
});

test.each(["parent", "source_version", "parent_fingerprint", "review_status", "review_fingerprint", "source_results"])(
  "floorplan-unified/4 rejects a furniture instance missing %s",
  (field) => {
    const invalid = clone(example);
    delete invalid.furniture_instances[0][field];
    expect(validate(invalid)).toBe(false);
  },
);

test("floorplan-unified/4 rejects an incomplete L1→L2→L3 parent chain", () => {
  const invalid = clone(example);
  delete invalid.furniture_instances[0].parent.group_id;
  expect(validate(invalid)).toBe(false);
});

test("floorplan-unified/4 rejects incomplete source result evidence", () => {
  const invalid = clone(example);
  invalid.furniture_instances[0].source_results = invalid.furniture_instances[0].source_results.slice(0, 1);
  expect(validate(invalid)).toBe(false);
});

test("the future L4 adjacent_to_window projection remains accepted unchanged", () => {
  const projection = example.window_projections.find((item) => item.target.level === "L4");
  expect(projection).toMatchObject({
    target: { level: "L4", entity_id: example.furniture_instances[0].id },
    relation: { kind: "adjacent_to_window" },
  });
  expect(validate(example)).toBe(true);
});

test("the frontend's formally reviewed aggregate satisfies floorplan-unified/4", () => {
  const occupancy = makeOccupancy();
  let results = makeInstance(occupancy);
  results = confirmFurnitureInstances(results, occupancy, ["instance-i"]);
  results = stampProvenance(results);
  const actual = clone(example);
  actual.furniture_instances = exportFurnitureInstances(results, occupancy);
  expect(actual.furniture_instances[0].provenance).not.toHaveProperty("schema_version");
  expect(actual.furniture_instances[0].source_results[0].provenance).not.toHaveProperty("schema_version");
  // This fixture's L4 projection targets its original example instance. Keep
  // the interface but point it at the generated stable instance ID.
  actual.window_projections = actual.window_projections.map((projection) =>
    projection.target.level === "L4"
      ? { ...projection, target: { ...projection.target, entity_id: actual.furniture_instances[0].id } }
      : projection,
  );
  expect(validate(actual)).toBe(true);
  expect(validate.errors).toBeNull();
});
