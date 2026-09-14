import { useEffect } from "react";
import { observer } from "mobx-react";
import { GROUP_TYPES } from "@hanning/frontend/domain/occupancy/domain";
import { hasSpatialTodo, matchesSpatialFilter, reviewedSpace, spatialPath, uniqueSpaceName } from "@hanning/frontend/domain/furnitureInstances/spatialProgress";
import styles from "@hanning/frontend/components/furnitureInstances/FurnitureInstanceControls.module.scss";

export const FurnitureSpatialTree = observer(({ item, review, renderRow, visibleRow }) => {
  const progress = review.spatialCounts;
  const focusedKey = item.furnitureInstanceFocusId
    ? `group:${item.furnitureInstanceFocusId}`
    : item.furnitureInstanceZoneId
      ? `zone:${item.furnitureInstanceZoneId}`
      : `room:${item.furnitureInstanceRoomId}`;
  useEffect(() => {
    review.expandSpatialPath(focusedKey);
  }, [review, focusedKey]);
  const currentPath = spatialPath(progress, focusedKey);
  const matches = (n) => matchesSpatialFilter(n, review.spatialFilter, review.spatialOnlyTodo);
  const visible = (n) => matches(n) || currentPath.includes(n.key) || n.children.some(visible);
  const blocked = review.scopeNavigationBlock;
  const nodeName = (n) =>
    uniqueSpaceName(
      n.kind === "group" ? { ...n.source, label: GROUP_TYPES[n.source.groupType] || n.source.groupType } : n.source,
      n.kind === "room"
        ? [...progress.rooms.values()].map((r) => r.source)
        : n.kind === "zone"
          ? [...progress.zones.values()].map((r) => r.source)
          : [...progress.groups.values()].map((r) => r.source),
    );
  const draw = (n) => {
    const expanded = !!review.spatialExpanded[n.key];
    const ownRows = n.rows.filter((row) => visibleRow(row) || row.id === item.furnitureInstanceEffectiveSelectedId);
    return (
      <section key={n.key} className={styles.spatialNode} aria-label={`${n.kind}:${n.id}`}>
        <div className={styles.spatialHeading}>
          <button
            type="button"
            aria-label={`展开 ${nodeName(n)}`}
            aria-expanded={expanded}
            onClick={() => review.toggleSpatial(n.key)}
          >
            {expanded ? "▾" : "▸"}
          </button>
          <button
            type="button"
            title={n.id}
            disabled={!!blocked}
            aria-current={focusedKey === n.key ? "location" : undefined}
            onClick={() => review.navigateSpatial(n.kind, n.id)}
          >
            {nodeName(n)}
          </button>
          {hasSpatialTodo(n) && (
            <button
              type="button"
              disabled={!!blocked}
              title={blocked || "只定位本范围待办，不确认或创建"}
              aria-label={`定位待办 ${nodeName(n)}`}
              onClick={() => review.nextSpatialTodo(n.key)}
            >
              定位待办
            </button>
          )}
        </div>
        <div className={styles.spatialCounts} aria-label={`${n.key} 进度`}>
          <div>
            已有实例 {n.populated}/{n.groupTotal} 组 · 待检查空组团 {n.empty}
          </div>
          <div>
            已复核 {n.counts.reviewed} / 待复核 {n.counts.pending} / 需处理 {n.counts.blocked}
          </div>
          {reviewedSpace(n) && <small title="复核只针对已有实例，不代表已排除漏标">已有实例均已复核</small>}
          {!n.groupTotal && !n.issues.length && <small>无家具组团</small>}
          {!!n.unresolved && <small className={styles.error}>归属异常组团 {n.unresolved}</small>}
          {currentPath.includes(n.key) && !matches(n) && <small>当前路径 · 不符合当前筛选</small>}
          {n.issues.map((issue, i) => (
            <small className={styles.error} key={i}>
              {issue}
            </small>
          ))}
        </div>
        {expanded && (
          <div className={styles.spatialChildren}>
            {n.children.filter(visible).map(draw)}
            {n.kind === "group" &&
              (n.empty ? (
                <p>待检查空组团：可选择本组绘制或使用组团轮廓创建。</p>
              ) : ownRows.length ? (
                ownRows.map(renderRow)
              ) : (
                <p>本组没有符合实例筛选的实例</p>
              ))}
          </div>
        )}
      </section>
    );
  };
  return (
    <section className={styles.spatialOverview} aria-label="空间进度概览">
      <strong>空间进度 · 房间 → 分区 → 组团</strong>
      <small>
        {review.unsaved || item.annotation.draftSaveError
          ? "当前修改尚未保存；操作进度保留在保存前"
          : item.annotation.isDraftSaving
            ? "正在保存草稿"
            : item.annotation.savedResultFingerprint !== item.annotation.draftResultFingerprint
              ? "当前窗口进度，尚未保存"
              : "当前标注/草稿进度；草稿不等于正式提交"}
      </small>
      {review.referenceBlock && (
        <p role="alert" className={styles.error}>
          进度基于当前已加载参考，来源需处理：{review.referenceBlock}。请使用页面上方的上游任务入口。
        </p>
      )}
      <label>
        空间状态筛选
        <select
          aria-label="空间状态筛选"
          value={review.spatialFilter}
          onChange={(e) => review.setSpatialFilter(e.target.value)}
        >
          <option value="all">全部</option>
          <option value="empty">待检查空组团</option>
          <option value="pending">待复核</option>
          <option value="blocked">需处理</option>
          <option value="reviewed">已有实例均已复核</option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={review.spatialOnlyTodo}
          onChange={(e) => review.setSpatialFilter(review.spatialFilter, e.target.checked)}
        />
        仅看待办
      </label>
      <button
        type="button"
        disabled={!!blocked}
        title={blocked || "当前分区优先；只定位，不自动确认"}
        onClick={() => review.nextSpatialTodo()}
      >
        下一个待办
      </button>
      {blocked && <small>{blocked}</small>}
      {review.spatialNotice && <p role="status">{review.spatialNotice}</p>}
      {progress.root.children.filter(visible).map(draw)}
      {!progress.root.children.some(visible) && (
        <p>
          没有符合当前空间筛选的房间。
          <button type="button" onClick={() => review.setSpatialFilter("all", false)}>
            查看全部
          </button>
        </p>
      )}
      {!!progress.root.issues.length && (
        <div role="alert" className={styles.error}>
          来源／归属问题：{[...new Set(progress.root.issues)].join("；")}。请检查上游参考。
        </div>
      )}
      {!!progress.unassigned.length && (
        <section aria-label="归属异常实例">
          <strong>归属异常实例 {progress.unassigned.length}</strong>
          {progress.unassigned.map(renderRow)}
        </section>
      )}
    </section>
  );
});
