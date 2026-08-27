import { applyOccupancyPreview } from "../operations";

const setup = () => {
  const calls = [];
  const controller = { checkOccupancyReference: jest.fn(async () => calls.push("reference")) };
  const item = {
    annotation: {
      store: { referenceSyncController: controller },
      referenceVersion: "v1",
      saveDraftImmediatelyWithResults: jest.fn(async () => calls.push("save")),
    },
    applyOccupancyResults: jest.fn(() => calls.push("write")),
  };
  const backup = jest.fn(() => calls.push("backup"));
  return { calls, controller, item, backup, preview: { results: [{ id: "new" }], fingerprint: "preview-version" } };
};
test("save, backup, fresh reference, guarded one-step write, then save", async () => {
  const { item, preview, backup, calls } = setup();
  await applyOccupancyPreview(item, preview, backup);
  expect(calls).toEqual(["save", "backup", "reference", "write", "save"]);
  expect(item.applyOccupancyResults).toHaveBeenCalledTimes(1);
  expect(item.applyOccupancyResults).toHaveBeenCalledWith(preview.results, preview.fingerprint);
});
test.each(["409 conflict", "network failure"])(
  "pre-save %s never writes or discards local results",
  async (message) => {
    const { item, preview, backup } = setup();
    item.annotation.saveDraftImmediatelyWithResults.mockRejectedValue(new Error(message));
    await expect(applyOccupancyPreview(item, preview, backup)).rejects.toThrow(message);
    expect(item.applyOccupancyResults).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
  },
);
test("a failed backup aborts before mutation", async () => {
  const { item, preview, backup } = setup();
  backup.mockImplementation(() => {
    throw new Error("backup unavailable");
  });
  await expect(applyOccupancyPreview(item, preview, backup)).rejects.toThrow("backup");
  expect(item.applyOccupancyResults).not.toHaveBeenCalled();
});
test("changed source reference aborts without writing", async () => {
  const { item, preview, backup, controller } = setup();
  controller.checkOccupancyReference.mockRejectedValue(new Error("source changed"));
  await expect(applyOccupancyPreview(item, preview, backup)).rejects.toThrow("source changed");
  expect(item.applyOccupancyResults).not.toHaveBeenCalled();
});
test("changed preview is rejected by the model, with no post-write save", async () => {
  const { item, preview, backup } = setup();
  item.applyOccupancyResults.mockImplementation(() => {
    throw new Error("preview changed");
  });
  await expect(applyOccupancyPreview(item, preview, backup)).rejects.toThrow("preview changed");
  expect(item.annotation.saveDraftImmediatelyWithResults).toHaveBeenCalledTimes(1);
});
test("post-write save failure leaves the edit in memory and reports unsaved, never rollback", async () => {
  const { item, preview, backup } = setup();
  item.annotation.saveDraftImmediatelyWithResults.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("offline"));
  await expect(applyOccupancyPreview(item, preview, backup)).rejects.toThrow("修改已保留在本地，但未保存");
  expect(item.applyOccupancyResults).toHaveBeenCalledTimes(1);
});
