import { CONTROLS, context, controlName, GEOMETRY_CONTROLS, FURNITURE_TYPES } from "./domain";
import { furnitureTypeColor } from "./presentation";
import { withAlpha } from "../utils/roomConstraintGeometry";

export const FURNITURE_APPEARANCE = Object.freeze({
  normal: { fill: 0.1, width: 1.5 },
  hover: { fill: 0.12, width: 2 },
  selected: { fill: 0.16, width: 3 },
  drawing: { fill: 0.1, width: 2 },
});

export function furnitureShapeStyles(type, state = "normal") {
  const color = furnitureTypeColor(type);
  const style = FURNITURE_APPEARANCE[state];
  return {
    fillColor: withAlpha(color, style.fill),
    strokeColor: color,
    strokeWidth: style.width,
    haloColor: ["selected", "hover"].includes(state) ? "#ffffff" : null,
  };
}

export function furnitureGeometryRegion(region) {
  return Boolean(
    region?.parent?.furnitureInstancesEnabled &&
      (GEOMETRY_CONTROLS.has(region.control?.name) ||
        region.results?.some((result) => GEOMETRY_CONTROLS.has(controlName(result)))),
  );
}

export function furnitureNativePartActive(region) {
  if (region.parent?.furnitureInstanceGeometryPreview) return false;
  const value = region.results?.find((result) => context(result).instance_id);
  if (
    value &&
    region.parent?.furnitureInstanceZoneId !== undefined &&
    (context(value).zone_id !== region.parent.furnitureInstanceZoneId ||
      context(value).room_id !== region.parent.furnitureInstanceRoomId)
  )
    return false;
  return Boolean(
    region.isDrawing ||
      region.selected ||
      region.inSelection ||
      (region.cleanId && region.cleanId === region.parent?.furnitureInstanceActivePartId),
  );
}

export function furnitureNativePartIds(item) {
  if (item.furnitureInstanceGeometryPreview) return new Set();
  const ids = (item.annotation?.selectedRegions || [])
    .filter((region) => furnitureGeometryRegion(region) && furnitureNativePartActive(region))
    .map((region) => region.cleanId);
  if (item.furnitureInstanceActivePartId) ids.push(item.furnitureInstanceActivePartId);
  return new Set(ids);
}

// A decorative sibling must follow Konva's live transform, before model commit on mouse-up.
export function syncFurnitureHalo(target) {
  const halo = target.getParent()?.findOne((node) => node.name() === `furniture-halo:${target.name().split(" ")[0]}`);
  if (!halo) return;
  for (const attr of ["x", "y", "width", "height", "scaleX", "scaleY", "rotation", "points"])
    if (target.getAttr(attr) !== undefined) halo.setAttr(attr, target.getAttr(attr));
}

export function furnitureGeometryStyles(region, base) {
  if (!furnitureGeometryRegion(region)) return null;
  if (!furnitureNativePartActive(region))
    return { ...base, fillColor: "rgba(0,0,0,0)", strokeColor: "rgba(0,0,0,0)", strokeWidth: 0, haloColor: null };
  const result = region.results?.find((candidate) => controlName(candidate) === CONTROLS.type);
  const type =
    result?.value?.choices?.[0] ||
    context(region.results?.find((candidate) => context(candidate).instance_id)).instance_type ||
    region.parent.furnitureInstanceDraftType;
  return { ...base, ...furnitureShapeStyles(type, region.isDrawing ? "drawing" : "selected") };
}

export function furnitureInstanceNames(instances) {
  const types = new Map();
  for (const instance of instances) {
    const type = instance.instanceType || instance.context.instance_type;
    if (!types.has(type)) types.set(type, []);
    types.get(type).push(instance.id);
  }
  return new Map(
    instances.map((instance) => {
      const type = instance.instanceType || instance.context.instance_type;
      const peers = types.get(type);
      let length = 6;
      while (
        length < instance.id.length &&
        peers.some((id) => id !== instance.id && id.slice(-length) === instance.id.slice(-length))
      )
        length++;
      return [
        instance.id,
        `${FURNITURE_TYPES[type] || type}${peers.length > 1 ? ` · ${instance.id.slice(-length)}` : ""}`,
      ];
    }),
  );
}

const intersects = (a, b, gap = 3) =>
  a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;

export function furnitureLabelLeader(label) {
  const clamp = (value, min, size) => Math.max(min, Math.min(value, min + size));
  const x = clamp(label.x + label.width / 2, label.bounds.x, label.bounds.width);
  const y = clamp(label.y + label.height / 2, label.bounds.y, label.bounds.height);
  return [x, y, clamp(x, label.x, label.width), clamp(y, label.y, label.height)];
}

// All inputs and output rectangles are CSS screen pixels, independent of canvas zoom/rotation.
export function layoutFurnitureLabels(candidates, viewport) {
  const placed = [];
  const obstacles = candidates
    .filter((entry) => !entry.parent && (entry.bounds.width < 60 || entry.bounds.height < 40))
    .map((entry) => entry.bounds);
  for (const entry of [...candidates].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
    const b = entry.bounds;
    if (b.x + b.width < 0 || b.y + b.height < 0 || b.x > viewport.width || b.y > viewport.height) continue;
    const width = Math.min(
      viewport.width - 8,
      16 + Array.from(entry.text).reduce((total, c) => total + (c.charCodeAt(0) > 255 ? 13 : 8), 0),
    );
    const height = 23;
    if (width < 20 || viewport.height < height + 8) continue;
    const positions = [
      [b.x, b.y - height - 7],
      [b.x + b.width + 7, b.y],
      [b.x, b.y + b.height + 7],
      [b.x - width - 7, b.y],
    ];
    if (entry.priority >= 2) {
      for (let y = 4; y + height < viewport.height; y += height + 5) {
        positions.push([viewport.width - width - 4, y], [4, y]);
      }
    }
    const fit = positions
      .map(([x, y]) => ({
        x: Math.max(4, Math.min(x, viewport.width - width - 4)),
        y: Math.max(4, Math.min(y, viewport.height - height - 4)),
        width,
        height,
      }))
      .find(
        (rect) =>
          !placed.some((other) => intersects(rect, other)) &&
          !intersects(rect, b) &&
          (entry.priority >= 2 || !obstacles.some((obstacle) => intersects(rect, obstacle))),
      );
    const fallback =
      entry.priority >= 2 &&
      positions
        .map(([x, y]) => ({
          x: Math.max(4, Math.min(x, viewport.width - width - 4)),
          y: Math.max(4, Math.min(y, viewport.height - height - 4)),
          width,
          height,
        }))
        .find((rect) => !placed.some((other) => intersects(rect, other)));
    if (fit || fallback) placed.push({ ...entry, ...(fit || fallback) });
  }
  return placed;
}
