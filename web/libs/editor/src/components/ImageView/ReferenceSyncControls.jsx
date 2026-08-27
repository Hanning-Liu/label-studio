import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { Modal } from "antd";
import { exportWholeRoomRecovery } from "./WholeRoomInheritanceControls";
import styles from "./ReferenceSyncControls.module.scss";

const reasons = {
  source_missing: "来源房间已删除：保留分区，请人工处理归属",
  outside_parent_room: "分区超出更新后的父房间：请人工调整",
  room_or_portal_changed: "房间或开口变化：请核对分区及连通信息",
  geometry_or_label_changed: "几何或类别变化：请重新核对",
  geometry_corrected_needs_review: "几何问题已修正，请确认",
};

export const ReferenceSyncControls = observer(({ item, compact = false }) => {
  const controller = item.annotation.store.referenceSyncController;
  const [state, setState] = useState(controller?.state || {});
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setState(controller?.state || {});
    return controller?.subscribe(setState);
  }, [controller]);
  if (!controller) return null;
  const status = state.status;
  if (!status?.enabled && !state.error) return null;
  const annotation = item.annotation;
  const source = status?.mode === "source";
  const current = source ? status.bindings[0] : status;
  const historical = annotation.type !== "prediction" && !!annotation.pk && !annotation.draftSelected;
  const changed = !source && current?.reference_version && annotation.referenceVersion !== current.reference_version;
  const pending = annotation.results.filter((result) => result.meta?.reference_review?.status === "pending");
  const disabled =
    item.vectorReviewBusy ||
    state.busy ||
    annotation.isDraftSaving ||
    !!annotation.submissionStarted ||
    item.isDrawing ||
    annotation.hasIncompletePolygons;
  const failed = state.error || current?.error;
  const workerDown = current?.enabled && !current?.worker_alive;
  const label =
    failed || workerDown
      ? "同步失败"
      : current?.status !== "synced"
        ? "同步中"
        : pending.length || current?.needs_review
          ? "待复核"
          : "已同步";
  const run = (operation) => {
    Promise.resolve()
      .then(operation)
      .catch(() => {});
  };
  const locate = (result) => {
    const parent = result.meta?.partition_context?.parent_room_id;
    if (parent && item.roomReferenceRegions.some((room) => room.cleanId === parent)) item.setFocusedRoom(parent);
    annotation.unselectAreas();
    if (result.area) annotation.selectAreas([result.area]);
  };
  const details = (
    <>
      {" "}
      {!source && changed && !historical && (
        <p role="status">Room 参考已更新。当前画面仍是旧版本；正在编辑时会保留现场。</p>
      )}
      {!source && historical && (
        <p>当前为历史提交结果{changed ? "（旧参考版本）" : ""}，后台不会改写。请进入复核草稿继续工作。</p>
      )}
      {workerDown && <p role="alert">同步后台心跳中断，暂时无法保证自动同步；已保存标注不会被清空。</p>}
      {failed && <p role="alert">{failed}</p>}
      {(state.notice || state.focusNotice) && (
        <p role="status">
          {state.notice} {state.focusNotice}
        </p>
      )}
      {expanded && !source && !historical && (
        <div className={styles.review}>
          <p>逐项检查后确认。此操作仅记录参考变更复核，不替代整室分区类别确认或标注提交。</p>
          {!pending.length && <p>当前草稿没有待处理的参考变更。</p>}
          {pending.map((result) => (
            <div key={`${result.area?.id}:${result.from_name.name}`} className={styles.actions}>
              <code>{result.area?.cleanId}</code>
              <span>{reasons[result.meta.reference_review.reason] || "参考变化待复核"}</span>
              <button type="button" onClick={() => locate(result)}>
                定位
              </button>
              <button
                type="button"
                disabled={
                  disabled ||
                  changed ||
                  ["source_missing", "outside_parent_room"].includes(result.meta.reference_review.reason)
                }
                onClick={() => run(() => controller.review([result.area.cleanId]))}
              >
                已检查，确认复核
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
  return (
    <section
      className={`${styles.controls} ${compact ? styles.compact : ""}`}
      data-testid="reference-sync-controls"
      aria-label="Room 参考同步"
    >
      <div className={styles.actions}>
        <strong>Room → L2 · {label}</strong>
        {current?.last_synced_at && <small>最近同步 {new Date(current.last_synced_at).toLocaleTimeString()}</small>}
        {source && current?.target_task_id && (
          <a
            href={`/projects/${current.target_project_id}/data?task=${current.target_task_id}`}
            target="_blank"
            rel="noreferrer"
          >
            打开 L2 任务 {current.target_task_id}
          </a>
        )}
        {!source && changed && !historical && (
          <button type="button" disabled={disabled} onClick={() => run(() => controller.apply())}>
            保存人工修改并安全应用新参考
          </button>
        )}
        {!source && historical && (
          <button type="button" disabled={disabled} onClick={() => run(() => controller.apply(true, true))}>
            进入复核草稿
          </button>
        )}
        {!source && !historical && (
          <button type="button" onClick={() => setExpanded(!expanded)}>
            参考变更待复核（{pending.length}）
          </button>
        )}
        {(failed || workerDown) && (
          <button type="button" disabled={disabled} onClick={() => run(() => controller.retry())}>
            重试同步
          </button>
        )}
        {!source && !compact && (
          <button type="button" onClick={() => exportWholeRoomRecovery(annotation, "reference-sync-recovery")}>
            导出当前窗口备份
          </button>
        )}
      </div>
      {compact ? (
        <>
          {(failed || workerDown || changed) && <small role="alert">参考同步需要处理，请查看详情</small>}
          <Modal
            visible={expanded}
            title="参考同步详情与复核"
            onCancel={() => setExpanded(false)}
            footer={null}
            width={800}
            destroyOnClose
          >
            <div className={styles.controls}>{details}</div>
          </Modal>
        </>
      ) : (
        details
      )}
    </section>
  );
});
