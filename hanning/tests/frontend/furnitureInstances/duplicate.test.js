import { TextEncoder } from "util";
import { duplicateFurnitureInstance } from "@hanning/frontend/domain/furnitureInstances/duplicate";
import { context, furnitureInstances } from "@hanning/frontend/domain/furnitureInstances/domain";
import {
  confirmFurnitureInstances,
  validateFurnitureInstances,
} from "@hanning/frontend/domain/furnitureInstances/constraints";
import { makeInstance, makeOccupancy, stampProvenance, square, id } from "./helpers";
global.TextEncoder = TextEncoder;

const data = (options = {}, group) => {
  const refs = makeOccupancy(group);
  return [...refs, ...makeInstance(refs, { instanceType: "dining_chair", ...options })];
};

test("copy keeps category, parent, note, rotation and paired IDs but resets review and provenance", () => {
  const source = stampProvenance(
    data({
      note: "餐椅",
      rectangle: { x: 30, y: 30, width: 8, height: 10, rotation: 23 },
    }),
  );
  const before = JSON.stringify(source);
  const copy = duplicateFurnitureInstance(source, "instance-i", id);
  const original = furnitureInstances(source)[0],
    instance = furnitureInstances(copy.results)[0];
  expect(JSON.stringify(source)).toBe(before);
  expect(copy.offset).toEqual([4, 4]);
  expect(instance.id).not.toBe(original.id);
  expect(instance.context).toMatchObject({
    instance_type: "dining_chair",
    note: "餐椅",
    group_id: "group-g",
    review_status: "pending",
    review_fingerprint: null,
  });
  expect(instance.parts[0].value).toMatchObject({
    x: 30.4,
    y: 30.8,
    width: 8,
    height: 10,
    rotation: 23,
  });
  expect(instance.parts[0].id).toBe(instance.categories[0].id);
  for (const result of copy.results) {
    expect(original.results.some((r) => r.id === result.id)).toBe(false);
    expect(result.meta.furniture_instance_provenance).toBeUndefined();
  }
  expect(
    validateFurnitureInstances([...source, ...copy.results], source, {
      review: false,
    }),
  ).toEqual([]);
});

test("a reviewed original stays reviewed while the independent copy requires review", () => {
  const source = data();
  const reviewed = confirmFurnitureInstances(source, source, ["instance-i"]);
  expect(furnitureInstances(reviewed)[0].context.review_status).toBe("reviewed");
  const copy = duplicateFurnitureInstance(reviewed, "instance-i", id);
  expect(furnitureInstances(copy.results)[0].context.review_status).toBe("pending");
  expect(furnitureInstances(copy.results)[0].context.review_fingerprint).toBeNull();
  expect(furnitureInstances(reviewed)[0].context.review_status).toBe("reviewed");
});

test.each(["front_edge", "front_direction"])("%s evidence translates with the entire copy", (status) => {
  const source = data({
    orientation: {
      status,
      vertices: [
        { x: 20, y: 20 },
        { x: 40, y: 20 },
      ],
    },
  });
  const copy = duplicateFurnitureInstance(source, "instance-i", id);
  const instance = furnitureInstances(copy.results)[0];
  expect(instance.orientationResults[0].value.vertices[0]).toMatchObject({
    x: 20.4,
    y: 20.8,
  });
  expect(
    validateFurnitureInstances([...source, ...copy.results], source, {
      review: false,
    }),
  ).toEqual([]);
});

test("multi-part polygon and hole stay rigid with all category pairs preserved", () => {
  const hole = square(30, 30, 40, 40)[0].slice().reverse();
  const source = data({
    geometry: [[square(20, 20, 60, 60)[0], hole], square(70, 70, 80, 80)],
  });
  const original = furnitureInstances(source)[0];
  const copy = duplicateFurnitureInstance(source, "instance-i", id);
  const instance = furnitureInstances(copy.results)[0];
  expect(instance.parts).toHaveLength(original.parts.length);
  expect(instance.geometry).toHaveLength(2);
  expect(instance.geometry.some((p) => p.length === 2)).toBe(true);
  expect(instance.categories).toHaveLength(instance.parts.length);
});

test("boundary copy chooses an inward offset and a full-parent copy falls back to zero", () => {
  const near = data({ geometry: [square(80, 80, 90, 90)] });
  const copied = duplicateFurnitureInstance(near, "instance-i", id);
  expect(copied.offset).toEqual([-4, -4]);
  const full = data({ geometry: [square(10, 10, 90, 90)] });
  expect(duplicateFurnitureInstance(full, "instance-i", id).offset).toEqual([0, 0]);
});

test("stale parent, invalid geometry and missing selection reject without touching input", () => {
  const source = data();
  const before = JSON.stringify(source);
  expect(() => duplicateFurnitureInstance(source, "absent", id)).toThrow("选择");
  const stale = source.map((r) =>
    context(r).instance_id
      ? {
          ...r,
          meta: {
            ...r.meta,
            furniture_instance_context: {
              ...context(r),
              parent_fingerprint: "changed",
            },
          },
        }
      : r,
  );
  expect(() => duplicateFurnitureInstance(stale, "instance-i", id)).toThrow();
  expect(() => duplicateFurnitureInstance(data({ geometry: [square(0, 0, 20, 20)] }), "instance-i", id)).toThrow();
  expect(JSON.stringify(source)).toBe(before);
});
