import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { Modal } from "antd";

import { GROUP_TYPES } from "../occupancy/domain";
import { downloadJson } from "../occupancy/download";
import { CONTROLS, FURNITURE_TYPES } from "./domain";
import { orientationForInstance } from "./constraints";
import { downloadFurnitureInstances, reimportFurnitureInstances } from "./download";
import {
  applyFurnitureInstanceOperation,
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
  const status = state.status;
  const referenceChanged =
    status?.enabled &&
    (status.source_version !== annotation.referenceVersion || status.reference_version !== annotation.referenceVersion);
  const historical = annotation.type !== "prediction" && !!annotation.pk && !annotation.draftSelected;
  const retryDisabled =
    item.furnitureInstanceBusy ||
    annotation.isDrawing ||
    annotation.hasIncompletePolygons ||
    !!annotation.submissionStarted ||
    annotation.isReadOnly();
  const disabled = retryDisabled || hasUnsavedMutation;

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

  let orientation = "unknown";
  try {
    if (selected) orientation = orientationForInstance(selected).status;
  } catch {
    orientation = "invalid";
  }

  return (
    <section className={styles.dock} data-testid="furniture-instance-controls" aria-label="L4 家具实例工具">
      <div className={styles.header}>
        <strong>L4 家具实例</strong>
        <span>
          L3 参考 {referenceChanged ? "有更新" : status?.enabled ? "已应用" : "状态未就绪"} · 实例 {instances.length}
        </span>
        {referenceChanged && !historical && (
          <button type="button" disabled={disabled} onClick={applyReference}>
            保存并手动应用 L3 更新
          </button>
        )}
        <button type="button" onClick={exportRecovery}>
          导出窗口备份
        </button>
        {hasUnsavedMutation && (
          <button type="button" disabled={retryDisabled} onClick={() => run(() => retryFurnitureInstanceSave(item))}>
            仅重试保存当前草稿
          </button>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={() => run(() => downloadFurnitureInstances(annotation))}
          title="正式保存后的结果才具有服务器 provenance"
        >
          导出家具实例
        </button>
        <button type="button" disabled={disabled} onClick={() => file.current?.click()}>
          重新导入
        </button>
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
        <button
          type="button"
          disabled={disabled || !focus || referenceChanged}
          onClick={() => start(CONTROLS.rectangle)}
        >
          画矩形实例
        </button>
        <button type="button" disabled={disabled || !focus || referenceChanged} onClick={() => start(CONTROLS.polygon)}>
          画多边形实例
        </button>
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
                {short(instance.id)} · {instance.context.review_status}
              </option>
            ))}
          </select>
        </label>
        <span>朝向证据：{orientation}</span>
        <button
          type="button"
          disabled={disabled || !selected || !!selected.orientationResults.length || referenceChanged}
          onClick={() => start(CONTROLS.frontDirection)}
        >
          标注正面方向
        </button>
        <button
          type="button"
          disabled={disabled || !selected || !!selected.orientationResults.length || referenceChanged}
          onClick={() => start(CONTROLS.frontEdge)}
        >
          标注正面边
        </button>
        <button
          type="button"
          disabled={disabled || !selected?.orientationResults.length || referenceChanged}
          onClick={() => {
            const retryableClear = retryableFurnitureInstanceOperation(item, () => {
              item.clearFurnitureInstanceOrientation(selected.id);
              return `实例 ${selected.id} 的朝向已恢复 unknown 并保存。`;
            });
            Modal.confirm({
              title: "删除显式朝向证据",
              content: "实例几何和类别将保留，orientation 会恢复为 unknown 并要求重新复核。",
              okText: "删除朝向证据",
              cancelText: "取消",
              onOk: () => run(retryableClear, { rethrow: true }),
            });
          }}
        >
          恢复 unknown
        </button>
        <button type="button" disabled={disabled || !selected || referenceChanged} onClick={confirmSelected}>
          已检查，确认复核
        </button>
        <button
          type="button"
          disabled={disabled || !selected}
          onClick={() => item.requestFurnitureInstanceDelete(selected.id)}
        >
          删除实例
        </button>
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
      {!!currentErrors.length && (
        <details className={styles.errors} open>
          <summary>当前实例需处理 {currentErrors.length} 项</summary>
          <ul>
            {currentErrors.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>{issue.message}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
});
