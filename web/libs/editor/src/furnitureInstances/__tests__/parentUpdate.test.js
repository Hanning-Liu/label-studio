import { TextEncoder } from "util";
import { acceptFurnitureParentUpdate, furnitureParentUpdate } from "../parentUpdate";
import { confirmFurnitureInstances, invalidateFurnitureReviews, validateFurnitureInstances } from "../constraints";
import { context, furnitureGroups } from "../domain";
import { FurnitureReviewSession } from "../reviewSession";
import { furnitureInstances } from "../domain";
import { makeInstance, makeOccupancy, resetIds, square, stampProvenance } from "./helpers";

global.TextEncoder = TextEncoder;
beforeEach(resetIds);

export const changedParent = (refs) =>
  refs.map((r) =>
    r.meta?.occupancy_context?.group_id === "group-g"
      ? { ...r, meta: { ...r.meta, occupancy_context: { ...r.meta.occupancy_context, group_note: "new boundary" } } }
      : r,
  );

const setup = () => {
  const refs = makeOccupancy();
  const manual = stampProvenance(
    confirmFurnitureInstances(
      [
        ...makeInstance(refs, {
          geometry: [square(20, 20, 30, 30), square(40, 40, 50, 50)],
          orientation: {
            status: "front_direction",
            vertices: [
              { x: 22, y: 25 },
              { x: 28, y: 25 },
            ],
          },
        }),
        ...makeInstance(refs, { instanceId: "untouched" }),
      ],
      refs,
      ["instance-i", "untouched"],
    ),
  );
  const nextRefs = changedParent(refs);
  let data = [...nextRefs, ...invalidateFurnitureReviews(manual, nextRefs)];
  const controller = {
    state: {
      status: {
        enabled: true,
        sync_type: "occupancy_to_furniture_instances",
        source_version: "v2",
        reference_version: "v2",
      },
    },
    checkFurnitureInstancesReference: jest.fn().mockResolvedValue({}),
  };
  const annotation = {
    referenceVersion: "v2",
    store: { referenceSyncController: controller },
    serializeAnnotation: () => data,
    saveDraftImmediatelyWithResults: jest.fn().mockResolvedValue({}),
    isReadOnly: () => false,
  };
  const item = {
    annotation,
    furnitureInstanceEffectiveSelectedId: "instance-i",
    furnitureInstanceFocusId: "group-g",
    setFurnitureInstanceBusy: (busy) => {
      item.furnitureInstanceBusy = busy;
    },
    get furnitureInstanceLogicals() {
      return furnitureInstances(data);
    },
    get furnitureInstanceParents() {
      return furnitureGroups(data);
    },
    get furnitureInstanceErrors() {
      return validateFurnitureInstances(data, data);
    },
    acceptFurnitureInstanceParentUpdate: jest.fn((id) => {
      data = furnitureParentUpdate(data, data, id).results;
    }),
  };
  return {
    refs,
    manual,
    nextRefs,
    item,
    annotation,
    controller,
    get data() {
      return data;
    },
    setData: (value) => {
      data = value;
    },
  };
};

test("explicit same-parent acceptance changes only the target's parent/review fields across all parts and evidence", () => {
  const s = setup();
  const before = JSON.stringify(s.data);
  const after = furnitureParentUpdate(s.data, s.data, "instance-i").results;
  expect(JSON.stringify(s.data)).toBe(before);
  const parent = furnitureGroups(s.data)[0];
  after.forEach((result, i) => {
    if (context(result).instance_id !== "instance-i") expect(result).toBe(s.data[i]);
    else
      expect(result).toEqual({
        ...s.data[i],
        meta: {
          ...s.data[i].meta,
          furniture_instance_context: {
            ...context(s.data[i]),
            parent_fingerprint: parent.fingerprint,
            review_status: "pending",
            review_fingerprint: null,
          },
        },
      });
  });
  expect(
    validateFurnitureInstances(after, after, { review: false }).filter((e) => e.instanceId === "instance-i"),
  ).toEqual([]);
  const reviewed = confirmFurnitureInstances(after, after, ["instance-i"]);
  expect(context(reviewed.find((r) => context(r).instance_id === "instance-i")).review_status).toBe("reviewed");
  expect(furnitureParentUpdate(reviewed, reviewed, "instance-i").results).toBe(reviewed);
});

test.each([
  ["outside", [square(25, 25, 35, 35)]],
  ["hole", [[...square(10, 10, 90, 90), ...square(19, 19, 31, 31)]]],
])("parent %s blocks acceptance without changing input", (_name, geometry) => {
  const s = setup();
  const refs = makeOccupancy([{ id: "group-g", type: "study_work", geometry }]);
  const data = [...refs, ...s.manual];
  const before = JSON.stringify(data);
  expect(() => furnitureParentUpdate(data, data, "instance-i")).toThrow(/超出/);
  expect(JSON.stringify(data)).toBe(before);
});

test.each(["deleted", "replaced", "chain", "duplicate", "inconsistent", "orientation"])(
  "%s cannot be silently repaired",
  (kind) => {
    const s = setup();
    let data = s.data;
    if (["deleted", "replaced"].includes(kind))
      data = [
        ...makeOccupancy(
          kind === "deleted" ? [] : [{ id: "replacement", type: "study_work", geometry: [square(10, 10, 90, 90)] }],
        ),
        ...s.manual,
      ];
    if (kind === "chain")
      data = data.map((r) =>
        context(r).instance_id === "instance-i"
          ? { ...r, meta: { ...r.meta, furniture_instance_context: { ...context(r), zone_id: "other-zone" } } }
          : r,
      );
    if (kind === "duplicate") data = [...data, ...s.nextRefs.filter((r) => r.from_name.startsWith("occupancy_"))];
    if (kind === "inconsistent")
      data = data.map((r, i) =>
        i === s.nextRefs.length
          ? {
              ...r,
              meta: { ...r.meta, furniture_instance_context: { ...context(r), parent_fingerprint: "0".repeat(64) } },
            }
          : r,
      );
    if (kind === "orientation")
      data = data.map((r) =>
        r.from_name === "furniture_front_direction"
          ? { ...r, value: { ...r.value, vertices: r.value.vertices.slice(0, 1) } }
          : r,
      );
    const before = JSON.stringify(data);
    expect(() => furnitureParentUpdate(data, data, "instance-i")).toThrow();
    expect(JSON.stringify(data)).toBe(before);
  },
);

test("unknown direction and reverted parent can be explicitly recovered without creating evidence", () => {
  const refs = makeOccupancy();
  const data = [
    ...refs,
    ...makeInstance(refs).map((r) => ({
      ...r,
      meta: { ...r.meta, furniture_instance_context: { ...context(r), review_status: "stale" } },
    })),
  ];
  const next = furnitureParentUpdate(data, data, "instance-i").results;
  expect(next).toHaveLength(data.length);
  expect(validateFurnitureInstances(next, next, { review: false })).toEqual([]);
});

test.each(["edit", "delete", "selection", "reference", "annotation", "parent"])(
  "async %s aborts acceptance before mutation",
  async (kind) => {
    const s = setup();
    s.controller.checkFurnitureInstancesReference.mockImplementation(async () => {
      if (kind === "selection") s.item.furnitureInstanceEffectiveSelectedId = "untouched";
      if (kind === "reference") s.annotation.referenceVersion = "v3";
      if (kind === "annotation") s.item.annotation = { ...s.annotation };
      if (kind === "delete") s.setData(s.data.filter((r) => context(r).instance_id !== "instance-i"));
      if (kind === "edit")
        s.setData(
          s.data.map((r) =>
            context(r).instance_id === "instance-i"
              ? { ...r, meta: { ...r.meta, furniture_instance_context: { ...context(r), note: "edit" } } }
              : r,
          ),
        );
      if (kind === "parent")
        s.setData(
          s.data.map((r) =>
            r.meta?.occupancy_context?.group_id
              ? {
                  ...r,
                  meta: { ...r.meta, occupancy_context: { ...r.meta.occupancy_context, group_note: "another update" } },
                }
              : r,
          ),
        );
    });
    await expect(acceptFurnitureParentUpdate(s.item, "instance-i")).rejects.toThrow();
    expect(s.item.acceptFurnitureInstanceParentUpdate).not.toHaveBeenCalled();
    expect(s.annotation.saveDraftImmediatelyWithResults).toHaveBeenCalledTimes(1);
  },
);

test.each(["save", "reference", "model"])(
  "%s failure leaves the instance blocked and never claims recovery",
  async (failure) => {
    const s = setup();
    if (failure === "save") s.annotation.saveDraftImmediatelyWithResults.mockRejectedValue(new Error("offline"));
    if (failure === "reference") s.controller.checkFurnitureInstancesReference.mockRejectedValue(new Error("conflict"));
    if (failure === "model")
      s.item.acceptFurnitureInstanceParentUpdate.mockImplementation(() => {
        throw new Error("model");
      });
    const before = JSON.stringify(s.data);
    const review = new FurnitureReviewSession(s.item);
    await review.acceptParentUpdate("instance-i");
    expect(JSON.stringify(s.data)).toBe(before);
    expect(review.unsaved).toBe(false);
    expect(review.frozenCounts).toBeNull();
    expect(review.error).toBeTruthy();
  },
);

test("post-save failure freezes progress; retry only saves, never accepts twice or confirms or navigates", async () => {
  const s = setup();
  const review = new FurnitureReviewSession(s.item);
  s.annotation.saveDraftImmediatelyWithResults
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({});
  const before = { ...review.counts.total };
  await review.acceptParentUpdate("instance-i");
  expect(review.unsaved).toBe(true);
  expect(review.counts.total).toEqual(before);
  expect(review.snapshot.total.pending).toBe(1);
  await review.acceptParentUpdate("instance-i");
  await review.retry();
  expect(review.unsaved).toBe(false);
  expect(review.counts.total.pending).toBe(1);
  expect(review.counts.total.reviewed).toBe(0);
  expect(s.item.acceptFurnitureInstanceParentUpdate).toHaveBeenCalledTimes(1);
  expect(s.controller.checkFurnitureInstancesReference).toHaveBeenCalledTimes(1);
  expect(s.annotation.saveDraftImmediatelyWithResults).toHaveBeenCalledTimes(3);
  expect(s.item.furnitureInstanceEffectiveSelectedId).toBe("instance-i");
});

test("double clicks accept once and perform a single save/check/save sequence", async () => {
  const s = setup();
  const review = new FurnitureReviewSession(s.item);
  await Promise.all([review.acceptParentUpdate("instance-i"), review.acceptParentUpdate("instance-i")]);
  expect(s.item.acceptFurnitureInstanceParentUpdate).toHaveBeenCalledTimes(1);
  expect(s.controller.checkFurnitureInstancesReference).toHaveBeenCalledTimes(1);
  expect(s.annotation.saveDraftImmediatelyWithResults).toHaveBeenCalledTimes(2);
});
