import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import styles from "./ReferenceSyncControls.module.scss";

export const ReferenceLineageStatus = observer(({ item }) => {
  const controller = item.annotation?.store?.referenceSyncController;
  const [state, setState] = useState(controller?.state || {});
  useEffect(() => {
    setState(controller?.state || {});
    return controller?.subscribe(setState);
  }, [controller]);
  const lineage = state.status?.lineage;
  if (!lineage) return null;
  const label = lineage.ready
    ? lineage.window_count === 0
      ? "L1 无窗，窗参考一致"
      : "窗参考一致"
    : lineage.root
      ? "窗参考缺失／过期"
      : "来源尚未确认";
  return (
    <section className={styles.controls} data-testid="reference-lineage-status" aria-label="户型来源链">
      <div role={lineage.ready ? "status" : "alert"}>
        <strong>{label}</strong>
        {lineage.root && <span> · L1 窗线 {lineage.window_count ?? "未知"} 条</span>}
      </div>
      {!lineage.ready && <p>请从最早出现问题的层级处理参考，再逐级保存和提交。当前草稿可以继续保存。</p>}
      {(lineage.issues || []).map((issue, index) => (
        <div key={`${issue.code}-${issue.task_id}-${index}`}>
          <span>{issue.message}</span>
          {!!issue.window_ids?.length && <span> · 窗 ID：{issue.window_ids.join("、")}</span>}
          {issue.project_id && issue.task_id && (
            <a href={`/projects/${issue.project_id}/data?task=${issue.task_id}`} target="_blank" rel="noreferrer">
              {" "}打开 L{issue.level ?? "?"} 任务 {issue.task_id}
            </a>
          )}
        </div>
      ))}
    </section>
  );
});
