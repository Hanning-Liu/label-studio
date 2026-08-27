import { equivalent, resultGeometry } from "./geometry";

// A storage triangle is not a user-editable footprint. Only whole, hole-free
// components may expose native handles; remainder stays on local correction.
export function editableParts(logical) {
  if (!logical || !["manual", "pending"].includes(logical.context.generation)) return [];
  return logical.parts.filter((part) =>
    logical.geometry.some((polygon) => polygon.length === 1 && equivalent(resultGeometry(part), [polygon])),
  );
}

export function occupancyToolbarTools(tools, enabled) {
  if (!enabled) return tools;
  const seen = new Set();
  return tools.filter((tool) => {
    if (tool.isDrawingTool && !["occupancy_rectangle", "occupancy_polygon"].includes(tool.control?.name)) return false;
    const key = tool.fullName;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
