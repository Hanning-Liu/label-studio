import { isSimplePolygon } from "./roomConstraintGeometry";

const EPS = 1e-7;
const signedArea = (points) => points.reduce((sum, p, i) => {
  const q = points[(i + 1) % points.length];
  return sum + p.x * q.y - q.x * p.y;
}, 0);

// Coordinates remain in image percentages. Edge direction is measured in image
// pixels, independent of canvas size, zoom and non-square image aspect ratios.
export function orthogonalizePolygon(points, width, height) {
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) {
    throw new Error("图片尺寸尚未就绪，请等待图片加载完成。");
  }
  if (!Array.isArray(points) || points.length < 4 || points.some((p) =>
    !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 100 || p.y < 0 || p.y > 100,
  ) || !isSimplePolygon(points)) {
    throw new Error("请先修正多边形：至少需要 4 个顶点，且不能自交、重合或超出图片。");
  }
  const n = points.length;
  const xGroups = Array.from({ length: n }, (_, i) => i);
  const yGroups = [...xGroups];
  const root = (groups, i) => {
    while (groups[i] !== i) i = groups[i];
    return i;
  };
  const join = (groups, a, b) => { groups[root(groups, b)] = root(groups, a); };
  const directions = points.map((p, i) => {
    const q = points[(i + 1) % n];
    const dx = (q.x - p.x) * width;
    const dy = (q.y - p.y) * height;
    if (Math.abs(Math.abs(dx) - Math.abs(dy)) <= EPS * Math.max(1, Math.abs(dx), Math.abs(dy))) {
      throw new Error(`第 ${i + 1} 条边接近 45°，无法确定横向或纵向，请先手动调整该边。`);
    }
    const horizontal = Math.abs(dx) > Math.abs(dy);
    join(horizontal ? yGroups : xGroups, i, (i + 1) % n);
    return horizontal ? "x" : "y";
  });
  const fit = (groups, axis) => {
    const sums = new Map();
    points.forEach((p, i) => {
      const key = root(groups, i);
      const group = sums.get(key) || { sum: 0, count: 0 };
      group.sum += p[axis];
      group.count++;
      sums.set(key, group);
    });
    return points.map((_, i) => {
      const group = sums.get(root(groups, i));
      return group.sum / group.count;
    });
  };
  // The mean is the least-squares projection onto each equality group. Runs of
  // collinear edges and the last-to-first edge share exactly the same coordinate.
  const xs = fit(xGroups, "x");
  const ys = fit(yGroups, "y");
  const candidate = points.map((_, i) => ({ x: xs[i], y: ys[i] }));
  const reversedOrCollapsed = directions.some((axis, i) => {
    const next = (i + 1) % n;
    const delta = candidate[next][axis] - candidate[i][axis];
    return Math.abs(delta) <= EPS || delta * (points[next][axis] - points[i][axis]) <= 0;
  });
  if (reversedOrCollapsed || !isSimplePolygon(candidate) || signedArea(candidate) * signedArea(points) <= 0) {
    throw new Error("正交化会造成边塌缩、反向或自交，已保留原形状。请先调整斜切角或过短的边。");
  }
  const changed = candidate.some((p, i) => Math.abs(p.x - points[i].x) > EPS || Math.abs(p.y - points[i].y) > EPS);
  return { points: changed ? candidate : points.map((p) => ({ ...p })), changed };
}
