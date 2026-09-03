import styles from "./OccupancyControls.module.scss";

const FALLBACK_ROOM_COLOR = "#7b8a83";

export const roomColor = (parent) => parent?.roomColor || FALLBACK_ROOM_COLOR;

export const colorWithAlpha = (color, alpha) => {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(color || "");
  if (!match) return `rgba(123, 138, 131, ${alpha})`;
  const value = match[1].length === 3 ? [...match[1]].map((v) => v + v).join("") : match[1];
  const number = Number.parseInt(value, 16);
  return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
};

export const shortId = (id, visible = 10) => {
  if (!id) return "—";
  return id.length > visible ? `…${id.slice(-visible)}` : id;
};

export function ParentIdentity({ parent, compact = false }) {
  const color = roomColor(parent);
  return (
    <span className={`${styles.parentIdentity} ${compact ? styles.parentIdentityCompact : ""}`} title={parent.label}>
      <span className={styles.roomSwatch} style={{ backgroundColor: color }} aria-hidden="true" />
      <span className={styles.parentLabels}>
        <strong>{parent.roomLabel}</strong>
        <span className={styles.identitySeparator}>·</span>
        <span>{parent.functionLabel}</span>
      </span>
      <code className={styles.identityId}>{shortId(parent.id)}</code>
    </span>
  );
}

export const roomStyle = (parent) => {
  const color = roomColor(parent);
  return {
    "--occupancy-room-color": color,
    "--occupancy-room-tint": colorWithAlpha(color, 0.08),
    "--occupancy-room-tint-strong": colorWithAlpha(color, 0.16),
  };
};
