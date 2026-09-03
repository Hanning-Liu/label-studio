import { applyFurnitureInstanceOperation, retryableFurnitureInstanceOperation } from "../operations";

const setup = () => {
  const calls = [];
  const controller = {
    checkFurnitureInstancesReference: jest.fn(async (version) => calls.push(`reference:${version}`)),
  };
  const item = {
    annotation: {
      store: { referenceSyncController: controller },
      referenceVersion: "l3-v1",
      saveDraftImmediatelyWithResults: jest.fn(async () => calls.push("save")),
    },
  };
  const operation = jest.fn(async () => {
    calls.push("write");
    return "done";
  });
  return { calls, controller, item, operation };
};

test("L4 mutation saves, checks the exact applied L3 reference, mutates, and immediately saves again", async () => {
  const { calls, controller, item, operation } = setup();

  await expect(applyFurnitureInstanceOperation(item, operation)).resolves.toBe("done");
  expect(calls).toEqual(["save", "reference:l3-v1", "write", "save"]);
  expect(controller.checkFurnitureInstancesReference).toHaveBeenCalledWith(item.annotation.referenceVersion);
  expect(operation).toHaveBeenCalledTimes(1);
});

test.each(["draft conflict", "network unavailable"])("pre-save failure %s never mutates L4", async (message) => {
  const { controller, item, operation } = setup();
  item.annotation.saveDraftImmediatelyWithResults.mockRejectedValue(new Error(message));

  await expect(applyFurnitureInstanceOperation(item, operation)).rejects.toThrow(message);
  expect(controller.checkFurnitureInstancesReference).not.toHaveBeenCalled();
  expect(operation).not.toHaveBeenCalled();
});

test("changed L3 reference aborts before the local model action", async () => {
  const { controller, item, operation } = setup();
  controller.checkFurnitureInstancesReference.mockRejectedValue(new Error("L3 参考已变化"));

  await expect(applyFurnitureInstanceOperation(item, operation)).rejects.toThrow("L3 参考已变化");
  expect(operation).not.toHaveBeenCalled();
  expect(item.annotation.saveDraftImmediatelyWithResults).toHaveBeenCalledTimes(1);
});

test("a local guard or rollback failure does not attempt the post-write save", async () => {
  const { item, operation } = setup();
  operation.mockRejectedValue(new Error("父级已过期"));

  await expect(applyFurnitureInstanceOperation(item, operation)).rejects.toThrow("父级已过期");
  expect(item.annotation.saveDraftImmediatelyWithResults).toHaveBeenCalledTimes(1);
});

test("post-write save failure keeps the local mutation and reports the explicit unsaved state", async () => {
  const { item, operation } = setup();
  item.annotation.saveDraftImmediatelyWithResults.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("offline"));

  await expect(applyFurnitureInstanceOperation(item, operation)).rejects.toThrow("修改保留本地但未保存");
  expect(operation).toHaveBeenCalledTimes(1);
  expect(item.annotation.saveDraftImmediatelyWithResults).toHaveBeenCalledTimes(2);
});

test("retry after post-write failure saves the retained mutation without repeating the local action or reference check", async () => {
  const { controller, item, operation } = setup();
  item.annotation.saveDraftImmediatelyWithResults
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({});
  const retryable = retryableFurnitureInstanceOperation(item, operation);

  await expect(retryable()).rejects.toMatchObject({
    code: "furniture_instance_local_mutation_unsaved",
    localMutationApplied: true,
  });
  await expect(retryable()).resolves.toBe("done");

  expect(operation).toHaveBeenCalledTimes(1);
  expect(controller.checkFurnitureInstancesReference).toHaveBeenCalledTimes(1);
  expect(item.annotation.saveDraftImmediatelyWithResults).toHaveBeenCalledTimes(3);
});
