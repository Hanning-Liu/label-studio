import { useState } from "react";
import { observer } from "mobx-react";
import { GROUP_TYPES, TYPES } from "./domain";
import { focusOccupancy } from "./focus";
import { COLORS } from "./OccupancyLayer";
import { ParentIdentity, roomStyle, shortId } from "./OccupancyPresentation";
import styles from "./OccupancyControls.module.scss";

const name = (r) => (r.type === "furniture_group" ? GROUP_TYPES[r.context.group_type] : TYPES[r.type]);

export const OccupancyOutliner = observer(({ item }) => {
  const [error, setError] = useState("");
  const blocked = item.occupancyBusy || item.annotation.isDrawing || item.annotation.hasIncompletePolygons;
  const locate = async (r) => {
    try {
      item.selectOccupancyLogical(r.id);
      await focusOccupancy(item, r.geometry);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  };
  const rows = item.occupancyLogicals;
  return (
    <div className={styles.outliner} aria-label="L3 逻辑区域列表">
      <p>逻辑区域 {rows.length} · 内部存储拆分边不显示</p>
      {error && <p role="alert">{error}</p>}
      {item.occupancyParents.map((p) => (
        <details key={p.id} open={item.occupancyFocusId === p.id} className={styles.parentGroup} style={roomStyle(p)}>
          <summary className={styles.parentSummary}>
            <ParentIdentity parent={p} />
          </summary>
          {rows
            .filter((r) => r.context.parent_zone_id === p.id)
            .map((r) => (
              <div key={r.id}>
                <button
                  className={styles.logicalRow}
                  key={r.id}
                  disabled={blocked}
                  onClick={() => locate(r)}
                  aria-pressed={item.occupancySelectedId === r.id}
                  style={roomStyle(p)}
                  title={`${p.roomLabel} · ${p.functionLabel} · ${r.id}`}
                >
                  <span className={styles.logicalPrimary}>
                    <span className={styles.typeSwatch} style={{ backgroundColor: COLORS[r.type] }} aria-hidden="true" />
                    <strong>{name(r)}</strong>
                  </span>
                  <small>区域 ID {shortId(r.id, 12)}</small>
                </button>
              </div>
            ))}
        </details>
      ))}
      {rows
        .filter((r) => !item.occupancyParents.some((p) => p.id === r.context.parent_zone_id))
        .map((r) => (
          <button key={r.id} disabled={blocked} onClick={() => locate(r)}>
            待重新绑定：{name(r)} · {r.id}
          </button>
        ))}
      <details>
        <summary>只读参考对象</summary>
        {item.regs
          .filter((r) => r.results.some((s) => item.occupancyIsReference(s.from_name?.name)))
          .map((r) => (
            <button
              key={r.id}
              disabled={blocked}
              className={styles.logicalRow}
              onClick={() => {
                item.annotation.unselectAreas();
                item.annotation.selectAreas([r]);
              }}
            >
              {r.results
                .map((s) => s.value?.[s.type])
                .flat()
                .filter((v) => typeof v === "string")
                .join(" · ") || r.type}{" "}
              · {r.cleanId}
            </button>
          ))}
      </details>
    </div>
  );
});

export const OccupancyDetails = observer(({ item }) => {
  const ids = new Set(item.annotation.selectedRegions.map((r) => r.cleanId));
  const rows = item.occupancyLogicals.filter((r) => r.parts.some((part) => ids.has(part.id)));
  return (
    <div className={styles.outliner}>
      {rows.map((r) => (
        <section key={r.id}>
          <strong>
            {name(r)}
          </strong>
          <p className={styles.small}>{r.id}</p>
          {item.occupancyParents.find((p) => p.id === r.context.parent_zone_id) ? (
            <p style={roomStyle(item.occupancyParents.find((p) => p.id === r.context.parent_zone_id))}>
              <ParentIdentity parent={item.occupancyParents.find((p) => p.id === r.context.parent_zone_id)} />
            </p>
          ) : (
            <p>父分区待重新绑定</p>
          )}
          <p>
            {item.occupancyErrors.some((e) => e.parentId === r.context.parent_zone_id) ? "待处理 / 待复核" : "已复核"}
          </p>
          <p>家具组团可在顶部“预览组团”中重新分类；可编辑轮廓可直接在画布上调整。</p>
        </section>
      ))}
    </div>
  );
});
