import { GROUP_TYPES } from "../occupancy/domain";
import { FURNITURE_TYPES } from "./domain";

import { FURNITURE_TYPE_GROUPS } from "@hanning/frontend/domain/catalog";
export { FURNITURE_TYPE_GROUPS };

const controlName = (result) => result?.from_name?.name || result?.from_name;
export const shortFurnitureId = (value) =>
  value?.length > 20 ? `${value.slice(0, 10)}…${value.slice(-7)}` : value || "—";

export function furnitureTypeColor(type) {
  return FURNITURE_TYPE_GROUPS.find((group) => group.types.includes(type))?.color || "#6B7280";
}

export function furnitureParentIdentity(parent, results = []) {
  if (!parent) return null;
  const room = results.find((result) => result.id === parent.roomId && result.meta?.room_graph_node);
  const zone = results.find(
    (result) => result.id === parent.zoneId && controlName(result) === "function_zone" && result.value?.labels?.[0],
  );
  return {
    groupType: GROUP_TYPES[parent.groupType] || parent.groupType || "家具组团",
    note: parent.groupNote || "无说明",
    room: room?.meta?.room_graph_node?.room_type || shortFurnitureId(parent.roomId),
    zone: zone?.value?.labels?.[0] || shortFurnitureId(parent.zoneId),
    id: shortFurnitureId(parent.id),
  };
}

export function assertFurniturePaletteCoverage() {
  const values = FURNITURE_TYPE_GROUPS.flatMap((group) => group.types);
  return values.length === Object.keys(FURNITURE_TYPES).length && new Set(values).size === values.length;
}
