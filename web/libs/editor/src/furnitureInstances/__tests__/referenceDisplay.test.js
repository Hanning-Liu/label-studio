import {
  furnitureInstanceInteractionLayerListening,
  furnitureInstanceToolbarTools,
  furnitureInstanceToolBlockReason,
} from "../referenceDisplay";

test("L4 toolbar keeps native geometry tools, removes other drawing tools, and deduplicates non-drawing tools", () => {
  const move = { fullName: "MoveTool", isDrawingTool: false };
  const duplicateMove = { fullName: "MoveTool", isDrawingTool: false };
  const rectangle = {
    fullName: "RectangleTool:furniture_instance_rectangle",
    isDrawingTool: true,
    control: { name: "furniture_instance_rectangle" },
  };
  const polygon = {
    fullName: "PolygonTool:furniture_instance_polygon",
    isDrawingTool: true,
    control: { name: "furniture_instance_polygon" },
  };
  const direction = {
    fullName: "VectorTool:furniture_front_direction",
    isDrawingTool: true,
    control: { name: "furniture_front_direction" },
  };
  const room = {
    fullName: "PolygonTool:room_polygon",
    isDrawingTool: true,
    control: { name: "room_polygon" },
  };
  const tools = [move, duplicateMove, rectangle, polygon, direction, room];

  expect(furnitureInstanceToolbarTools(tools, true)).toEqual([move, rectangle, polygon]);
  expect(furnitureInstanceToolbarTools(tools, false)).toBe(tools);
});

test("native L4 geometry tools expose their drawing blocker", () => {
  const tool = {
    obj: { furnitureInstancesEnabled: true, furnitureInstanceDrawBlockReason: () => "请先点击 Focus 家具组团" },
    control: { name: "furniture_instance_polygon" },
  };
  expect(furnitureInstanceToolBlockReason(tool)).toBe("请先点击 Focus 家具组团");
  expect(furnitureInstanceToolBlockReason({ ...tool, control: { name: "furniture_front_edge" } })).toBe("");
  expect(furnitureInstanceToolBlockReason({ ...tool, obj: { furnitureInstancesEnabled: false } })).toBe("");
});

test("canvas objects only listen in Move mode and never while drawing or busy", () => {
  const item = {
    furnitureInstancesEnabled: true,
    furnitureInstanceBusy: false,
    annotation: { isDrawing: false, hasIncompletePolygons: false },
    getToolsManager: () => ({ findSelectedTool: () => ({ fullName: "MoveTool", toolName: "MoveTool" }) }),
  };
  expect(furnitureInstanceInteractionLayerListening(item)).toBe(true);
  expect(
    furnitureInstanceInteractionLayerListening({
      ...item,
      getToolsManager: () => ({ findSelectedTool: () => ({ isDrawingTool: true, toolName: "PolygonTool" }) }),
    }),
  ).toBe(false);
  expect(furnitureInstanceInteractionLayerListening({ ...item, furnitureInstanceBusy: true })).toBe(false);
  expect(
    furnitureInstanceInteractionLayerListening({ ...item, annotation: { ...item.annotation, isDrawing: true } }),
  ).toBe(false);
  expect(
    furnitureInstanceInteractionLayerListening({
      ...item,
      annotation: { ...item.annotation, hasIncompletePolygons: true },
    }),
  ).toBe(false);
});
