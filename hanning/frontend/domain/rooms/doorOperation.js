export const doorKind = (label) => {
  if (label === "Door") return "swing";
  if (label === "Sliding door") return "sliding";
  return undefined;
};

export function doorOperationError(operation, kind, frame) {
  const { hingeEdges, swingEdges, spanPx } = frame;
  if (operation == null) return "";
  if (operation.version !== 1 || operation.kind !== kind) return "门型已变更，请重新确认开启信息。";
  if (kind === "swing") {
    if (!hingeEdges.includes(operation.hinge_edge) || !swingEdges.includes(operation.swing_edge))
      return "请选择门洞的铰链端和门扇开启侧。";
  } else if (kind === "sliding") {
    const span = operation.clear_span;
    const groups = operation.group_leaf_counts;
    if (span != null && (!Array.isArray(span) || span.length !== 2 || !span.every(Number.isFinite) ||
      span[0] < 0 || span[0] >= span[1] || span[1] > 1 || !(spanPx > 0))) {
      return "通行段必须位于门洞内，且起点小于终点。";
    }
    const pixels = operation.clear_span_points_px;
    if (pixels != null && (!span || !Array.isArray(pixels) || pixels.length !== 2 ||
      !pixels.every((pair, index) => Array.isArray(pair) && pair.length === 2 &&
        pair.every(Number.isSafeInteger) && isDoorPixel(frame, { x: pair[0], y: pair[1] }, span[index])) ||
      (span[1] - span[0]) * spanPx < 1 - 1e-6)) {
      return "通行段端点必须吸附到门洞内的原图像素；门洞改动后请重新标注。";
    }
    if (groups != null && (!Array.isArray(groups) || !groups.length ||
      !groups.every((count) => Number.isSafeInteger(count) && count > 0 && count <= 100)))
      return "请为每组填写 1 至 100 的整数扇数。";
    if (span == null && groups == null) return "请填写通行段或门组扇数。";
  } else {
    return "只有平开门或推拉门可以记录开启信息。";
  }
  return "";
}

export function doorFrame(points, imageSize) {
  if (!points || points.length !== 4 || !points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)))
    return null;
  const edges = points.map((point, i) => [point, points[(i + 1) % 4]]);
  const lengths = edges.map(([a, b]) => Math.hypot(a.x - b.x, a.y - b.y));
  if (Math.min(...lengths) <= 0) return null;
  const swingEdges = lengths[0] + lengths[2] >= lengths[1] + lengths[3] ? [0, 2] : [1, 3];
  const hingeEdges = swingEdges[0] === 0 ? [1, 3] : [0, 2];
  return { edges, swingEdges, hingeEdges, imageSize, depthPx: (lengths[hingeEdges[0]] + lengths[hingeEdges[1]]) / 2,
    spanPx: (lengths[swingEdges[0]] + lengths[swingEdges[1]]) / 2 };
}

export const pointAlong = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export const doorAxis = (frame) => frame.hingeEdges.map((index) => pointAlong(...frame.edges[index], 0.5));

export function doorOpeningSymbol(frame, kind, operation) {
  if (!operation || doorOperationError(operation, kind, frame)) return null;
  const axis = doorAxis(frame);
  if (kind === "sliding") {
    if (!operation.clear_span) return null;
    const points = operation.clear_span_points_px?.map(([x, y]) => ({ x, y })) ??
      operation.clear_span.map((ratio) => pointAlong(...axis, ratio));
    return { kind, points };
  }

  const [hinge, closed] = frame.hingeEdges[0] === operation.hinge_edge ? axis : [...axis].reverse();
  const side = pointAlong(...frame.edges[operation.swing_edge], 0.5);
  const center = pointAlong(hinge, closed, 0.5);
  const dx = closed.x - hinge.x;
  const dy = closed.y - hinge.y;
  const sign = dx * (side.y - center.y) - dy * (side.x - center.x) > 0 ? 1 : -1;
  // A conventional quarter arc indicates the recorded side, not a measured opening angle.
  const arc = Array.from({ length: 17 }, (_, index) => {
    const angle = sign * index * Math.PI / 32;
    return { x: hinge.x + dx * Math.cos(angle) - dy * Math.sin(angle),
      y: hinge.y + dx * Math.sin(angle) + dy * Math.cos(angle) };
  });
  return { kind, hinge, leaf: [hinge, arc[arc.length - 1]], arc };
}

function axisRatio([a, b], { x, y }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy);
}

const EPS = 1e-6;

function isDoorPixel(frame, point, ratio) {
  if (frame.imageSize && (point.x < 0 || point.x >= frame.imageSize.width ||
    point.y < 0 || point.y >= frame.imageSize.height)) return false;
  const axis = doorAxis(frame);
  const projection = axisRatio(axis, point);
  const closest = pointAlong(...axis, projection);
  return projection >= -EPS / frame.spanPx && projection <= 1 + EPS / frame.spanPx &&
    Math.abs(projection - ratio) * frame.spanPx <= EPS &&
    Math.hypot(point.x - closest.x, point.y - closest.y) <= Math.min(1, frame.depthPx / 2) + EPS;
}

export function snapDoorPixel(frame, point, min = 0, max = 1) {
  if (min > max + EPS / frame.spanPx) return null;
  const axis = doorAxis(frame);
  const target = pointAlong(...axis, Math.max(min, Math.min(max, axisRatio(axis, point))));
  const x = Math.round(target.x);
  const y = Math.round(target.y);
  let nearest = null;
  // The intended point is on the centerline. Search nearby grid points, including
  // inward alternatives when rounding at a jamb or inside a narrow rotated door.
  for (const dx of [0, -1, 1, -2, 2]) {
    for (const dy of [0, -1, 1, -2, 2]) {
      const pixel = { x: x + dx, y: y + dy };
      const ratio = Math.max(0, Math.min(1, axisRatio(axis, pixel)));
      if (ratio < min - EPS / frame.spanPx || ratio > max + EPS / frame.spanPx ||
        !isDoorPixel(frame, pixel, ratio)) continue;
      const distance = Math.hypot(pixel.x - target.x, pixel.y - target.y);
      if (!nearest || distance < nearest.distance - EPS) nearest = { pixel, ratio, distance };
    }
  }
  return nearest;
}
