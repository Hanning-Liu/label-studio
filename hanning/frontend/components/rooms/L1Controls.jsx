import { useEffect } from "react";
import { isAlive } from "mobx-state-tree";
import { observer } from "mobx-react";
import { l1Categories, L1_SHAPES } from "@hanning/frontend/domain/rooms/l1Tools";
import styles from "./L1Controls.module.scss";

export const L1Controls = observer(({ item }) => {
  const annotation = item.annotation;
  useEffect(() => {
    if (isAlive(item)) item.initializeL1Tools();
  }, [item, annotation.id, annotation.store.task?.id]);
  useEffect(() => {
    const cancel = (event) => {
      if (
        isAlive(item) &&
        item.l1ToolbarEnabled &&
        event.key?.toLowerCase() === "v" &&
        !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.isComposing &&
        !event.target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='dialog'], [role='alertdialog'], [role='combobox'], dialog")
      ) {
        // V is also assigned to a legacy room label. Handle it once, before
        // either legacy label handlers or duplicate toolbar toggle handlers.
        item.selectL1MoveTool();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (
        isAlive(item) &&
        ((event.key === "Escape" && item.cancelL1Drawing()) || (event.key === "Enter" && item.finishL1Vector()))
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("keydown", cancel, true);
    return () => document.removeEventListener("keydown", cancel, true);
  }, [item]);
  if (!item.l1ToolbarEnabled) return null;
  const blocked = item.l1SwitchBlockReason;
  const categories = l1Categories(item.l1Config, item.l1Family);
  const families = [
    ["room", "房间"],
    ["opening", "门与通道"],
    ["window", "窗"],
  ];
  const passage = item.l1Config.controls.some(
    (entry) =>
      entry.family === item.l1Family &&
      entry.labels.some(
        (label) => (label.alias || label.value) === item.l1Selection.category && label.value === "Open passage",
      ),
  );
  return (
    <section className={styles.dock} aria-label="L1 标注工具" data-testid="l1-tools">
      <strong>L1 标注</strong>
      <div className={styles.families} role="group" aria-label="标注对象">
        {families
          .filter(([family]) => item.l1Config.controls.some((entry) => entry.family === family))
          .map(([family, title]) => (
            <button
              key={family}
              type="button"
              aria-pressed={item.l1Family === family}
              disabled={!!blocked}
              onClick={() => item.selectL1Family(family)}
            >
              {title}
            </button>
          ))}
      </div>
      <label className={styles.category}>
        类型
        <select
          aria-label="L1 标注类型"
          value={item.l1Selection.category}
          disabled={!!blocked}
          onChange={(event) => item.selectL1Category(event.target.value)}
        >
          <option value="">请选择类型</option>
          {categories.map(({ key, title }) => (
            <option key={key} value={key}>
              {title}
            </option>
          ))}
        </select>
      </label>
      <span>
        {item.getToolsManager().findSelectedTool()?.toolName === "MoveTool" ? "当前工具：移动／选择 · " : ""}
        画法：{L1_SHAPES[item.l1Selection.shape]} · 右侧切换（V 选择）
      </span>
      <span className={styles.notice} role="status">
        {blocked ||
          (passage
            ? item.l1Selection.shape === "vector"
              ? "无墙体进深：沿共享边界绘制开放通道"
              : "有墙体进深：矩形短边表示墙体进深"
            : "顶部选择仅用于后续绘制；已有区域请在右侧区域属性中编辑")}
      </span>
    </section>
  );
});
