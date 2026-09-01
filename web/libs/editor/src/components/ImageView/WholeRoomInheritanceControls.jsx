import { useRef, useState } from "react";
import { observer } from "mobx-react";
import { Modal } from "antd";
import { zoneFingerprint } from "../../utils/wholeRoomInheritance";
import styles from "./WholeRoomInheritanceControls.module.scss";

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

const FunctionSelect = ({ labels, value, onChange, disabled, name }) => (
  <select aria-label={name} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    {labels.map((label) => (
      <option key={label} value={label}>
        {label === "Sanitary/general" ? "Sanitary/general · 卫浴综合" : label}
      </option>
    ))}
  </select>
);

export const WholeRoomInheritanceControls = observer(({ item }) => {
  const [dialog, setDialog] = useState(null);
  const [preview, setPreview] = useState([]);
  const [subdivision, setSubdivision] = useState(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const annotation = item.annotation;
  if (!item.wholeRoomInheritanceEnabled || !annotation.editable || annotation.isReadOnly()) return null;

  const zones = item.wholeRoomZones.filter((zone) => zone.review);
  const pending = zones.filter((zone) => !zone.review.reviewed);
  const labels = item.wholeRoomLabels;
  const disabled = busy || !!annotation.submissionStarted;
  const focusedZone = zones.find((zone) => zone.parentRoomId === item.focusedRoom?.cleanId);
  const subdivisionReason = item.wholeRoomSubdivisionReason(focusedZone?.id);
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
      setDialog(null);
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
      await saveAndBackup("before-whole-room-subdivision");
      const zone = item.wholeRoomZones.find((candidate) => candidate.id === id);
      if (item.wholeRoomSubdivisionReason(id)) throw new Error("分区已变化，请重新检查");
      setSubdivision({ id, room: zone.source.roomType, fingerprint: zoneFingerprint(zone.result, zone.label) });
      setDialog("subdivide");
    });
  const subdivide = () =>
    run(async () => {
      // Re-check the server revision after the confirmation dialog, before deletion.
      await save();
      const zone = item.wholeRoomZones.find((candidate) => candidate.id === subdivision.id);
      if (!zone || zoneFingerprint(zone.result, zone.label) !== subdivision.fingerprint)
        throw new Error("分区已变化，请取消后重新检查");
      item.startWholeRoomSubdivision(subdivision.id);
      setDialog(null);
      await save();
      setNotice("已移除自动整室分区并保存草稿。Focus room 已保留，请手工绘制；可以撤销本次移除。");
    });
  const locate = (zone) => {
    item.setFocusedRoom(zone.parentRoomId);
    annotation.unselectAreas();
    annotation.selectAreas([zone.region]);
    setDialog(null);
  };

  return (
    <div className={styles.controls} data-testid="whole-room-controls">
      <div className={styles.actions}>
        <button type="button" disabled={disabled} onClick={openPreview}>
          为空房间生成整室分区
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setError("");
            setDialog("review");
          }}
        >
          待确认分区（{pending.length}）
        </button>
        <button
          type="button"
          disabled={disabled || !!subdivisionReason}
          title={subdivisionReason || "备份并移除当前房间的自动整室分区"}
          onClick={prepareSubdivision}
        >
          开始细分
        </button>
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
        <button type="button" disabled={busy} onClick={() => exportWholeRoomRecovery(annotation, "manual-recovery")}>
          导出恢复 JSON
        </button>
      </div>
      <div className={saveError ? styles.error : styles.status} role={saveError ? "alert" : "status"}>
        {status}
        {notice ? ` · ${notice}` : ""}
      </div>
      <Modal
        visible={!!dialog}
        title={
          dialog === "generate" ? "为空房间生成整室分区" : dialog === "review" ? "自动继承分区确认" : "确认开始手工细分"
        }
        onCancel={() => !busy && setDialog(null)}
        maskClosable={false}
        keyboard={!busy}
        closable={!busy}
        footer={null}
        width={960}
        destroyOnClose
      >
        <div className={styles.dialog}>
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
                  disabled={busy || !preview.some((room) => room.selected && room.eligible)}
                  onClick={generate}
                >
                  保存备份并生成（{preview.filter((room) => room.selected && room.eligible).length}）
                </button>
              </div>
            </>
          )}
          {dialog === "review" && (
            <>
              <p>
                确认的是功能分区类别，不会确认连通 Vector，也不会提交任务。修改类别或轮廓、来源房间变化后需重新确认。
              </p>
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={busy || !pending.length}
                  onClick={() => confirm(pending.map((zone) => zone.id))}
                >
                  确认全部待确认分区（{pending.length}）
                </button>
              </div>
              <div className={styles.tableScroll}>
                <table>
                  <thead>
                    <tr>
                      <th>房间</th>
                      <th>功能类别</th>
                      <th>轮廓 / 确认状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {zones.map((zone) => (
                      <tr key={zone.id}>
                        <td>
                          {zone.source?.roomType || "来源房间缺失"}
                          <small>{zone.parentRoomId}</small>
                        </td>
                        <td>
                          <FunctionSelect
                            labels={labels}
                            value={zone.label}
                            disabled={busy}
                            name={`功能类别 ${zone.id}`}
                            onChange={(label) =>
                              run(async () => {
                                item.setWholeRoomZoneLabel(zone.id, label);
                                await save();
                              })
                            }
                          />
                        </td>
                        <td>
                          {zone.review.wholeRoom ? "整室" : "已调整"} · {zone.review.reviewed ? "已确认" : "待确认"}
                          {zone.review.sourceChanged && <small className={styles.error}>来源已变更，请复核</small>}
                        </td>
                        <td>
                          <button type="button" disabled={busy} onClick={() => locate(zone)}>
                            定位
                          </button>{" "}
                          <button
                            type="button"
                            disabled={busy || zone.review.reviewed || !zone.source}
                            onClick={() => confirm([zone.id])}
                          >
                            确认
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!zones.length && <p>当前没有自动继承分区；既有人工分区无需本次确认。</p>}
            </>
          )}
          {dialog === "subdivide" && (
            <>
              <p>
                已保存草稿并导出恢复 JSON。将移除 {subdivision?.room} 中的自动整室分区 {subdivision?.id}{" "}
                及配对类别结果。
              </p>
              <p>房间参考、Portal 和人工 Vector 保留。移除可撤销；之后请自行绘制分区，不会自动补余或填回。</p>
              <button type="button" disabled={busy} onClick={subdivide}>
                确认移除该自动分区并开始细分
              </button>
            </>
          )}
          {saveError && (
            <p className={styles.error} role="alert">
              {saveError}。本地修改仍保留；可取消对话框后导出恢复 JSON。
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          <div className={styles.actions}>
            <button type="button" disabled={busy} onClick={() => setDialog(null)}>
              {dialog === "review" ? "关闭" : "取消"}
            </button>
            {busy && <span>正在保存 / 处理，请勿关闭窗口…</span>}
          </div>
        </div>
      </Modal>
    </div>
  );
});
