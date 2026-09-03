import { act, render, screen, waitFor } from "@testing-library/react";
import Modal from "antd/lib/modal";
import { FurnitureInstanceControls } from "../FurnitureInstanceControls";
import { effectiveFurnitureInstanceReviewStatus } from "../FurnitureInstanceOutliner";

jest.mock("antd/lib/modal", () => ({ __esModule: true, default: { confirm: jest.fn() } }));

const setup = () => {
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
    saveDraftImmediatelyWithResults: jest
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({}),
  };
  const instance = {
    id: "instance-i",
    context: { instance_type: "desk", group_id: "group-g", review_status: "reviewed" },
    results: [],
    orientationResults: [],
  };
  const item = {
    annotation,
    furnitureInstancesEnabled: true,
    furnitureInstanceBusy: false,
    furnitureInstanceType: "desk",
    furnitureInstanceNote: "",
    furnitureInstanceDeleteRequestId: instance.id,
    furnitureInstanceParents: [{ id: "group-g", groupType: "study_work", roomId: "room-r", zoneId: "zone-z" }],
    furnitureInstanceLogicals: [instance],
    furnitureInstanceFocusId: "group-g",
    furnitureInstanceEffectiveSelectedId: instance.id,
    furnitureInstanceErrors: [],
    furnitureInstanceBoundarySnap: true,
    furnitureInstancePixelSnap: true,
    furnitureInstanceEditNotice: "",
    setFurnitureInstanceBusy: jest.fn((value) => {
      item.furnitureInstanceBusy = value;
    }),
    deleteFurnitureInstance: jest.fn(() => {
      item.furnitureInstanceDeleteRequestId = "";
    }),
    clearFurnitureInstanceDeleteRequest: jest.fn(() => {
      item.furnitureInstanceDeleteRequestId = "";
    }),
  };
  render(<FurnitureInstanceControls item={item} />);
  return { annotation, controller, item };
};

beforeEach(() => Modal.confirm.mockReset());
afterEach(() => jest.restoreAllMocks());

test("delete modal rejects after an unsaved local mutation and retry only saves without deleting twice", async () => {
  const { annotation, controller, item } = setup();
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
  expect(screen.getByRole("button", { name: "仅重试保存当前草稿" })).toBeEnabled();

  await act(async () => {
    await confirmation.onOk();
  });
  expect(item.deleteFurnitureInstance).toHaveBeenCalledTimes(1);
  expect(controller.checkFurnitureInstancesReference).toHaveBeenCalledTimes(1);
  expect(annotation.saveDraftImmediatelyWithResults).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("status")).toHaveTextContent("实例 instance-i 已从当前草稿删除");
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
});
