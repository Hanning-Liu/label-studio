import { withAlpha } from "../utils/roomConstraintGeometry";

const appearance = Object.freeze({
  focused: Object.freeze({ fill: 0.16, stroke: 0.9, width: 2 }),
  sameZone: Object.freeze({ fill: 0.045, stroke: 0.28, width: 1 }),
  context: Object.freeze({ fill: 0.02, stroke: 0.16, width: 1 }),
});

const resultName = (result) => result?.from_name?.name || result?.from_name;
export function furnitureInstanceToolbarTools(tools, enabled) {
  if (!enabled) return tools;
  const seen = new Set();
  return tools.filter((tool) => {
    // L4 drawing has one explicit entry point in FurnitureInstanceControls.
    // Keep the tools registered so the top buttons can activate them, but do
    // not expose a second set of ambiguous color/tool buttons below the dock.
    if (tool.isDrawingTool) return false;
    if (seen.has(tool.fullName)) return false;
    seen.add(tool.fullName);
    return true;
  });
}

export const furnitureReferenceContext = (region) => {
  const result = region?.results?.find(
    (candidate) =>
      candidate.meta?.occupancy_context || candidate.meta?.partition_context || candidate.meta?.room_graph_node,
  );
  if (!result) return null;
  return {
    control: resultName(result),
    occupancy: result.meta?.occupancy_context,
    partition: result.meta?.partition_context,
    room: result.meta?.room_graph_node,
  };
};

export function furnitureReferenceLevel(region) {
  const image = region?.parent;
  if (!image?.furnitureInstancesEnabled || !image.furnitureInstanceIsReference?.(region?.control?.name)) return null;
  const value = furnitureReferenceContext(region);
  const parent = image.furnitureInstanceParents?.find((candidate) => candidate.id === image.furnitureInstanceFocusId);
  if (value?.occupancy?.group_id && value.occupancy.group_id === image.furnitureInstanceFocusId) return "focused";
  if (
    parent &&
    (value?.occupancy?.parent_zone_id === parent.zoneId || value?.partition?.parent_room_id === parent.roomId)
  )
    return "sameZone";
  return "context";
}

export function furnitureReferenceStyles(region, baseStyles) {
  const level = furnitureReferenceLevel(region);
  if (!level) return null;
  const selected = appearance[level];
  const fill = baseStyles.fillColor || baseStyles.strokeColor;
  return {
    ...baseStyles,
    fillColor: withAlpha(fill, selected.fill),
    strokeColor: withAlpha(baseStyles.strokeColor, selected.stroke),
    labelColor: withAlpha(baseStyles.strokeColor, selected.stroke),
    strokeWidth: selected.width,
  };
}

export function partitionFurnitureReferenceRegions(regions, item) {
  const references = [];
  const interactive = [];
  for (const region of regions) {
    const reference =
      item?.furnitureInstancesEnabled &&
      region.results?.some((result) => item.furnitureInstanceIsReference?.(resultName(result)));
    (reference ? references : interactive).push(region);
  }
  return { references, interactive };
}

export function furnitureInstanceMultiRegionSelection(item) {
  return Boolean(
    item?.furnitureInstancesEnabled &&
      item.selectedRegions?.length > 1 &&
      item.selectedRegions.some((region) => region.results?.some((result) => result.meta?.furniture_instance_context)),
  );
}
