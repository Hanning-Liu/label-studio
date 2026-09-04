import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { Modal } from "antd";
import { Button } from "@humansignal/ui";

import { GROUP_TYPES } from "../occupancy/domain";
import { downloadJson } from "../occupancy/download";
import { CONTROLS, FURNITURE_TYPES, ORIENTATION_CONTROLS } from "./domain";
import { orientationForInstance } from "./constraints";
import { downloadFurnitureInstances, reimportFurnitureInstances } from "./download";
import { effectiveFurnitureInstanceReviewStatus } from "./FurnitureInstanceOutliner";
import {
  applyFurnitureInstanceOperation,
  recoverFurnitureInstanceOrientation,
  retryableFurnitureInstanceOperation,
  retryFurnitureInstanceSave,
} from "./operations";
import styles from "./FurnitureInstanceControls.module.scss";

const short = (value) => (value?.length > 20 ? `${value.slice(0, 10)}…${value.slice(-7)}` : value || "—");

export const FurnitureInstanceControls = observer(({ item }) => {
  const annotation = item.annotation;
  const controller = annotation.store.referenceSyncController;
  const [state, setState] = useState(controller?.state || {});
  const [type, setType] = useState(item.furnitureInstanceType);
  const [note, setNote] = useState(item.furnitureInstanceNote);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [hasUnsavedMutation, setHasUnsavedMutation] = useState(false);
  const file = useRef(null);

  useEffect(() => {
    setState(controller?.state || {});
    return controller?.subscribe(setState);
  }, [controller]);

  const run = async (operation, { rethrow = false } = {}) => {
    if (item.furnitureInstanceBusy) return;
    item.setFurnitureInstanceBusy(true);
    setError("");
    setNotice("");
    try {
      const message = await operation();
      setHasUnsavedMutation(false);
      if (message) setNotice(message);
    } catch (cause) {
      if (cause?.localMutationApplied) setHasUnsavedMutation(true);
      setError(cause.message || "操作失败；当前标注仍保留");
      if (rethrow) throw cause;
    } finally {
      item.setFurnitureInstanceBusy(false);
    }
  };

  useEffect(() => {
    if (!item.furnitureInstanceDeleteRequestId) return;
    const id = item.furnitureInstanceDeleteRequestId;
    const retryableDelete = retryableFurnitureInstanceOperation(item, () => {
      item.deleteFurnitureInstance(id);
      return `实例 ${id} 已从当前草稿删除。`;
    });
    Modal.confirm({
      title: "删除完整家具实例",
      content: `将删除实例 ${id} 的全部几何部分、类别和显式朝向证据；父级参考不会改变。`,
      okText: "删除实例",
      okType: "danger",
      cancelText: "取消",
      onOk: () => run(retryableDelete, { rethrow: true }),
      onCancel: () => item.clearFurnitureInstanceDeleteRequest(),
    });
  }, [item.furnitureInstanceDeleteRequestId]);

  if (!item.furnitureInstancesEnabled) return null;
  const parents = item.furnitureInstanceParents;
  const instances = item.furnitureInstanceLogicals;
  const focus = parents.find((parent) => parent.id === item.furnitureInstanceFocusId);
  const effectiveSelectedId = item.furnitureInstanceEffectiveSelectedId;
  const selected = instances.find((instance) => instance.id === effectiveSelectedId);
  const errors = item.furnitureInstanceErrors;
  const currentErrors = errors.filter((issue) => issue.instanceId === selected?.id);
  const reviewErrors = currentErrors.filter((issue) => issue.code === "review");
  const selectedDrawingControl = item.getToolsManager?.()?.findSelectedTool?.()?.control?.name || "";
  const activeDrawingControl =
    selectedDrawingControl === item.furnitureInstanceDrawingControl ? selectedDrawingControl : "";
  const activeOrientationControl = ORIENTATION_CONTROLS.has(activeDrawingControl) ? activeDrawingControl : "";
  const visibleErrors = currentErrors.filter(
    (issue) => issue.code !== "review" && !(activeOrientationControl && issue.code === "orientation"),
  );
  const status = state.status;
  const referenceChanged =
    status?.enabled &&
    (status.source_version !== annotation.referenceVersion || status.reference_version !== annotation.referenceVersion);
  const historical = annotation.type !== "prediction" && !!annotation.pk && !annotation.draftSelected;
  const commonDisabledReason = item.furnitureInstanceBusy
    ? "L4 操作或保存正在进行"
    : annotation.submissionStarted
      ? "正式提交正在进行"
      : annotation.isReadOnly()
        ? "当前标注为只读"
        : "";
  const drawingDisabledReason =
    annotation.isDrawing || annotation.hasIncompletePolygons ? "请先完成或取消当前绘制" : "";
  const retryDisabledReason = commonDisabledReason || drawingDisabledReason;
  const disabledReason =
    commonDisabledReason || (hasUnsavedMutation ? "请先重试保存或导出窗口备份" : drawingDisabledReason);
  const retryDisabled = Boolean(retryDisabledReason);
  const disabled = Boolean(disabledReason);

  const drawDisabledReason = (control) => {
    if (activeDrawingControl === control) return commonDisabledReason;
    return (
      disabledReason ||
      (!focus ? "请先选择 Focus 家具组团" : "") ||
      (referenceChanged ? "L3 参考有更新；请先保存、备份并手动应用" : "") ||
      item.furnitureInstanceDrawBlockReason?.(control) ||
      ""
    );
  };

  const orientationDisabledReason = (control) => {
    if (activeOrientationControl) return commonDisabledReason;
    return (
      commonDisabledReason ||
      (hasUnsavedMutation ? "请先重试保存或导出窗口备份" : "") ||
      drawingDisabledReason ||
      (!selected ? "请先选择家具实例" : "") ||
      (referenceChanged ? "L3 参考有更新；请先保存、备份并手动应用" : "") ||
      (selected?.orientationResults.length ? "该实例已有朝向证据；请先恢复 unknown" : "") ||
      item.furnitureInstanceDrawBlockReason?.(control) ||
      ""
    );
  };

  const resetDisabledReason =
    commonDisabledReason ||
    (hasUnsavedMutation ? "请先重试保存或导出窗口备份" : "") ||
    (!activeOrientationControl && drawingDisabledReason) ||
    (!selected ? "请先选择家具实例" : "") ||
    (referenceChanged ? "L3 参考有更新；请先保存、备份并手动应用" : "");

  const start = (control) => {
    setError("");
    setNotice("");
    try {
      item.setFurnitureInstanceDraft(type, note);
      item.startFurnitureInstanceTool(control);
    } catch (cause) {
      setError(cause.message || "无法开始绘制");
    }
  };

  const confirmSelected = () =>
    run(() => {
      if (!selected) throw new Error("请先选择家具实例");
      return applyFurnitureInstanceOperation(item, () => {
        item.confirmFurnitureInstanceReviews([selected.id]);
        return `实例 ${selected.id} 已记录人工复核并保存；仍需正式提交任务。`;
      });
    });

  const restoreUnknown = () =>
    run(() =>
      recoverFurnitureInstanceOrientation(item, () => {
        const changed = item.clearFurnitureInstanceOrientation(selected.id);
        return changed
          ? `实例 ${selected.id} 的朝向已恢复 unknown 并保存。`
          : `实例 ${selected.id} 已是 unknown；未产生新结果。`;
      }),
    );

  const applyReference = () =>
    Modal.confirm({
      title: "手动应用最新 L3 参考",
      content:
        "服务器会先保存当前草稿，只替换只读 L1–L3 参考。现有家具实例不会迁移；父组团变化的实例将明确标记 stale。",
      okText: "保存草稿并应用",
      cancelText: "取消",
      onOk: () => run(() => controller.applyFurnitureInstancesReference()),
    });

  const exportRecovery = () => {
    downloadJson(
      annotation.serializeAnnotation({ fast: true }),
      `task-${annotation.store.task.id}-l4-furniture-recovery-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
    setNotice("已导出当前窗口原始结果备份。");
  };

  const importFile = async (event) => {
    const selectedFile = event.target.files?.[0];
    event.target.value = "";
    if (!selectedFile) return;
    await run(async () => {
      const payload = JSON.parse(await selectedFile.text());
      const results = reimportFurnitureInstances(payload);
      return applyFurnitureInstanceOperation(item, () => {
        item.importFurnitureInstanceResults(results);
        return "家具实例已重新导入并保存当前草稿；只读父级参考未改变，请复核后提交。";
      });
    });
  };

  let orientation = activeOrientationControl ? "drawing" : "unknown";
  if (!activeOrientationControl) {
    try {
      if (selected) orientation = orientationForInstance(selected).status;
    } catch {
      orientation = "invalid";
    }
  }
  const effectiveReviewStatus = selected ? effectiveFurnitureInstanceReviewStatus(selected, currentErrors) : "";
  const reviewStatus = selected
    ? effectiveReviewStatus === "stale"
      ? "stale（父级已过期）"
      : reviewErrors.length || effectiveReviewStatus === "pending"
        ? "needs_review（待复核；保存值 pending）"
        : effectiveReviewStatus === "reviewed"
          ? "reviewed（已复核）"
          : "stale（父级已过期）"
    : "—";

  return (
    <section className={styles.dock} data-testid="furniture-instance-controls" aria-label="L4 家具实例工具">
      <div className={styles.header}>
        <strong>L4 家具实例</strong>
        <span>
          L3 参考 {referenceChanged ? "有更新" : status?.enabled ? "已应用" : "状态未就绪"} · 实例 {instances.length}
        </span>
        {referenceChanged && !historical && (
          <Button
            type="button"
            size="smaller"
            variant="neutral"
            look="outlined"
            disabled={disabled}
            tooltip={disabledReason || "保存当前草稿并显式应用最新 L3 参考"}
            aria-label="保存并手动应用 L3 更新"
            onClick={applyReference}
          >
            保存并手动应用 L3 更新
          </Button>
        )}
        <Button
          type="button"
          size="smaller"
          variant="neutral"
          look="outlined"
          aria-label="导出 L4 窗口备份"
          tooltip="导出当前窗口原始结果，不提交标注"
          onClick={exportRecovery}
        >
          导出窗口备份
        </Button>
        {hasUnsavedMutation && (
          <Button
            type="button"
            size="smaller"
            variant="warning"
            look="outlined"
            disabled={retryDisabled}
            tooltip={retryDisabledReason || "只重试保存已保留的本地修改"}
            aria-label="仅重试保存当前 L4 草稿"
            onClick={() => run(() => retryFurnitureInstanceSave(item))}
          >
            仅重试保存当前草稿
          </Button>
        )}
        <Button
          type="button"
          size="smaller"
          variant="neutral"
          look="outlined"
          disabled={disabled}
          onClick={() => run(() => downloadFurnitureInstances(annotation))}
          tooltip={disabledReason || "正式保存后的结果才具有服务器 provenance"}
          aria-label="导出家具实例"
        >
          导出家具实例
        </Button>
        <Button
          type="button"
          size="smaller"
          variant="neutral"
          look="outlined"
          disabled={disabled}
          tooltip={disabledReason || "重新导入经过校验的家具实例 JSON"}
          aria-label="重新导入家具实例"
          onClick={() => file.current?.click()}
        >
          重新导入
        </Button>
        <input ref={file} hidden type="file" accept="application/json,.json" onChange={importFile} />
      </div>

      <div className={styles.row}>
        <label>
          Focus 家具组团
          <select
            value={item.furnitureInstanceFocusId}
            disabled={disabled}
            onChange={(event) => item.setFurnitureInstanceFocus(event.target.value)}
          >
            <option value="">请选择</option>
            {parents.map((parent) => (
              <option key={parent.id} value={parent.id}>
                {GROUP_TYPES[parent.groupType] || parent.groupType} · {short(parent.id)} · 房间 {short(parent.roomId)}
              </option>
            ))}
          </select>
        </label>
        <label>
          实例类别
          <select value={type} disabled={disabled} onChange={(event) => setType(event.target.value)}>
            {Object.entries(FURNITURE_TYPES).map(([value, label]) => (
              <option key={value} value={value}>
                {label} ({value})
              </option>
            ))}
          </select>
        </label>
        <label>
          说明
          <input
            value={note}
            disabled={disabled}
            onChange={(event) => setNote(event.target.value)}
            placeholder="可选"
          />
        </label>
        <Button
          type="button"
          size="smaller"
          variant={activeDrawingControl === CONTROLS.rectangle ? "primary" : "neutral"}
          look={activeDrawingControl === CONTROLS.rectangle ? "filled" : "outlined"}
          disabled={Boolean(drawDisabledReason(CONTROLS.rectangle))}
          tooltip={drawDisabledReason(CONTROLS.rectangle) || "在当前 Focus 家具组团内绘制矩形实例"}
          aria-label="绘制矩形家具实例"
          aria-pressed={activeDrawingControl === CONTROLS.rectangle}
          onClick={() => activeDrawingControl === CONTROLS.rectangle || start(CONTROLS.rectangle)}
        >
          画矩形实例
        </Button>
        <Button
          type="button"
          size="smaller"
          variant={activeDrawingControl === CONTROLS.polygon ? "primary" : "neutral"}
          look={activeDrawingControl === CONTROLS.polygon ? "filled" : "outlined"}
          disabled={Boolean(drawDisabledReason(CONTROLS.polygon))}
          tooltip={drawDisabledReason(CONTROLS.polygon) || "在当前 Focus 家具组团内绘制多边形实例"}
          aria-label="绘制多边形家具实例"
          aria-pressed={activeDrawingControl === CONTROLS.polygon}
          onClick={() => activeDrawingControl === CONTROLS.polygon || start(CONTROLS.polygon)}
        >
          画多边形实例
        </Button>
      </div>

      <div className={styles.row}>
        <label>
          当前实例
          <select
            value={effectiveSelectedId}
            disabled={disabled}
            onChange={(event) => item.selectFurnitureInstance(event.target.value)}
          >
            <option value="">请选择</option>
            {instances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {FURNITURE_TYPES[instance.context.instance_type] || instance.context.instance_type} ·{" "}
                {short(instance.id)} · {effectiveFurnitureInstanceReviewStatus(instance, errors)}
              </option>
            ))}
          </select>
        </label>
        <span>朝向证据：{orientation}</span>
        <span>复核状态：{reviewStatus}</span>
        <Button
          type="button"
          size="smaller"
          variant={activeOrientationControl === CONTROLS.frontDirection ? "primary" : "neutral"}
          look={activeOrientationControl === CONTROLS.frontDirection ? "filled" : "outlined"}
          disabled={Boolean(orientationDisabledReason(CONTROLS.frontDirection))}
          tooltip={
            orientationDisabledReason(CONTROLS.frontDirection) ||
            (activeOrientationControl === CONTROLS.frontDirection
              ? "当前正在标注正面方向；Esc 取消"
              : "激活两点式正面方向 Vector")
          }
          aria-label="标注家具正面方向"
          aria-pressed={activeOrientationControl === CONTROLS.frontDirection}
          onClick={() => activeOrientationControl === CONTROLS.frontDirection || start(CONTROLS.frontDirection)}
        >
          标注正面方向
        </Button>
        <Button
          type="button"
          size="smaller"
          variant={activeOrientationControl === CONTROLS.frontEdge ? "primary" : "neutral"}
          look={activeOrientationControl === CONTROLS.frontEdge ? "filled" : "outlined"}
          disabled={Boolean(orientationDisabledReason(CONTROLS.frontEdge))}
          tooltip={
            orientationDisabledReason(CONTROLS.frontEdge) ||
            (activeOrientationControl === CONTROLS.frontEdge
              ? "当前正在标注正面边；Esc 取消"
              : "激活并吸附到真实家具边界的两点 Vector")
          }
          aria-label="标注家具正面边"
          aria-pressed={activeOrientationControl === CONTROLS.frontEdge}
          onClick={() => activeOrientationControl === CONTROLS.frontEdge || start(CONTROLS.frontEdge)}
        >
          标注正面边
        </Button>
        <Button
          type="button"
          size="smaller"
          variant="neutral"
          look="outlined"
          disabled={Boolean(resetDisabledReason)}
          tooltip={resetDisabledReason || "只清除当前实例的显式朝向证据和未完成草稿"}
          aria-label="将当前家具实例朝向恢复为 unknown"
          onClick={restoreUnknown}
        >
          恢复 unknown
        </Button>
        <Button
          type="button"
          size="smaller"
          variant="positive"
          look="outlined"
          disabled={disabled || !selected || referenceChanged}
          tooltip={
            disabledReason ||
            (!selected ? "请先选择家具实例" : "") ||
            (referenceChanged ? "L3 参考有更新；请先应用" : "确认当前内容已完成人工复核")
          }
          aria-label="确认当前家具实例已复核"
          onClick={confirmSelected}
        >
          已检查，确认复核
        </Button>
        <Button
          type="button"
          size="smaller"
          variant="negative"
          look="outlined"
          disabled={disabled || !selected}
          tooltip={disabledReason || (!selected ? "请先选择家具实例" : "删除当前实例的全部几何、类别和朝向")}
          aria-label="删除当前家具实例"
          onClick={() => item.requestFurnitureInstanceDelete(selected.id)}
        >
          删除实例
        </Button>
      </div>

      <div className={styles.options}>
        <label>
          <input
            type="checkbox"
            checked={item.furnitureInstanceBoundarySnap}
            onChange={(event) => item.setFurnitureInstanceSnapping("boundary", event.target.checked)}
          />
          吸附父组团边界（含孔洞边界）
        </label>
        <label>
          <input
            type="checkbox"
            checked={item.furnitureInstancePixelSnap}
            onChange={(event) => item.setFurnitureInstanceSnapping("pixel", event.target.checked)}
          />
          原图像素吸附
        </label>
      </div>

      {(item.furnitureInstanceEditNotice || notice) && (
        <p role="status">{item.furnitureInstanceEditNotice || notice}</p>
      )}
      {(error || state.error) && (
        <p className={styles.error} role="alert">
          {error || state.error}
        </p>
      )}
      {!!visibleErrors.length && (
        <details className={styles.errors} open>
          <summary>当前实例需处理 {visibleErrors.length} 项</summary>
          <ul>
            {visibleErrors.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>{issue.message}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
});
