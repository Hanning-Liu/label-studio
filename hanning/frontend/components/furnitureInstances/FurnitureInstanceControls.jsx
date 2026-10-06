import { CreateFurnitureCategory } from "./CreateFurnitureCategory";
import { furnitureNameExists, normalizeFurnitureName } from "@hanning/frontend/domain/catalog";
import { useEffect, useId, useRef, useState } from "react";
import { observer } from "mobx-react";
import { Modal, Popover, Tooltip } from "antd";
import { Button } from "@humansignal/ui";
import catalogDetails from "@hanning/frontend/domain/catalogDetails";
import { useFurnitureReviewSession } from "@hanning/frontend/domain/furnitureInstances/reviewSession";
import { furnitureParentUpdate } from "@hanning/frontend/domain/furnitureInstances/parentUpdate";
import { FurnitureGeometryControls } from "@hanning/frontend/components/furnitureInstances/FurnitureGeometryControls";

import { downloadJson } from "@hanning/frontend/domain/occupancy/download";
import { CONTROLS, FURNITURE_TYPES, ORIENTATION_CONTROLS } from "@hanning/frontend/domain/furnitureInstances/domain";
import { orientationForInstance } from "@hanning/frontend/domain/furnitureInstances/constraints";
import {
  downloadFurnitureInstances,
  reimportFurnitureInstances,
} from "@hanning/frontend/domain/furnitureInstances/download";
import { effectiveFurnitureInstanceReviewStatus } from "@hanning/frontend/components/furnitureInstances/FurnitureInstanceOutliner";
import {
  applyFurnitureInstanceOperation,
  recoverFurnitureInstanceOrientation,
  retryableFurnitureInstanceOperation,
} from "@hanning/frontend/domain/furnitureInstances/operations";
import styles from "@hanning/frontend/components/furnitureInstances/FurnitureInstanceControls.module.scss";
import {
  FURNITURE_TYPE_GROUPS,
  furnitureParentIdentity,
  shortFurnitureId,
} from "@hanning/frontend/domain/furnitureInstances/presentation";

export const FurnitureInstanceControls = observer(({ item, placement = "toolbar" }) => {
  const [menu, setMenu] = useState("");
  const [search, setSearch] = useState("");
  const [createName, setCreateName] = useState("");
  useEffect(() => {
    const key = `hanning-new-furniture-category:${window.location.pathname}`;
    const created = sessionStorage.getItem(key);
    if (created && item.furnitureInstanceAvailableTypes.includes(created)) {
      item.setFurnitureInstanceDraft(created, item.furnitureInstanceNote || "");
      sessionStorage.removeItem(key);
    }
  }, [item.annotation]);
  const categoryHelpId = useId();
  const annotation = item.annotation;
  const review = useFurnitureReviewSession(item);
  const controller = annotation.store.referenceSyncController;
  const [state, setState] = useState(controller?.state || {});
  const type = item.furnitureInstanceDraftType;
  const availableTypes = item.furnitureInstanceAvailableTypes;
  const [editType, setEditType] = useState("");
  const [note, setNote] = useState(item.furnitureInstanceNote);
  const error = review.error;
  const notice = review.notice;
  const hasUnsavedMutation = review.unsaved;
  const setError = (value) => review.setError(value);
  const setNotice = (value) => review.setNotice(value);
  const file = useRef(null);
  const selectedId = item.furnitureInstanceEffectiveSelectedId;
  const selectedType = item.furnitureInstanceLogicals.find((instance) => instance.id === selectedId)?.context
    .instance_type;
  useEffect(() => setEditType(selectedType || ""), [selectedId, selectedType]);

  useEffect(() => {
    setState(controller?.state || {});
    return controller?.subscribe(setState);
  }, [controller]);

  useEffect(() => {
    setMenu("");
    setNote(item.furnitureInstanceNote || "");
  }, [annotation]);
  useEffect(() => {
    const close = (event) => {
      if (event.key === "Escape") setMenu("");
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, []);

  const run = review.run;

  useEffect(() => {
    if (placement !== "toolbar" || !item.furnitureInstanceDeleteRequestId) return;
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
      onOk: () => run(retryableDelete, { rethrow: true, retry: true }),
      onCancel: () => item.clearFurnitureInstanceDeleteRequest(),
    });
  }, [item.furnitureInstanceDeleteRequestId]);

  if (!item.furnitureInstancesEnabled) return null;
  const parents = item.furnitureInstanceParents;
  const instances = item.furnitureInstanceLogicals;
  const focus = parents.find((parent) => parent.id === item.furnitureInstanceFocusId);
  const effectiveSelectedId = item.furnitureInstanceEffectiveSelectedId;
  const selected = instances.find((instance) => instance.id === effectiveSelectedId);
  const focusIdentity = furnitureParentIdentity(focus, item.furnitureInstanceData);
  const errors = item.furnitureInstanceErrors;
  const currentErrors = errors.filter((issue) => issue.instanceId === selected?.id);
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

  const confirmSelected = () => review.confirm(selected ? [selected.id] : []);

  const applyCategory = () =>
    run(() =>
      applyFurnitureInstanceOperation(item, () => {
        if (!selected) throw new Error("请先选择家具实例");
        item.setFurnitureInstanceCategory(selected.id, editType);
        return "当前实例类别已保存，请重新确认复核后提交。";
      }),
    );

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

  const copySelected = async () => {
    let created;
    await run(() =>
      applyFurnitureInstanceOperation(item, () => {
        if (item.furnitureInstanceEffectiveSelectedId !== selected?.id)
          throw new Error("所选实例已改变，请重新选择后复制");
        created = item.duplicateFurnitureInstance(selected.id);
        return created.offset.some(Boolean)
          ? "已复制并保存草稿；副本已选中，可直接拖动，之后请重新复核。"
          : "已原地复制并保存；边界没有偏移空间，副本已选中，可直接拖动。";
      }),
    );
    // run releases the busy guard even after a recoverable post-save failure.
    if (created) item.selectFurnitureInstance(created.id);
  };

  const orientationEnabled = item.furnitureInstanceOrientationEnabled;
  let orientation = activeOrientationControl ? "drawing" : "unknown";
  if (orientationEnabled && !activeOrientationControl) {
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
      : review.selectedRow?.status === "pending"
        ? "needs_review（待复核；保存值 pending）"
        : review.selectedRow?.status === "reviewed"
          ? review.pending?.ids.includes(selected.id) && (review.busy || review.unsaved)
            ? "确认待保存"
            : "reviewed（已复核）"
          : "需处理（请检查实例问题）"
    : "—";
  let parentUpdateReason = disabledReason || review.blockReason;
  if (selected && effectiveReviewStatus === "stale" && !parentUpdateReason) {
    try {
      furnitureParentUpdate(item.furnitureInstanceData, item.furnitureInstanceData, selected.id);
    } catch (cause) {
      parentUpdateReason = cause.message || "请先处理当前实例的校验问题";
    }
  }

  const popup = (key, label, content) => (
    <Popover
      trigger="click"
      placement="bottomLeft"
      visible={menu === key}
      onVisibleChange={(visible) => {
        setMenu(visible ? key : "");
        if (visible) setSearch("");
      }}
      destroyTooltipOnHide
      content={
        <div
          className={styles.popup}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setMenu("");
            }
          }}
        >
          {content}
        </div>
      }
    >
      <Button type="button" size="smaller" aria-expanded={menu === key}>
        {label}
      </Button>
    </Popover>
  );
  return (
    <section
      className={placement === "details" ? styles.instanceProperties : styles.dock}
      data-testid={placement === "details" ? "furniture-instance-properties" : "furniture-instance-controls"}
      aria-label={placement === "details" ? "L4 当前实例属性" : "L4 家具实例工具"}
    >
      {placement === "toolbar" ? (
        <>
          {createName && (
            <CreateFurnitureCategory
              item={item}
              name={createName}
              onClose={() => setCreateName("")}
              onCreated={(entry) => {
                sessionStorage.setItem(`hanning-new-furniture-category:${window.location.pathname}`, entry.id);
                window.location.reload();
              }}
            />
          )}
          <div className={styles.toolbarRow}>
            <strong>L4</strong>
            {popup(
              "category",
              `新建：${FURNITURE_TYPES[type] || "选择类别"} ▾`,
              <>
                <label className={styles.search}>
                  搜索家具类别
                  <input
                    autoFocus
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="搜索名称；输入新名称可创建类别"
                  />
                </label>
                {normalizeFurnitureName(search) && !furnitureNameExists(search) && (
                  <Button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setCreateName(normalizeFurnitureName(search));
                      setMenu("");
                    }}
                  >
                    创建“{normalizeFurnitureName(search)}”类别
                  </Button>
                )}
                <fieldset className={styles.palette} disabled={disabled}>
                  <legend>待绘制实例类别</legend>
                  {FURNITURE_TYPE_GROUPS.map((group) => ({
                    ...group,
                    types: group.types.filter((value) =>
                      `${FURNITURE_TYPES[value]} ${value} ${catalogDetails[value].aliases.join(" ")}`
                        .toLowerCase()
                        .includes(search.trim().toLowerCase()),
                    ),
                  }))
                    .filter((group) => group.types.length)
                    .map((group) => (
                      <section key={group.name} className={styles.paletteGroup} aria-label={group.name}>
                        <strong style={{ "--furniture-type-color": group.color }}>{group.name}</strong>
                        <div>
                          {group.types.map((value) => {
                            const selectedType = type === value;
                            const unavailable = !availableTypes.includes(value);
                            const helpId = `${categoryHelpId}-${value}`;
                            const description = unavailable
                              ? "当前项目尚未启用此类别，请先升级配置"
                              : `${catalogDetails[value].definition} 别称：${catalogDetails[value].aliases.join("、")}；易混淆：${catalogDetails[value].confusable.map((type) => FURNITURE_TYPES[type]).join("、")}`;
                            return (
                              <Tooltip key={value} id={helpId} title={description} trigger={["hover", "focus"]}>
                                <span
                                  className={styles.typeHint}
                                  tabIndex={unavailable ? 0 : undefined}
                                  aria-label={unavailable ? `${FURNITURE_TYPES[value]}：${description}` : undefined}
                                  aria-describedby={helpId}
                                >
                                  <button
                                    key={value}
                                    type="button"
                                    className={selectedType ? styles.typeSelected : styles.typeButton}
                                    style={{
                                      "--furniture-type-color": group.color,
                                    }}
                                    aria-label={`${FURNITURE_TYPES[value]} (${value})`}
                                    aria-pressed={selectedType}
                                    aria-describedby={helpId}
                                    disabled={unavailable}
                                    title={
                                      !availableTypes.includes(value)
                                        ? "当前项目尚未启用此类别，请先升级配置"
                                        : `${FURNITURE_TYPES[value]} (${value})`
                                    }
                                    onClick={() => {
                                      item.setFurnitureInstanceDraft(value, note);
                                      setMenu("");
                                    }}
                                  >
                                    <span aria-hidden="true">{selectedType ? "✓" : ""}</span>
                                    {FURNITURE_TYPES[value]}
                                  </button>
                                </span>
                              </Tooltip>
                            );
                          })}
                        </div>
                      </section>
                    ))}
                </fieldset>
              </>,
            )}
            {item.furnitureInstanceScope &&
              popup(
                "create",
                "创建方式 ▾",
                <FurnitureGeometryControls item={item} mode="create" onCreated={() => setMenu("")} />,
              )}
            <Button
              type="button"
              size="smaller"
              aria-label="复制当前家具实例"
              disabled={
                disabled ||
                !selected ||
                referenceChanged ||
                effectiveReviewStatus === "stale" ||
                !!item.furnitureInstanceGeometryPreview ||
                !!item.furnitureInstanceTransformCandidate
              }
              tooltip={disabledReason || "复制完整实例并稍微偏移，自动选中副本供拖动"}
              onClick={copySelected}
            >
              复制实例
            </Button>
            <div className={styles.options}>
              <label>
                <input
                  type="checkbox"
                  checked={item.furnitureInstanceBoundarySnap}
                  onChange={(event) => item.setFurnitureInstanceSnapping("boundary", event.target.checked)}
                />
                边界吸附
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={item.furnitureInstancePixelSnap}
                  onChange={(event) => item.setFurnitureInstanceSnapping("pixel", event.target.checked)}
                />
                像素吸附
              </label>
            </div>

            {popup(
              "more",
              "更多 ▾",
              <div className={styles.moreMenu}>
                <div className={styles.row}>
                  {" "}
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
                <label>
                  <input
                    type="checkbox"
                    checked={item.furnitureInstanceShowAllNames}
                    onChange={(event) => item.setFurnitureInstanceShowAllNames(event.target.checked)}
                  />
                  全图名称
                </label>
                {!focus && <span>请用 Move 选择 Focus 家具组团以显示组内名称。</span>}
                <section className={styles.statusCard} aria-label="当前 Focus 家具组团">
                  <strong>Focus 家具组团</strong>
                  {focusIdentity ? (
                    <span>
                      {focusIdentity.groupType} · {focusIdentity.note} · 房间 {focusIdentity.room} · 分区{" "}
                      {focusIdentity.zone} · {focusIdentity.id}
                    </span>
                  ) : (
                    <span>未选择；请先选择房间与功能分区，再使用 Move 点击橙色家具组团</span>
                  )}
                </section>
                <label>
                  待绘制实例说明
                  <input
                    value={note}
                    disabled={disabled || !type}
                    onChange={(event) => {
                      setNote(event.target.value);
                      item.setFurnitureInstanceDraft(type, event.target.value);
                    }}
                    placeholder="可选"
                  />
                </label>

                <span>
                  L3 参考 {referenceChanged ? "有更新" : status?.enabled ? "已应用" : "状态未就绪"} · 实例{" "}
                  {instances.length}
                </span>
              </div>,
            )}
          </div>
          <div className={styles.alerts}>
            {" "}
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
            {hasUnsavedMutation && (
              <Button
                type="button"
                size="smaller"
                variant="warning"
                look="outlined"
                disabled={retryDisabled}
                tooltip={retryDisabledReason || "只重试保存已保留的本地修改"}
                aria-label="仅重试保存当前 L4 草稿"
                onClick={review.retry}
              >
                仅重试保存当前草稿
              </Button>
            )}
          </div>
          {selected && !!visibleErrors.length && (
            <span className={styles.error}>当前实例需处理 {visibleErrors.length} 项，请查看右侧属性。</span>
          )}
        </>
      ) : (
        <>
          <div className={styles.row}>
            <section className={styles.statusCard} aria-label="当前家具实例">
              <strong>当前实例</strong>
              {selected ? (
                <span>
                  {FURNITURE_TYPES[selected.context.instance_type] || selected.context.instance_type} ·{" "}
                  {shortFurnitureId(selected.id)} · 父级 {shortFurnitureId(selected.context.room_id)} →{" "}
                  {shortFurnitureId(selected.context.zone_id)} → {shortFurnitureId(selected.context.group_id)} ·{" "}
                  {reviewStatus}
                </span>
              ) : (
                <span>未选择；请使用 Move 工具在画布点击家具实例</span>
              )}
            </section>
            {orientationEnabled && <span>朝向证据：{orientation}</span>}
            <label>
              当前实例类别
              <select
                aria-label="当前实例类别"
                value={editType}
                disabled={disabled || !selected || referenceChanged}
                onChange={(event) => setEditType(event.target.value)}
              >
                {!availableTypes.includes(editType) && (
                  <option value={editType}>{FURNITURE_TYPES[editType] || editType || "请选择实例"}</option>
                )}
                {availableTypes.map((value) => (
                  <option key={value} value={value}>
                    {FURNITURE_TYPES[value]}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="button"
              size="smaller"
              aria-label="应用当前实例类别"
              disabled={
                disabled ||
                !selected ||
                referenceChanged ||
                editType === selected?.context.instance_type ||
                !availableTypes.includes(editType)
              }
              onClick={applyCategory}
            >
              应用类别
            </Button>
            <span>复核状态：{reviewStatus}</span>
            {effectiveReviewStatus === "stale" && (
              <Button
                type="button"
                size="smaller"
                variant="primary"
                look="outlined"
                disabled={Boolean(parentUpdateReason)}
                tooltip={parentUpdateReason || "保留当前实例和原父级关系，接受更新后仍需确认复核"}
                onClick={() => review.acceptParentUpdate(selected.id)}
              >
                检查并接受父组团更新
              </Button>
            )}
            {orientationEnabled && (
              <>
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
              </>
            )}
            <Button
              type="button"
              size="smaller"
              variant="positive"
              look="outlined"
              disabled={
                disabled ||
                !selected ||
                referenceChanged ||
                review.selectedRow?.status !== "pending" ||
                !!review.blockReason
              }
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

          {effectiveReviewStatus === "stale" && (
            <p role="note">
              {parentUpdateReason ||
                "请检查当前实例仍属于原家具组团且符合新边界，再接受父组团更新。接受后转为待复核，实例 ID、几何和方向证据保留。"}
            </p>
          )}

          {item.furnitureInstanceScope && (
            <details className={styles.fineAdjustment} open={item.furnitureInstanceGeometryPreview ? true : undefined}>
              <summary>精细调整</summary>
              <FurnitureGeometryControls item={item} mode="edit" />
            </details>
          )}
        </>
      )}
      {placement === "toolbar" && (item.furnitureInstanceEditNotice || notice) && (
        <p role="status" title={item.furnitureInstanceEditNotice || notice}>
          {item.furnitureInstanceEditNotice || notice}
        </p>
      )}
      {placement === "toolbar" && (error || state.error) && (
        <p className={styles.error} role="alert">
          {error || state.error}
        </p>
      )}
      {placement === "details" && !!visibleErrors.length && (
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
