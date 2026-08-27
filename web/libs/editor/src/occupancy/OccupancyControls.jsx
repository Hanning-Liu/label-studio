import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { Modal } from "antd";
import {
  classifyLogical,
  confirmParents,
  context,
  GEOMETRY,
  generateRemainder,
  GROUP_TYPES,
  logicalExport,
  mergeGroups,
  newId,
  replaceLogicals,
  resultsForGeometry,
  TYPES,
} from "./domain";
import { difference, equivalent, resultGeometry } from "./geometry";
import { applyOccupancyPreview } from "./operations";
import { focusOccupancy } from "./focus";
import { COLORS, pathData } from "./OccupancyLayer";
import { downloadJson, exportOccupancyRecovery } from "./download";
import styles from "./OccupancyControls.module.scss";

export function downloadOccupancy(item) {
  const data = logicalExport(item.occupancyData, item.annotation.referenceVersion);
  downloadJson(data, `task-${item.annotation.store.task.id}-l3-multipolygon.json`);
}

const physicalPart = (logical, polygon) => logical.parts.find((part) => equivalent(resultGeometry(part), [polygon]));

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
  const [selected, setSelected] = useState([]),
    [rebind, setRebind] = useState("");
  const running = useRef(false);
  useEffect(() => {
    setState(controller?.state || {});
    return controller?.subscribe(setState);
  }, [controller]);
  if (!item.occupancyEnabled) return null;
  const parent = item.occupancyParents.find((p) => p.id === item.occupancyFocusId);
  const logicals = item.occupancyLogicals.filter((r) => r.context.parent_zone_id === item.occupancyFocusId);
  const errors = item.occupancyErrors,
    status = state.status;
  const refChanged =
    status?.source_version !== annotation.referenceVersion || status?.reference_version !== annotation.referenceVersion;
  const busy = item.occupancyBusy || !!annotation.submissionStarted;
  const drawing = annotation.isDrawing || annotation.hasIncompletePolygons;
  const disabled = busy || drawing || annotation.isReadOnly();
  const run = async (operation) => {
    if (running.current) return;
    running.current = true;
    item.setOccupancyBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (e) {
      setError(e.message || "操作失败，本地内容已保留");
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
      await applyOccupancyPreview(item, preview, exportOccupancyRecovery);
      setDialog(null);
      setPreview(null);
      setNotice("已应用并保存草稿；可以一次撤销，未提交任务。");
    });
  const locate = (r, geometry = r.geometry) => {
    item.selectOccupancyLogical(r.id);
    setDialog(null);
    run(() => focusOccupancy(item, geometry));
  };
  const generate = () =>
    prepare("生成剩余空间：替换旧自动补余，保留手工区域", (data) =>
      generateRemainder(data, parent?.id, annotation.referenceVersion),
    );
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
  const mutateGroup = (r, values) =>
    prepare("统一修改组团属性，相关复核失效", (data) =>
      data.map((result) =>
        GEOMETRY.has(result.from_name) && context(result).logical_id === r.id
          ? {
              ...result,
              meta: {
                ...result.meta,
                occupancy_context: {
                  ...context(result),
                  ...values,
                  review_status: "pending",
                  review_fingerprint: null,
                },
              },
            }
          : result,
      ),
    );
  const componentOperation = (r, poly, separate) =>
    prepare(
      separate ? "移出此占地分块，作为新的独立组团" : "删除此占地分块，补余将标记过期",
      (data) => {
        const c = { ...r.context, review_status: "pending", review_fingerprint: null };
        const rest = resultsForGeometry(difference(r.geometry, [poly]), r.type, c, r.parts[0]);
        const id = newId();
        const added = separate
          ? resultsForGeometry([poly], r.type, { ...c, logical_id: id, group_id: id }, r.parts[0])
          : [];
        return replaceLogicals(data, [r.id], [...rest, ...added]);
      },
      [poly],
    );
  const canConfirm = item.occupancyParents.filter(
    (p) => !errors.some((e) => e.parentId === p.id && e.code !== "review"),
  );
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
            setDialog("reference");
          }}
        >
          参考详情
        </button>
        <label>
          Focus 功能分区{" "}
          <select
            aria-label="Focus 功能分区"
            disabled={disabled}
            value={item.occupancyFocusId}
            onChange={(e) => item.setOccupancyFocus(e.target.value)}
          >
            <option value="">请选择…</option>
            {item.occupancyParents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
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
          当前组团：{GROUP_TYPES[item.occupancyGroup?.type] || "未选择"} {item.occupancyGroup?.id?.slice(-6)}
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
          disabled={disabled || !!item.occupancyDrawBlockReason()}
          onClick={() => {
            try {
              item.startOccupancyTool("occupancy_rectangle");
            } catch (e) {
              setError(e.message);
            }
          }}
        >
          画矩形
        </button>
        <button
          disabled={disabled || !!item.occupancyDrawBlockReason()}
          onClick={() => {
            try {
              item.startOccupancyTool("occupancy_polygon");
            } catch (e) {
              setError(e.message);
            }
          }}
        >
          画多边形
        </button>
        <button disabled={disabled} onClick={() => setDialog("areas")}>
          组团与空闲区域（{logicals.length}）
        </button>
        <button disabled={disabled || !parent || refChanged || item.occupancyPending.length > 0} onClick={generate}>
          生成剩余空间
        </button>
        <button disabled={disabled || !item.occupancyPending.length} onClick={() => setDialog("pending")}>
          绘制预览（{item.occupancyPending.length}）
        </button>
        <button disabled={disabled} onClick={() => setDialog("review")}>
          复核与问题（{errors.length}）
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
        <button onClick={() => setDialog("more")}>更多 / 备份</button>
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
        {item.occupancyDrawBlockReason() ||
          (item.occupancyCorrectionId ? "正在绘制局部修正范围" : `绘制模式：${TYPES[item.occupancyDrawMode]}`)}
        {notice ? ` · ${notice}` : ""}
        {item.occupancyActivePartId ? " · 已选中可编辑分块，可拖动轮廓或控制点调整" : ""}
        {item.occupancyEditNotice ? ` · ${item.occupancyEditNotice}` : ""}
      </div>
      {(error || annotation.draftSaveError || state.error) && (
        <div className={styles.error} role="alert">
          {error || annotation.draftSaveError || state.error}
        </div>
      )}
      <Modal
        visible={!!dialog}
        title={dialog === "preview" ? preview?.title : "L3 家具组团与空闲区域"}
        footer={null}
        onCancel={() => !busy && setDialog(null)}
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
                  : "确认后先保存草稿并下载操作前恢复 JSON，再检查版本、一次性应用。通行性仍需人工分类与复核。"}
                {preview?.clipped && " 本次轮廓超出父分区，应用后将使用下方裁剪轮廓。"}
              </p>
              {preview?.geometry && <PreviewGeometry parent={parent} geometry={preview.geometry} />}
              <button disabled={busy} onClick={apply}>
                确认应用并保存草稿
              </button>
            </>
          )}
          {dialog === "pending" && (
            <div className={styles.list}>
              {item.occupancyPending.map((r) => (
                <div key={r.id} className={styles.item}>
                  <span>
                    {TYPES[r.type]} · {r.id}
                  </span>
                  <div className={styles.row}>
                    <button
                      disabled={disabled}
                      onClick={() =>
                        prepare("确认绘制、父边界裁剪与同组并集", () => item.previewOccupancyDrawing(r.id))
                      }
                    >
                      查看应用预览
                    </button>
                    <button
                      disabled={disabled}
                      onClick={() => prepare("取消并移除本次未应用轮廓", (data) => replaceLogicals(data, [r.id], []))}
                    >
                      取消此轮廓
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {dialog === "areas" && (
            <>
              <div className={styles.row}>
                <button
                  disabled={selected.length < 2 || disabled}
                  onClick={() =>
                    prepare("合并已选家具组团：将按当前类型统一，重叠占地仅保留并集", (data) =>
                      mergeGroups(data, selected, type, note),
                    )
                  }
                >
                  合并选中组团
                </button>
                <select value={type} onChange={(e) => setType(e.target.value)}>
                  {Object.entries(GROUP_TYPES).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="组团说明" />
              </div>
              <div className={styles.list}>
                {logicals
                  .filter((r) => r.context.generation !== "pending")
                  .map((r) => (
                    <div className={styles.item} key={r.id}>
                      <div className={styles.row}>
                        {r.type === "furniture_group" && (
                          <input
                            type="checkbox"
                            checked={selected.includes(r.id)}
                            onChange={(e) =>
                              setSelected(e.target.checked ? [...selected, r.id] : selected.filter((id) => id !== r.id))
                            }
                          />
                        )}
                        <strong style={{ color: COLORS[r.type] }}>
                          {r.type === "furniture_group" ? GROUP_TYPES[r.context.group_type] : TYPES[r.type]}
                        </strong>
                        <span>{r.geometry.length} 个占地分块</span>
                        <button onClick={() => locate(r)}>定位 / 选中整区</button>
                      </div>
                      <div className={styles.small}>
                        {r.id} ·{" "}
                        {errors.some((e) => e.parentId === r.context.parent_zone_id && e.code === "review")
                          ? "待复核"
                          : r.context.review_status === "reviewed"
                            ? "已复核"
                            : "待复核"}
                        {errors.some((e) => e.objectId === r.id && e.code === "stale") ? " · 补余已过期" : ""}
                      </div>
                      <div className={styles.row}>
                        {r.type === "furniture_group" ? (
                          <>
                            <button
                              onClick={() => {
                                item.selectOccupancyLogical(r.id);
                                item.setOccupancyDrawMode("furniture_group");
                                setDialog(null);
                              }}
                            >
                              继续添加分块
                            </button>
                            <button onClick={() => mutateGroup(r, { group_type: type, group_note: note })}>
                              用上方类型与说明更新整组
                            </button>
                            <button
                              onClick={() =>
                                prepare(
                                  "归并本组重叠轮廓",
                                  (data) =>
                                    replaceLogicals(
                                      data,
                                      [r.id],
                                      resultsForGeometry(
                                        r.geometry,
                                        r.type,
                                        { ...r.context, review_status: "pending", review_fingerprint: null },
                                        r.parts[0],
                                      ),
                                    ),
                                  r.geometry,
                                )
                              }
                            >
                              归并本组轮廓
                            </button>
                          </>
                        ) : (
                          ["walkable", "restricted_free"].map((kind) => (
                            <span key={kind}>
                              <button
                                onClick={() =>
                                  prepare(`重分类为${TYPES[kind]}`, (data) => classifyLogical(data, r.id, kind))
                                }
                              >
                                {TYPES[kind]}
                              </button>{" "}
                              <button
                                onClick={() => {
                                  item.selectOccupancyLogical(r.id);
                                  item.setOccupancyDrawMode(kind, r.id);
                                  setDialog(null);
                                }}
                              >
                                局部改为{TYPES[kind]}
                              </button>
                            </span>
                          ))
                        )}
                        <button
                          onClick={() =>
                            prepare("删除整个逻辑区域（不修改参考）", (data) => replaceLogicals(data, [r.id], []))
                          }
                        >
                          删除区域
                        </button>
                      </div>
                      {r.type === "furniture_group" && (
                        <details>
                          <summary>占地分块管理</summary>
                          {r.geometry.map((poly, index) => (
                            <div className={styles.row} key={index}>
                              <span>分块 {index + 1}</span>
                              <button onClick={() => locate(r, [poly])}>定位</button>
                              <button
                                disabled={r.geometry.length < 2}
                                onClick={() => componentOperation(r, poly, true)}
                              >
                                移出并独立成组
                              </button>
                              <button onClick={() => componentOperation(r, poly, false)}>删除分块</button>
                              {poly.length === 1 && r.parts.length === r.geometry.length && physicalPart(r, poly) && (
                                <button
                                  onClick={() => {
                                    item.editOccupancyPart(physicalPart(r, poly).id);
                                    setDialog(null);
                                  }}
                                >
                                  编辑轮廓
                                </button>
                              )}
                            </div>
                          ))}
                        </details>
                      )}
                    </div>
                  ))}
              </div>
            </>
          )}
          {dialog === "review" && (
            <>
              <p>复核表示你已检查家具障碍占地、通行分类和完整覆盖；系统不会替你判断通行性。</p>
              <div className={styles.row}>
                <button disabled={!parent || disabled} onClick={() => confirm([parent.id])}>
                  确认当前父分区
                </button>
                <button disabled={!canConfirm.length || disabled} onClick={() => confirm(canConfirm.map((p) => p.id))}>
                  复核全部可确认分区（{canConfirm.length}）
                </button>
              </div>
              <div className={styles.list}>
                {errors.map((e, index) => (
                  <div className={styles.item} key={`${e.code}-${index}`}>
                    <span>{e.message}</span>
                    <button
                      onClick={() => {
                        const r = item.occupancyLogicals.find(
                          (r) => r.id === e.objectId || r.parts.some((p) => p.id === e.objectId),
                        );
                        if (r) locate(r);
                        else {
                          const p = item.occupancyParents.find((p) => p.id === e.parentId);
                          if (p) {
                            item.setOccupancyFocus(p.id);
                            setDialog(null);
                            run(() => focusOccupancy(item, p.geometry));
                          }
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
                ))}
              </div>
            </>
          )}
          {dialog === "reference" && (
            <>
              <p>仅使用指定 Task 的正式 L2 标注。更新不会删除、裁剪或重新归属任何 L3 对象。</p>
              <p>
                来源 Project {status?.source_project_id} / Task {status?.source_task_id} / Annotation{" "}
                {status?.source_annotation_id}
              </p>
              <p>当前参考：{annotation.referenceVersion}</p>
              <p>最新来源：{status?.source_version}</p>
              <button
                disabled={disabled || !refChanged}
                onClick={() =>
                  run(async () => {
                    await annotation.saveDraftImmediatelyWithResults();
                    exportOccupancyRecovery(annotation, "before-l3-reference-update");
                    await controller.applyOccupancyReference();
                    setNotice("参考已手动应用，原 L3 保留，请处理受影响父分区。");
                    setDialog(null);
                  })
                }
              >
                已备份，应用参考更新
              </button>
            </>
          )}
          {dialog === "more" && (
            <>
              <div className={styles.row}>
                <button onClick={() => exportOccupancyRecovery(annotation, "l3-manual-recovery")}>
                  导出完整恢复 JSON
                </button>
                <button onClick={() => downloadOccupancy(item)}>导出逻辑区域 MultiPolygon</button>
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
              <p>
                地毯通常不扩大障碍占地；家具间空隙留给补余。能站立的淋浴地面不能仅因用途被整体标为家具占用。通行性由人工判断，本版没有实际宽度阈值，也不验证
                L4 家具实例。
              </p>
            </>
          )}
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.row}>
            <button disabled={busy} onClick={() => setDialog(null)}>
              关闭 / 暂不应用
            </button>
            <button onClick={() => exportOccupancyRecovery(annotation, "l3-recovery")}>导出当前窗口备份</button>
          </div>
        </div>
      </Modal>
    </section>
  );
});
