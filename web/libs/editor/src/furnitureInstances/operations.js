// L4 mutations use the same server-backed operation boundary as L3: first
// persist every currently visible result, then verify that the applied L3
// reference is still current, mutate locally, and immediately persist again.
// The model actions retain their own cached-state guards and rollback logic.
export const FURNITURE_INSTANCE_UNSAVED = "furniture_instance_local_mutation_unsaved";

const unsavedMutationError = (error, operationResult) => {
  const wrapped = new Error(`修改保留本地但未保存：${error.message || error}。请重试保存或导出备份。`);
  wrapped.code = FURNITURE_INSTANCE_UNSAVED;
  wrapped.localMutationApplied = true;
  wrapped.operationResult = operationResult;
  return wrapped;
};

export async function applyFurnitureInstanceOperation(item, operation) {
  const annotation = item.annotation;

  await annotation.saveDraftImmediatelyWithResults();
  const controller = annotation.store.referenceSyncController;
  if (controller) await controller.checkFurnitureInstancesReference(annotation.referenceVersion);

  const result = await operation();
  try {
    await annotation.saveDraftImmediatelyWithResults();
  } catch (error) {
    throw unsavedMutationError(error, result);
  }
  return result;
}

// Orientation recovery is intentionally local-first. An incomplete one-point
// Vector must be removed before any draft save can serialize it. We still
// perform a fresh L3 reference check before mutation, then persist the repaired
// draft immediately. A failed post-write save follows the same explicit
// recoverable-unsaved contract as every other L4 mutation.
export async function recoverFurnitureInstanceOrientation(item, operation) {
  const annotation = item.annotation;
  const controller = annotation.store.referenceSyncController;

  if (controller) await controller.checkFurnitureInstancesReference(annotation.referenceVersion);

  const result = await operation();
  try {
    await annotation.saveDraftImmediatelyWithResults();
  } catch (error) {
    throw unsavedMutationError(error, result);
  }
  return result;
}

// Modal.confirm keeps the dialog open when onOk returns a rejected promise.
// Retrying this closure after a post-write save failure only persists the
// already-applied local mutation; it never repeats the destructive model action.
export function retryableFurnitureInstanceOperation(item, operation) {
  let pendingSave = false;
  let operationResult;

  return async () => {
    if (pendingSave) {
      try {
        await item.annotation.saveDraftImmediatelyWithResults();
      } catch (error) {
        throw unsavedMutationError(error, operationResult);
      }
      pendingSave = false;
      return operationResult;
    }
    try {
      return await applyFurnitureInstanceOperation(item, operation);
    } catch (error) {
      if (error?.code === FURNITURE_INSTANCE_UNSAVED) {
        pendingSave = true;
        operationResult = error.operationResult;
      }
      throw error;
    }
  };
}

export async function retryFurnitureInstanceSave(item) {
  try {
    await item.annotation.saveDraftImmediatelyWithResults();
  } catch (error) {
    throw unsavedMutationError(error);
  }
  return "已保存此前保留在本地的家具实例修改。";
}
