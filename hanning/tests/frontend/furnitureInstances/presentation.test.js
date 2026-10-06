import { FURNITURE_TYPES } from "@hanning/frontend/domain/furnitureInstances/domain";
import {
  assertFurniturePaletteCoverage,
  FURNITURE_TYPE_GROUPS,
  furnitureParentIdentity,
  furnitureTypeColor,
} from "@hanning/frontend/domain/furnitureInstances/presentation";

test("palette contains all and only the 32 stable furniture values exactly once", () => {
  const values = FURNITURE_TYPE_GROUPS.flatMap((group) => group.types);
  expect(values).toHaveLength(32);
  expect(new Set(values)).toEqual(new Set(Object.keys(FURNITURE_TYPES)));
  expect(new Set(values)).toHaveProperty("size", 32);
  expect(FURNITURE_TYPE_GROUPS).toHaveLength(9);
  expect(assertFurniturePaletteCoverage()).toBe(true);
});

test("palette groups retain the approved presentation colors", () => {
  expect(Object.fromEntries(FURNITURE_TYPE_GROUPS.map((group) => [group.name, group.color]))).toEqual({
    睡眠与更衣: "#7C3AED",
    工作学习: "#2563EB",
    会客与用餐: "#16A34A",
    收纳与展示: "#475569",
    厨房设施: "#EA580C",
    卫浴设施: "#0F766E",
    家用设备: "#C026D3",
    乐器: "#9F1239",
    其他: "#6B7280",
  });
  expect(furnitureTypeColor("bed")).toBe("#7C3AED");
  expect(furnitureTypeColor("sink")).toBe("#EA580C");
  expect(FURNITURE_TYPE_GROUPS.find((group) => group.name === "卫浴设施").types).toEqual([
    "toilet", "washbasin", "bathtub", "shower", "drying_rack",
  ]);
  expect(furnitureTypeColor("drying_rack")).toBe("#0F766E");
  expect(FURNITURE_TYPE_GROUPS.find((group) => group.name === "乐器").types).toEqual(["piano"]);
  expect(furnitureTypeColor("piano")).toBe("#9F1239");
  expect(FURNITURE_TYPE_GROUPS.find((group) => group.name === "会客与用餐").types.at(-1)).toBe("floor_lamp");
  expect(furnitureTypeColor("floor_lamp")).toBe("#16A34A");
});

test("focus identity resolves Chinese group, room and zone descriptions without changing ids", () => {
  const parent = {
    id: "group-a",
    groupType: "study_work",
    groupNote: "窗边",
    roomId: "room-a",
    zoneId: "zone-a",
  };
  const results = [
    { id: "room-a", meta: { room_graph_node: { room_type: "书房" } } },
    { id: "zone-a", from_name: "function_zone", value: { labels: ["学习办公"] } },
  ];
  expect(furnitureParentIdentity(parent, results)).toEqual({
    groupType: "学习办公",
    note: "窗边",
    room: "书房",
    zone: "学习办公",
    id: "group-a",
  });
});
