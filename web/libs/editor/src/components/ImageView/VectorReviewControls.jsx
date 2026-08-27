import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { Modal } from "antd";
import { vectorReviewDockEnabled, vectorReviewRows } from "../../utils/vectorReviewDock";
import { focusReviewVector } from "../../utils/vectorReviewFocus";
import styles from "./VectorReviewControls.module.scss";

// Controller state is not an MST observable; refresh buttons when references arrive.
function useReviewStatus(item) {
  const controller = item.annotation.store?.referenceSyncController;
  const [, refresh] = useState(0);
  useEffect(() => controller?.subscribe(() => refresh((value) => value + 1)), [controller]);
  return item.vectorReviewBlockReason?.() || "";
}

export const VectorReviewButton = observer(({ item, disabled = false }) => {
  const [dialog, setDialog] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const running = useRef(false);
  const reason = useReviewStatus(item);
  if (!vectorReviewDockEnabled(item)) return null;
  const rows = vectorReviewRows(item);
  const pending = rows.filter((row) => !row.reviewed).length;
  const busy = item.vectorReviewBusy;
  const blocked = disabled || busy || item.annotation.isDraftSaving || !!reason;
  const prepare = () => {
    setError("");
    setNotice("");
    setPreview(item.captureVectorReview());
    setDialog("confirm");
  };
  const locate = (row) => {
    setDialog(null);
    setError("");
    setNotice("");
    focusReviewVector(item, row.id).catch((failure) => setError(failure.message));
  };
  const confirm = async () => {
    if (running.current) return;
    running.current = true;
    setError("");
    setNotice("");
    try {
      const count = await item.confirmAllVectorsAndSave(preview);
      setNotice("已复核 " + count + " 条 Vector 并保存草稿；未确认分区或参考变更，未提交任务。");
      setDialog(null);
    } catch (failure) {
      setError(failure.message || "复核失败，请保留当前窗口");
      // Never reuse a stale preview after a rejected save.
      setPreview(null);
      setDialog("list");
    } finally {
      running.current = false;
    }
  };
  return (
    <>
      <button type="button" disabled={disabled || busy} onClick={() => setDialog("list")}>
        连通 Vector 待复核（{pending}）
      </button>
      <button
        type="button"
        title={reason || "确认本任务全部待复核人工 Vector"}
        disabled={blocked || !pending}
        onClick={prepare}
      >
        复核全部（{pending}）
      </button>
      {error && (
        <span role="alert" className={styles.error}>
          {error}
        </span>
      )}
      {notice && (
        <span role="status" className={styles.notice}>
          {notice}
        </span>
      )}
      <Modal
        visible={!!dialog}
        title={dialog === "confirm" ? "确认全部待复核 Vector" : "连通 Vector 复核"}
        onCancel={() => !busy && setDialog(null)}
        footer={null}
        width={800}
        destroyOnClose
        maskClosable={false}
        closable={!busy}
        keyboard={!busy}
      >
        <div className={styles.dialog}>
          {dialog === "confirm" ? (
            <>
              <p>
                本次将复核 {preview?.rows.length || 0} 条人工连通线：交通连通{" "}
                {preview?.rows.filter((r) => r.type === "交通连通").length || 0} 条，视觉连通{" "}
                {preview?.rows.filter((r) => r.type === "仅视觉连通").length || 0} 条。
              </p>
              <p>
                表示你已检查这些连通线的位置、类别和两侧分区，不代表系统自动判断正确。操作会保存草稿，但不会确认分区或参考变更，也不会提交任务。
              </p>
              {reason && <p role="alert">{reason}</p>}
              <button type="button" disabled={blocked || !preview?.rows.length} onClick={confirm}>
                已检查，确认全部
              </button>{" "}
              <button type="button" disabled={busy} onClick={() => setDialog(null)}>
                取消
              </button>
            </>
          ) : (
            <>
              <p>定位会将目标线带到工具条下方。检查后在常驻工具条勾选 Reviewed，或明确确认全部。</p>
              <button type="button" disabled={blocked || !pending} title={reason} onClick={prepare}>
                复核全部（{pending}）
              </button>
              {reason && <p role="alert">{reason}</p>}
              <div className={styles.tableScroll}>
                <table>
                  <thead>
                    <tr>
                      <th>Vector ID</th>
                      <th>连通类别</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <code>{row.id}</code>
                        </td>
                        <td>
                          {row.type}
                          <small>{row.label}</small>
                        </td>
                        <td>
                          {row.reviewed ? "已复核" : "待复核"}
                          {!row.control && <small>缺少复核控件配置</small>}
                        </td>
                        <td>
                          <button
                            type="button"
                            disabled={blocked}
                            onClick={() => locate(row)}
                            aria-label={"定位 Vector " + row.id}
                          >
                            定位
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!rows.length && <p>当前没有可编辑人工连通 Vector；只读 Portal 不在此列表。</p>}
              <button type="button" disabled={busy} onClick={() => setDialog(null)}>
                关闭
              </button>
            </>
          )}
          {busy && <p role="status">正在保存和复核，请勿关闭窗口…</p>}
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
        </div>
      </Modal>
    </>
  );
});

export const VectorReviewPanel = observer(({ item }) => {
  const [error, setError] = useState("");
  const reason = useReviewStatus(item);
  if (!vectorReviewDockEnabled(item)) return null;
  const annotation = item.annotation;
  const selected = annotation.selectedRegions;
  const row =
    selected.length === 1 ? vectorReviewRows(item).find((candidate) => candidate.region === selected[0]) : null;
  const blocked = !!reason || item.vectorReviewBusy || annotation.isDraftSaving;
  const change = (reviewed) => {
    try {
      item.setVectorReview([row.id], reviewed);
      setError("");
    } catch (failure) {
      setError(failure.message);
    }
  };
  return (
    <section className={styles.panel} aria-label="当前连通 Vector 复核" data-testid="vector-review-panel">
      {row ? (
        <>
          <strong>当前 Vector · {row.type}</strong>
          <span>{row.label}</span>
          <code>{row.id}</code>
          <span className={row.reviewed ? styles.reviewed : styles.pending}>{row.reviewed ? "已复核" : "待复核"}</span>
          <label className={styles.choice} title="已检查此线的位置、类别和两侧分区；可取消勾选">
            <input
              name="Reviewed"
              type="checkbox"
              checked={!!row.reviewed}
              disabled={blocked || !row.control}
              onChange={(event) => change(event.target.checked)}
            />
            Reviewed
          </label>
          <button
            type="button"
            disabled={blocked}
            onClick={() => {
              setError("");
              focusReviewVector(item, row.id).catch((failure) => setError(failure.message));
            }}
          >
            重新定位
          </button>
        </>
      ) : (
        <span>单独选中一条人工连通线即可复核，或从待复核列表定位。</span>
      )}
      {error && (
        <span role="alert" className={styles.error}>
          {error}
        </span>
      )}
    </section>
  );
});
