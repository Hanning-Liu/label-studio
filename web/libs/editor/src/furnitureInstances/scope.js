import { ALL_CONTROLS, furnitureGroups } from "./domain";
import { area, resultGeometry } from "../occupancy/geometry";
import { windowTraceFingerprint } from "../windows/domain";

const cache = new WeakMap();
export const ROOM_CONTROLS = new Set(["room_rectangle", "room_polygon"]);
export const ZONE_CONTROLS = new Set(["zone_rectangle", "zone_polygon"]);
const CONNECTIONS = new Set(["connection_vector", "visual_connection_vector"]);
const OPENINGS = new Set(["portal_rectangle", "portal_vector"]);
export const referenceKey = (r) => `${r.id}\u0000${r.from_name?.name || r.from_name}`;
const distanceToSegment = (p, a, b) => {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    d = dx * dx + dy * dy;
  const t = d ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / d)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

// Same 401 length-spaced samples, pixel tolerance and 95% support as the
// existing nested/grouped GraphML connectivity exporter. No nearest-zone guess.
export function connectionZoneIds(result, zones) {
  const W = result.original_width,
    H = result.original_height;
  const vertices = result.value?.vertices;
  if (
    !(W > 0 && H > 0) ||
    !Array.isArray(vertices) ||
    vertices.length !== 2 ||
    vertices.some((p) => p.isBezier || !Number.isFinite(p.x) || !Number.isFinite(p.y))
  )
    throw new Error("连接必须具有两个直线点和有效原图尺寸");
  const [a, b] = vertices.map((p) => [(p.x * W) / 100, (p.y * H) / 100]);
  const epsilon = Math.max(2, Math.round(0.001 * Math.min(W, H)));
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < Math.max(4, 2 * epsilon)) throw new Error("连接线过短");
  const supported = zones.filter((zone) => {
    const rings = zone.geometry.flatMap((p) => p.map((r) => r.map(([x, y]) => [(x * W) / 100, (y * H) / 100])));
    let count = 0;
    for (let i = 0; i <= 400; i++) {
      const p = [a[0] + ((b[0] - a[0]) * i) / 400, a[1] + ((b[1] - a[1]) * i) / 400];
      if (rings.some((r) => r.some((v, j) => distanceToSegment(p, v, r[(j + 1) % r.length]) <= epsilon))) count++;
    }
    return count / 401 >= 0.95;
  });
  if (supported.length !== 2 || new Set(supported.map((z) => z.roomId)).size !== 1)
    throw new Error(`连接应对应同房间两个分区，当前支持 ${supported.length} 个`);
  return supported.map((z) => z.id);
}

export function buildFurnitureScope(results) {
  const rooms = [],
    zones = [],
    issues = [],
    references = [];
  const seen = new Set();
  for (const result of results.filter((r) => ROOM_CONTROLS.has(r.from_name) || ZONE_CONTROLS.has(r.from_name))) {
    try {
      if (seen.has(result.id)) throw new Error("重复空间 ID");
      seen.add(result.id);
      const geometry = resultGeometry(result);
      if (!(area(geometry) > 0)) throw new Error("空间几何无效");
      if (ROOM_CONTROLS.has(result.from_name))
        rooms.push({
          id: result.id,
          result,
          geometry,
          label:
            result.meta?.room_graph_node?.room_type ||
            result.value?.rectanglelabels?.[0] ||
            result.value?.polygonlabels?.[0] ||
            result.id,
        });
      else
        zones.push({
          id: result.id,
          result,
          geometry,
          roomId: result.meta?.partition_context?.parent_room_id,
          label:
            results.find((r) => r.id === result.id && r.from_name === "function_zone")?.value?.labels?.[0] || result.id,
        });
    } catch (error) {
      issues.push(`${result.id}：${error.message}`);
    }
  }
  for (const zone of zones) if (!rooms.some((r) => r.id === zone.roomId)) issues.push(`${zone.id}：原父房间缺失`);
  let groups = [];
  try {
    groups = furnitureGroups(results);
  } catch (error) {
    issues.push(`家具组团：${error.message}`);
  }
  for (const group of groups)
    if (!zones.some((z) => z.id === group.zoneId && z.roomId === group.roomId))
      issues.push(`${group.id}：原父分区链不一致`);

  for (const result of results) {
    const name = result.from_name;
    if (
      !OPENINGS.has(name) &&
      !CONNECTIONS.has(name) &&
      name !== "window_vector" &&
      name !== "occupancy_barrier_vector"
    )
      continue;
    const entry = {
      id: result.id,
      control: name,
      key: referenceKey(result),
      result,
      roomIds: [],
      zoneIds: [],
      issue: "",
    };
    try {
      if (OPENINGS.has(name)) {
        const c = result.meta?.room_graph_edge;
        entry.level = "L1";
        entry.kind = "开口";
        entry.roomIds = c?.connected_room_ids || c?.room_ids || [];
        entry.exterior = !!c?.connects_to_exterior;
        entry.zoneIds = zones
          .filter((z) => z.result.meta?.partition_context?.opening_ids?.includes(result.id))
          .map((z) => z.id);
        if (!entry.roomIds.length) throw new Error("开口房间归属未确认");
      } else if (name === "window_vector") {
        const c = result.meta?.window_context;
        entry.level = "L1";
        entry.kind = "窗";
        entry.roomIds = c?.parent_room_id ? [c.parent_room_id] : [];
        entry.exterior = !!c?.connection?.connects_to_exterior;
        if (c?.derivation_status !== "current" || c.source_window_trace_fingerprint !== windowTraceFingerprint(result))
          throw new Error("窗来源未确认或已过期");
        for (const zone of zones) {
          const projections = zone.result.meta?.window_projections || [];
          const owned = projections.filter((p) => p.source_window_trace_id === c.source_trace_id);
          if (!owned.length) continue;
          const state = zone.result.meta?.window_projection_state;
          if (
            state?.status !== "current" ||
            owned.some(
              (p) =>
                p.target?.entity_id !== zone.id ||
                p.target?.room_id !== zone.roomId ||
                p.derivation?.target_fingerprint !== state.target_fingerprint ||
                p.derivation?.source_window_trace_fingerprint !== c.source_window_trace_fingerprint,
            )
          ) {
            entry.issue = `分区 ${zone.id} 的窗投影过期或不一致`;
            continue;
          }
          entry.zoneIds.push(zone.id);
        }
      } else if (CONNECTIONS.has(name)) {
        entry.level = "L2";
        entry.kind = name === "visual_connection_vector" ? "仅视觉连接" : "交通与视觉连接";
        entry.zoneIds = connectionZoneIds(result, zones);
        entry.roomIds = [zones.find((z) => z.id === entry.zoneIds[0]).roomId];
        const control = name === "visual_connection_vector" ? "visual_connection_review" : "connection_review";
        if (
          !results.some((r) => r.id === result.id && r.from_name === control && r.value?.choices?.includes("Reviewed"))
        )
          entry.issue = "连接尚未复核";
      } else {
        const c = result.meta?.occupancy_barrier_context;
        entry.level = "L3";
        entry.kind = "墙障碍";
        entry.roomIds = c?.parent_room_id ? [c.parent_room_id] : [];
        entry.zoneIds = c?.parent_zone_id ? [c.parent_zone_id] : [];
        if (
          !zones.some((z) => z.id === c?.parent_zone_id && z.roomId === c?.parent_room_id) ||
          !c?.matched_pairs?.length
        )
          throw new Error("墙障碍归属或关联组团未确认");
      }
    } catch (error) {
      entry.issue = error.message;
    }
    references.push(entry);
  }
  return { rooms, zones, groups, references, issues };
}

export function furnitureScopeFor(item, results) {
  const refs = results.filter((r) => !ALL_CONTROLS.has(r.from_name));
  const key = JSON.stringify(refs),
    previous = cache.get(item);
  if (previous?.key === key) return previous.value;
  const value = buildFurnitureScope(refs);
  cache.set(item, { key, value });
  return value;
}

export const instanceInScope = (item, instance) =>
  item.furnitureInstanceZoneId === undefined ||
  (instance.context.room_id === item.furnitureInstanceRoomId &&
    instance.context.zone_id === item.furnitureInstanceZoneId);

export function referenceInScope(item, entry) {
  if (!item.furnitureInstanceZoneId) return false;
  const kind =
    entry.control === "window_vector"
      ? "windows"
      : OPENINGS.has(entry.control)
        ? "openings"
        : entry.control === "occupancy_barrier_vector"
          ? "barriers"
          : "connections";
  if (item.furnitureInstanceReferenceLayers?.[kind] === false) return false;
  return Boolean(
    item.furnitureInstanceOverview ||
      entry.zoneIds.includes(item.furnitureInstanceZoneId) ||
      (item.furnitureInstanceRoomBackground && entry.roomIds.includes(item.furnitureInstanceRoomId)),
  );
}
