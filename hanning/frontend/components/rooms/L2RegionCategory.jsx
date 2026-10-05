import { observer } from "mobx-react";
import { l1LabelKey } from "@hanning/frontend/domain/rooms/l1Tools";
import styles from "./L1Controls.module.scss";

// Editing an existing region is deliberately separate from the next-drawing dock.
export const L2RegionCategory = observer(({ region }) => {
  const image = region.parent;
  if (!image?.l2ToolbarEnabled) return null;
  const result = region.results.find((result) =>
    image.l2Config.controls.some((entry) => entry.labelControl.name === result.from_name.name),
  );
  if (!result) return null;
  return (
    <>
      <label className={styles.category}>
        区域类型
        <select
          aria-label="L2 当前区域类型"
          value={result.mainValue?.[0] || ""}
          disabled={region.isReadOnly() || !!image.l2SwitchBlockReason}
          onChange={(event) => image.setL2RegionCategory(region, event.target.value)}
        >
          {result.from_name.children.map((label) => (
            <option key={l1LabelKey(label)} value={l1LabelKey(label)}>
              {label.showalias && label.alias ? label.alias : label.value}
            </option>
          ))}
        </select>
      </label>
    </>
  );
});
