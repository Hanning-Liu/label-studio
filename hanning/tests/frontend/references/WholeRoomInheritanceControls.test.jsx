import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WholeRoomInheritanceControls } from "@hanning/frontend/components/references/WholeRoomInheritanceControls";
jest.mock("antd", () => ({
  Modal: ({ visible, title, children }) =>
    visible ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));

function setup(compact = false, zones = [], controller, focusedRoom) {
  URL.createObjectURL = jest.fn(() => "blob:recovery");
  URL.revokeObjectURL = jest.fn();
  jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const annotation = {
    editable: true,
    isReadOnly: () => false,
    serializeAnnotation: () => [],
    draftResultFingerprint: "[]",
    savedResultFingerprint: "[]",
    draftSaved: new Date().toISOString(),
    saveDraftImmediatelyWithResults: jest.fn().mockResolvedValue({ id: 1 }),
    store: { task: { id: 20, data: '{"image":"plan.png"}' }, config: "<View/>", referenceSyncController: controller },
  };
  const item = {
    annotation,
    wholeRoomInheritanceEnabled: true,
    wholeRoomZones: zones,
    wholeRoomLabels: ["Sleeping"],
    focusedRoom,
    wholeRoomSubdivisionReason: (id) => id ? null : "请选择房间",
    startWholeRoomSubdivision: jest.fn(),
    assertWholeRoomEditable: jest.fn(),
    wholeRoomCandidates: [
      { id: "room-a", roomType: "Bedroom", suggestedLabel: "Sleeping", eligible: true, sourceFingerprint: "v1" },
    ],
    generateWholeRoomZones: jest.fn(() => ["zone-a"]),
    confirmWholeRoomZones: jest.fn(),
  };
  render(<WholeRoomInheritanceControls item={item} compact={compact} />);
  return { item, annotation };
}
afterEach(() => jest.restoreAllMocks());

test("subdivision cancellation does not save, take a snapshot, or download", () => {
  const controller = { subscribe: jest.fn(), subdivideWholeRoom: jest.fn() };
  const { item, annotation } = setup(false, [
    { id: "whole", parentRoomId: "room-a", source: { roomType: "Bedroom" }, review: { wholeRoom: true } },
  ], controller, { cleanId: "room-a" });
  fireEvent.click(screen.getByRole("button", { name: "开始细分" }));
  expect(screen.getByRole("dialog", { name: "确认开始手工细分" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(annotation.saveDraftImmediatelyWithResults).not.toHaveBeenCalled();
  expect(controller.subdivideWholeRoom).not.toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(item.startWholeRoomSubdivision).not.toHaveBeenCalled();
});

test("failed server snapshot preserves the zone without downloading", async () => {
  const controller = { subscribe: jest.fn(), subdivideWholeRoom: jest.fn().mockRejectedValue(new Error("快照写入失败")) };
  const { item } = setup(false, [
    { id: "whole", parentRoomId: "room-a", source: { roomType: "Bedroom" }, review: { wholeRoom: true } },
  ], controller, { cleanId: "room-a" });
  fireEvent.click(screen.getByRole("button", { name: "开始细分" }));
  const confirm = screen.getByRole("button", { name: "确认移除该自动分区并开始细分" });
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.getAllByText(/快照写入失败/).length).toBeGreaterThan(0));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(item.startWholeRoomSubdivision).not.toHaveBeenCalled();
});

test("history previews conflicts without offering to overwrite existing zones", async () => {
  const snapshot = { id: 1, room_type: "Bedroom", label: "Sleeping", created_at: "2026-11-14T00:00:00Z" };
  const controller = {
    subscribe: jest.fn(),
    loadSubdivisionHistory: jest.fn().mockResolvedValue({ snapshots: [snapshot] }),
    previewSubdivision: jest.fn().mockResolvedValue({
      ...snapshot, blocked_reason: "房间已有分区", conflicts: [{ zone_id: "new", label: "Study/work" }],
    }),
  };
  setup(true, [], controller);
  fireEvent.click(screen.getByRole("button", { name: "L2 复核（0）" }));
  fireEvent.click(screen.getByRole("button", { name: "细分历史" }));
  fireEvent.click(await screen.findByRole("button", { name: "预览恢复 Sleeping 1" }));
  expect(await screen.findByText("Study/work（new）")).toBeVisible();
  expect(screen.getByRole("button", { name: "恢复整室分区" })).toBeDisabled();
});

test("compact toolbar groups L2 reviews and keeps backup next to save", () => {
  const { item, annotation } = setup(true);
  expect(screen.queryByRole("button", { name: "为空房间生成整室分区" })).toBeNull();
  expect(screen.getByRole("button", { name: "保存草稿" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "L2 复核（0）" }));
  expect(screen.getByRole("dialog", { name: "L2 复核" })).toBeVisible();
  expect(screen.getByRole("button", { name: "分区类别（0）" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "上游变更（0）" })).toBeVisible();
  expect(screen.getByRole("button", { name: "连通线（0）" })).toBeVisible();
  expect(screen.getByRole("button", { name: "为空房间生成整室分区" })).toBeVisible();
  expect(screen.getByRole("button", { name: "导出当前窗口备份" })).toBeVisible();
  expect(item.generateWholeRoomZones).not.toHaveBeenCalled();
  expect(annotation.saveDraftImmediatelyWithResults).not.toHaveBeenCalled();
});

test("defaults to pending and lists all open-plan children separately without changing review state", () => {
  const openPlan = { parentRoomId: "open-plan", source: { roomType: "Open-plan space" } };
  const { item, annotation } = setup(true, [
    { ...openPlan, id: "living", label: "Living/social", review: null },
    { ...openPlan, id: "dining", label: "Dining", review: null },
    { ...openPlan, id: "hall", label: "Circulation", review: { reviewed: true, wholeRoom: false } },
    { ...openPlan, id: "entry", label: "Entry/transition", review: { reviewed: true, wholeRoom: false } },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "L2 复核（0）" }));
  expect(screen.getByText("没有待复核的分区。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "全部分区（4）" }));
  expect(screen.getAllByText("Open-plan space")).toHaveLength(4);
  expect(screen.getByText("分区 ID：living")).toBeVisible();
  expect(screen.getByText("分区 ID：dining")).toBeVisible();
  expect(screen.getAllByText("手工绘制 · 不适用继承复核")).toHaveLength(2);
  expect(screen.getAllByRole("button", { name: "确认", exact: true })).toHaveLength(2);
  expect(screen.getByRole("button", { name: "确认本组分区类别（0）" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  fireEvent.click(screen.getByRole("button", { name: "L2 复核（0）" }));
  expect(screen.getByText("没有待复核的分区。")).toBeVisible();
  expect(item.confirmWholeRoomZones).not.toHaveBeenCalled();
  expect(annotation.saveDraftImmediatelyWithResults).not.toHaveBeenCalled();
});

test("canceling the preview neither saves nor changes results", () => {
  const { item, annotation } = setup();
  fireEvent.click(screen.getByText("为空房间生成整室分区", { selector: "button" }));
  fireEvent.click(screen.getByText("取消"));
  expect(annotation.saveDraftImmediatelyWithResults).not.toHaveBeenCalled();
  expect(item.generateWholeRoomZones).not.toHaveBeenCalled();
});
test("a failed preflight save or version conflict cannot mutate results", async () => {
  const { item, annotation } = setup();
  annotation.saveDraftImmediatelyWithResults.mockRejectedValue(new Error("草稿版本冲突"));
  fireEvent.click(screen.getByText("为空房间生成整室分区", { selector: "button" }));
  fireEvent.click(screen.getByText("保存备份并生成（1）"));
  await waitFor(() => expect(screen.getAllByText(/草稿版本冲突/).length).toBeGreaterThan(0));
  expect(item.generateWholeRoomZones).not.toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
test("generation saves before and after, exports recovery first, and never confirms automatically", async () => {
  const { item, annotation } = setup();
  fireEvent.click(screen.getByText("为空房间生成整室分区", { selector: "button" }));
  fireEvent.click(screen.getByText("保存备份并生成（1）"));
  await waitFor(() => expect(annotation.saveDraftImmediatelyWithResults).toHaveBeenCalledTimes(2));
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(item.generateWholeRoomZones.mock.invocationCallOrder[0]).toBeGreaterThan(
    URL.createObjectURL.mock.invocationCallOrder[0],
  );
  expect(item.confirmWholeRoomZones).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});
