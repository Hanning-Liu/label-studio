// Konva Transformer boxes use absolute screen coordinates and radians.
// Geometry models use unzoomed image percentages and degrees. Keep these
// conversions separate so zoom, pan and 90-degree image rotation are respected.
export function constrainOccupancyBox(image, region, oldBox, newBox) {
  if (!image.occupancyConstrains(region)) return newBox;
  if (newBox.width <= 0 || newBox.height <= 0) return oldBox;
  const radians = newBox.rotation ?? oldBox.rotation ?? 0;
  const absolute = (x, y) => ({
    x: newBox.x + x * Math.cos(radians) - y * Math.sin(radians),
    y: newBox.y + x * Math.sin(radians) + y * Math.cos(radians),
  });
  const internal = (p) => {
    const [x, y] = image.fixZoomedCoords([p.x, p.y]);
    return { x: image.canvasToInternalX(x), y: image.canvasToInternalY(y) };
  };
  const zoom = (p) => {
    const [x, y] = image.zoomOriginalCoords([p.x, p.y]);
    return { x, y };
  };
  const screen = (p) => zoom({ x: image.internalToCanvasX(p.x), y: image.internalToCanvasY(p.y) });
  const origin = internal(absolute(0, 0)),
    right = internal(absolute(newBox.width, 0)),
    bottom = internal(absolute(0, newBox.height));
  let corners;
  if (region.type === "rectangleregion") {
    const previous = {
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      rotation: region.rotation,
    };
    const dx = image.internalToCanvasX(right.x - origin.x),
      dy = image.internalToCanvasY(right.y - origin.y);
    const target = {
      ...origin,
      width: image.canvasToInternalX(Math.hypot(dx, dy)),
      height: image.canvasToInternalY(
        Math.hypot(image.internalToCanvasX(bottom.x - origin.x), image.internalToCanvasY(bottom.y - origin.y)),
      ),
      rotation: ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360,
    };
    const accepted = image.constrainOccupancyRectangle(region, previous, target);
    const a = (accepted.rotation * Math.PI) / 180;
    const p = { x: image.internalToCanvasX(accepted.x), y: image.internalToCanvasY(accepted.y) };
    const w = image.internalToCanvasX(accepted.width),
      h = image.internalToCanvasY(accepted.height);
    corners = [
      p,
      { x: p.x + w * Math.cos(a), y: p.y + w * Math.sin(a) },
      { x: p.x - h * Math.sin(a), y: p.y + h * Math.cos(a) },
    ].map(zoom);
  } else if (region.type === "polygonregion") {
    const previous = region.points.map((p) => ({ x: p.x, y: p.y }));
    const xs = previous.map((p) => p.x),
      ys = previous.map((p) => p.y);
    const x = Math.min(...xs),
      y = Math.min(...ys),
      w = Math.max(...xs) - x,
      h = Math.max(...ys) - y;
    if (!(w > 0 && h > 0)) return oldBox;
    const target = previous.map((p) =>
      internal(absolute(((p.x - x) / w) * newBox.width, ((p.y - y) / h) * newBox.height)),
    );
    // Preserve an affine transform here. Individual vertex snapping happens on
    // release; the live transformer must not introduce internal distortions.
    const accepted = image.constrainOccupancyPolygon(region, previous, target, false);
    const left = Math.min(...accepted.map((p) => p.x)),
      top = Math.min(...accepted.map((p) => p.y));
    const right = Math.max(...accepted.map((p) => p.x)),
      bottom = Math.max(...accepted.map((p) => p.y));
    corners = [
      { x: left, y: top },
      { x: right, y: top },
      { x: left, y: bottom },
    ].map(screen);
  } else return newBox;
  const [p, r, b] = corners;
  return {
    ...newBox,
    x: p.x,
    y: p.y,
    width: Math.hypot(r.x - p.x, r.y - p.y),
    height: Math.hypot(b.x - p.x, b.y - p.y),
    rotation: Math.atan2(r.y - p.y, r.x - p.x),
  };
}
