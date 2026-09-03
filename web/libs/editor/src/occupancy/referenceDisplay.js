import { withAlpha } from "../utils/roomConstraintGeometry";

export const OCCUPANCY_ZONE_REFERENCE_APPEARANCE = Object.freeze({
  focused: Object.freeze({ fillOpacity: 0.2, strokeOpacity: 1, labelOpacity: 1, strokeWidth: 2 }),
  sameRoom: Object.freeze({ fillOpacity: 0.1, strokeOpacity: 0.65, labelOpacity: 0.75, strokeWidth: 1.5 }),
  outsideRoom: Object.freeze({ fillOpacity: 0.05, strokeOpacity: 0.3, labelOpacity: 0.35, strokeWidth: 1 }),
});

export const partitionContextForRegion = (region) =>
  region?.results?.find((result) => result.meta?.partition_context)?.meta?.partition_context || null;

export const isOccupancyZoneReferenceRegion = (region) => !!partitionContextForRegion(region);

export function partitionOccupancyZoneReferenceRegions(regions) {
  const references = [];
  const interactive = [];

  for (const region of regions) {
    (isOccupancyZoneReferenceRegion(region) ? references : interactive).push(region);
  }

  return { references, interactive };
}

export function occupancyZoneReferenceLevel(region) {
  const image = region?.parent;
  const context = partitionContextForRegion(region);
  if (!image?.occupancyEnabled || !context) return null;

  const focusId = image.occupancyFocusId;
  if (!focusId) return "outsideRoom";
  if (region.cleanId === focusId) return "focused";

  const focusedRegion = image.regs?.find((candidate) => candidate.cleanId === focusId);
  const focusedRoomId = partitionContextForRegion(focusedRegion)?.parent_room_id;
  return focusedRoomId && focusedRoomId === context.parent_room_id ? "sameRoom" : "outsideRoom";
}

export function occupancyZoneReferenceStyles(region, baseStyles) {
  const level = occupancyZoneReferenceLevel(region);
  if (!level) return null;
  const appearance = OCCUPANCY_ZONE_REFERENCE_APPEARANCE[level];
  const fill = baseStyles.fillColor || baseStyles.strokeColor;

  return {
    ...baseStyles,
    fillColor: withAlpha(fill, appearance.fillOpacity),
    strokeColor: withAlpha(baseStyles.strokeColor, appearance.strokeOpacity),
    labelColor: withAlpha(baseStyles.strokeColor, appearance.labelOpacity),
    strokeWidth: appearance.strokeWidth,
  };
}

export const shouldRenderOccupancyReferenceRegion = (image, region) =>
  !image?.occupancyEnabled || !region?.isRoomReference || !!image.occupancyShowRoomReferences;
