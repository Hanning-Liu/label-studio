import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReferenceSyncControls } from "@hanning/frontend/components/references/ReferenceSyncControls";

jest.mock("antd", () => ({ Modal: ({ visible, children }) => visible ? <div role="dialog">{children}</div> : null }));

function setup(patch = {}, editable = true) {
  const controller = {
    state: { status: { enabled: true, mode: "target", status: "synced", worker_alive: true, drafts: [] }, ...patch },
    subscribe: () => () => {}, apply: jest.fn().mockResolvedValue(),
  };
  const annotation = { pk: "11", draftSelected: false, editable, results: [], store: { referenceSyncController: controller } };
  render(<ReferenceSyncControls item={{ annotation }} compact />);
  return controller;
}

test("historical toolbar explains disabled Update and offers explicit draft entry", async () => {
  const controller = setup();
  expect(screen.getByText(/进入复核草稿后可再次 Update/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "进入复核草稿" }));
  await waitFor(() => expect(controller.apply).toHaveBeenCalledWith(true, true));
});

test("entry failure does not label a successful sync as failed and details are accessible", () => {
  setup({ actionError: "409 草稿版本冲突" });
  expect(screen.getByText("Room → L2 · 已同步")).toBeVisible();
  expect(screen.queryByRole("button", { name: "重试同步" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "同步详情" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("409 草稿版本冲突");
  expect(screen.getByRole("button", { name: "导出当前窗口备份" })).toBeVisible();
});

test("readonly historical annotation cannot create a draft", () => {
  setup({}, false);
  expect(screen.getByRole("button", { name: "进入复核草稿" })).toBeDisabled();
});

test("orphan row offers explicit parent selection, reports errors and saves without confirming review", async () => {
  const rebindZoneParent = jest.fn().mockRejectedValueOnce(new Error("分区重叠")).mockResolvedValueOnce();
  const controller = {
    state: { status: { enabled: true, mode: "target", status: "synced", worker_alive: true, reference_version: "v" } },
    subscribe: () => () => {}, rebindZoneParent, review: jest.fn(),
  };
  const item = {
    l2ToolbarEnabled: true,
    roomReferenceRegions: [{ cleanId: "open", labelName: "Open-plan space" }],
    annotation: { draftId: 5, draftSelected: true, referenceVersion: "v", isReadOnly: () => false,
      store: { referenceSyncController: controller },
      results: [{ id: "orphan", from_name: "zone_rectangle",
        meta: { reference_review: { status: "pending", reason: "source_missing" } } }],
    },
  };
  render(<ReferenceSyncControls item={item} compact />);
  fireEvent.click(screen.getByRole("button", { name: "参考变更待复核（1）" }));
  fireEvent.click(screen.getByRole("button", { name: "重新绑定", exact: true }));
  const save = screen.getByRole("button", { name: "重新绑定并保存草稿" });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText("新父房间"), { target: { value: "open" } });
  fireEvent.click(save);
  expect(await screen.findByRole("alert")).toHaveTextContent("分区重叠");
  fireEvent.click(save);
  await waitFor(() => expect(save).not.toBeInTheDocument());
  expect(rebindZoneParent).toHaveBeenLastCalledWith(item, "orphan", "open");
  expect(controller.review).not.toHaveBeenCalled();
});
