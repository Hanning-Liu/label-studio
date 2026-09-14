import { TextEncoder } from "util";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { extendObservable, runInAction } from "mobx";
import { reviewSetup } from "@hanning/tests/frontend/furnitureInstances/reviewTestHelpers";
import { buildFurnitureScope } from "@hanning/frontend/domain/furnitureInstances/scope";
import { FurnitureInstanceOutliner } from "@hanning/frontend/components/furnitureInstances/FurnitureInstanceOutliner";
global.TextEncoder = TextEncoder;
jest.mock("@hanning/frontend/domain/furnitureInstances/reviewFocus", () => ({
  ...jest.requireActual("@hanning/frontend/domain/furnitureInstances/reviewFocus"),
  focusFurnitureReview: jest.fn().mockResolvedValue(),
}));
const setup = () => {
  const f = reviewSetup();
  Object.defineProperty(f.item, "furnitureInstanceScope", { get: () => buildFurnitureScope(f.state.results) });
  Object.defineProperty(f.item, "furnitureInstanceRoomId", { get: () => "room-r" });
  Object.defineProperty(f.item, "furnitureInstanceZoneId", { get: () => "zone-z" });
  f.item.setFurnitureInstanceSpace = jest.fn();
  f.item.furnitureInstanceReferenceLayers = { windows: true, openings: true, connections: true, barriers: true };
  f.item.furnitureInstanceRoomBackground = false;
  f.item.furnitureInstanceOverview = false;
  extendObservable(f.item, { furnitureInstanceGeometryPreview: null });
  render(<FurnitureInstanceOutliner item={f.item} />);
  return f;
};
test("room counts are visible without drilling down; expansion/filter never saves or changes Focus", () => {
  const f = setup(),
    before = JSON.stringify(f.state.results);
  expect(screen.getByLabelText("room:room-r 进度")).toHaveTextContent("已有实例 2/2 组");
  fireEvent.click(screen.getByRole("button", { name: "展开 Study · room-r" }));
  fireEvent.change(screen.getByLabelText("空间状态筛选"), { target: { value: "reviewed" } });
  expect(screen.getAllByText("当前路径 · 不符合当前筛选").length).toBeGreaterThan(0);
  expect(f.item.setFurnitureInstanceSpace).not.toHaveBeenCalled();
  expect(f.annotation.saveDraftImmediatelyWithResults).not.toHaveBeenCalled();
  expect(JSON.stringify(f.state.results)).toBe(before);
});
test("shared frozen room totals survive failed confirmation; retry saves only once", async () => {
  const f = setup();
  f.annotation.saveDraftImmediatelyWithResults
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({});
  await act(async () => f.session.confirm(["a", "b"]));
  expect(f.session.unsaved).toBe(true);
  expect(screen.getByLabelText("room:room-r 进度")).toHaveTextContent("已复核 0 / 待复核 3");
  expect(screen.getByRole("button", { name: "下一个待办" })).toBeDisabled();
  await act(async () => f.session.retry());
  expect(screen.getByLabelText("room:room-r 进度")).toHaveTextContent("已复核 2 / 待复核 1");
  expect(f.item.confirmFurnitureInstanceReviews).toHaveBeenCalledTimes(1);
});
test("todo browsing progresses without confirmations and pauses the continuous review session", async () => {
  const f = setup();
  act(() =>
    runInAction(() => {
      f.session.active = true;
    }),
  );
  await act(async () => f.session.nextSpatialTodo("room:room-r"));
  expect(f.state.selected).toBe("a");
  expect(f.session.active).toBe(false);
  await act(async () => f.session.nextSpatialTodo("room:room-r"));
  expect(f.state.selected).toBe("b");
  await act(async () => f.session.nextSpatialTodo("room:room-r"));
  expect(f.state.selected).toBe("c");
  await act(async () => f.session.nextSpatialTodo("room:room-r"));
  expect(f.session.spatialNotice).toContain("本轮已浏览");
  expect(f.item.confirmFurnitureInstanceReviews).not.toHaveBeenCalled();
  expect(f.annotation.saveDraftImmediatelyWithResults).not.toHaveBeenCalled();
});
test("preview blocks new navigation without dropping the preview", async () => {
  const f = setup();
  act(() =>
    runInAction(() => {
      f.item.furnitureInstanceGeometryPreview = { angle: 30 };
    }),
  );
  await act(async () => f.session.nextSpatialTodo());
  expect(f.session.spatialNotice).toContain("预览");
  expect(f.item.selectFurnitureInstance).not.toHaveBeenCalled();
  expect(f.item.furnitureInstanceGeometryPreview.angle).toBe(30);
});
test("deleting the last instance exposes the empty group and navigation never creates", async () => {
  const f = setup();
  act(() =>
    runInAction(() => {
      f.state.results = f.state.results.filter((r) => r.meta?.furniture_instance_context?.instance_id !== "c");
    }),
  );
  expect(screen.getByLabelText("room:room-r 进度")).toHaveTextContent("待检查空组团 1");
  await act(async () => f.session.nextSpatialTodo("group:g2"));
  expect(f.item.setFurnitureInstanceFocus).toHaveBeenCalledWith("g2");
  expect(screen.getByText(/待检查空组团：可选择本组绘制/)).toBeVisible();
  expect(f.annotation.saveDraftImmediatelyWithResults).not.toHaveBeenCalled();
});
test("non-review mutations freeze spatial counts on failed save and recover without replay", async () => {
  const f = setup();
  await act(async () =>
    f.session.run(async () => {
      runInAction(() => {
        f.state.results = f.state.results.filter((r) => r.meta?.furniture_instance_context?.instance_id !== "c");
      });
      throw Object.assign(new Error("offline"), { localMutationApplied: true });
    }),
  );
  expect(f.session.spatialCounts.root.counts.total).toBe(3);
  expect(f.session.spatialSnapshot.root.counts.total).toBe(2);
  await act(async () => f.session.retry());
  expect(f.session.spatialCounts.root.counts.total).toBe(2);
  expect(f.session.spatialCounts.root.empty).toBe(1);
});
test("reference-only changes block confirmation but allow read-only progress browsing", () => {
  const f = setup(),
    before = JSON.stringify(f.state.results);
  act(() =>
    runInAction(() => {
      f.session.referenceStatus = { lineage: { ready: false, version: "new", issues: [{ message: "L1 已变化" }] } };
    }),
  );
  expect(screen.getByRole("button", { name: "开始复核" })).toBeDisabled();
  expect(screen.getByText(/进度基于当前已加载参考/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("空间状态筛选"), { target: { value: "pending" } });
  expect(JSON.stringify(f.state.results)).toBe(before);
});
