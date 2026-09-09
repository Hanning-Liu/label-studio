import { useEffect, useRef } from "react";
import { observer } from "mobx-react";

import { GROUP_TYPES } from "../occupancy/domain";
import { FURNITURE_TYPES } from "./domain";
import { REVIEW_LABELS } from "./review";
import { useFurnitureReviewSession } from "./reviewSession";
import styles from "./FurnitureInstanceControls.module.scss";

const short = (value) => (value?.length > 22 ? `${value.slice(0, 11)}…${value.slice(-8)}` : value || "—");
const STALE_PARENT_CODES = new Set(["parent_missing", "parent_chain", "parent_stale", "stale_status"]);

export const effectiveFurnitureInstanceReviewStatus = (instance, issues = []) =>
  issues.some((issue) => issue.instanceId === instance.id && STALE_PARENT_CODES.has(issue.code))
    ? "stale"
    : instance.context.review_status;

const progress = (counts) => `已复核 ${counts.reviewed} / 待复核 ${counts.pending} / 需处理 ${counts.blocked}`;

export const FurnitureReviewBar = observer(({ item, review }) => {
  const root = useRef(null);
  useEffect(() => {
    let inReview = false;
    const activate = (event) => {
      inReview = Boolean(root.current?.contains(event.target) || item.stageRef?.container()?.contains(event.target));
    };
    const keydown = (event) => {
      const editable = event.target?.closest?.(
        'input, textarea, select, [contenteditable="true"], [role="dialog"], .ant-modal',
      );
      const foreignButton = event.target?.closest?.("button, a") && !root.current?.contains(event.target);
      if (
        event.key !== "Enter" ||
        !event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.repeat ||
        event.isComposing ||
        editable ||
        foreignButton ||
        !inReview ||
        !review.active ||
        review.blockReason ||
        item.annotation.store.settings?.enableHotkeys === false ||
        review.selectedRow?.status !== "pending" ||
        document.querySelector('[role="dialog"][aria-modal="true"], .ant-modal-wrap:not([style*="display: none"])')
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void review.confirm([review.selectedRow.id], { advance: true });
    };
    document.addEventListener("pointerdown", activate, true);
    document.addEventListener("focusin", activate, true);
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("pointerdown", activate, true);
      document.removeEventListener("focusin", activate, true);
      document.removeEventListener("keydown", keydown, true);
    };
  }, [item, review]);
  const reason = review.blockReason;
  return (
    <section ref={root} className={styles.reviewBar} aria-label="家具快速复核">
      <strong>复核进度</strong>
      <div aria-label="全任务复核进度">全任务：{progress(review.counts.total)}</div>
      <div aria-label="本组复核进度">本组：{progress(review.groupCounts)}</div>
      <label>
        显示状态
        <select
          aria-label="家具复核状态筛选"
          value={review.filter}
          disabled={!!review.navigationBlock}
          onChange={(event) => review.setFilter(event.target.value)}
        >
          <option value="all">全部</option>
          <option value="pending">待复核</option>
          <option value="blocked">需处理</option>
          <option value="reviewed">已复核</option>
        </select>
      </label>
      <div className={styles.reviewActions}>
        <button
          type="button"
          disabled={!!reason}
          title={reason || "当前组团优先，连续处理全任务"}
          onClick={review.start}
        >
          {review.active ? "继续复核" : "开始复核"}
        </button>
        <button
          type="button"
          disabled={!!reason || !review.active || review.selectedRow?.status !== "pending"}
          title={reason || "保存成功后选择下一条待复核实例（Shift+Enter）"}
          onClick={() => review.confirm([review.selectedRow.id], { advance: true })}
        >
          确认并下一个
        </button>
        {review.active && (
          <button type="button" onClick={review.stop}>
            退出连续复核
          </button>
        )}
      </div>
      <div className={styles.reviewActions}>
        <button
          type="button"
          disabled={!!reason || !item.furnitureInstanceFocusId || !["all", "pending"].includes(review.filter)}
          onClick={review.selectAll}
        >
          全选本组可复核项
        </button>
        <button type="button" disabled={!!review.navigationBlock || !review.checkedIds.length} onClick={review.clear}>
          清空勾选
        </button>
        <button
          type="button"
          className={styles.confirmBatch}
          disabled={!!reason || !review.checkedIds.length}
          onClick={() => review.confirm(review.checkedIds, { batch: true })}
        >
          确认勾选的 {review.checkedIds.length} 个实例
        </button>
      </div>
      {review.referenceBlock && (
        <p role="alert" className={styles.error}>
          {review.referenceBlock}
        </p>
      )}
      {review.unsaved && (
        <div role="alert" className={styles.error}>
          {review.pending ? `本次 ${review.pending.ids.length} 个确认尚未保存` : "当前修改尚未保存"}
          <button
            type="button"
            disabled={review.busy || item.annotation.isDrawing || item.annotation.hasIncompletePolygons}
            onClick={review.retry}
          >
            仅重试保存
          </button>
        </div>
      )}
      {review.error && (
        <p role="alert" className={styles.error}>
          {review.error}
        </p>
      )}
      {review.problems.length > 0 && (
        <ul aria-label="本次复核问题" className={styles.error}>
          {review.problems.map((problem) => (
            <li key={problem.id}>
              <button type="button" disabled={!!review.navigationBlock} onClick={() => review.locate(problem.id)}>
                {short(problem.id)}：{problem.message}
              </button>
            </li>
          ))}
        </ul>
      )}
      {review.notice && <p role="status">{review.notice}</p>}
      {review.snapshot.globalIssues.length > 0 && (
        <ul className={styles.error} aria-label="全局复核问题">
          {review.snapshot.globalIssues.map((issue, index) => (
            <li key={`${issue.code}:${index}`}>{issue.message}</li>
          ))}
        </ul>
      )}
      <small>勾选表示你已检查该实例；确认后保存草稿，正式提交仍由你操作。</small>
    </section>
  );
});

export const FurnitureInstanceOutliner = observer(({ item }) => {
  const review = useFurnitureReviewSession(item);
  const blocked = !!review.navigationBlock;
  const parents = item.furnitureInstanceParents;
  const rows = review.snapshot.rows;
  const visible = (row) =>
    review.filter === "all" ||
    row.status === review.filter ||
    ((review.busy || review.unsaved) && review.pending?.ids.includes(row.id));
  const renderRow = (row) => {
    const instance = row.instance;
    const name = `${FURNITURE_TYPES[instance.context.instance_type] || instance.context.instance_type} · ${short(instance.id)}`;
    const canCheck = !review.blockReason && row.status === "pending" && row.groupId === item.furnitureInstanceFocusId;
    const waiting = review.pending?.ids.includes(row.id) && (review.busy || review.unsaved);
    return (
      <div key={row.id} className={styles.reviewRow}>
        <input
          type="checkbox"
          aria-label={`勾选已检查：${name}`}
          checked={!!review.checked[row.id]}
          disabled={!canCheck}
          title={
            canCheck
              ? "勾选不会移动画布"
              : review.blockReason ||
                (row.status === "reviewed"
                  ? "已复核，无需重复确认"
                  : row.status === "blocked"
                    ? "请先处理实例问题"
                    : "请先 Focus 本组团")
          }
          onChange={() => review.toggle(row.id)}
        />
        <div>
          <button
            type="button"
            disabled={blocked}
            aria-pressed={item.furnitureInstanceEffectiveSelectedId === row.id}
            onClick={() => review.locate(row.id)}
          >
            {name} · {waiting ? "确认待保存" : REVIEW_LABELS[row.status]}
          </button>
          {!!row.errors.length && (
            <ul className={styles.error}>
              {row.errors.map((issue, index) => (
                <li key={index}>{issue.message}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  };
  return (
    <div className={styles.outliner} aria-label="L4 家具实例列表">
      <FurnitureReviewBar item={item} review={review} />
      <p>家具实例 {rows.length} · 父级链只读且不可由当前 Focus 覆盖</p>
      {parents.map((parent) => {
        const own = rows.filter((row) => row.groupId === parent.id);
        if (!own.length) return null;
        const focused = item.furnitureInstanceFocusId === parent.id;
        return (
          <section
            key={parent.id}
            className={styles.reviewGroup}
            aria-label={`${GROUP_TYPES[parent.groupType] || parent.groupType}组团`}
          >
            <button
              type="button"
              disabled={blocked}
              aria-expanded={focused}
              onClick={() => review.focusGroup(parent.id)}
            >
              {GROUP_TYPES[parent.groupType] || parent.groupType} · {short(parent.id)}
              <br />
              房间 {short(parent.roomId)} / 分区 {short(parent.zoneId)}
              <br />
              {progress(review.counts.groups[parent.id] || { reviewed: 0, pending: 0, blocked: 0 })}
            </button>
            {focused && (own.some(visible) ? own.filter(visible).map(renderRow) : <span>本组没有符合筛选的实例</span>)}
          </section>
        );
      })}
      {rows.filter((row) => !parents.some((parent) => parent.id === row.groupId) && visible(row)).map(renderRow)}
    </div>
  );
});

export const FurnitureInstanceDetails = observer(({ item }) => {
  const review = useFurnitureReviewSession(item);
  const selectedIds = new Set(item.annotation.selectedRegions.map((region) => region.cleanId));
  const rows = item.furnitureInstanceLogicals.filter((instance) =>
    instance.results.some((result) => selectedIds.has(result.id)),
  );
  return (
    <div className={styles.outliner}>
      {rows.map((instance) => {
        const parent = item.furnitureInstanceParents.find((candidate) => candidate.id === instance.context.group_id);
        const issues = item.furnitureInstanceErrors.filter((issue) => issue.instanceId === instance.id);
        const status = REVIEW_LABELS[review.snapshot.rows.find((row) => row.id === instance.id)?.status] || "需处理";
        return (
          <section key={instance.id}>
            <strong>{FURNITURE_TYPES[instance.context.instance_type] || instance.context.instance_type}</strong>
            <p>{instance.id}</p>
            <p>
              房间 {short(instance.context.room_id)} → 分区 {short(instance.context.zone_id)} → 组团{" "}
              {short(instance.context.group_id)}
            </p>
            <p>{parent ? `父级存在 · ${status}` : "原父级已删除 · stale（未迁移）"}</p>
            <p>
              几何部分 {instance.parts.length} · 朝向证据 {instance.orientationResults.length || 0}
            </p>
            <p>{issues.length ? `需处理 ${issues.length} 项` : "正式提交校验通过"}</p>
          </section>
        );
      })}
    </div>
  );
});
