export function downloadJson(value, filename) {
  const json = JSON.stringify(value, null, 2);
  // Some embedded/runtime environments replace URL without the Blob helpers.
  // A data URL remains a local download; annotation data never leaves the device.
  const urlApi = document.defaultView?.URL;
  const blobUrl =
    typeof urlApi?.createObjectURL === "function"
      ? urlApi.createObjectURL(new Blob([json], { type: "application/json" }))
      : null;
  const link = document.createElement("a");
  link.href = blobUrl || `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
  link.download = filename;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
  }
  if (blobUrl) setTimeout(() => urlApi.revokeObjectURL(blobUrl), 1000);
}

export function exportOccupancyRecovery(annotation, reason) {
  const task = annotation.store.task;
  downloadJson(
    [
      {
        data: typeof task.data === "string" ? JSON.parse(task.data) : task.data,
        annotations: [{ result: annotation.serializeAnnotation({ fast: true }) }],
        meta: {
          occupancy_recovery: {
            schema_version: 1,
            reason,
            task_id: task.id,
            draft_id: annotation.draftId,
            draft_updated_at: annotation.draftRevision,
            reference_version: annotation.referenceVersion,
            exported_at: new Date().toISOString(),
            label_config: annotation.store.config,
          },
        },
      },
    ],
    `task-${task.id}-${reason}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
}
