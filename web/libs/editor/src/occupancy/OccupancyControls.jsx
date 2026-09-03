import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { Modal, Select } from "antd";
import {
  confirmParents,
  deleteLogicalRegion,
  generateWalkableArea,
  GROUP_TYPES,
  logicalExport,
  OCCUPANCY_GENERATION_BLOCKED,
  reclassifyGroup,
  TYPES,
} from "./domain";
import { applyOccupancyOperation, applyOccupancyPreview } from "./operations";
import { focusOccupancy } from "./focus";
import { COLORS, pathData } from "./OccupancyLayer";
import { cacheOccupancyRecovery, downloadJson, exportOccupancyRecovery } from "./download";
import { ParentIdentity } from "./OccupancyPresentation";
import { referenceSourcePath, referenceState, shortReferenceVersion } from "./referencePresentation";
import { groupReviewIssues, presentGenerationIssues, presentOccupancyIssue } from "./validationPresentation";
import styles from "./OccupancyControls.module.scss";
import { BARRIER_CONTROL } from "./barriers";

const DIALOG_TITLES = {
  reference: "L2 参考来源与更新",
  more: "恢复文件、数据导出与高级操作",
  group: "创建家具组团",
  groupPreview: "预览当前功能分区的家具组团",
  delete: "删除 L3 区域",
  review: "复核与问题",
};

export function downloadOccupancy(item) {
  const data = logicalExport(item.occupancyData, item.annotation.referenceVersion);
  downloadJson(data, `task-${item.annotation.store.task.id}-l3-multipolygon.json`);
}

function PreviewGeometry({ parent, geometry }) {
  const sx = (parent?.result.original_width || 100) / 100;
  const sy = (parent?.result.original_height || 100) / 100;
  const points = (parent?.geometry || geometry).flat(2);
  const xs = points.map(([x]) => x * sx),
    ys = points.map(([, y]) => y * sy);
  const left = Math.min(...xs),
    top = Math.min(...ys);
  const width = Math.max(...xs) - left,
    height = Math.max(...ys) - top;
  const pad = Math.max(width, height) * 0.06;
  return (
    <svg
      className={styles.preview}
      viewBox={`${left - pad} ${top - pad} ${width + 2 * pad} ${height + 2 * pad}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <path
        d={pathData(parent?.geometry || [], sx, sy)}
        fill="#e5ece8"
        stroke="#718479"
        strokeWidth={Math.max(width, height) / 300}
      />
      <path
        d={pathData(geometry, sx, sy)}
        fill="#42aa9170"
        stroke="#237957"
        strokeWidth={Math.max(width, height) / 250}
        fillRule="evenodd"
      />
    </svg>
  );
}

function OccupancyOverview({ parent, regions }) {
  if (!parent) return null;
  const sx = (parent.result.original_width || 100) / 100;
  const sy = (parent.result.original_height || 100) / 100;
  const points = parent.geometry.flat(2);
  const xs = points.map(([x]) => x * sx);
  const ys = points.map(([, y]) => y * sy);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const width = Math.max(...xs) - left;
  const height = Math.max(...ys) - top;
  const pad = Math.max(width, height) * 0.06;
  return (
    <svg
      className={styles.preview}
      viewBox={`${left - pad} ${top - pad} ${width + 2 * pad} ${height + 2 * pad}`}
      preserveAspectRatio="xMidYMid meet"
      aria-label="当前功能分区组团与可通行区域预览"
    >
      <path
        d={pathData(parent.geometry, sx, sy)}
        fill="#f5f7f6"
        stroke="#516159"
        strokeWidth={Math.max(width, height) / 260}
        fillRule="evenodd"
      />
      {regions.map((region) => {
        const [x, y] = region.geometry[0]?.[0]?.[0] || [0, 0];
        return (
          <g key={region.id}>
            <path
              d={pathData(region.geometry, sx, sy)}
              fill={COLORS[region.type]}
              fillOpacity="0.32"
              stroke={COLORS[region.type]}
              strokeWidth={Math.max(width, height) / 320}
              fillRule="evenodd"
            />
            <text x={x * sx} y={y * sy} fill={COLORS[region.type]} fontSize={Math.max(width, height) / 35}>
              {region.type === "furniture_group" ? GROUP_TYPES[region.context.group_type] : TYPES[region.type]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function GroupEditor({ region, disabled, onLocate, onReclassify }) {
  const [groupType, setGroupType] = useState(region.context.group_type);
  const [groupNote, setGroupNote] = useState(region.context.group_note || "");
  useEffect(() => {
    setGroupType(region.context.group_type);
    setGroupNote(region.context.group_note || "");
  }, [region.id, region.context.group_type, region.context.group_note]);
  const invalidOther = groupType === "other" && !groupNote.trim();
  const changed = groupType !== region.context.group_type || groupNote !== (region.context.group_note || "");
  return (
    <div className={styles.item}>
      <div className={styles.row}>
        <span className={styles.typeSwatch} style={{ backgroundColor: COLORS.furniture_group }} aria-hidden="true" />
        <strong>{GROUP_TYPES[region.context.group_type]}</strong>
        <span className={styles.small}>{region.id}</span>
        <button disabled={disabled} onClick={() => onLocate(region)}>
          定位
        </button>
      </div>
      <div className={styles.row}>
        <select
          aria-label={`重新分类组团 ${region.id}`}
          value={groupType}
          onChange={(e) => setGroupType(e.target.value)}
        >
          {Object.entries(GROUP_TYPES).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <input
          aria-label={`组团说明 ${region.id}`}
          value={groupNote}
          onChange={(e) => setGroupNote(e.target.value)}
          placeholder={groupType === "other" ? "其他类型必须填写说明" : "组团说明（可选）"}
        />
        <button
          disabled={disabled || !changed || invalidOther}
          onClick={() => onReclassify(region, groupType, groupNote)}
        >
          更新分类
        </button>
      </div>
      {invalidOther && <small className={styles.error}>“其他”类型必须填写说明。</small>}
    </div>
  );
}

function GenerationIssuePanel({ issues, parents, logicals, disabled, onLocate, onOpenReview }) {
  const presentations = presentGenerationIssues(issues, parents, logicals);

  if (!presentations.length) return null;
  return (
    <section className={styles.generationIssues} role="alert" aria-label="无法生成可通行区域的具体原因">
      <div className={styles.generationIssueHeader}>
        <strong>暂时无法生成可通行区域：需要处理 {presentations.length} 项问题</strong>
        <span>下面只列出当前 Focus 功能分区的阻断项，现有家具组团没有被修改。</span>
      </div>
      <ol className={styles.generationIssueList}>
        {presentations.map((presentation, index) => (
          <li key={`${presentation.issue.code}-${presentation.object.id}-${presentation.related?.id || index}`}>
            <div className={styles.generationIssueBody}>
              <strong>{presentation.title}</strong>
              <span>{presentation.detail}</span>
              <small>处理方式：{presentation.action}</small>
            </div>
            <div className={styles.generationIssueActions}>
              {presentation.region && (
                <button disabled={disabled} onClick={() => onLocate(presentation.region)}>
                  定位“{presentation.object.label}”
                </button>
              )}
              {presentation.relatedRegion && (
                <button disabled={disabled} onClick={() => onLocate(presentation.relatedRegion)}>
                  定位“{presentation.related.label}”
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
      <button disabled={disabled} onClick={onOpenReview}>
        打开“复核与问题”，只看当前功能分区
      </button>
    </section>
  );
}

export const OccupancyControls = observer(({ item }) => {
  const annotation = item.annotation,
    controller = annotation.store.referenceSyncController;
  const [state, setState] = useState(controller?.state || {}),
    [dialog, setDialog] = useState(null),
    [preview, setPreview] = useState(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [type, setType] = useState("sleeping"),
    [note, setNote] = useState("");
  const [generationIssues, setGenerationIssues] = useState([]);
  const [rebind, setRebind] = useState("");
  const [reviewParentId, setReviewParentId] = useState("");
  const [referenceBackupFingerprint, setReferenceBackupFingerprint] = useState("");
  const running = useRef(false);
  useEffect(() => {
    setState(controller?.state || {});
    return controller?.subscribe(setState);
  }, [controller]);
  useEffect(() => {
    setReferenceBackupFingerprint("");
  }, [state.status?.source_version, annotation.referenceVersion]);
  useEffect(() => {
    const upgraded = item.upgradeLegacyOccupancy();
    if (upgraded) setNotice(`已将 ${upgraded} 个旧版待应用家具轮廓恢复为可编辑草稿；请保存草稿。`);
  }, [item, annotation]);
  useEffect(() => {
    if (!item.occupancyDeleteRequestId) return;
    setError("");
    setDialog("delete");
  }, [item.occupancyDeleteRequestId]);
  useEffect(() => {
    setGenerationIssues([]);
  }, [item.occupancyFocusId]);
  if (!item.occupancyEnabled) return null;
  const parent = item.occupancyParents.find((p) => p.id === item.occupancyFocusId);
  const logicals = item.occupancyLogicals.filter((r) => r.context.parent_zone_id === item.occupancyFocusId);
  const groups = logicals.filter((r) => r.type === "furniture_group");
  const focusBarriers = item.occupancyBarriers.filter((barrier) => barrier.context.parent_zone_id === item.occupancyFocusId);
  const matchedBarrierPairs = focusBarriers.reduce((count, barrier) => count + (barrier.context.matched_pairs?.length || 0), 0);
  const generatedWalkable = logicals.filter((r) => r.type === "walkable" && r.context.generation === "remainder");
  const errors = item.occupancyErrors,
    status = state.status;
  const refChanged =
    !!status &&
    (status.source_version !== annotation.referenceVersion || status.reference_version !== annotation.referenceVersion);
  const referenceStatus = referenceState(status, refChanged);
  const referenceBackupReady =
    !!referenceBackupFingerprint && referenceBackupFingerprint === annotation.draftResultFingerprint;
  const busy = item.occupancyBusy || !!annotation.submissionStarted;
  const drawing = annotation.isDrawing || annotation.hasIncompletePolygons;
  const disabled = busy || drawing || annotation.isReadOnly();
  const activePart = item.regs.find((region) => region.cleanId === item.occupancyActivePartId);
  const activePolygon = activePart?.type === "polygonregion" && activePart.occupancyVertexEditing ? activePart : null;
  const selectedPoint = activePolygon?.selectedPoint;
  const deleteLogical = item.occupancyLogicals.find((region) => region.id === item.occupancyDeleteRequestId);
  const deleteParent = item.occupancyParents.find(
    (candidate) => candidate.id === deleteLogical?.context.parent_zone_id,
  );
  const deletePartIds = new Set(deleteLogical?.parts.map((part) => part.id) || []);
  const deleteRelationCount = item.occupancyData.filter(
    (result) => result.type === "relation" && (deletePartIds.has(result.from_id) || deletePartIds.has(result.to_id)),
  ).length;
  const run = async (operation) => {
    if (running.current) return;
    running.current = true;
    item.setOccupancyBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (e) {
      if (e.code === OCCUPANCY_GENERATION_BLOCKED && Array.isArray(e.issues)) {
        setGenerationIssues(e.issues);
        setError(`无法生成可通行区域：当前功能分区有 ${e.issues.length} 项需要处理。`);
      } else {
        setError(e.message || "操作失败，本地内容已保留");
      }
    } finally {
      running.current = false;
      item.setOccupancyBusy(false);
    }
  };
  const prepare = (title, make, geometry) => {
    try {
      item.refreshOccupancyReviews();
      const reason = item.occupancyOperationBlockReason();
      if (reason) throw new Error(reason);
      const fingerprint = item.occupancyOperationFingerprint();
      const next = make(item.occupancyData);
      setPreview({
        title,
        results: next.results || next,
        geometry: next.geometry || geometry,
        fingerprint,
        clipped: next.clipped,
        unchanged: next.unchanged,
      });
      setError("");
      setDialog("preview");
    } catch (e) {
      setError(e.message);
    }
  };
  const apply = () =>
    run(async () => {
      await applyOccupancyPreview(item, preview, cacheOccupancyRecovery);
      setDialog(null);
      setPreview(null);
      setNotice("已应用并保存草稿；可以一次撤销，未提交任务。");
    });
  const execute = (makeResults, { backupName = null, success = "修改已写入并保存草稿。" } = {}) =>
    run(async () => {
      const operation = await applyOccupancyOperation(item, makeResults, cacheOccupancyRecovery, { backupName });
      setNotice(typeof success === "function" ? success(operation) : success);
    });
  const locate = (r, geometry = r.geometry) => {
    item.selectOccupancyLogical(r.id);
    setDialog(null);
    run(() => focusOccupancy(item, geometry));
  };
  const locateBarrier = (barrier) => {
    const region = item.regs.find((candidate) => candidate.cleanId === barrier.id);
    if (!region) {
      setError("隔墙对象已不存在，请重新打开复核窗口");
      return;
    }
    if (barrier.context.parent_zone_id) item.setOccupancyFocus(barrier.context.parent_zone_id);
    item.annotation.unselectAreas();
    item.annotation.selectAreas([region]);
    setDialog(null);
    const points = (barrier.result.value?.vertices || []).map((vertex) => [vertex.x, vertex.y]);
    if (points.length === 2) run(() => focusOccupancy(item, [[points]]));
  };
  const generate = () => {
    setGenerationIssues([]);
    return execute((data) => generateWalkableArea(data, parent?.id, annotation.referenceVersion), {
      backupName: "before-l3-walkable-generation",
      success: (operation) =>
        operation.unchanged
          ? "家具与父分区未变化，可通行区域已经是最新结果。"
          : `已生成 ${operation.count} 个可通行区域并保存草稿；当前父分区需要重新复核。`,
    });
  };
  const confirm = (ids) =>
    prepare(`已检查，确认 ${ids.length} 个父分区（不代表系统自动判断通行性）`, (data) =>
      confirmParents(data, ids, annotation.referenceVersion),
    );
  const setGroup = () => {
    try {
      item.createOccupancyGroup(type, note);
      setDialog(null);
      setNotice("已创建当前组团，请使用 Rectangle 或 Polygon 绘制障碍占地。");
    } catch (e) {
      setError(e.message);
    }
  };
  const mutateGroup = (r, groupType, groupNote) => {
    setGenerationIssues([]);
    return execute((data) => reclassifyGroup(data, r.id, groupType, groupNote), {
      success: `已将组团重新分类为“${GROUP_TYPES[groupType]}”；已有自动可通行区域需要重新生成。`,
    });
  };
  const removeRequestedLogical = () => {
    const requestedId = item.occupancyDeleteRequestId;

    return run(async () => {
      try {
        const operation = await applyOccupancyOperation(
          item,
          (data) => deleteLogicalRegion(data, requestedId),
          cacheOccupancyRecovery,
          { backupName: "before-l3-logical-delete" },
        );
        item.clearOccupancyDeleteRequest();
        setDialog(null);
        setNotice(
          `已删除 ${operation.deletedParts} 个存储轮廓及其配对类别并保存草稿；当前父分区需要重新生成可通行区域并复核。`,
        );
      } catch (operationError) {
        // A post-write save failure intentionally keeps the local deletion. In
        // that case close the now-stale confirmation, while run() exposes the
        // explicit unsaved error in the frozen toolbar.
        if (!item.occupancyLogicals.some((region) => region.id === requestedId)) {
          item.clearOccupancyDeleteRequest();
          setDialog(null);
        }
        throw operationError;
      }
    });
  };
  const canConfirm = item.occupancyParents.filter(
    (p) => !errors.some((e) => e.parentId === p.id && e.code !== "review"),
  );
  const reviewErrors = reviewParentId ? errors.filter((e) => e.parentId === reviewParentId) : errors;
  const reviewGroups = groupReviewIssues(reviewErrors, item.occupancyParents, item.occupancyLogicals);
  const affectedParentCount = new Set(errors.map((issue) => issue.parentId || "__unassigned")).size;
  const staleParentCount = new Set(errors.filter((issue) => issue.code === "stale").map((issue) => issue.parentId)).size;
  const dirty = annotation.savedResultFingerprint !== annotation.draftResultFingerprint;
  return (
    <section className={styles.dock} data-testid="occupancy-review-dock" aria-label="家具组团标注工具条">
      <div className={styles.row}>
        <span>
          {!status
            ? "参考加载中"
            : status.error
              ? `参考异常：${status.error}`
              : refChanged
                ? "L2 参考有更新（手动应用）"
                : "L2 参考已加载"}
        </span>
        <button
          disabled={disabled || !controller}
          onClick={() => {
            setReferenceBackupFingerprint("");
            setDialog("reference");
          }}
        >
          参考详情
        </button>
        <label className={styles.focusField}>
          Focus 功能分区{" "}
          <Select
            aria-label="Focus 功能分区"
            className={styles.focusSelect}
            dropdownClassName={styles.focusDropdown}
            disabled={disabled}
            value={item.occupancyFocusId || undefined}
            placeholder="请选择…"
            showSearch
            allowClear
            optionLabelProp="label"
            optionFilterProp="title"
            dropdownMatchSelectWidth={false}
            onChange={(value) => item.setOccupancyFocus(value || "")}
          >
            {item.occupancyParents.map((p) => (
              <Select.Option key={p.id} value={p.id} title={p.label} label={<ParentIdentity parent={p} compact />}>
                <ParentIdentity parent={p} />
              </Select.Option>
            ))}
          </Select>
        </label>
        <button disabled={!parent || drawing} onClick={() => run(() => focusOccupancy(item, parent.geometry))}>
          定位父分区
        </button>
        <label title="靠近所属父分区边线或顶点约 10 屏幕像素时吸附；边界优先于像素">
          <input
            type="checkbox"
            checked={item.occupancyBoundarySnap}
            onChange={(e) => item.setOccupancySnapping("boundary", e.target.checked)}
          />{" "}
          边界吸附
        </label>
        <label title="按原始图像像素对齐，不随缩放改变精度；关闭吸附也不能越出父分区">
          <input
            type="checkbox"
            checked={item.occupancyPixelSnap}
            onChange={(e) => item.setOccupancySnapping("pixel", e.target.checked)}
          />{" "}
          原图像素吸附
        </label>
      </div>
      <div className={styles.row}>
        <span>
          待绘制组团：{GROUP_TYPES[item.occupancyGroup?.type] || "未创建"} {item.occupancyGroup?.id?.slice(-6)}
        </span>
        <button
          disabled={disabled || !parent}
          onClick={() => {
            setDialog("group");
            setNote("");
          }}
        >
          创建组团
        </button>
        <button
          disabled={disabled || !parent}
          title="沿家具组团的真实公共边界绘制；10 屏幕像素内自动吸附"
          onClick={() => {
            try {
              item.startOccupancyTool(BARRIER_CONTROL);
              setError("");
              setNotice("人工隔墙模式：请沿家具组团公共边界绘制两点 Vector。");
            } catch (e) {
              setError(e.message);
            }
          }}
        >
          标注隔墙
        </button>
        {activePolygon && (
          <button
            disabled={disabled || !selectedPoint || activePolygon.points.length <= 3}
            title={
              !selectedPoint
                ? "先点击一个多边形顶点"
                : activePolygon.points.length <= 3
                  ? "多边形至少保留 3 个顶点"
                  : "删除当前选中的顶点，也可以按 Delete 或 Backspace"
            }
            onClick={() => {
              if (activePolygon.deletePoint(selectedPoint)) {
                setError("");
                setNotice("已删除所选顶点；该分区需要重新复核。");
              } else {
                setError(item.occupancyEditNotice || "该顶点不能删除");
              }
            }}
          >
            删除所选顶点
          </button>
        )}
        <button disabled={disabled || !parent} onClick={() => setDialog("groupPreview")}>
          预览组团（{groups.length}）
        </button>
        <button
          disabled={disabled}
          onClick={() => {
            setReviewParentId("");
            setRebind("");
            setDialog("review");
          }}
        >
          复核与问题（{affectedParentCount} 分区 / {errors.length} 项）
        </button>
        <button
          disabled={busy || drawing}
          onClick={() =>
            run(async () => {
              await annotation.saveDraftImmediatelyWithResults();
              setNotice("草稿已保存；未提交。");
            })
          }
        >
          保存草稿
        </button>
        <button onClick={() => setDialog("more")}>恢复与导出</button>
      </div>
      <div className={styles.status} role="status" title={item.occupancyEditNotice || undefined}>
        {annotation.isDraftSaving
          ? "保存中…"
          : annotation.draftSaveError
            ? "草稿保存失败"
            : dirty
              ? "有未保存修改"
              : "已保存"}{" "}
        ·{" "}
        {item.occupancyDrawBlockReason(item.occupancyDrawingControl) ||
          (item.occupancyDrawingControl === BARRIER_CONTROL
            ? `人工隔墙：当前分区 ${focusBarriers.length} 条 Vector，排除 ${matchedBarrierPairs} 组紧邻`
            : item.occupancyCorrectionId
              ? "正在绘制局部修正范围"
              : `绘制模式：${TYPES[item.occupancyDrawMode]}`)}
        {notice ? ` · ${notice}` : ""}
        {activePolygon
          ? " · 多边形编辑：拖动顶点调整，点击边线新增顶点，选中顶点后可删除；拖动内部可整体移动"
          : item.occupancyActivePartId
            ? " · 已选中可编辑矩形，可拖动轮廓或缩放控制点调整"
            : ""}
        {item.occupancyEditNotice ? ` · ${item.occupancyEditNotice}` : ""}
      </div>
      {(error || annotation.draftSaveError || state.error) && (
        <div className={styles.error} role="alert">
          {error || annotation.draftSaveError || state.error}
        </div>
      )}
      <Modal
        visible={!!dialog}
        title={
          dialog === "preview"
            ? preview?.title
            : dialog === "delete" && deleteLogical?.type === "furniture_group"
              ? "删除家具组团"
              : DIALOG_TITLES[dialog] || "L3 家具组团标注"
        }
        footer={null}
        onCancel={() => {
          if (busy) return;
          if (dialog === "delete") item.clearOccupancyDeleteRequest();
          setDialog(null);
        }}
        maskClosable={false}
        width={1000}
        destroyOnClose
      >
        <div className={styles.dialog}>
          {dialog === "group" && (
            <>
              <p>组团按实际障碍占地绘制，家具之间的空隙不要填入组团。单件家具也可独立成组。</p>
              <div className={styles.row}>
                <select aria-label="组团类型" value={type} onChange={(e) => setType(e.target.value)}>
                  {Object.entries(GROUP_TYPES).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="组团说明"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="其他类型必须填写说明"
                />
                <button onClick={setGroup}>创建并开始绘制</button>
              </div>
            </>
          )}
          {dialog === "preview" && (
            <>
              <p>
                {preview?.unchanged
                  ? "输入未变化，不新增任何对象。"
                  : "确认后先保存草稿并下载操作前恢复 JSON，再检查版本、一次性应用；应用后仍需按规则复核。"}
                {preview?.clipped && " 本次轮廓超出父分区，应用后将使用下方裁剪轮廓。"}
              </p>
              {preview?.geometry && <PreviewGeometry parent={parent} geometry={preview.geometry} />}
              <button disabled={busy} onClick={apply}>
                确认应用并保存草稿
              </button>
            </>
          )}
          {dialog === "groupPreview" && parent && (
            <>
              <p>
                当前仅显示 <ParentIdentity parent={parent} />
                。家具组团分类和可通行区域生成会立即写入草稿，可使用撤销恢复。
              </p>
              <OccupancyOverview parent={parent} regions={logicals} />
              <div className={styles.row}>
                <strong>
                  {generatedWalkable.length
                    ? errors.some((e) => e.parentId === parent.id && e.code === "stale")
                      ? "现有可通行区域已过期"
                      : "现有可通行区域是最新结果"
                    : "尚未生成可通行区域"}
                </strong>
                <button
                  className={styles.primaryAction}
                  disabled={disabled || refChanged}
                  onClick={generate}
                  title={refChanged ? "请先保存、备份并应用最新 L2 参考" : undefined}
                >
                  {generatedWalkable.length ? "重新生成可通行区域" : "生成可通行区域"}
                </button>
              </div>
              <GenerationIssuePanel
                issues={generationIssues}
                parents={item.occupancyParents}
                logicals={item.occupancyLogicals}
                disabled={disabled}
                onLocate={locate}
                onOpenReview={() => {
                  setReviewParentId(parent.id);
                  setRebind(parent.id);
                  setDialog("review");
                }}
              />
              <div className={styles.list}>
                {!groups.length && <p>当前功能分区没有家具组团；可以直接生成覆盖整个父分区的可通行区域。</p>}
                {groups.map((r) => (
                  <GroupEditor key={r.id} region={r} disabled={disabled} onLocate={locate} onReclassify={mutateGroup} />
                ))}
              </div>
            </>
          )}
          {dialog === "delete" && (
            <>
              {deleteLogical ? (
                <>
                  <p>
                    将删除当前逻辑区域的全部轮廓及其配对类别。旧版多分块组团也会作为一个完整组团删除；房间、L2
                    功能分区、Portal、连通线和其他 L3 区域不会改变。
                  </p>
                  <div className={styles.item}>
                    {deleteParent && <ParentIdentity parent={deleteParent} />}
                    <div className={styles.row}>
                      <span className={styles.typeSwatch} style={{ backgroundColor: COLORS[deleteLogical.type] }} />
                      <strong>
                        {deleteLogical.type === "furniture_group"
                          ? GROUP_TYPES[deleteLogical.context.group_type]
                          : TYPES[deleteLogical.type]}
                      </strong>
                      <span className={styles.small}>逻辑 ID：{deleteLogical.id}</span>
                      <span className={styles.small}>轮廓：{deleteLogical.parts.length}</span>
                    </div>
                  </div>
                  {deleteRelationCount ? (
                    <p className={styles.error} role="alert">
                      该区域关联了 {deleteRelationCount} 条手工 Relation。请先人工处理关系；系统不会连带删除 Relation。
                    </p>
                  ) : (
                    <p>
                      确认后会先保存当前草稿并下载操作前恢复
                      JSON，再执行一次可撤销删除并再次保存。已有自动可通行区域会变为过期，需在“预览组团”中重新生成。
                    </p>
                  )}
                  <div className={styles.row}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        item.clearOccupancyDeleteRequest();
                        setDialog(null);
                      }}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className={styles.dangerAction}
                      disabled={disabled || !!deleteRelationCount}
                      onClick={removeRequestedLogical}
                    >
                      {deleteLogical.type === "furniture_group" ? "删除组团并保存草稿" : "删除区域并保存草稿"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className={styles.error}>待删除区域已变化或不存在，请关闭后重新选择。</p>
                  <button
                    type="button"
                    onClick={() => {
                      item.clearOccupancyDeleteRequest();
                      setDialog(null);
                    }}
                  >
                    关闭
                  </button>
                </>
              )}
            </>
          )}
          {dialog === "review" && (
            <>
              <p>复核表示你已检查家具障碍占地、通行分类和完整覆盖；系统不会替你判断通行性。</p>
              <div className={styles.reviewSummary} role="status">
                <strong>
                  当前全任务有 {affectedParentCount} 个功能分区、{errors.length} 项问题
                </strong>
                <span>
                  {staleParentCount
                    ? `其中 ${staleParentCount} 个分区的可通行区域已过期，必须先重新生成；“复核全部”不会替代重新计算。`
                    : "当前没有过期的自动可通行区域。"}
                </span>
              </div>
              {reviewParentId && (
                <div className={styles.reviewFilter}>
                  <span>
                    当前只显示{" "}
                    <ParentIdentity parent={item.occupancyParents.find((p) => p.id === reviewParentId)} compact />
                    的问题（{reviewErrors.length}）
                  </span>
                  <button
                    onClick={() => {
                      setReviewParentId("");
                      setRebind("");
                    }}
                  >
                    显示全部问题（{errors.length}）
                  </button>
                </div>
              )}
              <div className={styles.row}>
                <button disabled={!parent || disabled} onClick={() => confirm([parent.id])}>
                  确认当前父分区
                </button>
                <button disabled={!canConfirm.length || disabled} onClick={() => confirm(canConfirm.map((p) => p.id))}>
                  复核全部可确认分区（{canConfirm.length}）
                </button>
              </div>
              <div className={styles.list}>
                {!reviewGroups.length && <p>当前范围没有待处理问题。</p>}
                {reviewGroups.map((group) => (
                  <section
                    className={`${styles.reviewParentGroup} ${group.staleCount ? styles.reviewParentStale : ""}`}
                    key={group.key}
                  >
                    <header className={styles.reviewParentHeader}>
                      {group.parent ? (
                        <ParentIdentity parent={group.parent} />
                      ) : (
                        <strong>父功能分区：{group.parentId || "无法识别"}</strong>
                      )}
                      <span className={styles.reviewIssueCount}>{group.issues.length} 项</span>
                    </header>
                    {group.staleCount > 0 && (
                      <div className={styles.staleReviewIssue} role="alert">
                        <div>
                          <strong>可通行区域已过期</strong>
                          <span>
                            家具组团、手工空闲区域或父参考发生变化，当前自动可通行区域不再对应最新输入。正式提交前必须重新生成。
                          </span>
                          <small>受影响的自动可通行逻辑区域：{group.staleCount} 个</small>
                        </div>
                        <div className={styles.generationIssueActions}>
                          {group.parent && (
                            <>
                              <button
                                disabled={disabled}
                                onClick={() => {
                                  item.setOccupancyFocus(group.parent.id);
                                  setDialog(null);
                                  run(() => focusOccupancy(item, group.parent.geometry));
                                }}
                              >
                                定位父分区
                              </button>
                              <button
                                className={styles.primaryAction}
                                disabled={disabled}
                                onClick={() => {
                                  item.setOccupancyFocus(group.parent.id);
                                  setGenerationIssues([]);
                                  setDialog("groupPreview");
                                }}
                              >
                                打开预览组团
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                    {group.reviewCount > 0 && (
                      <div className={styles.reviewPendingSummary}>
                        <strong>待复核：{group.reviewCount} 个 L3 逻辑区域</strong>
                        <span>{group.staleCount ? "请先重新生成可通行区域，再确认本分区。" : "检查后可确认本分区。"}</span>
                      </div>
                    )}
                    {group.otherIssues.map((e, index) => {
                      const presentation = presentOccupancyIssue(
                        e,
                        item.occupancyParents,
                        item.occupancyLogicals,
                        item.occupancyBarriers,
                      );
                      return (
                        <div className={styles.reviewDetailIssue} key={`${e.code}-${e.objectId || index}`}>
                          <div>
                            <strong>{presentation.title}</strong>
                            <span>{presentation.detail}</span>
                          </div>
                          <button
                            onClick={() => {
                              if (presentation.barrier) locateBarrier(presentation.barrier);
                              else if (presentation.region) locate(presentation.region);
                              else if (group.parent) {
                                item.setOccupancyFocus(group.parent.id);
                                setDialog(null);
                                run(() => focusOccupancy(item, group.parent.geometry));
                              }
                            }}
                          >
                            定位
                          </button>
                          {["source", "parent_missing"].includes(e.code) && (
                            <div className={styles.row}>
                              <select value={rebind} onChange={(event) => setRebind(event.target.value)}>
                                <option value="">选择新父分区 / 当前父分区</option>
                                {item.occupancyParents.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.label}
                                  </option>
                                ))}
                              </select>
                              <button
                                disabled={!rebind}
                                onClick={() =>
                                  prepare("明确重新绑定 / 接受当前父参考：几何保持原样，仍需校验及复核", (data) =>
                                    item.acceptOccupancyParent(data, e.parentId, rebind),
                                  )
                                }
                              >
                                预览更新归属
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </section>
                ))}
              </div>
            </>
          )}
          {dialog === "reference" && (
            <>
              <p className={styles.dialogIntro}>
                本任务的房间与功能分区边界来自下面这条已提交的 L2 标注；来源任务中尚未提交的草稿不会进入本任务。
              </p>
              <ol className={styles.sourcePath} aria-label="L2 参考来源路径">
                {referenceSourcePath(status).map((step, index) => (
                  <li key={step.label}>
                    <span className={styles.sourceStep}>{index + 1}</span>
                    <span>
                      <strong>{step.label}</strong>
                      <small>
                        {step.idLabel}：{step.id}
                      </small>
                    </span>
                  </li>
                ))}
              </ol>
              <div className={styles.referenceState} data-tone={referenceStatus.tone} role="status">
                <strong>{referenceStatus.title}</strong>
                <span>{referenceStatus.detail}</span>
                <small>
                  当前已加载：{shortReferenceVersion(annotation.referenceVersion)} · 来源最新：
                  {shortReferenceVersion(status?.source_version)}
                </small>
              </div>
              <section className={styles.exportSection} aria-label="画布参考显示">
                <h4>画布参考显示</h4>
                <p>
                  默认隐藏与 L2 完整覆盖范围重复的 L1 房间几何，只显示 L2 功能分区、Portal 和连通参考。L1
                  数据仍保留，用于房间名称、颜色、归属和一致性检查。
                </p>
                <label className={styles.row}>
                  <input
                    type="checkbox"
                    checked={item.occupancyShowRoomReferences}
                    onChange={(event) => item.setOccupancyRoomReferencesVisible(event.target.checked)}
                  />{" "}
                  临时显示 L1 房间轮廓（仅当前窗口）
                </label>
              </section>
              <details className={styles.technicalDetails}>
                <summary>技术信息（仅在排查同步问题时使用）</summary>
                <dl>
                  <dt>当前任务已加载的参考指纹</dt>
                  <dd>
                    <code title={annotation.referenceVersion || undefined}>
                      {annotation.referenceVersion || "暂无版本信息"}
                    </code>
                  </dd>
                  <dt>来源端最新正式版本指纹</dt>
                  <dd>
                    <code title={status?.source_version || undefined}>{status?.source_version || "暂无版本信息"}</code>
                  </dd>
                </dl>
              </details>
              <div className={styles.referenceActions}>
                <section>
                  <span className={styles.actionStep}>步骤 1</span>
                  <strong>备份当前 L3 标注</strong>
                  <p>
                    在更新 L2 参考之前，系统会先保存当前草稿，并下载一份 JSON
                    备份到你的电脑。如果更新后出现问题，可以用它恢复当前标注。
                  </p>
                  <button
                    disabled={disabled}
                    onClick={() =>
                      run(async () => {
                        await annotation.saveDraftImmediatelyWithResults();
                        exportOccupancyRecovery(annotation, "before-l3-reference-update");
                        setReferenceBackupFingerprint(annotation.draftResultFingerprint);
                        setNotice("当前标注已备份；请在浏览器下载列表中确认 JSON 文件。");
                      })
                    }
                  >
                    保存草稿并下载备份
                  </button>
                  {referenceBackupReady ? (
                    <small className={styles.ready}>当前标注已备份，可以更新 L2 参考。</small>
                  ) : referenceBackupFingerprint ? (
                    <small className={styles.backupStale}>标注已有变化，请重新备份。</small>
                  ) : null}
                </section>
                <section>
                  <span className={styles.actionStep}>步骤 2</span>
                  <strong>更新 L2 参考边界</strong>
                  <p>只替换只读参考；不会删除、裁剪或自动重新归属现有 L3 对象，受影响区域会要求重新复核。</p>
                  <button
                    disabled={disabled || !controller || !status || !refChanged || !referenceBackupReady}
                    onClick={() =>
                      run(async () => {
                        if (referenceBackupFingerprint !== annotation.draftResultFingerprint) {
                          throw new Error("备份后标注已有变化，请重新备份。");
                        }
                        await annotation.saveDraftImmediatelyWithResults();
                        await controller.applyOccupancyReference();
                        setReferenceBackupFingerprint("");
                        setNotice("L2 最新参考已应用；原 L3 已保留，请处理受影响父分区。");
                        setDialog(null);
                      })
                    }
                  >
                    {!refChanged ? "当前已是最新参考" : referenceBackupReady ? "更新 L2 参考边界" : "请先备份当前标注"}
                  </button>
                </section>
              </div>
            </>
          )}
          {dialog === "more" && (
            <>
              <section className={styles.exportSection}>
                <h4>恢复文件</h4>
                <p>用于意外刷新、参考更新或批量操作后的人工恢复；包含当前窗口尚未保存的修改，不会保存或提交任务。</p>
                <button onClick={() => exportOccupancyRecovery(annotation, "l3-manual-recovery")}>
                  下载当前窗口恢复文件（JSON）
                </button>
              </section>
              <section className={styles.exportSection}>
                <h4>下游数据导出</h4>
                <p>导出按逻辑区域重建的 MultiPolygon，供分析和可视化使用；它不能替代上面的恢复文件。</p>
                <button onClick={() => downloadOccupancy(item)}>导出 L3 逻辑区域（MultiPolygon JSON）</button>
              </section>
              <section className={styles.exportSection}>
                <h4>高级绘制</h4>
                <div className={styles.row}>
                  <button
                    disabled={disabled || !parent}
                    onClick={() => {
                      item.setOccupancyDrawMode("walkable");
                      setDialog(null);
                    }}
                  >
                    手工绘制可通行区域
                  </button>
                  <button
                    disabled={disabled || !parent}
                    onClick={() => {
                      item.setOccupancyDrawMode("restricted_free");
                      setDialog(null);
                    }}
                  >
                    手工绘制受限空闲
                  </button>
                </div>
              </section>
              <p className={styles.guidance}>
                地毯通常不扩大障碍占地；家具间空隙留给可通行区域计算。能站立的淋浴地面不能仅因用途被整体标为家具占用。自动生成结果仍需人工复核，本版没有实际宽度阈值，也不验证
                L4 家具实例。
              </p>
            </>
          )}
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          {!["group", "groupPreview", "delete"].includes(dialog) && (
            <div className={styles.row}>
              <button disabled={busy} onClick={() => setDialog(null)}>
                {dialog === "reference" ? "暂不更新" : dialog === "preview" ? "取消并返回" : "关闭"}
              </button>
              {!["reference", "more"].includes(dialog) && (
                <button
                  title="下载包含当前窗口全部标注结果的本地 JSON；不会保存草稿或提交任务"
                  onClick={() => exportOccupancyRecovery(annotation, "l3-recovery")}
                >
                  下载当前窗口恢复文件（JSON）
                </button>
              )}
            </div>
          )}
        </div>
      </Modal>
    </section>
  );
});
