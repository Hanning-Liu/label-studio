import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HierarchyProjectForm } from "../../frontend/projectCreation/HierarchyProjectForm";

const task = { id: 5, image_name: "floorplan.png", annotation_id: 4, version: "abc", ready: true, reason: "" };
const projects = [{ id: 5, title: "深大分享 L1" }];
const data = { projects, tasks: [task], count: 1, page: 1, pages: 1 };
const setup = (overrides = {}) => {
  const props = {
    loadSources: jest.fn().mockResolvedValue(data),
    createProject: jest.fn().mockResolvedValue(undefined),
    onCancel: jest.fn(),
    onStandard: jest.fn(),
    ...overrides,
  };
  render(<HierarchyProjectForm {...props} />);
  return props;
};

test("pagination fetches all image choices and resets the previous selection", async () => {
  const loadSources = jest.fn(async (params) => ({ ...data, count: 21, pages: 2,
    tasks: params.page === 2 ? [{ ...task, id: 25, ready: false, reason: "尚未提交" }] : [task] }));
  setup({ loadSources });
  await waitFor(() => expect(screen.getByLabelText("来源图片")).toHaveValue("5"));
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(loadSources).toHaveBeenLastCalledWith({ level: 2, project_id: 5, page: 2 }));
  await screen.findByText(/#25/);
  expect(screen.getByLabelText("来源图片")).toHaveValue("");
  expect(screen.getByRole("button", { name: "创建 L2 项目" })).toBeDisabled();
});

test("selects the only valid source, creates with its exact identity and prevents duplicate clicks", async () => {
  let resolve;
  const createProject = jest.fn(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  setup({ createProject });
  const button = await screen.findByRole("button", { name: "创建 L2 项目" });
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "我的 L2" } });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(createProject).toHaveBeenCalledTimes(1);
  expect(createProject).toHaveBeenCalledWith({
    level: 2,
    title: "我的 L2",
    source_task: 5,
    source_annotation: 4,
    source_version: "abc",
  });
  expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  await act(async () => resolve());
});

test("switching levels clears the old source; L1 requires no upstream", async () => {
  const props = setup();
  await waitFor(() => expect(screen.getByLabelText("来源图片")).toHaveValue("5"));
  props.loadSources.mockResolvedValue({ ...data, projects: [], tasks: [], count: 0 });
  fireEvent.click(screen.getByRole("radio", { name: /L3/ }));
  await screen.findByText(/尚无 L2 项目/);
  expect(screen.getByRole("button", { name: "创建 L3 项目" })).toBeDisabled();
  fireEvent.click(screen.getByRole("radio", { name: /L1/ }));
  fireEvent.click(screen.getByRole("button", { name: "创建 L1 项目" }));
  await waitFor(() => expect(props.createProject).toHaveBeenCalledWith({ level: 1, title: "L1 房间、门与窗" }));
});

test("unusable annotations explain the blocker and cannot be submitted", async () => {
  setup({
    loadSources: jest
      .fn()
      .mockResolvedValue({ ...data, tasks: [{ ...task, ready: false, reason: "缺少唯一有效正式标注" }] }),
  });
  await waitFor(() => expect(screen.getByLabelText("来源图片")).not.toBeDisabled());
  fireEvent.change(screen.getByLabelText("来源图片"), { target: { value: "5" } });
  expect(screen.getByText("缺少唯一有效正式标注")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "创建 L2 项目" })).toBeDisabled();
});

test("errors are visible with a source refresh action", async () => {
  setup({ createProject: jest.fn().mockRejectedValue(new Error("上游标注已变化")) });
  await waitFor(() => expect(screen.getByRole("button", { name: "创建 L2 项目" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "创建 L2 项目" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("上游标注已变化");
  expect(screen.getByRole("button", { name: "刷新来源" })).toBeInTheDocument();
});

test("cancel and standard project actions never create a hierarchy project", async () => {
  const props = setup();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  fireEvent.click(screen.getByRole("button", { name: "普通项目 / 自定义模板" }));
  expect(props.onCancel).toHaveBeenCalled();
  expect(props.onStandard).toHaveBeenCalled();
  expect(props.createProject).not.toHaveBeenCalled();
  await act(async () => {});
});

test("late responses cannot replace the currently selected level", async () => {
  let resolve;
  setup({
    loadSources: jest.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    ),
  });
  fireEvent.click(screen.getByRole("radio", { name: /L1/ }));
  await act(async () => resolve(data));
  expect(screen.queryByLabelText("来源图片")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "创建 L1 项目" })).not.toBeDisabled();
});
