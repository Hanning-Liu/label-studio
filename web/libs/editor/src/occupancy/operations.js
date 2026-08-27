// All destructive/bulk L3 edits pass this boundary. The model separately guards
// the preview fingerprint and rolls back an interrupted local transaction.
export async function applyOccupancyPreview(item, preview, backup) {
  const annotation = item.annotation;
  await annotation.saveDraftImmediatelyWithResults();
  backup(annotation, "before-l3-operation");
  const controller = annotation.store.referenceSyncController;
  if (controller) await controller.checkOccupancyReference(annotation.referenceVersion);
  item.applyOccupancyResults(preview.results, preview.fingerprint);
  try {
    await annotation.saveDraftImmediatelyWithResults();
  } catch (error) {
    throw new Error(`修改已保留在本地，但未保存：${error.message}。请重试或导出备份。`);
  }
}
