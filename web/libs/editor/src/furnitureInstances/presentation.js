import { GROUP_TYPES } from "../occupancy/domain";
import { FURNITURE_TYPES } from "./domain";

export const FURNITURE_TYPE_GROUPS = Object.freeze([
  { name: "睡眠与更衣", color: "#7C3AED", types: ["bed", "bedside_table", "wardrobe"] },
  { name: "工作学习", color: "#2563EB", types: ["desk", "office_chair"] },
  {
    name: "会客与用餐",
    color: "#16A34A",
    types: ["sofa", "armchair", "coffee_table", "dining_table", "dining_chair"],
  },
  { name: "收纳与展示", color: "#475569", types: ["cabinet", "bookshelf", "tv_stand", "shoe_cabinet"] },
  { name: "厨房设施", color: "#EA580C", types: ["refrigerator", "stove", "kitchen_cabinet", "sink"] },
  { name: "卫浴设施", color: "#0F766E", types: ["toilet", "washbasin", "bathtub", "shower"] },
  { name: "家用设备", color: "#C026D3", types: ["television", "washing_machine", "dryer"] },
  { name: "其他", color: "#6B7280", types: ["other"] },
]);

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
