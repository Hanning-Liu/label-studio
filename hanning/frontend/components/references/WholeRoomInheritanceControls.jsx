import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { Modal } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { zoneFingerprint } from "@hanning/frontend/domain/rooms/wholeRoomInheritance";
import styles from "@hanning/frontend/components/references/WholeRoomInheritanceControls.module.scss";
import { VectorReviewButton, VectorReviewPanel } from "@hanning/frontend/components/references/VectorReviewControls";
import { ReferenceSyncControls } from "./ReferenceSyncControls";
import { buildReferenceReviewRows } from "./referenceReview";
import { vectorReviewRows } from "@hanning/frontend/domain/rooms/vectorReviewDock";
import { exportWholeRoomRecovery } from "./exportWholeRoomRecovery";


const FunctionSelect = ({ labels, value, onChange, disabled, name }) => (
  <select aria-label={name} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    {labels.map((label) => (
      <option key={label} value={label}>
        {label === "Sanitary/general" ? "Sanitary/general · 卫浴综合" : label}
      </option>
    ))}
  </select>
);

export const WholeRoomInheritanceControls = observer(({ item, compact = false, focusControl = null, subdivisionRegion = null }) => {
  const [dialog, setDialog] = useState(null);
  const [section, setSection] = useState("reference");
  const [showAllZones, setShowAllZones] = useState(false);
  const [preview, setPreview] = useState([]);
  const [subdivision, setSubdivision] = useState(null);
  const [snapshots, setSnapshots] = useState(null);
  const [restorePreview, setRestorePreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const annotation = item.annotation;
  const controller = annotation.store.referenceSyncController;
  const [syncState, setSyncState] = useState(controller?.state);
  useEffect(() => {
    setSyncState(controller?.state);
    return controller?.subscribe(setSyncState);
  }, [controller]);
  if (!item.wholeRoomInheritanceEnabled || !annotation.editable || annotation.isReadOnly()) return null;

  const allZones = item.wholeRoomZones;
  const zones = allZones.filter((zone) => zone.review);
  const pending = zones.filter((zone) => !zone.review.reviewed);
  const visibleZones = [...(showAllZones ? allZones : pending)].sort(
    (first, second) =>
      (first.source?.roomType || "").localeCompare(second.source?.roomType || "") ||
      (first.parentRoomId || "").localeCompare(second.parentRoomId || ""),
  );
  const labels = item.wholeRoomLabels;
  const disabled = busy || !!annotation.submissionStarted || !!item.vectorReviewBusy || !!syncState?.busy || !!annotation.isDraftSaving;
  const focusedZone = subdivisionRegion
    ? zones.find((zone) => zone.region === subdivisionRegion)
    : zones.find((zone) => zone.parentRoomId === item.focusedRoom?.cleanId);
  const subdivisionReason = item.wholeRoomSubdivisionReason(focusedZone?.id);
  const draft = syncState?.status?.drafts?.find((entry) => Number(entry.id) === Number(annotation.draftId));
  const reviewGroups = [
    { id: "reference", label: "上游变更", count: buildReferenceReviewRows(annotation.results, draft?.pending).length },
    { id: "zones", label: "分区类别", count: pending.length },
    { id: "vectors", label: "连通线", count: vectorReviewRows(item).filter((row) => !row.reviewed).length },
  ];
  const reviewCount = reviewGroups.reduce((total, group) => total + group.count, 0);
  const close = () => {
    setShowAllZones(false);
    setRestorePreview(null);
    setDialog(null);
  };
  const dirty = annotation.savedResultFingerprint !== annotation.draftResultFingerprint;
  const saveError = error || annotation.draftSaveError;
  const savedTime = annotation.draftSaved ? new Date(annotation.draftSaved).toLocaleTimeString() : "";
  const status = annotation.isDraftSaving
    ? "草稿保存中…"
    : saveError
      ? `保存/操作失败：${saveError}`
      : dirty
        ? "有尚未保存的修改"
        : `草稿已保存 ${savedTime}`;

  const run = async (operation) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      item.assertWholeRoomEditable();
      await operation();
    } catch (failure) {
      setError(failure?.message || "操作失败；请保留当前窗口并导出恢复 JSON");
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const save = () => annotation.saveDraftImmediatelyWithResults();
  const saveAndBackup = async (reason) => {
    await save(); // Never mutate results or claim success if the server rejected this save.
    exportWholeRoomRecovery(annotation, reason);
  };
  const openPreview = () => {
    setError("");
    setPreview(
      item.wholeRoomCandidates.map((room) => ({
        roomId: room.id,
        roomType: room.roomType,
        label: room.suggestedLabel,
        sourceFingerprint: room.sourceFingerprint,
        eligible: room.eligible,
        selected: room.eligible,
        reason: room.reason,
      })),
    );
    setDialog("generate");
  };
  const generate = () =>
    run(async () => {
      await saveAndBackup("before-whole-room-generation");
      const ids = item.generateWholeRoomZones(preview.filter((room) => room.selected && room.eligible));
      // A failed second save leaves the new results locally editable and undoable.
      // Close the stale preview so retrying cannot repeat the mutation.
      setDialog(compact ? "review" : null);
      await save();
      setNotice(`已生成 ${ids.length} 个整室分区并保存草稿；全部待确认。未提交任务。`);
    });
  const confirm = (ids) =>
    run(async () => {
      item.confirmWholeRoomZones(ids);
      await save();
      setNotice(`已确认 ${ids.length} 个功能分区并保存草稿；未确认 Vector，未提交任务。`);
    });
  const prepareSubdivision = () =>
    run(async () => {
      const id = focusedZone?.id;
      const reason = item.wholeRoomSubdivisionReason(id);
      if (reason) throw new Error(reason);
      setSubdivision({ id, room: focusedZone.source.roomType, fingerprint: zoneFingerprint(focusedZone.result, focusedZone.label) });
      setDialog("subdivide");
    });
  const subdivide = () =>
    run(async () => {
      const checkZone = () => {
        const zone = item.wholeRoomZones.find((candidate) => candidate.id === subdivision.id);
        if (!zone || zoneFingerprint(zone.result, zone.label) !== subdivision.fingerprint)
          throw new Error("分区已变化，请取消后重新检查");
        const reason = item.wholeRoomSubdivisionReason(subdivision.id);
        if (reason) throw new Error(reason);
      };
      checkZone();
      if (!controller) throw new Error("此任务未启用服务端快照，未移除分区");
      await controller.subdivideWholeRoom(annotation, subdivision.id, () => {
        checkZone();
        item.startWholeRoomSubdivision(subdivision.id);
        setDialog(null);
      });
    });
  const openHistory = () => run(async () => {
    setSnapshots(null);
    setRestorePreview(null);
    setDialog("history");
    setSnapshots((await controller.loadSubdivisionHistory(annotation)).snapshots);
  });
  const previewRestore = (id) => run(async () => {
    setRestorePreview(null);
    setRestorePreview(await controller.previewSubdivision(annotation, id));
  });
  const restore = () => run(async () => {
    await controller.restoreSubdivision(annotation, restorePreview);
    close();
  });
  const locate = (zone) => {
    item.setFocusedRoom(zone.parentRoomId);
    annotation.unselectAreas();
    annotation.selectAreas([zone.region]);
    close();
  };
  if (subdivisionRegion && subdivisionReason && !dialog && !notice && !saveError) return null;

  return (
    <div className={styles.controls} data-testid="whole-room-controls">
      {subdivisionRegion ? (
        <button type="button" className={styles.subdivideButton} disabled={disabled || !!subdivisionReason}
          onClick={prepareSubdivision}>开始细分</button>
      ) : <div className={styles.actions}>
        {focusControl}
        {!compact && (
          <button type="button" disabled={disabled} onClick={openPreview}>
            为空房间生成整室分区
          </button>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setError("");
            setSection(reviewGroups.find((group) => group.count > 0)?.id || "zones");
            setDialog("review");
          }}
        >
          {compact ? `L2 复核（${reviewCount}）` : `待确认分区（${pending.length}）`}
        </button>
        {!compact && <VectorReviewButton item={item} disabled={disabled} />}
        {!compact && (
          <button
            type="button"
            disabled={disabled || !!subdivisionReason}
            title={subdivisionReason || "备份并移除当前房间的自动整室分区"}
            onClick={prepareSubdivision}
          >
            开始细分
          </button>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            run(async () => {
              await save();
              setNotice("草稿已保存，未提交任务。");
            })
          }
        >
          保存草稿
        </button>
        {!compact && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => exportWholeRoomRecovery(annotation, "manual-recovery")}
          >
            导出恢复 JSON
          </button>
        )}
        {compact && (
          <button type="button" disabled={disabled} title="导出当前窗口备份" aria-label="导出当前窗口备份"
            onClick={() => exportWholeRoomRecovery(annotation, "manual-recovery")}>
            <DownloadOutlined aria-hidden="true" />
          </button>
        )}
      </div>}
      {!subdivisionRegion && <VectorReviewPanel item={item} hideEmpty={compact} />}
      {(!subdivisionRegion || saveError || notice) && <div className={saveError ? styles.error : styles.status} role={saveError ? "alert" : "status"}>
        {status}
        {notice ? ` · ${notice}` : ""}
      </div>}
      {!subdivisionRegion && syncState?.subdivisionNotice && <p role="status">{syncState.subdivisionNotice}</p>}
      {!subdivisionRegion && syncState?.subdivisionError && <p className={styles.error} role="alert">{syncState.subdivisionError}</p>}
      <Modal
        visible={!!dialog}
        title={
          dialog === "history"
            ? "细分历史"
            : compact && ["review", "generate"].includes(dialog)
            ? "L2 复核"
            : dialog === "generate"
              ? "为空房间生成整室分区"
              : dialog === "review"
                ? "自动继承分区确认"
                : "确认开始手工细分"
        }
        onCancel={() => !disabled && close()}
        maskClosable={false}
        keyboard={!disabled}
        closable={!disabled}
        footer={null}
        width={960}
        destroyOnClose
      >
        <div className={styles.dialog}>
          {compact && dialog === "review" && (
            <div className={styles.reviewGroups} role="group" aria-label="复核分组">
              {reviewGroups.map((group) => (
                <button type="button" key={group.id} aria-pressed={section === group.id} disabled={disabled}
                  onClick={() => setSection(group.id)}>{group.label}（{group.count}）</button>
              ))}
            </div>
          )}
          {compact && dialog === "review" && section === "reference" &&
            (syncState?.status?.enabled ? <ReferenceSyncControls item={item} embedded onLocate={close} /> :
              <p>当前没有可复核的上游参考变更。</p>)}
          {compact && dialog === "review" && section === "vectors" &&
            <VectorReviewButton item={item} embedded disabled={busy} onLocate={close} />}
          {dialog === "generate" && (
            <>
              <p>仅处理本任务完全没有功能分区的房间。生成前先保存草稿并下载完整恢复 JSON；生成后仍需单独确认类别。</p>
              <div className={styles.tableScroll}>
                <table>
                  <thead>
                    <tr>
                      <th>生成</th>
                      <th>房间</th>
                      <th>建议功能类别（可修改）</th>
                      <th>处理状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((room, index) => (
                      <tr key={room.roomId}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`生成 ${room.roomType} ${room.roomId}`}
                            disabled={busy || !room.eligible}
                            checked={room.selected}
                            onChange={(event) =>
                              setPreview(
                                preview.map((row, i) =>
                                  i === index ? { ...row, selected: event.target.checked } : row,
                                ),
                              )
                            }
                          />
                        </td>
                        <td>
                          {room.roomType}
                          <small>{room.roomId}</small>
                        </td>
                        <td>
                          <FunctionSelect
                            labels={labels}
                            value={room.label}
                            disabled={busy || !room.eligible}
                            name={`建议类别 ${room.roomId}`}
                            onChange={(label) =>
                              setPreview(preview.map((row, i) => (i === index ? { ...row, label } : row)))
                            }
                          />
                        </td>
                        <td>{room.reason || "可生成 · 待确认"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={disabled || !preview.some((room) => room.selected && room.eligible)}
                  onClick={generate}
                >
                  保存备份并生成（{preview.filter((room) => room.selected && room.eligible).length}）
                </button>
              </div>
            </>
          )}
          {dialog === "review" && (!compact || section === "zones") && (
            <>
              <p>
                此处只确认整室继承分区的类别，不会确认连通线或提交任务。
              </p>
              <div className={styles.reviewGroups} role="group" aria-label="分区列表范围">
                <button type="button" aria-pressed={!showAllZones} onClick={() => setShowAllZones(false)}>
                  待复核（{pending.length}）
                </button>
                <button type="button" aria-pressed={showAllZones} onClick={() => setShowAllZones(true)}>
                  全部分区（{allZones.length}）
                </button>
              </div>
              <div className={styles.actions}>
                {compact && item.wholeRoomCandidates.some((room) => room.eligible) &&
                  <button type="button" disabled={disabled} onClick={openPreview}>为空房间生成整室分区</button>}
                <button
                  type="button"
                  disabled={disabled || !pending.some((zone) => zone.source)}
                  onClick={() => confirm(pending.filter((zone) => zone.source).map((zone) => zone.id))}
                >
                  确认本组分区类别（{pending.filter((zone) => zone.source).length}）
                </button>
              </div>
              {visibleZones.length > 0 && <div className={styles.tableScroll}>
                <table>
                  <thead>
                    <tr>
                      <th>所属房间（L1）</th>
                      <th>功能分区（L2）</th>
                      <th>轮廓 / 确认状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleZones.map((zone) => (
                      <tr key={zone.id}>
                        <td>
                          {zone.source?.roomType || "来源房间缺失"}
                          {zone.parentRoomId && <small>房间 ID：{zone.parentRoomId}</small>}
                        </td>
                        <td>
                          {zone.review ? <FunctionSelect
                            labels={labels}
                            value={zone.label}
                            disabled={disabled || !zone.source}
                            name={`功能类别 ${zone.id}`}
                            onChange={(label) =>
                              run(async () => {
                                item.setWholeRoomZoneLabel(zone.id, label);
                                await save();
                              })
                            }
                          /> : zone.label || "未标注类别"}
                          <small>分区 ID：{zone.id}</small>
                        </td>
                        <td>
                          {zone.review
                            ? `${zone.review.wholeRoom ? "整室" : "已调整"} · ${zone.review.reviewed ? "已确认" : "待确认"}`
                            : "手工绘制 · 不适用继承复核"}
                          {zone.review?.sourceChanged && <small className={styles.error}>来源已变更，请复核</small>}
                        </td>
                        <td>
                          <button type="button" disabled={disabled} onClick={() => locate(zone)}>
                            定位
                          </button>{" "}
                          {zone.review && <button
                            type="button"
                            disabled={disabled || zone.review.reviewed || !zone.source}
                            onClick={() => confirm([zone.id])}
                          >
                            确认
                          </button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>}
              {!visibleZones.length && <p>{showAllZones ? "当前没有功能分区。" : "没有待复核的分区。"}</p>}
            </>
          )}
          {dialog === "subdivide" && (
            <>
              <p>
                确认后先保存「细分前快照」，再移除 {subdivision?.room} 中的整室分区及其类别。
              </p>
              <p>房间参考、Portal 和人工 Vector 保留。移除可撤销；之后请自行绘制分区，不会自动补余或填回。</p>
              <button type="button" disabled={disabled} onClick={subdivide}>
                确认移除该自动分区并开始细分
              </button>
            </>
          )}
          {dialog === "history" && (
            <>
              {snapshots?.length === 0 && <p>此草稿没有细分前快照。</p>}
              {!!snapshots?.length && <ul>
                {snapshots.map((snapshot) => (
                  <li key={snapshot.id}>
                    {snapshot.room_type || snapshot.room_id} · {snapshot.label} · {new Date(snapshot.created_at).toLocaleString()}{" "}
                    <button type="button" disabled={disabled} onClick={() => previewRestore(snapshot.id)}
                      aria-label={`预览恢复 ${snapshot.label} ${snapshot.id}`}>预览恢复</button>
                  </li>
                ))}
              </ul>}
              {restorePreview && <section aria-label="恢复预览">
                <h3>恢复 {restorePreview.room_type || restorePreview.room_id} · {restorePreview.label}</h3>
                <p>仅恢复此整室分区，不替换当前草稿。</p>
                {restorePreview.blocked_reason && <p role="alert">{restorePreview.blocked_reason}</p>}
                {!!restorePreview.conflicts.length && <ul>
                  {restorePreview.conflicts.map(({ zone_id, label }) => <li key={zone_id}>{label || "未标注类别"}（{zone_id}）</li>)}
                </ul>}
                <button type="button" disabled={disabled || !!restorePreview.blocked_reason} onClick={restore}>恢复整室分区</button>
              </section>}
            </>
          )}
          {saveError && (
            <p className={styles.error} role="alert">
              {saveError}。本地修改仍保留；可取消对话框后导出恢复 JSON。
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          <div className={styles.actions}>
            {dialog === "review" && controller && <button type="button" disabled={disabled} onClick={openHistory}>细分历史</button>}
            {dialog === "history" && <button type="button" disabled={disabled} onClick={() => { setError(""); setDialog("review"); }}>返回复核</button>}
            <button type="button" disabled={disabled} onClick={() => compact && dialog === "generate" ? setDialog("review") : close()}>
              {["review", "history"].includes(dialog) ? "关闭" : compact && dialog === "generate" ? "返回分区类别" : "取消"}
            </button>
            {busy && <span>正在保存 / 处理，请勿关闭窗口…</span>}
          </div>
        </div>
      </Modal>
    </div>
  );
});
