import { TextEncoder } from "util";
import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { runInAction } from "mobx";
import { FurnitureInstanceOutliner } from "../FurnitureInstanceOutliner";
import { reviewSetup } from "./reviewTestHelpers";
import { focusFurnitureReview } from "../reviewFocus";

global.TextEncoder = TextEncoder;
jest.mock("../reviewFocus", () => ({
  ...jest.requireActual("../reviewFocus"),
  focusFurnitureReview: jest.fn().mockResolvedValue(),
}));

const setup = () => {
  const fixture = reviewSetup();
  render(<FurnitureInstanceOutliner item={fixture.item} />);
  return fixture;
};

test("checkboxes do not locate, names do not check, and batch confirms only checked rows", async () => {
  const { item, annotation } = setup();
  const bed = screen.getByRole("checkbox", { name: "勾选已检查：床 · a" });
  expect(bed).not.toBeChecked();
  fireEvent.click(bed);
  expect(item.selectFurnitureInstance).not.toHaveBeenCalled();
  expect(annotation.saveDraftImmediatelyWithResults).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "床头柜 · b · 待复核" }));
  expect(item.selectFurnitureInstance).toHaveBeenCalledWith("b");
  expect(screen.getByRole("checkbox", { name: "勾选已检查：床头柜 · b" })).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "确认勾选的 1 个实例" }));
  await waitFor(() => expect(item.confirmFurnitureInstanceReviews).toHaveBeenCalledWith(["a"]));
  await waitFor(() => expect(screen.getByLabelText("全任务复核进度")).toHaveTextContent("已复核 1 / 待复核 2"));
  expect(screen.getByRole("button", { name: "确认勾选的 0 个实例" })).toBeDisabled();
});

test("group heading directly sets Focus and clears checks; filters never save", async () => {
  const { item, annotation, session } = setup();
  fireEvent.click(screen.getByRole("checkbox", { name: "勾选已检查：床 · a" }));
  fireEvent.click(screen.getByRole("button", { name: /g2.*房间/ }));
  expect(item.setFurnitureInstanceFocus).toHaveBeenCalledWith("g2");
  expect(session.checkedIds).toEqual([]);
  expect(screen.getByRole("checkbox", { name: "勾选已检查：书桌 · c" })).toBeEnabled();
  fireEvent.change(screen.getByLabelText("家具复核状态筛选"), { target: { value: "reviewed" } });
  expect(screen.getByText("本组没有符合筛选的实例")).toBeVisible();
  expect(annotation.saveDraftImmediatelyWithResults).not.toHaveBeenCalled();
});

test("Shift+Enter is scoped, ignores repeats, inputs, modals and existing submit chords", async () => {
  const { item, session, state } = setup();
  fireEvent.click(screen.getByRole("button", { name: "开始复核" }));
  await waitFor(() => expect(session.active).toBe(true));
  const bar = screen.getByRole("region", { name: "家具快速复核" });
  fireEvent.pointerDown(bar);
  for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true, repeat: true }]) {
    fireEvent.keyDown(bar, { key: "Enter", ...modifiers });
  }
  fireEvent.keyDown(screen.getByLabelText("家具复核状态筛选"), { key: "Enter", shiftKey: true });
  const modal = document.createElement("div");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  document.body.append(modal);
  fireEvent.keyDown(bar, { key: "Enter", shiftKey: true });
  modal.remove();
  const appModal = document.createElement("button");
  appModal.setAttribute("aria-label", "Close modal");
  document.body.append(appModal);
  fireEvent.keyDown(bar, { key: "Enter", shiftKey: true });
  appModal.remove();
  act(() =>
    runInAction(() => {
      state.drawing = true;
    }),
  );
  fireEvent.keyDown(bar, { key: "Enter", shiftKey: true });
  act(() =>
    runInAction(() => {
      state.drawing = false;
    }),
  );
  expect(item.confirmFurnitureInstanceReviews).not.toHaveBeenCalled();
  fireEvent.keyDown(bar, { key: "Enter", shiftKey: true });
  await waitFor(() => expect(item.confirmFurnitureInstanceReviews).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(state.selected).toBe("b"));
  expect(focusFurnitureReview).toHaveBeenCalled();
});

test("save failure visibly freezes progress and retry does not confirm twice", async () => {
  const { annotation, item, session } = setup();
  annotation.saveDraftImmediatelyWithResults
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({});
  fireEvent.click(screen.getByRole("button", { name: "全选本组可复核项" }));
  fireEvent.click(screen.getByRole("button", { name: "确认勾选的 2 个实例" }));
  await waitFor(() => expect(session.unsaved).toBe(true));
  expect(screen.getByText("本次 2 个确认尚未保存")).toBeVisible();
  expect(screen.getByLabelText("全任务复核进度")).toHaveTextContent("已复核 0 / 待复核 3");
  expect(screen.getByRole("button", { name: "开始复核" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "仅重试保存" }));
  await waitFor(() => expect(session.unsaved).toBe(false));
  expect(screen.getByLabelText("全任务复核进度")).toHaveTextContent("已复核 2 / 待复核 1");
  expect(item.confirmFurnitureInstanceReviews).toHaveBeenCalledTimes(1);
});

test("checked valid reviews become disabled in the reviewed filter and unknown remains reviewable", async () => {
  const { session } = setup();
  await act(async () => {
    await session.confirm(["a"]);
  });
  fireEvent.change(screen.getByLabelText("家具复核状态筛选"), { target: { value: "reviewed" } });
  expect(screen.getByRole("checkbox", { name: "勾选已检查：床 · a" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "床 · a · 已复核" })).toBeEnabled();
});

test("continuous shortcut accepts an instance name focus, but not an unrelated button or readonly annotation", async () => {
  const { session, item, state } = setup();
  await act(async () => {
    await session.start();
  });
  const name = screen.getByRole("button", { name: "床 · a · 待复核" });
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  fireEvent.focusIn(elsewhere);
  fireEvent.keyDown(elsewhere, { key: "Enter", shiftKey: true });
  fireEvent.focusIn(name);
  act(() =>
    runInAction(() => {
      state.readonly = true;
    }),
  );
  fireEvent.keyDown(name, { key: "Enter", shiftKey: true });
  expect(item.confirmFurnitureInstanceReviews).not.toHaveBeenCalled();
  act(() =>
    runInAction(() => {
      state.readonly = false;
    }),
  );
  fireEvent.keyDown(name, { key: "Enter", shiftKey: true });
  await waitFor(() => expect(item.confirmFurnitureInstanceReviews).toHaveBeenCalledTimes(1));
  elsewhere.remove();
});
