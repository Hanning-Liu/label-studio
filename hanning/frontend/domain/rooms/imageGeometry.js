import {
  clampPointToPolygon,
  clampRectangleTransform,
  isSimplePolygon,
  nearestPointOnPolygon,
  partitionContext,
  pointInPolygon,
  polygonArea,
  polygonBoundaryOverlaps,
  polygonInsidePolygon,
  polygonsHavePositiveOverlap,
  rectanglePortalGeometry,
  rotatedRectanglePoints,
  segmentInsidePolygon,
  snapSegmentToOpening,
} from "@hanning/frontend/domain/rooms/roomConstraintGeometry";

export const csvNames = (value) =>
  new Set(
    String(value || "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );

export const rectangleToInternalPolygon = (region, image, attrs = region) => {
  const canvas = {
    x: image.internalToCanvasX(attrs.x),
    y: image.internalToCanvasY(attrs.y),
    width: image.internalToCanvasX(attrs.width),
    height: image.internalToCanvasY(attrs.height),
    rotation: attrs.rotation || 0,
  };
  return rotatedRectanglePoints(canvas).map((point) => ({
    x: image.canvasToInternalX(point.x),
    y: image.canvasToInternalY(point.y),
  }));
};

export const regionToInternalPolygon = (region, image) => {
  if (!region) return null;
  if (region.type === "rectangleregion") return rectangleToInternalPolygon(region, image);
  if (region.type === "polygonregion") return region.points.map((point) => ({ x: point.x, y: point.y }));
  return null;
};

export const vectorToInternalSegment = (region, image) => {
  const vertices = Array.from(region?.vertices || []).slice(0, 2);
  if (vertices.length !== 2) return null;
  return vertices.map((point) => ({
    x: region.converted ? image.imageToInternalX(point.x) : point.x,
    y: region.converted ? image.imageToInternalY(point.y) : point.y,
  }));
};

export const segmentLength = ([start, end]) => Math.hypot(end.x - start.x, end.y - start.y);
export const normalizedOpeningType = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

export const canvasRectangleFromEdge = (attrs, edgeIndex, snapped) => {
  const [start, end] = snapped;
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  const angle = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
  const radians = (angle * Math.PI) / 180;
  const normal = { x: -Math.sin(radians), y: Math.cos(radians) };

  if (edgeIndex === 0) return { ...attrs, x: start.x, y: start.y, width: length, rotation: angle };
  if (edgeIndex === 1) {
    const rotation = angle - 90;
    const widthVector = {
      x: attrs.width * Math.cos((rotation * Math.PI) / 180),
      y: attrs.width * Math.sin((rotation * Math.PI) / 180),
    };
    return { ...attrs, x: start.x - widthVector.x, y: start.y - widthVector.y, height: length, rotation };
  }
  if (edgeIndex === 2) {
    const rotation = angle - 180;
    return {
      ...attrs,
      x: end.x + normal.x * attrs.height,
      y: end.y + normal.y * attrs.height,
      width: length,
      rotation,
    };
  }
  return { ...attrs, x: end.x, y: end.y, height: length, rotation: angle - 270 };
};
