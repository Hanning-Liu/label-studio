import { useEffect, useLayoutEffect, useRef } from "react";
import { isAlive } from "mobx-state-tree";
import { observer } from "mobx-react";
import { l1Categories, L1_SHAPES } from "@hanning/frontend/domain/rooms/l1Tools";
import { L2_FAMILIES } from "@hanning/frontend/domain/rooms/l2Tools";
import styles from "./L1Controls.module.scss";

export const L2Controls = observer(({ item, onDockResize }) => {
  const annotation = item.annotation;
  const dockRow = useRef(null);
  useLayoutEffect(() => {
    const dock = dockRow.current?.parentElement;
    if (!dock || !onDockResize) return;
    const measure = () => onDockResize(Math.ceil(dock.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    return () => observer.disconnect();
  }, [item.l2ToolbarEnabled, onDockResize]);
  useEffect(() => {
    if (isAlive(item)) item.initializeL2Tools();
  }, [item, annotation.id, annotation.store.task?.id]);
  useEffect(() => {
    const cancel = (event) => {
      if (
        isAlive(item) &&
        item.l2ToolbarEnabled &&
        item.annotation.store.settings.enableHotkeys &&
        event.key?.toLowerCase() === "v" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        !event.isComposing &&
        !event.target?.closest?.(
          "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='dialog'], [role='alertdialog'], [role='combobox'], dialog",
        )
      ) {
        // Handle V once before legacy label or toolbar toggle handlers.
        item.selectL2MoveTool();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (
        isAlive(item) &&
        ((event.key === "Escape" && item.cancelL2Drawing()) || (event.key === "Enter" && item.finishL2Vector()))
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("keydown", cancel, true);
    return () => document.removeEventListener("keydown", cancel, true);
  }, [item]);
  if (!item.l2ToolbarEnabled) return null;
  const blocked = item.l2SwitchBlockReason;
  const categories = l1Categories(item.l2Config, item.l2Family);
  const families = L2_FAMILIES;
  return (
    <section ref={dockRow} className={`${styles.dock} ${styles.embedded}`} aria-label="L2 标注工具" data-testid="l2-tools">
      <strong>L2 标注</strong>
      <div className={styles.families} role="group" aria-label="标注对象">
        {families
          .filter(([family]) => item.l2Config.controls.some((entry) => entry.family === family))
          .map(([family, title]) => (
            <button
              key={family}
              type="button"
              aria-pressed={item.l2Family === family}
              disabled={!!blocked}
              onClick={() => item.selectL2Family(family)}
            >
              {title}
            </button>
          ))}
      </div>
      <label className={styles.category}>
        类型
        <select
          aria-label="L2 标注类型"
          value={item.l2Selection.category}
          disabled={!!blocked}
          onChange={(event) => item.selectL2Category(event.target.value)}
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
        画法：{L1_SHAPES[item.l2Selection.shape]} · 右侧切换（V 选择）
      </span>
      <span className={styles.notice} role="status">
        {blocked ||
          (item.l2Family === "zone" && !item.focusedRoom
            ? "请先选择 Focus room；功能分区限制在该房间内"
            : "顶部选择仅用于后续绘制；已有区域请在右侧区域属性中编辑")}
      </span>
    </section>
  );
});
