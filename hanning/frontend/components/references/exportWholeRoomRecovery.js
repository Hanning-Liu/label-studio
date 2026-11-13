// A normal Label Studio task JSON with additional recovery context, including the
// entire current result array (references, manual results, and relations).
export function exportWholeRoomRecovery(annotation, reason) {
  const task = annotation.store.task;
  const data = typeof task.data === "string" ? JSON.parse(task.data) : task.data;
  const recovery = [
    {
      data,
      annotations: [{ result: annotation.serializeAnnotation({ fast: true }) }],
      meta: {
        whole_room_recovery: {
          schema_version: 1,
          reason,
          task_id: task.id,
          draft_id: annotation.draftId,
          draft_updated_at: annotation.draftRevision,
          exported_at: new Date().toISOString(),
          label_config: annotation.store.config,
        },
      },
    },
  ];
  const url = URL.createObjectURL(new Blob([JSON.stringify(recovery, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `task-${task.id}-${reason}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
