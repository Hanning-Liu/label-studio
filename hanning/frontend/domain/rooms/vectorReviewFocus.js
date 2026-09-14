const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const requests = new WeakMap();

// Pure geometry, including zero-height/width lines. Never zoom in on a short line.
export function reviewFocusFit(bounds, viewport, currentZoom, padding = 48) {
  const width = Math.max(1, viewport.right - viewport.left - padding * 2);
  const height = Math.max(1, viewport.bottom - viewport.top - padding * 2);
  const ratio = Math.min(
    1,
    width / Math.max(1, bounds.right - bounds.left),
    height / Math.max(1, bounds.bottom - bounds.top),
  );
  return {
    zoom: Math.max(0.1, currentZoom * ratio),
    x: (viewport.left + viewport.right) / 2,
    y: (viewport.top + viewport.bottom) / 2,
  };
}

function screenBounds(image, region) {
  const result = region.serialize({ fast: true });
  const vertices = result?.value?.vertices;
  if (!vertices?.length) return null;
  const canvas = image.stageRef.container().getBoundingClientRect();
  const transform = image.stageRef.getAbsoluteTransform();
  const points = vertices.map((p) =>
    transform.point({ x: (p.x * image.stageWidth) / 100, y: (p.y * image.stageHeight) / 100 }),
  );
  if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  return {
    left: canvas.left + Math.min(...points.map((p) => p.x)),
    right: canvas.left + Math.max(...points.map((p) => p.x)),
    top: canvas.top + Math.min(...points.map((p) => p.y)),
    bottom: canvas.top + Math.max(...points.map((p) => p.y)),
  };
}

export async function focusReviewVector(image, id) {
  const reason = image.vectorReviewBlockReason();
  if (reason || image.vectorReviewBusy) throw new Error(reason || "复核正在保存");
  const region = image.connectionVectorRegions.find((r) => r.cleanId === id && !r.isReadOnly());
  if (!region) throw new Error("Vector 已不存在或不可编辑");
  const request = {};
  requests.set(image, request);
  const annotation = image.annotation;
  const active = () =>
    requests.get(image) === request &&
    image.annotation === annotation &&
    image.connectionVectorRegions.includes(region) &&
    annotation.selectedRegions.length === 1 &&
    annotation.selectedRegions[0] === region &&
    !image.vectorReviewBlockReason();
  image.annotation.unselectAreas();
  image.annotation.selectAreas([region]);
  // Selection and modal closing must finish before measuring the canvas/dock.
  await frame();
  await frame();
  if (!active()) return;
  const container = image.stageRef?.container();
  const scroll = container?.closest(".lsf-main-content");
  if (!scroll) throw new Error("画布尚未就绪，请稍后点击重新定位");
  const visible = () => {
    const rect = scroll.getBoundingClientRect();
    const dock = scroll.querySelector('[data-testid="function-zone-review-dock"]');
    return {
      left: rect.left,
      right: rect.right - 16,
      top: rect.top + (dock?.getBoundingClientRect().height || 0),
      bottom: rect.bottom - 40,
    };
  };
  // Make the canvas visible first; its own clipping rectangle can be smaller
  // than the scroll viewport. Fit/pan within their intersection, not the page.
  for (let pass = 0; pass < 3; pass++) {
    scroll.scrollTo({
      top: clamp(
        scroll.scrollTop + container.getBoundingClientRect().top - visible().top,
        0,
        scroll.scrollHeight - scroll.clientHeight,
      ),
      behavior: "instant",
    });
    await frame();
    if (!active()) return;
    const bounds = screenBounds(image, region);
    if (!bounds) throw new Error("Vector 坐标不可用于定位");
    const canvas = container.getBoundingClientRect();
    const view = visible();
    const viewport = {
      left: Math.max(canvas.left, view.left),
      right: Math.min(canvas.right, view.right),
      top: Math.max(canvas.top, view.top),
      bottom: Math.min(canvas.bottom, view.bottom),
    };
    if (viewport.right - viewport.left <= 96 || viewport.bottom - viewport.top <= 96)
      throw new Error("可用画布空间过小，请扩大窗口后重新定位");
    const target = reviewFocusFit(bounds, viewport, image.currentZoom);
    if (target.zoom < image.currentZoom - 0.001) {
      image.setZoom(target.zoom, { reviewFit: true });
      image.updateImageAfterZoom();
      await frame();
      if (!active()) return;
      continue;
    }
    image.setZoomPosition(
      image.zoomingPositionX + target.x - (bounds.left + bounds.right) / 2,
      image.zoomingPositionY + target.y - (bounds.top + bounds.bottom) / 2,
      { reviewFocus: true },
    );
    await frame();
    if (!active()) return;
    return;
  }
}
