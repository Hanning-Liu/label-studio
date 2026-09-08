import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Modal from "antd/lib/modal";

import { FurnitureInstanceControls } from "../FurnitureInstanceControls";
import { effectiveFurnitureInstanceReviewStatus } from "../FurnitureInstanceOutliner";
import { FURNITURE_TYPES } from "../domain";

jest.mock("antd/lib/modal", () => ({ __esModule: true, default: { confirm: jest.fn() } }));

const invalidEdge = () => ({
  id: "orientation-i",
  from_name: "furniture_front_edge",
  value: {
    closed: false,
    vertices: [{ x: 20, y: 20 }],
    vectorlabels: ["front_edge"],
  },
});

const setup = ({
  deleteRequestId = "",
  errors = [],
  orientationResults = [],
  otherInstances = [],
  reviewStatus = "reviewed",
  saveDraft = jest.fn().mockResolvedValue({}),
} = {}) => {
  const status = {
    enabled: true,
    sync_type: "occupancy_to_furniture_instances",
    source_version: "l3-v1",
    reference_version: "l3-v1",
  };
  const controller = {
    state: { status },
    subscribe: jest.fn(() => () => {}),
    checkFurnitureInstancesReference: jest.fn().mockResolvedValue(status),
  };
  const annotation = {
    store: { referenceSyncController: controller, task: { id: 20 } },
    referenceVersion: "l3-v1",
    type: "annotation",
    pk: null,
    draftSelected: true,
    isDrawing: false,
    hasIncompletePolygons: false,
    submissionStarted: 0,
    isReadOnly: jest.fn(() => false),
    serializeAnnotation: jest.fn(() => []),
    saveDraftImmediatelyWithResults: saveDraft,
  };
  const instance = {
    id: "instance-i",
    context: {
      instance_type: "desk",
      room_id: "room-r",
      zone_id: "zone-z",
      group_id: "group-g",
      review_status: reviewStatus,
      review_fingerprint: reviewStatus === "reviewed" ? "a".repeat(64) : null,
    },
    geometry: [],
    results: [{ id: "geometry-i" }],
    orientationResults,
  };
  const item = {
    annotation,
    furnitureInstancesEnabled: true,
    furnitureInstanceOrientationEnabled: true,
    furnitureInstanceBusy: false,
    furnitureInstanceType: "desk",
    furnitureInstanceDraftType: "desk",
    furnitureInstanceAvailableTypes: Object.keys(FURNITURE_TYPES),
    furnitureInstanceNote: "",
    furnitureInstanceDrawingControl: "",
    furnitureInstanceDeleteRequestId: deleteRequestId,
    furnitureInstanceParents: [
      { id: "group-g", groupType: "study_work", groupNote: "窗边", roomId: "room-r", zoneId: "zone-z" },
    ],
    furnitureInstanceData: [
      { id: "room-r", meta: { room_graph_node: { room_type: "书房" } } },
      { id: "zone-z", from_name: "function_zone", value: { labels: ["学习办公"] } },
    ],
    furnitureInstanceLogicals: [instance, ...otherInstances],
    furnitureInstanceFocusId: "group-g",
    furnitureInstanceEffectiveSelectedId: instance.id,
    furnitureInstanceErrors: errors,
    furnitureInstanceBoundarySnap: true,
    furnitureInstancePixelSnap: true,
    furnitureInstanceShowAllNames: false,
    setFurnitureInstanceShowAllNames: jest.fn(),
    furnitureInstanceEditNotice: "",
    selectedToolControl: "",
    getToolsManager: () => ({
      findSelectedTool: () =>
        item.selectedToolControl ? { control: { name: item.selectedToolControl } } : { fullName: "MoveTool" },
    }),
    furnitureInstanceDrawBlockReason: jest.fn(() => ""),
    setFurnitureInstanceBusy: jest.fn((value) => {
      item.furnitureInstanceBusy = value;
    }),
    setFurnitureInstanceDraft: jest.fn((value) => {
      item.furnitureInstanceDraftType = value;
    }),
    setFurnitureInstanceCategory: jest.fn(),
    startFurnitureInstanceTool: jest.fn((control) => {
      item.furnitureInstanceDrawingControl = control;
      item.selectedToolControl = control;
    }),
    clearFurnitureInstanceOrientation: jest.fn((id) => {
      const target = item.furnitureInstanceLogicals.find((candidate) => candidate.id === id);
      const changed = Boolean(target.orientationResults.length);
      target.orientationResults = [];
      item.furnitureInstanceErrors = item.furnitureInstanceErrors.filter(
        (issue) => issue.instanceId !== id || issue.code !== "orientation",
      );
      item.furnitureInstanceDrawingControl = "";
      if (changed && target.context.review_status === "reviewed") {
        target.context = { ...target.context, review_status: "pending", review_fingerprint: null };
      }
      return changed;
    }),
    confirmFurnitureInstanceReviews: jest.fn(),
    deleteFurnitureInstance: jest.fn(() => {
      item.furnitureInstanceDeleteRequestId = "";
    }),
    clearFurnitureInstanceDeleteRequest: jest.fn(() => {
      item.furnitureInstanceDeleteRequestId = "";
    }),
    requestFurnitureInstanceDelete: jest.fn(),
    setFurnitureInstanceFocus: jest.fn(),
    selectFurnitureInstance: jest.fn(),
    setFurnitureInstanceSnapping: jest.fn(),
  };
  const controls = () => <FurnitureInstanceControls item={{ ...item }} />;
  const view = render(controls());
  return {
    annotation,
    controller,
    instance,
    item,
    rerender: () => view.rerender(controls()),
  };
};

test("keyboard focus exposes category definitions with an accessible description", async () => {
  const { item } = setup();
  const button = screen.getByRole("button", { name: "梳妆台 (dressing_table)" });
  fireEvent.focus(button);
  const hint = await screen.findByRole("tooltip");
  expect(hint).toHaveTextContent("梳妆");
  expect(hint).toHaveTextContent("易混淆");
  expect(button.getAttribute("aria-describedby")).toBe(hint.id);
  expect(item.setFurnitureInstanceDraft).not.toHaveBeenCalled();
});

test("an unavailable category has a keyboard-focusable explanation", async () => {
  const { item, rerender } = setup();
  item.furnitureInstanceAvailableTypes = item.furnitureInstanceAvailableTypes.filter(
    (type) => type !== "dressing_table",
  );
  rerender();
  const button = screen.getByRole("button", { name: "梳妆台 (dressing_table)" });
  expect(button).toBeDisabled();
  expect(button.parentElement.tabIndex).toBe(0);
  fireEvent.focus(button.parentElement);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("当前项目尚未启用此类别");
});

beforeEach(() => Modal.confirm.mockReset());
afterEach(() => jest.restoreAllMocks());

test("delete modal rejects after an unsaved local mutation and retry only saves without deleting twice", async () => {
  const saveDraft = jest
    .fn()
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({});
  const { annotation, controller, item } = setup({ deleteRequestId: "instance-i", saveDraft });
  await waitFor(() => expect(Modal.confirm).toHaveBeenCalledTimes(1));
  const confirmation = Modal.confirm.mock.calls[0][0];

  let firstError;
  await act(async () => {
    try {
      await confirmation.onOk();
    } catch (error) {
      firstError = error;
    }
  });
  expect(firstError).toMatchObject({ localMutationApplied: true });
  expect(item.deleteFurnitureInstance).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert")).toHaveTextContent("修改保留本地但未保存");
  expect(screen.getByRole("button", { name: "仅重试保存当前 L4 草稿" })).toBeEnabled();

  await act(async () => {
    await confirmation.onOk();
  });
  expect(item.deleteFurnitureInstance).toHaveBeenCalledTimes(1);
  expect(controller.checkFurnitureInstancesReference).toHaveBeenCalledTimes(1);
  expect(annotation.saveDraftImmediatelyWithResults).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("status")).toHaveTextContent("实例 instance-i 已从当前草稿删除");
});

test("orientation controls are absent when a project explicitly disables them", () => {
  const { item, rerender } = setup();
  item.furnitureInstanceOrientationEnabled = false;
  rerender();
  expect(screen.queryByRole("button", { name: "标注家具正面方向" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "标注家具正面边" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "将当前家具实例朝向恢复为 unknown" })).not.toBeInTheDocument();
});

test("category changes are explicit and save failure can retry without repeating the edit", async () => {
  const saveDraft = jest
    .fn()
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({});
  const { item } = setup({ saveDraft });
  fireEvent.change(screen.getByRole("combobox", { name: "当前实例类别" }), { target: { value: "dressing_table" } });
  expect(item.setFurnitureInstanceCategory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "应用当前实例类别" }));
  await waitFor(() => expect(item.setFurnitureInstanceCategory).toHaveBeenCalledWith("instance-i", "dressing_table"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("修改保留本地但未保存"));
  fireEvent.click(screen.getByRole("button", { name: "仅重试保存当前 L4 草稿" }));
  await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(3));
  expect(item.setFurnitureInstanceCategory).toHaveBeenCalledTimes(1);
});

test("unconfigured classes are disabled and selecting another instance resets an unapplied edit", () => {
  const { item, rerender } = setup();
  item.furnitureInstanceAvailableTypes = ["desk", "office_chair"];
  rerender(<FurnitureInstanceControls item={item} />);
  expect(screen.getByRole("button", { name: "梳妆台 (dressing_table)" })).toBeDisabled();
  fireEvent.change(screen.getByRole("combobox", { name: "当前实例类别" }), { target: { value: "office_chair" } });
  item.furnitureInstanceEffectiveSelectedId = "";
  rerender(<FurnitureInstanceControls item={item} />);
  expect(screen.getByRole("combobox", { name: "当前实例类别" })).toHaveValue("");
  expect(item.setFurnitureInstanceCategory).not.toHaveBeenCalled();
});

test("renders canvas-first status cards and all 28 grouped palette choices", () => {
  const { item, rerender } = setup();
  expect(screen.getByRole("region", { name: "当前 Focus 家具组团" })).toHaveTextContent(
    "学习办公 · 窗边 · 房间 书房 · 分区 学习办公 · group-g",
  );
  expect(screen.getByRole("region", { name: "当前家具实例" })).toHaveTextContent(
    "书桌 · instance-i · 父级 room-r → zone-z → group-g",
  );
  expect(screen.getByRole("combobox", { name: "当前实例类别" })).toHaveValue("desk");
  expect(screen.queryByRole("button", { name: "绘制矩形家具实例" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "绘制多边形家具实例" })).not.toBeInTheDocument();
  for (const [value, label] of Object.entries(FURNITURE_TYPES)) {
    expect(screen.getByRole("button", { name: `${label} (${value})` })).toBeInTheDocument();
  }
  fireEvent.click(screen.getByRole("button", { name: "沙发 (sofa)" }));
  expect(item.setFurnitureInstanceDraft).toHaveBeenCalledWith("sofa", "");
  rerender(<FurnitureInstanceControls item={item} />);
  expect(item.setFurnitureInstanceCategory).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "沙发 (sofa)" })).toHaveAttribute("aria-pressed", "true");
});

test("orientation buttons are explicit controls with pressed feedback and a single active mode", () => {
  const { item, rerender } = setup();
  const direction = screen.getByRole("button", { name: "标注家具正面方向" });
  const edge = screen.getByRole("button", { name: "标注家具正面边" });

  expect(direction).toBeEnabled();
  expect(direction).toHaveAttribute("type", "button");
  expect(direction).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(direction);
  expect(item.startFurnitureInstanceTool).toHaveBeenCalledWith("furniture_front_direction");
  rerender();
  expect(screen.getByRole("button", { name: "标注家具正面方向" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("朝向证据：drawing")).toBeInTheDocument();

  fireEvent.click(edge);
  expect(item.startFurnitureInstanceTool).toHaveBeenLastCalledWith("furniture_front_edge");
  rerender();
  expect(screen.getByRole("button", { name: "标注家具正面方向" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "标注家具正面边" })).toHaveAttribute("aria-pressed", "true");
});

test("restore unknown removes only the selected invalid evidence, clears its error, and is idempotent", async () => {
  const otherOrientation = [{ id: "orientation-other", from_name: "furniture_front_direction" }];
  const other = {
    id: "instance-other",
    context: { instance_type: "chair", group_id: "group-g", review_status: "reviewed" },
    results: [{ id: "geometry-other" }],
    orientationResults: otherOrientation,
  };
  const { annotation, controller, instance, item, rerender } = setup({
    orientationResults: [invalidEdge()],
    otherInstances: [other],
    errors: [
      { code: "orientation", instanceId: "instance-i", message: "front_edge 必须包含两个端点" },
      { code: "orientation", instanceId: "instance-other", message: "另一个实例错误" },
    ],
  });
  const geometryResults = instance.results;

  expect(screen.getByText("朝向证据：invalid")).toBeInTheDocument();
  expect(screen.getByText("front_edge 必须包含两个端点")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "将当前家具实例朝向恢复为 unknown" }));
  await waitFor(() => expect(annotation.saveDraftImmediatelyWithResults).toHaveBeenCalledTimes(1));
  rerender();

  expect(screen.getByText("朝向证据：unknown")).toBeInTheDocument();
  expect(screen.queryByText("front_edge 必须包含两个端点")).not.toBeInTheDocument();
  expect(screen.getByText(/复核状态：needs_review/)).toBeInTheDocument();
  expect(instance.context).toMatchObject({ review_status: "pending", review_fingerprint: null });
  expect(instance.results).toBe(geometryResults);
  expect(other.orientationResults).toBe(otherOrientation);
  expect(controller.checkFurnitureInstancesReference).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "将当前家具实例朝向恢复为 unknown" }));
  await waitFor(() => expect(annotation.saveDraftImmediatelyWithResults).toHaveBeenCalledTimes(2));
  expect(item.clearFurnitureInstanceOrientation).toHaveBeenCalledTimes(2);
  expect(instance.orientationResults).toEqual([]);
  expect(other.orientationResults).toBe(otherOrientation);
  expect(screen.getByRole("status")).toHaveTextContent("已是 unknown；未产生新结果");
});

test("review validation is a non-red needs_review status instead of a blocking detail", () => {
  setup({ errors: [{ code: "review", instanceId: "instance-i", message: "复核指纹已失效" }] });
  expect(screen.getByText(/复核状态：needs_review/)).toBeInTheDocument();
  expect(screen.queryByText("当前实例需处理 1 项")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("parent fingerprint failures are shown as stale without rewriting saved context", () => {
  const instance = {
    id: "instance-i",
    context: { review_status: "reviewed" },
  };
  expect(
    effectiveFurnitureInstanceReviewStatus(instance, [
      { code: "parent_stale", instanceId: "instance-i" },
      { code: "review", instanceId: "instance-other" },
    ]),
  ).toBe("stale");
  expect(effectiveFurnitureInstanceReviewStatus(instance, [{ code: "review", instanceId: "instance-i" }])).toBe(
    "reviewed",
  );
  expect(instance.context.review_status).toBe("reviewed");

  setup({ errors: [{ code: "parent_stale", instanceId: "instance-i", message: "父家具组团已更新" }] });
  expect(screen.getByText("复核状态：stale（父级已过期）")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "当前家具实例" })).toHaveTextContent(
    "书桌 · instance-i · 父级 room-r → zone-z → group-g · stale（父级已过期）",
  );
});
