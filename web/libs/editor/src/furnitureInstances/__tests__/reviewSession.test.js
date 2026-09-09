import { runInAction } from "mobx";
import { TextEncoder } from "util";
import { focusFurnitureReview } from "../reviewFocus";
import { makeInstance } from "./helpers";

jest.mock("../reviewFocus", () => ({
  ...jest.requireActual("../reviewFocus"),
  focusFurnitureReview: jest.fn().mockResolvedValue(),
}));
global.TextEncoder = TextEncoder;
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

import { reviewSetup } from "./reviewTestHelpers";

test("bulk review saves and checks once, changes only checked instances and counts multipart once", async () => {
  const { session, item, state, calls } = reviewSetup();
  const original = state.results.filter((r) => r.meta?.furniture_instance_context?.instance_id === "c");
  expect(session.snapshot.rows.map((row) => row.errors)).toEqual([[], [], []]);
  expect(session.snapshot.total).toEqual({ total: 3, reviewed: 0, pending: 3, blocked: 0 });
  session.selectAll();
  expect(session.checkedIds).toEqual(["a", "b"]);
  expect(item.selectFurnitureInstance).not.toHaveBeenCalled();
  await session.confirm(session.checkedIds, { batch: true });
  expect(calls).toEqual(["save", "reference", "confirm", "save"]);
  expect(item.confirmFurnitureInstanceReviews).toHaveBeenCalledWith(["a", "b"]);
  expect(state.results.filter((r) => r.meta?.furniture_instance_context?.instance_id === "c")).toEqual(original);
  expect(session.snapshot.total).toEqual({ total: 3, reviewed: 2, pending: 1, blocked: 0 });
  expect(session.checkedIds).toEqual([]);
  expect(state.focus).toBe("g1");
});

test("continuous review crosses groups, wraps and skips current valid reviews", async () => {
  const { session, state, item } = reviewSetup();
  await session.start();
  expect(state.selected).toBe("a");
  await session.confirm(["a"], { advance: true });
  expect(state.selected).toBe("b");
  await session.confirm(["b"], { advance: true });
  expect(state.focus).toBe("g2");
  expect(state.selected).toBe("c");
  await session.confirm(["c"], { advance: true });
  expect(session.active).toBe(false);
  expect(session.notice).toContain("全部已复核");
  expect(item.confirmFurnitureInstanceReviews).toHaveBeenCalledTimes(3);
});

test("post-save failure freezes counts and retry persists once then advances once", async () => {
  const { session, annotation, item, state } = reviewSetup();
  await session.start();
  annotation.saveDraftImmediatelyWithResults
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({});
  await session.confirm(["a"], { advance: true });
  expect(session.unsaved).toBe(true);
  expect(session.counts.total.reviewed).toBe(0);
  expect(session.snapshot.total.reviewed).toBe(1);
  expect(state.selected).toBe("a");
  await session.confirm(["b"], { advance: true });
  expect(item.confirmFurnitureInstanceReviews).toHaveBeenCalledTimes(1);
  await session.retry();
  await session.retry();
  expect(state.selected).toBe("b");
  expect(session.counts.total.reviewed).toBe(1);
  expect(annotation.saveDraftImmediatelyWithResults).toHaveBeenCalledTimes(3);
  expect(item.confirmFurnitureInstanceReviews).toHaveBeenCalledTimes(1);
});

test("reference changes during failed-save recovery pause auto-advance without discarding local confirmation", async () => {
  const { session, annotation, state } = reviewSetup();
  await session.start();
  annotation.saveDraftImmediatelyWithResults
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({});
  await session.confirm(["a"], { advance: true });
  runInAction(() => {
    session.referenceStatus = { ...session.referenceStatus, source_version: "v2" };
  });
  await session.retry();
  expect(state.selected).toBe("a");
  expect(session.active).toBe(false);
  expect(session.notice).toContain("连续复核已暂停");
});

test.each(["pre-save", "reference", "model"])("%s failure never marks a batch complete", async (stage) => {
  const { session, annotation, item, controller, state } = reviewSetup();
  const original = state.results;
  const failure = new Error("test failure");
  if (stage === "pre-save") annotation.saveDraftImmediatelyWithResults.mockRejectedValue(failure);
  if (stage === "reference") controller.checkFurnitureInstancesReference.mockRejectedValue(failure);
  if (stage === "model")
    item.confirmFurnitureInstanceReviews.mockImplementation(() => {
      throw failure;
    });
  session.selectAll();
  await session.confirm(session.checkedIds, { batch: true });
  expect(state.results).toBe(original);
  expect(session.unsaved).toBe(false);
  expect(session.pending).toBe(null);
  expect(session.counts.total.reviewed).toBe(0);
});

test.each(["edit", "delete", "annotation"])("%s during awaited pre-save aborts the fixed batch", async (change) => {
  const { session, annotation, item, state } = reviewSetup();
  const gate = deferred();
  annotation.saveDraftImmediatelyWithResults.mockImplementationOnce(() => gate.promise);
  session.selectAll();
  const pending = session.confirm(session.checkedIds, { batch: true });
  runInAction(() => {
    if (change === "annotation") state.switched = true;
    else
      state.results = state.results.flatMap((r) => {
        if (r.meta?.furniture_instance_context?.instance_id !== "b") return [r];
        return change === "delete"
          ? []
          : [
              {
                ...r,
                meta: {
                  ...r.meta,
                  furniture_instance_context: { ...r.meta.furniture_instance_context, note: "changed" },
                },
              },
            ];
      });
  });
  gate.resolve();
  await pending;
  expect(item.confirmFurnitureInstanceReviews).not.toHaveBeenCalled();
  expect(session.unsaved).toBe(false);
});

test("double click while saving cannot start a second confirmation", async () => {
  const { session, annotation, item } = reviewSetup();
  const gate = deferred();
  annotation.saveDraftImmediatelyWithResults.mockImplementationOnce(() => gate.promise);
  const first = session.confirm(["a"]);
  await session.confirm(["a"]);
  gate.resolve();
  await first;
  expect(item.confirmFurnitureInstanceReviews).toHaveBeenCalledTimes(1);
});

test("changed checked content, scope and filter clear the affected selection without writing results", () => {
  const { session, state, annotation } = reviewSetup();
  const disconnect = session.connect();
  session.selectAll();
  runInAction(() => {
    state.results = state.results.map((r) =>
      r.meta?.furniture_instance_context?.instance_id === "a"
        ? {
            ...r,
            meta: { ...r.meta, furniture_instance_context: { ...r.meta.furniture_instance_context, note: "changed" } },
          }
        : r,
    );
  });
  expect(session.checkedIds).toEqual(["b"]);
  session.setFilter("all");
  expect(session.checkedIds).toEqual([]);
  session.selectAll();
  runInAction(() => {
    state.focus = "g2";
  });
  expect(session.checkedIds).toEqual([]);
  expect(annotation.saveDraftImmediatelyWithResults).not.toHaveBeenCalled();
  disconnect();
});

test("new and newly invalidated instances re-enter a continuous queue", async () => {
  const { session, state, refs } = reviewSetup();
  await session.start();
  await session.confirm(["a"], { advance: true });
  runInAction(() => {
    state.results = [
      ...state.results.map((r) =>
        r.meta?.furniture_instance_context?.instance_id === "a"
          ? {
              ...r,
              meta: { ...r.meta, furniture_instance_context: { ...r.meta.furniture_instance_context, note: "edited" } },
            }
          : r,
      ),
      ...makeInstance(refs, { groupId: "g1", instanceId: "d" }),
    ];
  });
  await session.confirm(["b"], { advance: true });
  await session.confirm(["c"], { advance: true });
  expect(state.selected).toBe("d");
  await session.confirm(["d"], { advance: true });
  expect(state.selected).toBe("a");
});

test("blocked and orphan results never count as complete, unknown direction is eligible", async () => {
  const { session, state } = reviewSetup();
  expect(session.snapshot.rows.find((r) => r.id === "a").status).toBe("pending");
  runInAction(() => {
    state.results = state.results.filter(
      (r) => r.meta?.furniture_instance_context?.instance_id !== "c" || r.type === "choices",
    );
  });
  expect(session.snapshot.globalIssues.length).toBeGreaterThan(0);
  expect(session.blockReason).toContain("无法归属");
  await session.start();
  expect(session.notice).not.toContain("全部已复核");
});

test("view navigation preserves annotations and delegates all-part focus", async () => {
  const { session, state, annotation } = reviewSetup();
  const original = state.results;
  await session.focusGroup("g2");
  await session.locate("c");
  expect(focusFurnitureReview).toHaveBeenCalled();
  expect(state.results).toBe(original);
  expect(annotation.saveDraftImmediatelyWithResults).not.toHaveBeenCalled();
});

test("editing retained local results before retry pauses navigation and keeps the invalidated review pending", async () => {
  const { session, annotation, state, item } = reviewSetup();
  await session.start();
  annotation.saveDraftImmediatelyWithResults
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({});
  await session.confirm(["a"], { advance: true });
  runInAction(() => {
    state.results = state.results.map((r) =>
      r.meta?.furniture_instance_context?.instance_id === "a"
        ? {
            ...r,
            meta: {
              ...r.meta,
              furniture_instance_context: { ...r.meta.furniture_instance_context, note: "edited after failure" },
            },
          }
        : r,
    );
  });
  await session.retry();
  expect(item.confirmFurnitureInstanceReviews).toHaveBeenCalledTimes(1);
  expect(state.selected).toBe("a");
  expect(session.active).toBe(false);
  expect(session.counts.total.pending).toBe(3);
});

test("empty and blocked-only tasks stop without a false completion; reference conflicts leave counts unchanged", async () => {
  const { session, state } = reviewSetup();
  runInAction(() => {
    session.referenceStatus = { ...session.referenceStatus, source_version: "v2" };
  });
  expect(session.counts.total).toEqual({ total: 3, reviewed: 0, pending: 3, blocked: 0 });
  expect(session.blockReason).toContain("参考");
  runInAction(() => {
    session.referenceStatus = { ...session.referenceStatus, source_version: "v1" };
    state.results = state.results.map((r) =>
      r.meta?.furniture_instance_context
        ? {
            ...r,
            meta: {
              ...r.meta,
              furniture_instance_context: { ...r.meta.furniture_instance_context, review_status: "stale" },
            },
          }
        : r,
    );
  });
  await session.start();
  expect(session.notice).toBe("剩余 3 个实例需处理");
  runInAction(() => {
    state.results = state.results.filter((r) => !r.meta?.furniture_instance_context);
  });
  await session.start();
  expect(session.notice).toBe("尚无家具实例可复核");
});

test("starting from a reviewed-only filter reveals the pending queue without changing results", async () => {
  const { session, annotation } = reviewSetup();
  session.setFilter("reviewed");
  await session.start();
  expect(session.filter).toBe("pending");
  expect(annotation.saveDraftImmediatelyWithResults).not.toHaveBeenCalled();
});
