import {
  area,
  intersection,
  resultGeometry,
  validationMultiGeometry,
  VALIDATION_EPS_AREA,
  fingerprint,
} from "../occupancy/geometry";
import { furnitureConstraintSpace } from "./constraints";
import { rotatedRectanglePoints } from "../utils/roomConstraintGeometry";

export function rectanglePixelCenter(result) {
  const v = result.value,
    W = result.original_width,
    H = result.original_height,
    a = ((v.rotation || 0) * Math.PI) / 180;
  return {
    x: (v.x * W) / 100 + ((v.width * W) / 200) * Math.cos(a) - ((v.height * H) / 200) * Math.sin(a),
    y: (v.y * H) / 100 + ((v.width * W) / 200) * Math.sin(a) + ((v.height * H) / 200) * Math.cos(a),
  };
}
export const rectanglePreviewToken = (instance, parent, reference) =>
  fingerprint({ results: instance.results, parent: parent.fingerprint, reference });

export function rectanglePreview(result, parentGeometry, options = {}, siblings = []) {
  const W = result.original_width,
    H = result.original_height;
  const center = rectanglePixelCenter(result);
  const x = options.centerX ?? center.x,
    y = options.centerY ?? center.y;
  const angle = options.angle ?? result.value.rotation ?? 0,
    scale = options.scale ?? 1;
  if (![x, y, angle, scale, W, H].every(Number.isFinite) || !(W > 0 && H > 0 && scale > 0))
    throw new Error("请输入有效的角度、中心和尺寸比例");
  const rotation = ((angle % 360) + 360) % 360,
    a = (rotation * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  const space = furnitureConstraintSpace(parentGeometry, { width: W, height: H, boundary: false, pixel: false });
  const rectangle = (factor) => {
    const w = ((result.value.width * W) / 100) * factor,
      h = ((result.value.height * H) / 100) * factor;
    return {
      x: ((x - (w * c) / 2 + (h * s) / 2) * 100) / W,
      y: ((y - (w * s) / 2 - (h * c) / 2) * 100) / H,
      width: (w * 100) / W,
      height: (h * 100) / H,
      rotation,
    };
  };
  const valid = (value) => {
    const w = (value.width * W) / 100,
      h = (value.height * H) / 100;
    if (w < 1 || h < 1) return false;
    if (
      !space.inside(
        rotatedRectanglePoints({ x: (value.x * W) / 100, y: (value.y * H) / 100, width: w, height: h, rotation }),
      )
    )
      return false;
    const geometry = validationMultiGeometry(resultGeometry({ ...result, value }), W, H);
    return siblings.every(
      (sibling) =>
        area(intersection(geometry, validationMultiGeometry(resultGeometry(sibling), W, H))) <= VALIDATION_EPS_AREA,
    );
  };
  let value = rectangle(scale),
    acceptedScale = scale;
  if (options.fit && !valid(value)) {
    let lo = 0,
      hi = Math.min(1, scale);
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2,
        candidate = rectangle(mid);
      // Positive rectangles nested around an interior center have monotone
      // containment. The minimum size is checked after solving containment.
      const points = rotatedRectanglePoints({
        x: (candidate.x * W) / 100,
        y: (candidate.y * H) / 100,
        width: (candidate.width * W) / 100,
        height: (candidate.height * H) / 100,
        rotation,
      });
      const geometry = validationMultiGeometry(resultGeometry({ ...result, value: candidate }), W, H);
      const contained =
        space.inside(points) &&
        siblings.every(
          (sibling) =>
            area(intersection(geometry, validationMultiGeometry(resultGeometry(sibling), W, H))) <= VALIDATION_EPS_AREA,
        );
      if (contained) lo = mid;
      else hi = mid;
    }
    // Retain the requested ghost when the chosen center has no feasible size.
    // A zero-size result is neither valid storage nor useful preview geometry.
    acceptedScale = lo;
    value = rectangle(lo > 0 ? lo : scale);
  } else if (options.fit && scale > 1) {
    acceptedScale = 1;
    value = rectangle(1);
  }
  const legal = acceptedScale > 0 && valid(value);
  return {
    value,
    geometry: resultGeometry({ ...result, value }),
    valid: legal,
    scale: acceptedScale,
    centerX: x,
    centerY: y,
    angle: rotation,
    issue: legal ? "" : "轮廓超出原父组团、穿过孔洞、与同实例分块重叠或小于 1 像素；请调整中心/缩小，或使用适配预览",
  };
}

export function parentEdgeAngles(parent, W, H) {
  return parent.geometry.flatMap((polygon, p) =>
    polygon.flatMap((ring, r) =>
      ring.slice(0, -1).map((a, i) => {
        const b = ring[i + 1];
        return {
          key: `${p}:${r}:${i}`,
          label: `分块 ${p + 1} ${r ? "孔洞 " + r : "外边界"} · 边 ${i + 1}`,
          angle: ((((Math.atan2((b[1] - a[1]) * H, (b[0] - a[0]) * W) * 180) / Math.PI) % 360) + 360) % 360,
        };
      }),
    ),
  );
}
