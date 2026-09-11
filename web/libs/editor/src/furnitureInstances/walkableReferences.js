import { resultGeometry, union, area } from "../occupancy/geometry";

const geometryControls = new Set(["occupancy_rectangle", "occupancy_polygon"]);
const cache = new WeakMap();

// Read-only presentation. Never replace, regenerate or change stored parts.
export function buildWalkableReferences(results) {
  const labels = new Map();
  for (const result of results.filter((r) => r.from_name === "occupancy_type")) {
    const entries = labels.get(result.id) || [];
    entries.push(result.value?.labels?.[0]);
    labels.set(result.id, entries);
  }
  const groups = new Map();
  for (const part of results.filter((r) => geometryControls.has(r.from_name))) {
    const id = part.meta?.occupancy_context?.logical_id;
    const key = id || `missing:${part.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(part);
  }
  const regions = [], errors = [], partIds = new Set();
  for (const [id, parts] of groups) {
    if (!parts.some((part) => labels.get(part.id)?.includes("walkable"))) continue;
    try {
      const first = parts[0].meta?.occupancy_context;
      if (!first?.logical_id || !first.parent_room_id || !first.parent_zone_id)
        throw new Error("缺少逻辑区域或父级身份");
      if (new Set(parts.map((part) => part.id)).size !== parts.length) throw new Error("重复几何结果 ID");
      for (const part of parts) {
        const c = part.meta?.occupancy_context;
        if (labels.get(part.id)?.length !== 1 || labels.get(part.id)[0] !== "walkable" ||
          c.parent_room_id !== first.parent_room_id || c.parent_zone_id !== first.parent_zone_id ||
          part.original_width !== parts[0].original_width || part.original_height !== parts[0].original_height ||
          part.to_name !== parts[0].to_name || (part.image_rotation || 0) !== (parts[0].image_rotation || 0))
          throw new Error("分块类别、父级或图像信息不一致");
      }
      const geometry = union(...parts.map(resultGeometry));
      if (!geometry.length || !(area(geometry) > 0)) throw new Error("整体几何为空或无效");
      regions.push({ id, roomId: first.parent_room_id, zoneId: first.parent_zone_id, geometry });
      for (const part of parts) partIds.add(part.id);
    } catch (error) {
      errors.push(`可通行区域 ${id}：${error.message}，暂保留原分块显示。`);
    }
  }
  return { regions, errors, partIds };
}

export function walkableReferencesFor(item, results) {
  const references = results.filter((r) => geometryControls.has(r.from_name) || r.from_name === "occupancy_type");
  const key = JSON.stringify(references);
  const previous = cache.get(item);
  if (previous?.key === key) return previous.value;
  const value = buildWalkableReferences(references);
  cache.set(item, { key, value });
  return value;
}
