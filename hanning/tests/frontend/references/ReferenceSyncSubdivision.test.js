import { ReferenceSyncController } from "@hanning/frontend/adapters/referenceSyncController";

function setup() {
  const annotation = {
    draftId: 7,
    draftSelected: true,
    draftRevision: "v1",
    referenceVersion: "r1",
    draftResultFingerprint: "whole",
    savedResultFingerprint: "whole",
    saveDraftImmediatelyWithResults: jest.fn().mockResolvedValue({}),
  };
  const controller = new ReferenceSyncController({ task: { id: 8 }, currentAnnotation: annotation });
  controller.request = jest.fn().mockResolvedValue({ id: 9, zone_id: "zone" });
  return { annotation, controller };
}

test("commits the server snapshot before invoking the undoable local removal", async () => {
  const { annotation, controller } = setup();
  const remove = jest.fn();
  await controller.subdivideWholeRoom(annotation, "zone", remove);
  const payload = controller.request.mock.calls[0][1];
  expect(payload).toMatchObject({ action: "snapshot", draft_id: 7, reference_version: "r1", expected_updated_at: "v1" });
  expect(controller.request.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]);
  expect(remove.mock.invocationCallOrder[0]).toBeLessThan(annotation.saveDraftImmediatelyWithResults.mock.invocationCallOrder[0]);
});

test("does not remove the region if the local draft changes while the snapshot is in flight", async () => {
  const { annotation, controller } = setup();
  const remove = jest.fn();
  controller.request.mockImplementation(async () => {
    annotation.draftResultFingerprint = "edited";
    return { id: 9, zone_id: "zone" };
  });
  await expect(controller.subdivideWholeRoom(annotation, "zone", remove)).rejects.toThrow("当前窗口在操作期间已变化");
  expect(remove).not.toHaveBeenCalled();
  expect(annotation.saveDraftImmediatelyWithResults).not.toHaveBeenCalled();
});

test("does not authorize recovery after a new draft revision", async () => {
  const { annotation, controller } = setup();
  const preview = await controller.previewSubdivision(annotation, 9);
  annotation.draftRevision = "v2";
  await expect(controller.restoreSubdivision(annotation, preview)).rejects.toThrow("预览后草稿已变化");
  expect(controller.request).toHaveBeenCalledTimes(1);
});
