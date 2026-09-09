import { reviewFocusFit } from "../utils/vectorReviewFocus";

const requests = new WeakMap();
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

export function furnitureReviewPoints(instance) {
  return [
    ...instance.geometry.flat(2),
    ...instance.orientationResults.flatMap((result) => (result.value?.vertices || []).map(({ x, y }) => [x, y])),
  ];
}

export function reviewViewportFit(box, viewport, zoom) {
  const padding = 24;
  if (
    box.left >= viewport.left + padding &&
    box.right <= viewport.right - padding &&
    box.top >= viewport.top + padding &&
    box.bottom <= viewport.bottom - padding
  )
    return null;
  return reviewFocusFit(box, viewport, zoom, padding);
}

// Only pan when needed. Every await checks ownership, so an old navigation cannot
// move a newly selected annotation, instance, or a newer navigation request.
export async function focusFurnitureReview(item, points, stillCurrent = () => true) {
  const request = {};
  const annotation = item.annotation;
  requests.set(item, request);
  const active = () =>
    requests.get(item) === request &&
    item.annotation === annotation &&
    stillCurrent() &&
    !annotation.isDrawing &&
    !annotation.hasIncompletePolygons;
  await frame();
  await frame();
  if (!active()) return;
  const container = item.stageRef?.container();
  const scroll = container?.closest(".lsf-main-content");
  if (!scroll || !points.length) throw new Error("画布尚未就绪，请点击实例重新定位");
  for (let pass = 0; pass < 3; pass++) {
    if (!active()) return;
    let bounds = scroll.getBoundingClientRect();
    let canvas = container.getBoundingClientRect();
    if (canvas.top >= bounds.bottom - 96 || canvas.bottom <= bounds.top + 96) {
      scroll.scrollTop += canvas.top - bounds.top;
      await frame();
      if (!active()) return;
      bounds = scroll.getBoundingClientRect();
      canvas = container.getBoundingClientRect();
    }
    const viewport = {
      left: Math.max(canvas.left, bounds.left),
      right: Math.min(canvas.right, bounds.right - 16),
      top: Math.max(canvas.top, bounds.top),
      bottom: Math.min(canvas.bottom, bounds.bottom - 40),
    };
    if (viewport.right - viewport.left <= 96 || viewport.bottom - viewport.top <= 96) {
      throw new Error("可用画布空间过小，请扩大窗口后重新定位");
    }
    const transform = item.stageRef.getAbsoluteTransform();
    const screen = points.map(([x, y]) =>
      transform.point({ x: (x * item.stageWidth) / 100, y: (y * item.stageHeight) / 100 }),
    );
    const box = {
      left: canvas.left + Math.min(...screen.map((p) => p.x)),
      right: canvas.left + Math.max(...screen.map((p) => p.x)),
      top: canvas.top + Math.min(...screen.map((p) => p.y)),
      bottom: canvas.top + Math.max(...screen.map((p) => p.y)),
    };
    if (!Object.values(box).every(Number.isFinite)) throw new Error("家具坐标不可用于定位");
    const fit = reviewViewportFit(box, viewport, item.currentZoom);
    if (!fit) return;
    if (fit.zoom < item.currentZoom - 0.001) {
      item.setZoom(fit.zoom, { reviewFit: true });
      item.updateImageAfterZoom();
      await frame();
      continue;
    }
    item.setZoomPosition(
      item.zoomingPositionX + fit.x - (box.left + box.right) / 2,
      item.zoomingPositionY + fit.y - (box.top + box.bottom) / 2,
      { reviewFocus: true },
    );
    return;
  }
}
