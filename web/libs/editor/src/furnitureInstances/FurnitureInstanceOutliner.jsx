import { useState } from "react";
import { observer } from "mobx-react";

import { GROUP_TYPES } from "../occupancy/domain";
import { focusOccupancy } from "../occupancy/focus";
import { FURNITURE_TYPES } from "./domain";
import styles from "./FurnitureInstanceControls.module.scss";

const short = (value) => (value?.length > 22 ? `${value.slice(0, 11)}…${value.slice(-8)}` : value || "—");
const STALE_PARENT_CODES = new Set(["parent_missing", "parent_chain", "parent_stale", "stale_status"]);

export const effectiveFurnitureInstanceReviewStatus = (instance, issues = []) =>
  issues.some((issue) => issue.instanceId === instance.id && STALE_PARENT_CODES.has(issue.code))
    ? "stale"
    : instance.context.review_status;

export const FurnitureInstanceOutliner = observer(({ item }) => {
  const [error, setError] = useState("");
  const blocked = item.furnitureInstanceBusy || item.annotation.isDrawing || item.annotation.hasIncompletePolygons;
  const locate = async (instance) => {
    try {
      item.selectFurnitureInstance(instance.id);
      await focusOccupancy(item, instance.geometry);
      setError("");
    } catch (cause) {
      setError(cause.message);
    }
  };
  const parents = item.furnitureInstanceParents;
  const rows = item.furnitureInstanceLogicals;
  return (
    <div className={styles.outliner} aria-label="L4 家具实例列表">
      <p>家具实例 {rows.length} · 父级链只读且不可由当前 Focus 覆盖</p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {parents.map((parent) => (
        <details key={parent.id} open={item.furnitureInstanceFocusId === parent.id}>
          <summary>
            {GROUP_TYPES[parent.groupType] || parent.groupType} · {short(parent.id)} · 房间 {short(parent.roomId)} /
            分区 {short(parent.zoneId)}
          </summary>
          {rows
            .filter((instance) => instance.context.group_id === parent.id)
            .map((instance) => {
              const status = effectiveFurnitureInstanceReviewStatus(instance, item.furnitureInstanceErrors);
              return (
                <button
                  type="button"
                  key={instance.id}
                  disabled={blocked}
                  aria-pressed={item.furnitureInstanceEffectiveSelectedId === instance.id}
                  onClick={() => locate(instance)}
                >
                  {FURNITURE_TYPES[instance.context.instance_type] || instance.context.instance_type} ·{" "}
                  {short(instance.id)} · {status}
                </button>
              );
            })}
        </details>
      ))}
      {rows
        .filter((instance) => !parents.some((parent) => parent.id === instance.context.group_id))
        .map((instance) => (
          <button type="button" key={instance.id} disabled={blocked} onClick={() => locate(instance)}>
            父级已失效：{FURNITURE_TYPES[instance.context.instance_type]} · {short(instance.id)} · stale
          </button>
        ))}
    </div>
  );
});

export const FurnitureInstanceDetails = observer(({ item }) => {
  const selectedIds = new Set(item.annotation.selectedRegions.map((region) => region.cleanId));
  const rows = item.furnitureInstanceLogicals.filter((instance) =>
    instance.results.some((result) => selectedIds.has(result.id)),
  );
  return (
    <div className={styles.outliner}>
      {rows.map((instance) => {
        const parent = item.furnitureInstanceParents.find((candidate) => candidate.id === instance.context.group_id);
        const issues = item.furnitureInstanceErrors.filter((issue) => issue.instanceId === instance.id);
        const status = effectiveFurnitureInstanceReviewStatus(instance, issues);
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
