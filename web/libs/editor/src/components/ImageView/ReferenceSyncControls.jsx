import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { Modal } from "antd";
import { exportWholeRoomRecovery } from "./WholeRoomInheritanceControls";
import { buildReferenceReviewRows, referenceReviewSummary } from "./referenceReview";
import styles from "./ReferenceSyncControls.module.scss";

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
  const hasLocalEdits =
    annotation.savedResultFingerprint !== null && annotation.savedResultFingerprint !== undefined
      ? annotation.savedResultFingerprint !== annotation.draftResultFingerprint
      : !!annotation.history?.hasChanges &&
        (!annotation.draftSaved || new Date(annotation.history.lastAdditionTime) > new Date(annotation.draftSaved));
  const changed = !source && current?.reference_version && annotation.referenceVersion !== current.reference_version;
  const repairable = source && current?.source_metadata_repair_available;
  const draftStatus = current?.drafts?.find((draft) => Number(draft.id) === Number(annotation.draftId));
  const pending = buildReferenceReviewRows(annotation.results, draftStatus?.pending || []);
  const eligible = pending.filter((row) => row.eligible);
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
  const locate = (row) => {
    const result = row.result;
    const parent = result.meta?.partition_context?.parent_room_id;
    if (parent && item.roomReferenceRegions.some((room) => room.cleanId === parent)) item.setFocusedRoom(parent);
    annotation.unselectAreas();
    if (result.area) annotation.selectAreas([result.area]);
  };
  const reviewAll = () => {
    const summary = referenceReviewSummary(eligible);
    const excluded = pending.length - eligible.length;
    Modal.confirm({
      title: `确认全部可复核对象（${eligible.length}）`,
      content: (
        <div className={styles.confirmation}>
          <p>
            功能分区 {summary.zones} 个，交通连通 Vector {summary.connections} 个，视觉连通 Vector {summary.visuals}{" "}
            个。
          </p>
          {excluded > 0 && <p>{excluded} 个父房间缺失或越界对象不会被批量确认，仍需人工修正。</p>}
          <p>该操作表示你已逐项检查这些参考变化；不会确认 Vector 几何复核、整室分区类别，也不会提交任务。</p>
        </div>
      ),
      okText: "已检查，确认全部",
      cancelText: "取消",
      onOk: () => controller.review(eligible.map((row) => row.id)),
    });
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
          <div className={styles.reviewHeader}>
            <strong>待复核对象 {pending.length} 个</strong>
            <button type="button" disabled={disabled || changed || !eligible.length} onClick={reviewAll}>
              全部确认参考复核（{eligible.length}）
            </button>
          </div>
          {!pending.length && <p>当前草稿没有待处理的参考变更。</p>}
          {pending.map((row) => (
            <div key={row.id} className={styles.reviewRow}>
              <span className={styles.swatch} style={{ backgroundColor: row.color }} aria-hidden="true" />
              <div className={styles.reviewIdentity}>
                <div className={styles.reviewTitle}>
                  <strong>{row.targetLabel}</strong>
                  <span className={styles.targetBadge}>{row.targetType}</span>
                  <code>{row.id}</code>
                </div>
                <span>触发原因：{row.triggerLabel}</span>
                {!!row.review.changed_reference_ids?.length && (
                  <small>变化的参考 ID：{row.review.changed_reference_ids.join("、")}</small>
                )}
              </div>
              <div className={styles.rowActions}>
                <button type="button" onClick={() => locate(row)}>
                  定位
                </button>
                <button
                  type="button"
                  disabled={disabled || changed || !row.eligible}
                  onClick={() => run(() => controller.review([row.id]))}
                >
                  已检查，确认复核
                </button>
              </div>
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
        {repairable && failed && (
          <button
            type="button"
            disabled={disabled || hasLocalEdits}
            onClick={() => run(() => controller.repairSourceMetadata())}
            title={hasLocalEdits ? "请先保存或撤销当前窗口修改" : "只重算派生元数据，不改变房间或 Portal 几何"}
          >
            修复 Portal 元数据并重新同步
          </button>
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
        {((failed && !repairable) || workerDown) && (
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
