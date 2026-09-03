// Konva Transformer boxes use absolute screen coordinates and radians.
// Geometry models use unzoomed image percentages and degrees. Keep these
// conversions separate so zoom, pan and 90-degree image rotation are respected.

const MOVING_RECTANGLE_EDGES = {
  "top-left": [true, false, true, false],
  "top-center": [false, false, true, false],
  "top-right": [false, true, true, false],
  "middle-left": [true, false, false, false],
  "middle-right": [false, true, false, false],
  "bottom-left": [true, false, false, true],
  "bottom-center": [false, false, false, true],
  "bottom-right": [false, true, false, true],
};

// A Transformer resize reports a complete bounding box even though only one
// handle is moving. Rebuilding every side through screen/image coordinates can
// nudge an already-snapped stationary edge outside its parent by a fraction of
// a pixel. Preserve stationary edges from the model exactly and let the normal
// constraint/snap path process only the edges controlled by the active handle.
export function lockRectangleToActiveAnchor(previous, target, activeAnchor) {
  const moving = MOVING_RECTANGLE_EDGES[activeAnchor];

  if (!moving) return target;

  const previousRotation = previous.rotation || 0;
  const targetRotation = target.rotation || 0;
  const rotationDelta = ((targetRotation - previousRotation + 540) % 360) - 180;

  // Rotation is disabled for L3 occupancy rectangles. Keep the legacy path if
  // that changes in the future instead of applying resize locks to a rotation.
  if (Math.abs(rotationDelta) > 1e-6) return target;

  const radians = (previousRotation * Math.PI) / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const local = (point) => ({ x: point.x * c + point.y * s, y: -point.x * s + point.y * c });
  const world = (point) => ({ x: point.x * c - point.y * s, y: point.x * s + point.y * c });
  const edges = (rectangle) => {
    const origin = local(rectangle);

    return [origin.x, origin.x + rectangle.width, origin.y, origin.y + rectangle.height];
  };
  const fixed = edges(previous);
  const desired = edges({ ...target, rotation: previousRotation });

  for (let side = 0; side < desired.length; side++) {
    if (!moving[side]) desired[side] = fixed[side];
  }

  const origin = world({ x: desired[0], y: desired[2] });

  return {
    ...target,
    ...origin,
    width: desired[1] - desired[0],
    height: desired[3] - desired[2],
    rotation: previousRotation,
  };
}

export function constrainOccupancyBox(image, region, oldBox, newBox, activeAnchor) {
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
    const anchoredTarget = lockRectangleToActiveAnchor(previous, target, activeAnchor);
    const accepted = image.constrainOccupancyRectangle(region, previous, anchoredTarget);
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

// Transformer dragging reports absolute screen coordinates. Convert the drag
// delta back into image percentages, apply the same parent-boundary clamp and
// snapping used by direct Rectangle dragging, then return an accepted screen
// position. This keeps the shape on the boundary during the drag instead of
// allowing it outside and correcting it only on mouse-up.
export function constrainOccupancyDragPosition(image, region, dragStart, proposedPosition) {
  if (!image.occupancyConstrains?.(region) || region.type !== "rectangleregion") return proposedPosition;

  const internal = (p) => {
    const [x, y] = image.fixZoomedCoords([p.x, p.y]);

    return { x: image.canvasToInternalX(x), y: image.canvasToInternalY(y) };
  };
  const screen = (p) => {
    const [x, y] = image.zoomOriginalCoords([image.internalToCanvasX(p.x), image.internalToCanvasY(p.y)]);

    return { x, y };
  };
  const start = internal(dragStart);
  const proposed = internal(proposedPosition);
  const previous = {
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
    rotation: region.rotation,
  };
  const accepted = image.constrainOccupancyRectangle(region, previous, {
    ...previous,
    x: previous.x + proposed.x - start.x,
    y: previous.y + proposed.y - start.y,
  });
  const previousOrigin = screen(previous);
  const acceptedOrigin = screen(accepted);

  return {
    x: dragStart.x + acceptedOrigin.x - previousOrigin.x,
    y: dragStart.y + acceptedOrigin.y - previousOrigin.y,
  };
}
