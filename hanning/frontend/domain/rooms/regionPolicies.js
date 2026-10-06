import { withAlpha, clampPolygonTransform } from "./roomConstraintGeometry";
import { occupancyZoneReferenceStyles } from "../occupancy/referenceDisplay";
import { furnitureReferenceStyles } from "../furnitureInstances/referenceDisplay";
import { lockRectangleToActiveAnchor } from "../occupancy/transform";

export const shouldRenderRoomReference = (region) =>
  Boolean(region?.isRoomReference && region?.parent?.hasRoomConstraints);

export function referenceShapeStyles(item, regionStyles) {
  const isReference = shouldRenderRoomReference(item);
  const isFocused = isReference && item.parent?.focusedRoom?.cleanId === item.cleanId;
  const occupancyReferenceStyles = occupancyZoneReferenceStyles(item, regionStyles);
  const furnitureInstanceReferenceStyles = furnitureReferenceStyles(item, regionStyles);
  return furnitureInstanceReferenceStyles || occupancyReferenceStyles || (isReference ? {
    ...regionStyles,
    fillColor: withAlpha(regionStyles.fillColor || regionStyles.strokeColor, isFocused ? 0.12 : 0.05),
    strokeColor: withAlpha(regionStyles.strokeColor, isFocused ? 0.95 : 0.35),
    strokeWidth: isFocused ? 2 : 1,
  } : regionStyles);
}

export function rectangleCandidate(self, previous, rawTarget, activeAnchor) {
  const constrained = self.parent?.occupancyConstrains?.(self);
  const target = constrained ? lockRectangleToActiveAnchor(previous, rawTarget, activeAnchor, self.parent) : rawTarget;
  return constrained
    ? self.parent.constrainOccupancyRectangle(self, previous, target)
    : self.control?.constrainto
      ? self.parent?.constrainRectangle?.(self, previous, target) || previous
      : target;
}

export function polygonCandidate(self, previous, target, { snap = true } = {}) {
  if (self.parent?.occupancyConstrains?.(self))
    target = self.parent.constrainOccupancyPolygon(self, previous, target, snap);
  if (self.control?.constrainto) {
    const room = self.parent.getRoomPolygon(self.partitionContext?.parent_room_id);
    if (room) target = clampPolygonTransform(previous, target, room);
  }
  return target;
}

export function vectorReferenceStyles(item, regionStyles) {
  const isReference = item.isOpeningReference;
  const isFocusedOpening = isReference && item.roomGraphEdge?.room_ids?.includes(item.parent?.focusedRoom?.cleanId);
  const referenceOpacity = isFocusedOpening ? 0.9 : 0.4;
  const invalidBarrier = item.results.some(
    (result) => result.from_name?.name === "occupancy_barrier_vector" && result.meta?.occupancy_barrier_context?.match_error,
  );
  const invalidWindow = item.parent?.windowEnabled && item.results.some((result) => result.meta?.window_context?.derivation_error);
  const vectorStroke = invalidBarrier || invalidWindow ? "#dc2626" : regionStyles.strokeColor;
  return { isReference, isFocusedOpening, referenceOpacity, vectorStroke };
}

// Read before the Rectangle's transformend; Konva clears this handle after the
// Transformer's transformend. The event and model write remain in RectRegion.
export function activeTransformerAnchor(node) {
  const transformer = node.getStage?.()?.findOne((candidate) => {
    if (candidate === node || typeof candidate.getActiveAnchor !== "function") return false;
    const nodes = candidate.nodes?.();
    return Array.isArray(nodes) && nodes.includes(node);
  });
  return transformer?.getActiveAnchor?.() || "";
}
