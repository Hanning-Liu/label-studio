import { observer } from "mobx-react";
import { WholeRoomInheritanceControls } from "./WholeRoomInheritanceControls";
import styles from "./RoomFocusSelector.module.scss";

export const RoomFocusSelector = observer(({ item, compact = false }) => {
  if (!item.hasRoomConstraints) return null;
  const selectedId = item.focusedRoom?.cleanId || "";
  const focusControl = (
    <div className={styles.roomFocusRow}>
      <label htmlFor={`room-focus-${item.name}`}>Focus room</label>
      <select
        id={`room-focus-${item.name}`}
        value={selectedId}
        disabled={!!item.vectorReviewBusy || (item.l2ToolbarEnabled && !!item.l2SwitchBlockReason)}
        onChange={(event) => item.setFocusedRoom(event.target.value)}
      >
        <option value="">Select a room…</option>
        {item.focusRoomOptions.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      {item.roomConstraintNotice ? <span role="alert">{item.roomConstraintNotice}</span> : null}
    </div>
  );
  return (
    <div
      className={`${styles.roomFocus} ${item.wholeRoomInheritanceEnabled ? styles.roomFocusDocked : ""} ${compact ? styles.roomFocusCompact : ""}`}
      data-testid="room-focus-selector"
    >
      {!compact && focusControl}
      <WholeRoomInheritanceControls item={item} compact={compact} focusControl={compact ? focusControl : null} />
    </div>
  );
});
