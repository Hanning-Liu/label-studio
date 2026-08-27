import { useState } from "react";
import { observer } from "mobx-react";
import { GROUP_TYPES, TYPES } from "./domain";
import { focusOccupancy } from "./focus";
import styles from "./OccupancyControls.module.scss";
import { editableParts } from "./editing";

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
        <details key={p.id} open={item.occupancyFocusId === p.id}>
          <summary>{p.label}</summary>
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
                >
                  {name(r)} · {r.geometry.length} 个分块{r.context.generation === "pending" ? " · 待应用" : ""}
                  <small>{r.id}</small>
                </button>
                {item.occupancySelectedId === r.id && editableParts(r).length > 1 && (
                  <div>
                    {editableParts(r).map((part, index) => (
                      <button
                        key={part.id}
                        disabled={blocked}
                        onClick={() => item.editOccupancyPart(part.id)}
                        aria-pressed={item.occupancyActivePartId === part.id}
                      >
                        编辑分块 {index + 1}（{part.type === "rectangle" ? "矩形" : "多边形"}）
                      </button>
                    ))}
                  </div>
                )}
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
            {name(r)} · {r.geometry.length} 个占地分块
          </strong>
          <p className={styles.small}>{r.id}</p>
          <p>{item.occupancyParents.find((p) => p.id === r.context.parent_zone_id)?.label || "父分区待重新绑定"}</p>
          <p>
            {item.occupancyErrors.some((e) => e.parentId === r.context.parent_zone_id) ? "待处理 / 待复核" : "已复核"}
          </p>
          <p>分类、继续添加分块、局部修正和安全删除，请使用顶部“组团与空闲区域”。</p>
          <p>
            {editableParts(r).length
              ? "单分块选中即可拖动/调整；多个分块请在 Regions 列表选择“编辑分块”。"
              : "自动补余或带孔洞区域请使用局部修正，不编辑内部存储分块。"}
          </p>
        </section>
      ))}
    </div>
  );
});
