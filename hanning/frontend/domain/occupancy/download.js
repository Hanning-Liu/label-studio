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

const automaticRecoveryFallback = new Map();

function occupancyRecovery(annotation, reason) {
  const task = annotation.store.task;
  return [
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
  ];
}

function automaticRecoveryKey(annotation) {
  return `label-studio:l3:auto-recovery:task-${annotation.store.task.id}`;
}

// Routine L3 mutations need a pre-operation recovery point, but must not
// initiate a browser download. sessionStorage is tab-scoped and overwrites the
// previous automatic snapshot for the same task; the in-memory copy keeps the
// protection available when storage is blocked or full.
export function cacheOccupancyRecovery(annotation, reason) {
  const key = automaticRecoveryKey(annotation);
  const serialized = JSON.stringify(occupancyRecovery(annotation, reason));
  automaticRecoveryFallback.set(key, serialized);
  try {
    document.defaultView?.sessionStorage?.setItem(key, serialized);
  } catch {
    // The already-written in-memory fallback is sufficient for this tab.
  }
  return key;
}

export function readCachedOccupancyRecovery(annotation) {
  const key = automaticRecoveryKey(annotation);
  let serialized = null;
  try {
    serialized = document.defaultView?.sessionStorage?.getItem(key);
  } catch {
    // Fall through to the in-memory copy.
  }
  serialized ||= automaticRecoveryFallback.get(key);
  return serialized ? JSON.parse(serialized) : null;
}

export function exportOccupancyRecovery(annotation, reason) {
  const task = annotation.store.task;
  downloadJson(
    occupancyRecovery(annotation, reason),
    `task-${task.id}-${reason}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
}
