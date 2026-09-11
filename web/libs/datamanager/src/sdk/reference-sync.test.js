/** @jest-environment jsdom */
import { ReferenceSyncController, hasReferenceEdits, isReferenceBusy } from "./reference-sync";

const annotation = () => ({
  pk: null, draftId: 7, referenceVersion: "old", baseManualHash: "manual", draftSelected: true,
  draftResultFingerprint: "saved", savedResultFingerprint: "saved", objects: [{ isDrawing: false }],
  saveDraftImmediatelyWithResults: jest.fn().mockResolvedValue({}),
});
const status = { enabled: true, mode: "target", status: "synced", reference_version: "new", drafts: [{ id: 7 }] };
const setup = () => {
  const current = annotation();
  const wrapper = { currentAnnotation: current, task: { id: 20 }, lsf: {} };
  const controller = new ReferenceSyncController(wrapper);
  controller.request = jest.fn().mockResolvedValue(status);
  return { current, wrapper, controller };
};

const historicalSetup = () => {
  const context = setup();
  Object.assign(context.current, {
    pk: "11", draftId: 0, draftSelected: false, referenceVersion: "new",
    draftRevision: "2026-09-04T09:00:00Z", editable: true,
    serializeAnnotation: jest.fn(() => [{ id: "zone", value: { x: 10 } }]),
  });
  context.controller.replace = jest.fn();
  const raw = { id: 9, result: [{ id: "zone" }], reference_version: "new", updated_at: "2026-09-11T09:00:00Z" };
  const latest = { ...status, drafts: [{ id: 9, annotation_id: 11, updated_at: raw.updated_at }] };
  context.controller.request.mockResolvedValueOnce({ ...status, drafts: [] })
    .mockResolvedValueOnce(raw).mockResolvedValueOnce(latest);
  return { ...context, raw, latest };
};

test("unchanged formal L2 enters a new linked draft using loaded version tokens", async () => {
  const { controller, current, raw } = historicalSetup();
  await controller.apply(true, true);
  expect(controller.request).toHaveBeenNthCalledWith(2, "/api/tasks/20/annotations/11/drafts", {
    result: [{ id: "zone", value: { x: 10 } }], reference_version: "new", base_manual_hash: "manual",
    expected_updated_at: "2026-09-04T09:00:00Z",
  });
  expect(controller.replace).toHaveBeenCalledWith(current, raw, true);
  expect(current.saveDraftImmediatelyWithResults).not.toHaveBeenCalled();
});

test("existing review draft is loaded without creating or overwriting a draft", async () => {
  const { controller, current, raw, latest } = historicalSetup();
  controller.request.mockReset().mockResolvedValueOnce(latest).mockResolvedValueOnce(raw).mockResolvedValueOnce(latest);
  await controller.apply(true, true);
  expect(controller.request).toHaveBeenNthCalledWith(2, "/api/drafts/9/");
  expect(controller.replace).toHaveBeenCalledWith(current, raw, true);
});

test("dirty historical window cannot overwrite an existing review draft", async () => {
  const { controller, current, latest } = historicalSetup();
  current.draftResultFingerprint = "unsaved";
  controller.request.mockReset().mockResolvedValue(latest);
  await expect(controller.apply(true, true)).rejects.toThrow("另有修改");
  expect(controller.request).toHaveBeenCalledTimes(1);
  expect(controller.replace).not.toHaveBeenCalled();
});

test.each(["save failure", "source changed", "draft changed", "edited", "task changed"])(
  "review entry preserves the window on %s", async (reason) => {
    const { controller, current, wrapper, raw, latest } = historicalSetup();
    controller.request.mockReset().mockResolvedValueOnce({ ...status, drafts: [] });
    if (reason === "save failure") controller.request.mockRejectedValueOnce(new Error("409 conflict"));
    else {
      controller.request.mockImplementationOnce(async () => {
        if (reason === "edited") current.draftResultFingerprint = "local edit";
        if (reason === "task changed") wrapper.currentAnnotation = annotation();
        return raw;
      }).mockResolvedValueOnce({ ...latest,
        ...(reason === "source changed" ? { reference_version: "newer" } : {}),
        ...(reason === "draft changed" ? { drafts: [{ ...latest.drafts[0], updated_at: "2026-09-11T10:00:00Z" }] } : {}),
      });
    }
    await expect(controller.apply(true, true)).rejects.toThrow();
    expect(controller.replace).not.toHaveBeenCalled();
    expect(controller.applying).toBe(false);
    expect(controller.state.actionError).toBeTruthy();
  },
);

test("task switch while fetching status stops before creating any draft", async () => {
  const { controller, wrapper } = historicalSetup();
  controller.request.mockReset().mockImplementation(async () => {
    wrapper.currentAnnotation = annotation();
    return { ...status, drafts: [] };
  });
  await expect(controller.apply(true, true)).rejects.toThrow("画面发生变化");
  expect(controller.request).toHaveBeenCalledTimes(1);
});

test("double click starts only one review entry", async () => {
  const { controller } = historicalSetup();
  const first = controller.apply(true, true);
  await expect(controller.apply(true, true)).rejects.toThrow("等待保存");
  await first;
  expect(controller.request.mock.calls.filter(([, body]) => body)).toHaveLength(1);
});

test("status polling does not erase a review entry failure or misreport synchronization", async () => {
  const { controller } = historicalSetup();
  controller.state.actionError = "draft save failed";
  controller.request.mockReset().mockResolvedValue({ ...status, drafts: [] });
  await controller.poll();
  expect(controller.state.actionError).toBe("draft save failed");
  expect(controller.state.error).toBe("");
  expect(controller.state.status.status).toBe("synced");
});

test("L4 rejects an invalid ancestor even when the direct source version still matches", async () => {
  const { controller } = setup();
  controller.request.mockResolvedValue({
    ...status, sync_type: "occupancy_to_furniture_instances", source_version: "old", reference_version: "old",
    lineage: { ready: false, version: "root-changed", issues: [{ message: "L2 缺少 L1 窗参考" }] },
  });
  await expect(controller.checkFurnitureInstancesReference("old")).rejects.toThrow("L2 缺少 L1 窗参考");
});

test("L4 accepts a verified windowless source chain", async () => {
  const { controller } = setup();
  controller.request.mockResolvedValue({
    ...status, sync_type: "occupancy_to_furniture_instances", source_version: "old", reference_version: "old",
    lineage: { ready: true, version: "windowless", window_count: 0, issues: [] },
  });
  await expect(controller.checkFurnitureInstancesReference("old")).resolves.toMatchObject({ lineage: { ready: true } });
});

test("L3 manual policy never auto-applies even when draft is clean", async () => {
  const { controller } = setup();
  controller.apply = jest.fn();
  controller.request.mockResolvedValue({ ...status, apply_policy: "manual", sync_type: "function_zone_to_occupancy" });
  await controller.poll();
  expect(controller.apply).not.toHaveBeenCalled();
});

test("L3 apply stops on failed save without calling the apply endpoint", async () => {
  const { controller, current } = setup();
  controller.state.status = { ...status, apply_policy: "manual", sync_type: "function_zone_to_occupancy", source_version: "new" };
  current.saveDraftImmediatelyWithResults.mockRejectedValue(new Error("409 conflict"));
  await expect(controller.applyOccupancyReference()).rejects.toThrow("409");
  expect(controller.request).not.toHaveBeenCalled();
  expect(controller.applying).toBe(false);
});
test("L4 manual apply uses the same guarded endpoint without changing L3 compatibility", async () => {
  const { controller, current } = setup();
  controller.state.status = {
    ...status,
    apply_policy: "manual",
    sync_type: "occupancy_to_furniture_instances",
    source_version: "new",
  };
  current.draftRevision = "2026-09-03T08:00:00Z";
  controller.replace = jest.fn();
  controller.request.mockResolvedValue({ id: 7, updated_at: current.draftRevision, result: [] });

  await controller.applyFurnitureInstancesReference();

  expect(controller.request).toHaveBeenCalledWith("/api/tasks/20/reference-sync/apply/", {
    draft_id: 7,
    expected_updated_at: current.draftRevision,
    reference_version: "old",
    base_manual_hash: "manual",
    source_version: "new",
  });
  expect(controller.replace).toHaveBeenCalledTimes(1);
});
test("L3 operation check always fetches a fresh source/reference version", async () => {
  const { controller } = setup();
  controller.state.status = { ...status, source_version: "old", reference_version: "old" };
  controller.request.mockResolvedValue({ ...status, sync_type: "function_zone_to_occupancy", source_version: "old", reference_version: "old" });
  await expect(controller.checkOccupancyReference("old")).resolves.toMatchObject({ source_version: "old" });
  controller.request.mockResolvedValue({ ...status, sync_type: "function_zone_to_occupancy", source_version: "new", reference_version: "old" });
  await expect(controller.checkOccupancyReference("old")).rejects.toThrow("L2 参考已变化");
  expect(controller.request).toHaveBeenCalledTimes(2);
});
test("L4 operation check rejects a changed L3 source version", async () => {
  const { controller } = setup();
  controller.request.mockResolvedValue({
    ...status,
    sync_type: "occupancy_to_furniture_instances",
    source_version: "newer",
    reference_version: "old",
  });
  await expect(controller.checkFurnitureInstancesReference("old")).rejects.toThrow("L3 参考已变化");
});

test.each(["isDraftSaving", "submissionStarted", "hasIncompletePolygons"])("does not replace during %s", (key) => {
  expect(isReferenceBusy({ ...annotation(), [key]: true })).toBeTruthy();
});
test("drawing, pointer interaction and unsaved results are protected", () => {
  const value = annotation();
  expect(isReferenceBusy(value, true)).toBeTruthy();
  value.objects[0].isDrawing = true;
  expect(isReferenceBusy(value)).toBeTruthy();
  value.draftResultFingerprint = "edited";
  expect(hasReferenceEdits(value)).toBe(true);
});
test("poll applies idle updates but never dirty, drawing or historical results", async () => {
  const { controller, current } = setup();
  controller.apply = jest.fn();
  await controller.poll();
  expect(controller.apply).toHaveBeenCalledTimes(1);
  current.draftResultFingerprint = "dirty";
  await controller.poll();
  current.savedResultFingerprint = "dirty";
  current.objects[0].isDrawing = true;
  await controller.poll();
  current.objects[0].isDrawing = false;
  current.pk = "8"; current.draftSelected = false;
  await controller.poll();
  expect(controller.apply).toHaveBeenCalledTimes(1);
});
test("safe apply saves edits first and a rejected save never replaces them", async () => {
  const { controller, current } = setup();
  current.draftResultFingerprint = "dirty";
  current.saveDraftImmediatelyWithResults.mockRejectedValue(new Error("409 manual conflict"));
  controller.replace = jest.fn();
  await expect(controller.apply()).rejects.toThrow("409");
  expect(controller.replace).not.toHaveBeenCalled();
  expect(controller.request).not.toHaveBeenCalled();
  expect(current.draftResultFingerprint).toBe("dirty");
});
test("edits made while the latest draft is downloading survive", async () => {
  const { controller, current } = setup();
  controller.replace = jest.fn();
  controller.request.mockResolvedValueOnce(status).mockImplementationOnce(async () => {
    current.draftResultFingerprint = "new local edits";
    return { reference_version: "new", result: [] };
  });
  await controller.apply();
  expect(controller.replace).not.toHaveBeenCalled();
});
test("switching tasks or closing aborts a pending load", async () => {
  const { controller } = setup();
  controller.replace = jest.fn();
  controller.request.mockResolvedValueOnce(status).mockImplementationOnce(async () => {
    controller.stop();
    return { reference_version: "new", result: [] };
  });
  await controller.apply();
  expect(controller.replace).not.toHaveBeenCalled();
  expect(controller.abort.signal.aborted).toBe(true);
});
test("reference-only server rebase advances manual baseline but not loaded reference", () => {
  const { controller, current } = setup();
  current.setReferenceBaseline = jest.fn();
  controller.seed(current, { reference_version: "new", base_manual_hash: "b" }, { loaded: false });
  expect(current.setReferenceBaseline).toHaveBeenCalledWith({ reference_version: "new", base_manual_hash: "b" }, false);
});

test("bulk reference review saves first, removes duplicate ids and replaces from one response", async () => {
  const { controller, current } = setup();
  controller.state.status = { ...status, reference_version: "old" };
  current.draftRevision = "2026-08-31T08:00:00Z";
  controller.replace = jest.fn();
  controller.request.mockResolvedValue({
    id: 7,
    updated_at: "2026-08-31T08:01:00Z",
    reference_version: "old",
    result: [],
  });

  await controller.review(["zone-a", "zone-a", "vector-b"]);

  expect(current.saveDraftImmediatelyWithResults).toHaveBeenCalledTimes(1);
  expect(controller.request).toHaveBeenCalledWith("/api/tasks/20/reference-sync/review/", {
    draft_id: 7,
    expected_updated_at: "2026-08-31T08:00:00Z",
    reference_version: "old",
    region_ids: ["zone-a", "vector-b"],
  });
  expect(controller.replace).toHaveBeenCalledTimes(1);
});

test("reference review refuses an empty eligible selection before saving", async () => {
  const { controller, current } = setup();
  await expect(controller.review([])).rejects.toThrow("没有可确认");
  expect(current.saveDraftImmediatelyWithResults).not.toHaveBeenCalled();
});

test("source metadata repair uses the loaded annotation version and preserves local results", async () => {
  const { controller, current } = setup();
  controller.state.status = {
    enabled: true,
    mode: "source",
    bindings: [{
      source_metadata_repair_available: true,
      source_annotation_updated_at: "2026-08-31T08:00:00Z",
    }],
  };
  controller.request
    .mockResolvedValueOnce({ repaired_portal_ids: ["portal"], repaired_room_ids: [] })
    .mockResolvedValueOnce(controller.state.status);
  await controller.repairSourceMetadata();
  expect(controller.request).toHaveBeenNthCalledWith(1, "/api/tasks/20/reference-sync/repair-source/", {
    expected_annotation_updated_at: "2026-08-31T08:00:00Z",
  });
  expect(current.draftResultFingerprint).toBe("saved");
});

test("source metadata repair refuses a dirty browser window", async () => {
  const { controller, current } = setup();
  controller.state.status = {
    enabled: true,
    mode: "source",
    bindings: [{
      source_metadata_repair_available: true,
      source_annotation_updated_at: "2026-08-31T08:00:00Z",
    }],
  };
  current.draftResultFingerprint = "dirty";
  await expect(controller.repairSourceMetadata()).rejects.toThrow("未保存修改");
  expect(controller.request).not.toHaveBeenCalled();
});

test("source metadata repair allows an unchanged legacy annotation without a saved fingerprint", async () => {
  const { controller, current } = setup();
  controller.state.status = {
    enabled: true,
    mode: "source",
    bindings: [{
      source_metadata_repair_available: true,
      source_annotation_updated_at: "2026-08-31T08:00:00Z",
    }],
  };
  current.savedResultFingerprint = null;
  current.history = { hasChanges: false };
  controller.request
    .mockResolvedValueOnce({ repaired_portal_ids: ["portal"], repaired_room_ids: [] })
    .mockResolvedValueOnce(controller.state.status);

  await controller.repairSourceMetadata();

  expect(controller.request).toHaveBeenNthCalledWith(1, "/api/tasks/20/reference-sync/repair-source/", {
    expected_annotation_updated_at: "2026-08-31T08:00:00Z",
  });
});
