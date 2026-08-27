import { reviewFocusFit } from "../utils/vectorReviewFocus";
export async function focusOccupancy(item, geometry) {
  if (item.annotation.isDrawing || item.annotation.hasIncompletePolygons) throw new Error("请先完成绘制");
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  await frame();
  await frame();
  const container = item.stageRef?.container(),
    scroll = container?.closest(".lsf-main-content");
  if (!scroll) throw new Error("画布未就绪");
  const points = geometry.flat(2);
  for (let pass = 0; pass < 3; pass++) {
    const bounds = scroll.getBoundingClientRect(),
      dock = scroll.querySelector('[data-testid="occupancy-review-dock"]');
    const top = bounds.top + (dock?.getBoundingClientRect().height || 0);
    scroll.scrollTop += container.getBoundingClientRect().top - top;
    await frame();
    const canvas = container.getBoundingClientRect(),
      transform = item.stageRef.getAbsoluteTransform();
    const screen = points.map(([x, y]) =>
      transform.point({ x: (x * item.stageWidth) / 100, y: (y * item.stageHeight) / 100 }),
    );
    const box = {
      left: canvas.left + Math.min(...screen.map((p) => p.x)),
      right: canvas.left + Math.max(...screen.map((p) => p.x)),
      top: canvas.top + Math.min(...screen.map((p) => p.y)),
      bottom: canvas.top + Math.max(...screen.map((p) => p.y)),
    };
    const viewport = {
      left: Math.max(canvas.left, bounds.left),
      right: Math.min(canvas.right, bounds.right - 16),
      top: Math.max(top, canvas.top),
      bottom: Math.min(canvas.bottom, bounds.bottom - 32),
    };
    const fit = reviewFocusFit(box, viewport, item.currentZoom);
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
