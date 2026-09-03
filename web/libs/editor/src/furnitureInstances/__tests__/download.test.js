import { TextEncoder } from "util";
import { confirmFurnitureInstances, validateFurnitureInstances } from "../constraints";
import { context, furnitureInstances } from "../domain";
import {
  aggregateFurnitureInstances,
  exportFurnitureInstances,
  reimportFurnitureInstances,
  withFurnitureInstances,
} from "../download";
import { makeInstance, makeOccupancy, resetIds, square, stampProvenance } from "./helpers";

global.TextEncoder = TextEncoder;

beforeEach(resetIds);

const savedResults = (occupancy, options = {}) => {
  let results = makeInstance(occupancy, options);
  results = confirmFurnitureInstances(results, occupancy, [options.instanceId || "instance-i"]);
  return stampProvenance(results);
};

test("formal export requires server-stamped per-result provenance but draft validation does not", () => {
  const occupancy = makeOccupancy();
  const draft = makeInstance(occupancy);
  expect(validateFurnitureInstances(draft, occupancy, { review: false })).toEqual([]);
  expect(() => exportFurnitureInstances(draft, occupancy, { requireReview: false })).toThrow("服务端 provenance");

  const corrupt = stampProvenance(draft);
  corrupt[0].meta.furniture_instance_provenance.result_id = "different-result";
  expect(
    validateFurnitureInstances(corrupt, occupancy, { review: false }).some((issue) => issue.code === "provenance"),
  ).toBe(true);
});

test("save, JSON refresh, export and reimport preserve all source results and provenance", () => {
  const occupancy = makeOccupancy();
  const results = savedResults(occupancy, {
    orientation: {
      status: "front_direction",
      vertices: [
        { x: 25, y: 30 },
        { x: 35, y: 30 },
      ],
    },
  });
  const refreshed = JSON.parse(JSON.stringify(results));
  expect(validateFurnitureInstances(refreshed, occupancy)).toEqual([]);

  const exported = exportFurnitureInstances(refreshed, occupancy);
  expect(exported).toHaveLength(1);
  expect(exported[0]).toMatchObject({
    kind: "furniture_instance",
    id: "instance-i",
    instance_type: "desk",
    parent: { room_id: "room-r", zone_id: "zone-z", group_id: "group-g" },
    orientation: {
      status: "front_direction",
      origin: { x: 25, y: 30 },
      direction_vector: { dx: 1, dy: 0 },
    },
    review_status: "reviewed",
  });
  expect(exported[0].source_results.map((source) => source.role)).toEqual(["geometry", "category", "front_direction"]);
  for (const source of exported[0].source_results) {
    expect(source.provenance).toMatchObject({ project_id: 14, task_id: 24, annotation_id: 104 });
    expect(source.provenance.result_id).toBe(source.raw.id);
    expect(source.provenance).not.toHaveProperty("schema_version");
  }
  expect(exported[0].provenance).toEqual(exported[0].source_results[0].provenance);

  const reimported = reimportFurnitureInstances(JSON.parse(JSON.stringify({ furniture_instances: exported })));
  expect(validateFurnitureInstances(reimported, occupancy)).toEqual([]);
  expect(exportFurnitureInstances(reimported, occupancy)).toEqual(exported);
});

test("aggregate output keeps natural Polygon/MultiPolygon geometry, every part and every hole", () => {
  const occupancy = makeOccupancy();
  const geometry = [[square(20, 20, 60, 60)[0], square(30, 30, 40, 40)[0]], square(70, 20, 80, 30)];
  const results = savedResults(occupancy, { geometry });
  const [exported] = exportFurnitureInstances(results, occupancy);
  expect(exported.geometry.type).toBe("MultiPolygon");
  expect(exported.geometry.coordinates).toHaveLength(2);
  expect(exported.geometry.coordinates[0]).toHaveLength(2);
  expect(exported.source_results.filter((source) => source.role === "geometry").length).toBe(
    furnitureInstances(results)[0].parts.length,
  );
  expect(exported.source_results.filter((source) => source.role === "category").length).toBe(
    furnitureInstances(results)[0].parts.length,
  );
});

test("unknown orientation remains explicit unknown even for a rotated category-bearing rectangle", () => {
  const occupancy = makeOccupancy();
  const results = savedResults(occupancy, {
    instanceType: "bed",
    rectangle: { x: 25, y: 25, width: 20, height: 10, rotation: 91 },
  });
  expect(exportFurnitureInstances(results, occupancy)[0].orientation).toEqual({ status: "unknown" });
});

test("floorplan-unified/4 attachment preserves the future L4 adjacent_to_window interface verbatim", () => {
  const occupancy = makeOccupancy();
  const results = savedResults(occupancy);
  const projection = {
    kind: "window_projection",
    target: { level: "L4", entity_id: "instance-i", room_id: "room-r" },
    relation: { kind: "adjacent_to_window", evidence: "positive_area_inward_projection_intersection" },
  };
  const unified = { schema: "floorplan-unified/4", window_projections: [projection], furniture_instances: [] };
  const aggregated = aggregateFurnitureInstances(unified, results, occupancy);
  expect(aggregated.window_projections).toEqual([projection]);
  expect(aggregated.furniture_instances).toHaveLength(1);
  expect(unified.furniture_instances).toEqual([]);
  expect(() => withFurnitureInstances({ schema: "floorplan-unified/3" }, [])).toThrow("floorplan-unified/4");
});

test("reimport rejects source role or provenance corruption instead of guessing associations", () => {
  const occupancy = makeOccupancy();
  const exported = exportFurnitureInstances(savedResults(occupancy), occupancy);
  exported[0].source_results[0].role = "category";
  expect(() => reimportFurnitureInstances(exported)).toThrow("role");

  const clean = exportFurnitureInstances(savedResults(occupancy), occupancy);
  clean[0].source_results[0].provenance.result_id = "wrong";
  expect(() => reimportFurnitureInstances(clean)).toThrow("provenance");

  const extra = exportFurnitureInstances(savedResults(occupancy), occupancy);
  extra[0].source_results[0].provenance.schema_version = 1;
  expect(() => reimportFurnitureInstances(extra)).toThrow("公共 Schema");

  const unknown = exportFurnitureInstances(savedResults(occupancy), occupancy);
  delete unknown[0].source_results[0].role;
  unknown[0].source_results[0].raw.from_name = "unknown_control";
  expect(() => reimportFurnitureInstances(unknown)).toThrow("role");
});

test("reimport requires strict instance provenance matching the primary geometry source", () => {
  const occupancy = makeOccupancy();

  const missing = JSON.parse(JSON.stringify(exportFurnitureInstances(savedResults(occupancy), occupancy)));
  delete missing[0].provenance;
  expect(() => reimportFurnitureInstances(missing)).toThrow("primary geometry source");

  const tampered = JSON.parse(JSON.stringify(exportFurnitureInstances(savedResults(occupancy), occupancy)));
  tampered[0].provenance.annotation_id += 1;
  expect(() => reimportFurnitureInstances(tampered)).toThrow("primary geometry source");

  const extra = JSON.parse(JSON.stringify(exportFurnitureInstances(savedResults(occupancy), occupancy)));
  extra[0].provenance.schema_version = 1;
  expect(() => reimportFurnitureInstances(extra)).toThrow("primary geometry source");
});

test("server provenance is separate from the editable context and survives confirmation", () => {
  const occupancy = makeOccupancy();
  const results = savedResults(occupancy);
  expect(context(results[0]).provenance).toBeUndefined();
  expect(results[0].meta.furniture_instance_provenance).toMatchObject({
    schema_version: 1,
    result_id: results[0].id,
  });
});
