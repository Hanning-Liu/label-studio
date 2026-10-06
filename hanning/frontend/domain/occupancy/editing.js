import { equivalent, resultGeometry } from "@hanning/frontend/domain/occupancy/geometry";

const OCCUPANCY_DRAWING_CONTROLS = new Set(["occupancy_rectangle", "occupancy_polygon", "occupancy_barrier_vector"]);

// A storage triangle is not a user-editable footprint. Only whole, hole-free
// components may expose native handles; remainder stays on local correction.
export function editableParts(logical) {
  if (!logical || logical.context.generation !== "manual") return [];
  return logical.parts.filter((part) =>
    logical.geometry.some((polygon) => polygon.length === 1 && equivalent(resultGeometry(part), [polygon])),
  );
}

export function occupancyToolbarTools(tools, enabled) {
  if (!enabled) return tools;
  const seen = new Set();
  return tools.filter((tool) => {
    if (tool.isDrawingTool && !OCCUPANCY_DRAWING_CONTROLS.has(tool.control?.name)) return false;
    const key = tool.fullName;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The native Image toolbar is the only L3 drawing entry point. Keep its
// disabled state and tooltip in sync with the same guard used on canvas.
export function occupancyToolBlockReason(tool) {
  if (!tool?.obj?.occupancyEnabled || !OCCUPANCY_DRAWING_CONTROLS.has(tool.control?.name)) return "";
  return tool.obj.occupancyDrawBlockReason?.(tool.control?.name) || "";
}

// A drawing tool can remain selected after page load even though the user has
// not entered an L3 drawing flow. Do not let that stale tool selection disable
// canvas selection for every existing furniture group.
export function occupancyLogicalLayerListening(item) {
  return !(
    item?.occupancyBusy ||
    item?.annotation?.isDrawing ||
    item?.annotation?.hasIncompletePolygons ||
    item?.occupancyDrawingControl
  );
}


// Reopened unfinished polygons must mount their native view: its effect resumes
// drawing. Hiding them until selected leaves hasIncompletePolygons locking all
// controls, with no canvas or toolbar path to resume that selection.
export function occupancyNativeRegionVisible(item, region) {
  return !item.occupancyEnabled ||
    !region.results.some((result) => result.meta?.occupancy_context) ||
    region.isDrawing ||
    (region.type === "polygonregion" && !region.closed && !region.isReadOnly()) ||
    region.results.some((result) => result.meta?.occupancy_context?.generation === "pending") ||
    region.cleanId === item.occupancyActivePartId;
}
