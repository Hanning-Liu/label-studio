import { clone, area, difference, EPS_AREA, resultGeometry, union } from "./geometry";
import { context, GEOMETRY, logicalRegions, newId, parents } from "./domain";

function editableGroup(results, logicalId) {
  const group = logicalRegions(results).find((region) => region.id === logicalId);
  if (!group || group.type !== "furniture_group" || group.context.generation !== "manual")
    throw new Error("请选择已绘制的家具组团");
  if (group.parts.some((part) => part.readonly || part.value.closed === false))
    throw new Error("只读或未闭合的家具组团不能复制或移动");
  const parent = parents(results).find((candidate) => candidate.id === group.context.parent_zone_id);
  if (!parent) throw new Error("所属父功能分区不存在，请先重新绑定");
  return { group, parent };
}

function translatedPart(part, dx, dy) {
  const result = clone(part);
  if (Array.isArray(result.value.points)) result.value.points = result.value.points.map(([x, y]) => [x + dx, y + dy]);
  else {
    result.value.x += dx;
    result.value.y += dy;
  }
  return result;
}

const fits = (parts, parent) => area(difference(union(...parts.map(resultGeometry)), parent.geometry)) <= EPS_AREA;

// A rigid offset in ORIGINAL pixels: preserve rectangles, rotations, holes and
// all component relationships. Never clip a duplicate to make it fit.
export function duplicateGroup(results, logicalId, idFactory = newId) {
  const { group, parent } = editableGroup(results, logicalId);
  if (!fits(group.parts, parent)) throw new Error("原组团越出父功能分区，请先调整轮廓");
  const { original_width: width, original_height: height } = parent.result;
  if (!(width > 0 && height > 0)) throw new Error("缺少原图尺寸");
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
  const offset = offsets.find(([x, y]) =>
    fits(
      group.parts.map((part) => translatedPart(part, (x * 100) / width, (y * 100) / height)),
      parent,
    ),
  );
  const id = idFactory();
  const additions = group.parts.flatMap((part) => {
    const copy = translatedPart(part, (offset[0] * 100) / width, (offset[1] * 100) / height);
    copy.id = idFactory();
    copy.meta.occupancy_context = {
      ...context(part),
      logical_id: id,
      group_id: id,
      review_status: "pending",
      review_fingerprint: null,
    };
    // These server-owned projections describe the ORIGINAL target identity
    // and position. Let the normal draft/submit pipeline derive the new ones.
    delete copy.meta.window_projections;
    delete copy.meta.window_projection_state;
    const originalLabel = results.find((result) => result.id === part.id && result.from_name === "occupancy_type");
    if (!originalLabel) throw new Error("组团缺少配对类别，无法复制");
    const label = clone(originalLabel);
    label.id = copy.id;
    return [copy, label];
  });
  return { results: [...results, ...additions], logicalId: id, offset };
}

// Used for whole-group drag when a union has multiple components or holes.
// The same translation applies to every storage part; invalid drops do nothing.
export function translateGroup(results, logicalId, dx, dy) {
  if (![dx, dy].every(Number.isFinite)) throw new Error("移动距离无效");
  const { group, parent } = editableGroup(results, logicalId);
  const parts = group.parts.map((part) => translatedPart(part, dx, dy));
  if (!fits(parts, parent)) throw new Error("组团不能移出所属功能分区，已保留原位置");
  const byId = new Map(parts.map((part) => [part.id, part]));
  return results.map((result) =>
    GEOMETRY.has(result.from_name) && byId.has(result.id) ? byId.get(result.id) : result,
  );
}
