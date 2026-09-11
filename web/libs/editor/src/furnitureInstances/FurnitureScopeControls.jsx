import { observer } from "mobx-react";
import { GROUP_TYPES } from "../occupancy/domain";
import { useFurnitureReviewSession } from "./reviewSession";
import { referenceInScope } from "./scope";
import styles from "./FurnitureInstanceControls.module.scss";

export const FurnitureScopeNavigation = observer(({ item }) => {
  const review = useFurnitureReviewSession(item),
    scope = item.furnitureInstanceScope;
  if (!scope) return null;
  const change = (fn) => {
    try {
      fn();
      review.clear();
    } catch (error) {
      review.setError(error.message);
    }
  };
  const rooms = scope.rooms,
    zones = scope.zones.filter((z) => z.roomId === item.furnitureInstanceRoomId);
  const groups = scope.groups.filter(
    (g) => g.roomId === item.furnitureInstanceRoomId && g.zoneId === item.furnitureInstanceZoneId,
  );
  const reason = review.navigationBlock;
  return (
    <nav className={styles.scopeNavigation} aria-label="L4 空间层级" data-testid="furniture-scope-navigation">
      <div className={styles.row}>
        <label>
          房间
          <select
            aria-label="Focus 房间"
            value={item.furnitureInstanceRoomId}
            disabled={!!reason}
            onChange={(e) => change(() => item.setFurnitureInstanceSpace(e.target.value))}
          >
            <option value="">选择房间</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label} · {r.id}
              </option>
            ))}
          </select>
        </label>
        <span aria-hidden="true">›</span>
        <label>
          功能分区
          <select
            aria-label="Focus 功能分区"
            value={item.furnitureInstanceZoneId}
            disabled={!!reason || !item.furnitureInstanceRoomId}
            onChange={(e) => change(() => item.setFurnitureInstanceSpace(item.furnitureInstanceRoomId, e.target.value))}
          >
            <option value="">选择功能分区</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.label} · {z.id}
              </option>
            ))}
          </select>
        </label>
        <span aria-hidden="true">›</span>
        <label>
          家具组团
          <select
            aria-label="Focus 家具组团"
            value={item.furnitureInstanceFocusId}
            disabled={!!reason || !item.furnitureInstanceZoneId}
            onChange={(e) => change(() => item.setFurnitureInstanceFocus(e.target.value))}
          >
            <option value="">选择家具组团</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {GROUP_TYPES[g.groupType] || g.groupType} · {g.groupNote || g.id}
              </option>
            ))}
          </select>
        </label>
      </div>
      <small>
        {!item.furnitureInstanceRoomId
          ? "第一步：选择房间"
          : !item.furnitureInstanceZoneId
            ? zones.length
              ? "第二步：选择功能分区"
              : "本房间尚无有效功能分区"
            : !item.furnitureInstanceFocusId
              ? groups.length
                ? "查看本区参考，然后选择橙色家具组团"
                : "本分区没有可用家具组团"
              : "当前组团可绘制；其他分区实例仅作为布局背景"}
      </small>
    </nav>
  );
});

export const FurnitureReferencePanel = observer(({ item }) => {
  const review = useFurnitureReviewSession(item),
    scope = item.furnitureInstanceScope;
  if (!scope) return null;
  const visible = scope.references.filter((r) => referenceInScope(item, r));
  const unresolved = scope.references.filter(
    (r) => r.issue && (!r.roomIds.length || r.roomIds.includes(item.furnitureInstanceRoomId)),
  );
  const unique = [...new Map([...visible, ...unresolved].map((r) => [r.key, r])).values()];
  const lineage = review.referenceStatus?.lineage;
  return (
    <details className={styles.referencePanel} open={!!item.furnitureInstanceZoneId}>
      <summary>本区上级参考 · {visible.length} 项</summary>
      <div className={styles.options}>
        {[
          ["windows", "窗"],
          ["openings", "开口"],
          ["connections", "交通/视觉连接"],
          ["barriers", "墙障碍"],
          ["roomBackground", "本房间背景"],
          ["overview", "全图概览"],
        ].map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={
                key === "overview"
                  ? item.furnitureInstanceOverview
                  : key === "roomBackground"
                    ? item.furnitureInstanceRoomBackground
                    : item.furnitureInstanceReferenceLayers[key]
              }
              onChange={(e) => item.setFurnitureInstanceReferenceDisplay(key, e.target.checked)}
            />
            {label}
          </label>
        ))}
      </div>
      {!item.furnitureInstanceZoneId ? (
        <p>选择功能分区后显示相关参考。</p>
      ) : (
        ["L1", "L2", "L3"].map((level) => (
          <section key={level}>
            <strong>{level} 参考</strong>
            {unique
              .filter((r) => r.level === level)
              .map((r) => (
                <div key={r.key} className={styles.referenceRow}>
                  <span>
                    {r.kind} · {r.id}
                    {r.exterior ? " · 连向室外" : ""}
                  </span>
                  <small>
                    {r.zoneIds.includes(item.furnitureInstanceZoneId) ? "本区关联" : "房间背景 / 归属待确认"}
                    {r.zoneIds.length > 1
                      ? ` · 对端 ${r.zoneIds.filter((id) => id !== item.furnitureInstanceZoneId).join("、")}`
                      : ""}
                  </small>
                  {(r.issue || lineage?.ready === false) && (
                    <span className={styles.error}>{r.issue || "来源链未就绪，关联暂未确认"}</span>
                  )}
                </div>
              ))}
          </section>
        ))
      )}
      {[...scope.issues, ...(item.furnitureInstanceWalkableReferences?.errors || [])].map((issue, i) => (
        <p key={i} role="alert" className={styles.error}>
          {issue}
        </p>
      ))}
      <small>仅显示已有标注支持的连接。来源异常请使用页面上方的来源链入口处理。</small>
    </details>
  );
});
