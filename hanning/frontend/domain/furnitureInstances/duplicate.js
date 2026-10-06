import { clone } from "@hanning/frontend/domain/occupancy/geometry";
import { context, CONTROLS, furnitureInstances, newId } from "./domain";
import { validateFurnitureInstances } from "./constraints";

// Translate the complete logical instance, including orientation, without
// clipping or reshaping it. Category results share their geometry's new ID.
export function duplicateFurnitureInstance(results, instanceId, idFactory = newId) {
  const instance = furnitureInstances(results).find((value) => value.id === instanceId);
  if (!instance) throw new Error("请先选择一个家具实例");
  if (
    instance.results.some(
      (result) => result.readonly || (result.value?.closed === false && result.from_name === CONTROLS.polygon),
    )
  )
    throw new Error("只读或未完成的家具实例不能复制");
  const issues = validateFurnitureInstances(results, results, {
    review: false,
  }).filter((issue) => !issue.instanceId || issue.instanceId === instanceId);
  if (issues.length) throw new Error(issues.map((issue) => issue.message).join("；"));
  const { original_width: width, original_height: height } = instance.parts[0];
  if (!(width > 0 && height > 0)) throw new Error("缺少原图尺寸，无法复制");
  const id = idFactory();
  const ids = new Map(instance.results.map((result) => [result.id, null]));
  for (const key of ids.keys()) ids.set(key, idFactory());
  const offsets = [4, 2, 1].flatMap((n) => [
    [n, n],
    [-n, n],
    [n, -n],
    [-n, -n],
    [n, 0],
    [-n, 0],
    [0, n],
    [0, -n],
  ]);
  offsets.push([0, 0]);
  for (const offset of offsets) {
    const dx = (offset[0] * 100) / width,
      dy = (offset[1] * 100) / height;
    const additions = instance.results.map((source) => {
      const copy = clone(source);
      copy.id = ids.get(source.id);
      copy.meta = {
        furniture_instance_context: {
          ...context(source),
          instance_id: id,
          review_status: "pending",
          review_fingerprint: null,
        },
      };
      // Server provenance and origin IDs belong to the original instance.
      delete copy.parentID;
      delete copy.origin;
      if (copy.from_name === CONTROLS.rectangle) {
        copy.value.x += dx;
        copy.value.y += dy;
      } else if (copy.from_name === CONTROLS.polygon) {
        copy.value.points = copy.value.points.map(([x, y]) => [x + dx, y + dy]);
      } else if (Array.isArray(copy.value.vertices)) {
        copy.value.vertices = copy.value.vertices.map((point) =>
          Array.isArray(point) ? [point[0] + dx, point[1] + dy] : { ...point, x: point.x + dx, y: point.y + dy },
        );
      }
      return copy;
    });
    const checked = [...results, ...additions];
    const errors = validateFurnitureInstances(checked, checked, {
      review: false,
    }).filter((issue) => !issue.instanceId || issue.instanceId === id);
    if (!errors.length) return { id, results: additions, offset };
  }
  throw new Error("没有合法复制位置，请先检查实例及父组团边界");
}
