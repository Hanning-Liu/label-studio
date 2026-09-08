import {
  furnitureGeometryStyles,
  furnitureInstanceNames,
  furnitureShapeStyles,
  layoutFurnitureLabels,
} from "../appearance";
import { instanceHitGeometry, furnitureScreenTransform } from "../FurnitureInstanceLayer";
import { furnitureReferenceStyles } from "../referenceDisplay";
import { FURNITURE_TYPES } from "../domain";
import details from "../catalogDetails.json";

test("all 28 classes have definitions, aliases and valid disambiguation links", () => {
  expect(Object.keys(details).sort()).toEqual(Object.keys(FURNITURE_TYPES).sort());
  for (const entry of Object.values(details)) {
    expect(entry.definition.length).toBeGreaterThan(5);
    expect(entry.aliases.length).toBeGreaterThan(0);
    expect(entry.confusable.every((type) => Object.hasOwn(FURNITURE_TYPES, type))).toBe(true);
  }
});

test("fill alpha does not weaken category strokes and native parts have one visible owner", () => {
  const normal = furnitureShapeStyles("sink");
  const selected = furnitureShapeStyles("sink", "selected");
  expect(normal.strokeColor).toBe("#EA580C");
  expect(normal.fillColor).toContain("0.1");
  expect(selected.fillColor).toContain("0.16");
  expect(selected.strokeWidth).toBe(3);
  const region = {
    parent: { furnitureInstancesEnabled: true, furnitureInstanceDraftType: "bar_counter" },
    control: { name: "furniture_instance_rectangle" },
    results: [],
  };
  expect(furnitureGeometryStyles(region, {}).strokeWidth).toBe(0);
  expect(furnitureGeometryStyles({ ...region, isDrawing: true }, {})).toMatchObject({
    strokeColor: "#16A34A",
    strokeWidth: 2,
  });
  expect(furnitureGeometryStyles({ ...region, selected: true }, {})).toMatchObject({ strokeWidth: 3 });
  expect(furnitureGeometryStyles({ ...region, parent: {} }, {})).toBeNull();
});

test("all native selected parts are removed from the logical overlay", () => {
  const instance = {
    parts: [{ id: "a" }, { id: "b" }],
    geometry: [
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    ],
  };
  expect(instanceHitGeometry(instance, new Set(["a", "b"]))).toEqual([]);
  expect(instanceHitGeometry(instance, new Set())).toBe(instance.geometry);
});

test("short names extend colliding ID suffixes without creating identities", () => {
  const instances = ["one-123456", "two-123456", "third-abcdef"].map((id) => ({
    id,
    context: { instance_type: "sink" },
  }));
  const names = furnitureInstanceNames(instances);
  expect(new Set(names.values()).size).toBe(3);
  expect(names.get("third-abcdef")).toBe("水槽 · abcdef");
  expect(furnitureInstanceNames([instances[0]]).get("one-123456")).toBe("水槽");
});

test.each([0.25, 0.5, 1, 2])("label placement and text sizes remain in screen pixels at zoom %s", (zoomScale) => {
  const matrix = furnitureScreenTransform({ zoomScale, rotation: 90, zoomingPositionX: 20, zoomingPositionY: 30 });
  const transformed = matrix.point({ x: 50, y: 60 });
  const restored = matrix.copy().invert().point(transformed);
  expect(restored.x).toBeCloseTo(50);
  expect(restored.y).toBeCloseTo(60);
  const entries = [3, 2, 1].map((priority) => ({
    id: String(priority),
    priority,
    text: "水槽 · abcdef",
    bounds: { x: 50, y: 50, width: 30, height: 30 },
  }));
  const result = layoutFurnitureLabels(entries, { width: 320, height: 200 });
  expect(result.slice(0, 2).map((label) => label.priority)).toEqual([3, 2]);
  for (const label of result) {
    expect(label.height).toBe(23);
    expect(label.x).toBeGreaterThanOrEqual(0);
    expect(label.x + label.width).toBeLessThanOrEqual(320);
    expect(label.y + label.height).toBeLessThanOrEqual(200);
  }
});

test("native parent references contribute no duplicate focus fill", () => {
  const region = {
    control: { name: "occupancy_polygon" },
    results: [{ meta: { occupancy_context: { group_id: "g" } } }],
    parent: {
      furnitureInstancesEnabled: true,
      furnitureInstanceIsReference: () => true,
      furnitureInstanceParents: [{ id: "g" }],
      furnitureInstanceFocusId: "g",
    },
  };
  const style = furnitureReferenceStyles(region, { fillColor: "#ff0000", strokeColor: "#ff0000" });
  expect(style.fillColor).toContain(", 0)");
  expect(style.strokeColor).toContain(", 0)");
});
