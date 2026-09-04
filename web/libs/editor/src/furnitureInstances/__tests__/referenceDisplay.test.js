import { furnitureInstanceToolbarTools } from "../referenceDisplay";

test("L4 toolbar keeps registered drawing tools behind explicit controls and retains one non-drawing tool", () => {
  const move = { fullName: "MoveTool", isDrawingTool: false };
  const duplicateMove = { fullName: "MoveTool", isDrawingTool: false };
  const rectangle = {
    fullName: "RectangleTool:furniture_instance_rectangle",
    isDrawingTool: true,
    control: { name: "furniture_instance_rectangle" },
  };
  const direction = {
    fullName: "VectorTool:furniture_front_direction",
    isDrawingTool: true,
    control: { name: "furniture_front_direction" },
  };
  const tools = [move, duplicateMove, rectangle, direction];

  expect(furnitureInstanceToolbarTools(tools, true)).toEqual([move]);
  expect(furnitureInstanceToolbarTools(tools, false)).toBe(tools);
});
