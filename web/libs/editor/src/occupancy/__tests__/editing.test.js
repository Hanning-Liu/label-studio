import { editableParts, occupancyToolbarTools } from "../editing";
import { logicalRegions, resultsForGeometry } from "../domain";
import { resultGeometry } from "../geometry";

const rect = {
  id: "part",
  from_name: "occupancy_rectangle",
  type: "rectangle",
  original_width: 300,
  original_height: 200,
  value: { x: 12.3456789, y: 20, width: 10, height: 9, rotation: 27.1234 },
};
const c = { logical_id: "group", generation: "manual", group_id: "group" };

test("only L3 drawing tools remain; non-L3 toolbar is unchanged", () => {
  const tool = (name, control, drawing = true) => ({
    fullName: name,
    control: { name: control },
    isDrawingTool: drawing,
  });
  const tools = [
    tool("RectangleTool", "zone_rectangle"),
    tool("PolygonTool", "room_polygon"),
    tool("RectangleTool", "occupancy_rectangle"),
    tool("Rectangle3PointTool", "occupancy_rectangle"),
    tool("PolygonTool", "occupancy_polygon"),
    tool("RectangleTool", "occupancy_rectangle"),
    tool("MoveTool", "image", false),
  ];
  expect(occupancyToolbarTools(tools, true)).toEqual(tools.slice(2, 5).concat(tools[6]));
  expect(occupancyToolbarTools(tools, false)).toBe(tools);
});
test("unchanged rotated rectangle retains exact native shape and paired IDs", () => {
  const results = resultsForGeometry(resultGeometry(rect), "furniture_group", c, rect, () => "new", [rect]);
  expect(results[0].from_name).toBe("occupancy_rectangle");
  expect(results[0].value).toEqual(rect.value);
  expect(results[0].id).toBe(results[1].id);
  expect(editableParts(logicalRegions(results)[0])).toHaveLength(1);
});
test("clipped non-rectangle remains polygon; remainder triangles are never editable", () => {
  const triangle = [
    [
      [
        [1, 1],
        [9, 1],
        [1, 9],
        [1, 1],
      ],
    ],
  ];
  const results = resultsForGeometry(triangle, "furniture_group", c, rect, () => "new", [rect]);
  expect(results[0].type).toBe("polygon");
  expect(editableParts(logicalRegions(results)[0])).toHaveLength(1);
  const remainder = resultsForGeometry(triangle, "unclassified", { ...c, generation: "remainder" }, rect);
  expect(editableParts(logicalRegions(remainder)[0])).toEqual([]);
});
test("manual hole decomposition has no editable storage triangles", () => {
  const shape = [
    [
      [
        [0, 0],
        [20, 0],
        [20, 20],
        [0, 20],
        [0, 0],
      ],
      [
        [5, 5],
        [5, 10],
        [10, 10],
        [10, 5],
        [5, 5],
      ],
    ],
  ];
  const results = resultsForGeometry(shape, "furniture_group", c, rect);
  expect(results.length).toBeGreaterThan(2);
  expect(editableParts(logicalRegions(results)[0])).toEqual([]);
});
