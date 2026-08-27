import clipping from "polygon-clipping";
import earcut from "earcut";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

// Coordinates are Label Studio image percentages. This is floating point noise,
// not a minimum feature size: never drop a component based on its area.
export const EPS_AREA = 1e-8;
export const clone = (value) => JSON.parse(JSON.stringify(value));
const close = (ring) => {
  const points = ring.map((p) => [...p]);
  if (points.length && (points[0][0] !== points.at(-1)[0] || points[0][1] !== points.at(-1)[1]))
    points.push([...points[0]]);
  return points;
};
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSegment = (a, b, p) =>
  Math.abs(cross(a, b, p)) <= 1e-12 &&
  p[0] >= Math.min(a[0], b[0]) &&
  p[0] <= Math.max(a[0], b[0]) &&
  p[1] >= Math.min(a[1], b[1]) &&
  p[1] <= Math.max(a[1], b[1]);
export function assertRing(input) {
  const ring = close(input);
  if (ring.length < 4 || ring.some((p) => p.length !== 2 || p.some((n) => !Number.isFinite(n))))
    throw new Error("轮廓坐标无效");
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i],
      b = ring[i + 1];
    if (a[0] === b[0] && a[1] === b[1]) throw new Error("轮廓存在重复顶点");
    for (let j = i + 2; j < ring.length - 1; j++) {
      if (i === 0 && j === ring.length - 2) continue;
      const c = ring[j],
        d = ring[j + 1];
      if (
        (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) ||
        onSegment(a, b, c) ||
        onSegment(a, b, d) ||
        onSegment(c, d, a) ||
        onSegment(c, d, b)
      )
        throw new Error("轮廓自交");
    }
  }
  if (ringArea(ring) === 0) throw new Error("轮廓面积为零");
  return ring;
}
export function ringArea(ring) {
  // Translate to local origin to avoid cancellation for tiny slivers far from 0.
  const [x, y] = ring[0] || [0, 0];
  return (
    Math.abs(
      ring.reduce((sum, p, i) => {
        const q = ring[(i + 1) % ring.length];
        return sum + (p[0] - x) * (q[1] - y) - (q[0] - x) * (p[1] - y);
      }, 0),
    ) / 2
  );
}
export const area = (multi) =>
  multi.reduce((sum, polygon) => sum + ringArea(polygon[0]) - polygon.slice(1).reduce((s, r) => s + ringArea(r), 0), 0);
export const union = (...geometries) => (geometries.length ? clipping.union(...geometries) : []);
export const difference = (subject, ...geometries) =>
  geometries.length ? clipping.difference(subject, ...geometries) : clone(subject);
export const intersection = (a, b) => clipping.intersection(a, b);
export const equivalent = (a, b) => area(clipping.xor(a, b)) <= EPS_AREA;

export function resultGeometry(result) {
  const v = result.value || {};
  let ring;
  if (Array.isArray(v.points)) ring = v.points;
  else if (Number.isFinite(v.width) && Number.isFinite(v.height)) {
    if (v.width <= 0 || v.height <= 0) throw new Error("矩形尺寸无效");
    const w = result.original_width,
      h = result.original_height;
    if (!(w > 0 && h > 0)) throw new Error("缺少原图尺寸");
    const a = ((v.rotation || 0) * Math.PI) / 180;
    ring = [
      [0, 0],
      [v.width, 0],
      [v.width, v.height],
      [0, v.height],
    ].map(([x, y]) => [
      v.x + x * Math.cos(a) - ((y * h) / w) * Math.sin(a),
      v.y + ((x * w) / h) * Math.sin(a) + y * Math.cos(a),
    ]);
  } else throw new Error("不支持的区域几何");
  return [[assertRing(ring)]];
}

// Portable fingerprint format v1. Rounding applies to the digest only, never to
// stored coordinates. Python uses the same normalized strings and SHA-256.
export function canonical(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("指纹包含非有限数值");
    const fixed = value.toFixed(10);
    return fixed === "-0.0000000000" ? "0.0000000000" : fixed;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const fingerprint = (value) => bytesToHex(sha256(utf8ToBytes(JSON.stringify(canonical(value)))));

export function storageParts(multi) {
  const parts = [];
  for (const polygon of multi) {
    if (polygon.length === 1) {
      parts.push(assertRing(polygon[0]).slice(0, -1));
      continue;
    }
    const flat = earcut.flatten(polygon.map((ring) => assertRing(ring).slice(0, -1)));
    const indices = earcut(flat.vertices, flat.holes, flat.dimensions);
    if (!indices.length || indices.length % 3) throw new Error("孔洞拆分失败，未修改标注");
    for (let i = 0; i < indices.length; i += 3) {
      parts.push(indices.slice(i, i + 3).map((j) => flat.vertices.slice(j * 2, j * 2 + 2)));
    }
  }
  const geometries = parts.map((ring) => [[assertRing(ring)]]);
  if (!equivalent(union(...geometries), multi)) throw new Error("拆分并集不能重建原区域，未修改标注");
  for (let i = 0; i < geometries.length; i++)
    for (let j = i + 1; j < geometries.length; j++) {
      if (area(intersection(geometries[i], geometries[j])) > EPS_AREA) throw new Error("存储分块发生重叠，未修改标注");
    }
  return parts;
}
