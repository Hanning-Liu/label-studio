import { render, screen } from "@testing-library/react";
import { ReferenceLineageStatus } from "./ReferenceLineageStatus";

const show = (lineage) =>
  render(<ReferenceLineageStatus item={{ annotation: { store: {
    referenceSyncController: { state: { status: { lineage } }, subscribe: () => () => {} },
  } } }} />);

test("windowless authority is explicitly shown without changing annotation data", () => {
  show({ ready: true, window_count: 0, root: { task_id: 19 }, issues: [] });
  expect(screen.getByRole("status")).toHaveTextContent("L1 无窗，窗参考一致");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("broken ancestor points to its explicit task in a new window", () => {
  show({ ready: false, window_count: 12, root: { task_id: 19 }, issues: [
    { code: "window_missing", level: 2, project_id: 10, task_id: 20, message: "L2 缺少 L1 窗参考", window_ids: ["window-12"] },
  ] });
  expect(screen.getByRole("alert")).toHaveTextContent("窗参考缺失");
  expect(screen.getByText(/窗 ID：window-12/)).toBeVisible();
  expect(screen.getByRole("link")).toHaveAttribute("href", "/projects/10/data?task=20");
  expect(screen.getByRole("link")).toHaveAttribute("target", "_blank");
});

test("unknown source is never presented as windowless", () => {
  show({ ready: false, root: null, window_count: null, issues: [] });
  expect(screen.getByRole("alert")).toHaveTextContent("来源尚未确认");
  expect(screen.queryByText(/L1 无窗/)).toBeNull();
});
