import {
  area,
  clone,
  difference,
  EPS_AREA,
  equivalent,
  fingerprint,
  intersection,
  resultGeometry,
  storageParts,
  union,
} from "./geometry";

export const GEOMETRY = new Set(["occupancy_rectangle", "occupancy_polygon"]);
export const PARENTS = new Set(["zone_rectangle", "zone_polygon"]);
export const REFERENCES = new Set([
  "room_rectangle",
  "room_polygon",
  "portal_rectangle",
  "portal_vector",
  "zone_rectangle",
  "zone_polygon",
  "function_zone",
  "connection_vector",
  "visual_connection_vector",
  "connection_review",
  "visual_connection_review",
]);
export const TYPES = {
  furniture_group: "家具组团占用",
  walkable: "可通行",
  restricted_free: "受限空闲",
  unclassified: "未分类（草稿）",
};
export const GROUP_TYPES = {
  sleeping: "睡眠",
  study_work: "学习办公",
  dining: "用餐",
  living_social: "起居会客",
  storage: "收纳",
  dressing_grooming: "更衣梳妆",
  cooking_preparation: "烹饪备餐",
  washbasin: "洗漱",
  toilet: "如厕",
  shower_fixtures: "淋浴设施",
  bathtub: "浴缸",
  laundry_drying: "洗衣晾晒",
  equipment_service: "设备服务",
  other: "其他",
};
export const context = (r) => r.meta?.occupancy_context || {};
export const labelOf = (results, id, control) =>
  results.find((r) => r.id === id && r.from_name === control)?.value?.labels?.[0];
export const sourceFingerprint = (result, results) =>
  fingerprint({
    value: result.value,
    width: result.original_width,
    height: result.original_height,
    label: labelOf(results, result.id, "function_zone"),
    room: result.meta?.partition_context?.parent_room_id || null,
  });
export const newId = () =>
  `oc_${Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(16).padStart(8, "0")).join("")}`;
export function parents(results) {
  return results
    .filter((r) => PARENTS.has(r.from_name))
    .map((result) => {
      const roomId = result.meta?.partition_context?.parent_room_id;
      const room = results.find((r) => r.id === roomId && r.meta?.room_graph_node);
      return {
        id: result.id,
        result,
        roomId,
        label: `${room?.meta.room_graph_node.room_type || "房间"} · ${labelOf(results, result.id, "function_zone") || "未知功能"} · ${result.id}`,
        geometry: resultGeometry(result),
        fingerprint: sourceFingerprint(result, results),
      };
    });
}
export function logicalRegions(results) {
  const regions = new Map();
  for (const result of results.filter((r) => GEOMETRY.has(r.from_name))) {
    const c = context(result),
      id = c.logical_id || `invalid:${result.id}`;
    if (!regions.has(id))
      regions.set(id, { id, context: c, type: labelOf(results, result.id, "occupancy_type"), parts: [], geometry: [] });
    const region = regions.get(id);
    region.parts.push(result);
    region.geometry = union(region.geometry, resultGeometry(result));
  }
  return [...regions.values()];
}
const semantic = (r, results) => {
  const c = context(r);
  return {
    id: r.id,
    control: r.from_name,
    value: r.value,
    width: r.original_width,
    height: r.original_height,
    type: labelOf(results, r.id, "occupancy_type"),
    logical_id: c.logical_id,
    group_id: c.group_id || null,
    group_type: c.group_type || null,
    group_note: c.group_note || "",
    parent_zone_id: c.parent_zone_id,
    parent_room_id: c.parent_room_id,
    generation: c.generation,
    parent_fingerprint: c.parent_fingerprint,
    remainder_input_fingerprint: c.remainder_input_fingerprint || null,
  };
};
export function parentContentFingerprint(results, parentId) {
  const parent = parents(results).find((p) => p.id === parentId);
  return fingerprint({
    parent: parent?.fingerprint || null,
    regions: results
      .filter((r) => GEOMETRY.has(r.from_name) && context(r).parent_zone_id === parentId)
      .map((r) => semantic(r, results))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}
export function remainderInputFingerprint(results, parentId) {
  const parent = parents(results).find((p) => p.id === parentId);
  return fingerprint({
    parent: parent?.fingerprint || null,
    regions: results
      .filter(
        (r) =>
          GEOMETRY.has(r.from_name) && context(r).parent_zone_id === parentId && context(r).generation !== "remainder",
      )
      .map((r) => semantic(r, results))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}
export function resultsForGeometry(geometry, type, c, source, idFactory = newId, preserveParts = []) {
  if (!Object.hasOwn(TYPES, type)) throw new Error("区域类别无效");
  return storageParts(geometry).flatMap((points) => {
    const id = idFactory();
    // Preserve a drawn rectangle (including its exact rotation/coordinates) only
    // if it still describes this complete component after clipping/union.
    const rectangle =
      c.generation === "manual" &&
      preserveParts.find(
        (part) => part.from_name === "occupancy_rectangle" && equivalent(resultGeometry(part), [[points]]),
      );
    return [
      {
        id,
        from_name: rectangle ? "occupancy_rectangle" : "occupancy_polygon",
        to_name: source.to_name || "image",
        type: rectangle ? "rectangle" : "polygon",
        original_width: source.original_width,
        original_height: source.original_height,
        image_rotation: source.image_rotation || 0,
        value: rectangle ? clone(rectangle.value) : { points },
        meta: { occupancy_context: { schema_version: 1, ...clone(c) } },
      },
      {
        id,
        from_name: "occupancy_type",
        to_name: source.to_name || "image",
        type: "labels",
        value: { labels: [type] },
      },
    ];
  });
}
export function baseContext(parent, sourceVersion, generation, logicalId = newId()) {
  return {
    schema_version: 1,
    logical_id: logicalId,
    group_id: null,
    group_type: null,
    group_note: "",
    parent_zone_id: parent.id,
    parent_room_id: parent.roomId,
    source_version: sourceVersion,
    parent_fingerprint: parent.fingerprint,
    generation,
    review_status: "pending",
    review_fingerprint: null,
  };
}
export function replaceLogicals(results, ids, additions) {
  const removing = new Set(
    results.filter((r) => GEOMETRY.has(r.from_name) && ids.includes(context(r).logical_id)).map((r) => r.id),
  );
  if (results.some((r) => r.type === "relation" && (removing.has(r.from_id) || removing.has(r.to_id))))
    throw new Error("待替换对象存在手工 Relations，请先人工处理关系");
  return [...results.filter((r) => !removing.has(r.id)), ...additions];
}
export function generateRemainder(results, parentId, sourceVersion, idFactory = newId) {
  const parent = parents(results).find((p) => p.id === parentId);
  if (!parent) throw new Error("请选择有效的父功能分区");
  const regions = logicalRegions(results).filter((r) => r.context.parent_zone_id === parentId);
  const input = remainderInputFingerprint(results, parentId);
  const old = regions.filter((r) => r.context.generation === "remainder");
  const manual = regions.filter((r) => r.context.generation !== "remainder");
  if (validateOccupancy(results, sourceVersion, { partial: true }).some((e) => e.parentId === parentId))
    throw new Error("请先处理当前分区的几何、归属或分块冲突");
  const remainder = difference(parent.geometry, ...manual.map((r) => r.geometry));
  if (
    old.length &&
    old.every((r) => r.context.remainder_input_fingerprint === input) &&
    equivalent(union(...old.map((r) => r.geometry)), remainder)
  )
    return { results, count: 0, unchanged: true };
  const additions = remainder.flatMap((polygon) =>
    resultsForGeometry(
      [polygon],
      "unclassified",
      { ...baseContext(parent, sourceVersion, "remainder", idFactory()), remainder_input_fingerprint: input },
      parent.result,
      idFactory,
    ),
  );
  return {
    results: replaceLogicals(
      results,
      old.map((r) => r.id),
      additions,
    ),
    count: remainder.length,
    unchanged: false,
    geometry: remainder,
  };
}
export function classifyLogical(results, logicalId, type) {
  if (!["walkable", "restricted_free"].includes(type)) throw new Error("请选择可通行或受限空闲");
  const region = logicalRegions(results).find((r) => r.id === logicalId);
  if (!region || region.type === "furniture_group") throw new Error("请选择空闲区域");
  const ids = new Set(region.parts.map((r) => r.id));
  return results.map((r) =>
    ids.has(r.id)
      ? r.from_name === "occupancy_type"
        ? { ...r, value: { labels: [type] } }
        : {
            ...r,
            meta: {
              ...r.meta,
              occupancy_context: { ...context(r), review_status: "pending", review_fingerprint: null },
            },
          }
      : r,
  );
}
export function localCorrection(results, logicalId, patch, type, idFactory = newId) {
  const region = logicalRegions(results).find((r) => r.id === logicalId);
  if (!region || region.type === "furniture_group" || !["walkable", "restricted_free"].includes(type))
    throw new Error("请选择空闲区域和修正类别");
  const part = intersection(region.geometry, patch),
    rest = difference(region.geometry, patch);
  if (!part.length) throw new Error("修正范围与目标区域没有交集");
  const c = { ...region.context, review_status: "pending", review_fingerprint: null };
  // Both children remain remainder-derived. Regeneration replaces them together;
  // explicitly drawn manual free areas are never replaced.
  const added = [
    ...resultsForGeometry(rest, region.type, c, region.parts[0], idFactory),
    ...resultsForGeometry(part, type, { ...c, logical_id: idFactory() }, region.parts[0], idFactory),
  ];
  return replaceLogicals(results, [logicalId], added);
}
export function mergeGroups(results, ids, groupType, note, idFactory = newId) {
  const regions = logicalRegions(results).filter((r) => ids.includes(r.id));
  if (
    regions.length !== ids.length ||
    regions.length < 2 ||
    regions.some((r) => r.type !== "furniture_group") ||
    new Set(regions.map((r) => r.context.parent_zone_id)).size !== 1
  )
    throw new Error("只能合并同一父分区内的家具组团");
  if (!GROUP_TYPES[groupType] || (groupType === "other" && !note?.trim()))
    throw new Error("组团类型无效，其他须填写说明");
  const c = {
    ...regions[0].context,
    group_type: groupType,
    group_note: note || "",
    review_status: "pending",
    review_fingerprint: null,
  };
  return replaceLogicals(
    results,
    ids,
    resultsForGeometry(union(...regions.map((r) => r.geometry)), "furniture_group", c, regions[0].parts[0], idFactory),
  );
}
export function confirmParents(results, ids, sourceVersion) {
  const errors = validateOccupancy(results, sourceVersion, { review: false }).filter((e) => ids.includes(e.parentId));
  if (errors.length) throw new Error(errors.map((e) => e.message).join("；"));
  if (!ids.length || ids.some((id) => !parents(results).some((p) => p.id === id))) throw new Error("复核父分区不存在");
  const hashes = Object.fromEntries(ids.map((id) => [id, parentContentFingerprint(results, id)]));
  return results.map((r) =>
    GEOMETRY.has(r.from_name) && hashes[context(r).parent_zone_id]
      ? {
          ...r,
          meta: {
            ...r.meta,
            occupancy_context: {
              ...context(r),
              review_status: "reviewed",
              review_fingerprint: hashes[context(r).parent_zone_id],
            },
          },
        }
      : r,
  );
}
export function validateOccupancy(results, sourceVersion, { partial = false, review = true } = {}) {
  const errors = [],
    parentList = parents(results),
    parentMap = new Map(parentList.map((p) => [p.id, p]));
  const push = (code, c, id, message) =>
    errors.push({
      code,
      parentId: c.parent_zone_id,
      objectId: id,
      message: `${parentMap.get(c.parent_zone_id)?.label || "父分区缺失"}：${message}`,
    });
  const geoms = results.filter((r) => GEOMETRY.has(r.from_name)),
    ids = new Set(),
    groups = new Map();
  for (const r of geoms) {
    const c = context(r),
      p = parentMap.get(c.parent_zone_id),
      label = results.filter((l) => l.id === r.id && l.from_name === "occupancy_type");
    if (
      ids.has(r.id) ||
      !c.logical_id ||
      label.length !== 1 ||
      label[0]?.value?.labels?.length !== 1 ||
      !Object.hasOwn(TYPES, label[0]?.value?.labels?.[0])
    )
      push("pair", c, r.id, "几何与类别配对或逻辑区域 ID 无效");
    ids.add(r.id);
    const type = label[0]?.value?.labels?.[0];
    if (!partial && !["manual", "remainder"].includes(c.generation))
      push("pending_draw", c, c.logical_id, "绘制轮廓尚未确认应用");
    if (!p) {
      push("parent_missing", c, r.id, "原父分区已删除或拆并；请明确重新绑定，现有标注已保留");
      continue;
    }
    // source_version is provenance. Current task reference revision is guarded
    // by transport; only the owning parent's fingerprint invalidates this L3.
    if (!c.source_version || c.parent_fingerprint !== p.fingerprint || c.parent_room_id !== p.roomId)
      push("source", c, r.id, "来源已变化，需检查并接受当前父参考");
    if (type === "furniture_group") {
      if (!c.group_id || !GROUP_TYPES[c.group_type] || (c.group_type === "other" && !c.group_note?.trim()))
        push("group", c, r.id, "组团类型/ID 无效或其他类型缺少说明");
      const identity = fingerprint([c.logical_id, c.parent_zone_id, c.group_type, c.group_note || ""]);
      if (groups.has(c.group_id) && groups.get(c.group_id) !== identity) push("group", c, r.id, "同组类型或归属不一致");
      groups.set(c.group_id, identity);
    } else if (c.group_id || c.group_type) push("group", c, r.id, "空闲区域不能携带家具组团属性");
    try {
      if (area(difference(resultGeometry(r), p.geometry)) > EPS_AREA) push("outside", c, r.id, "轮廓超出父功能分区");
    } catch (error) {
      push("geometry", c, r.id, error.message);
    }
    if (!partial) {
      if (type === "unclassified") push("unclassified", c, c.logical_id, "剩余空间尚未分类");
      if (c.generation === "remainder" && c.remainder_input_fingerprint !== remainderInputFingerprint(results, p.id))
        push("stale", c, c.logical_id, "补余已过期，请预览并重新生成");
      if (
        review &&
        (c.review_status !== "reviewed" || c.review_fingerprint !== parentContentFingerprint(results, p.id))
      )
        push("review", c, c.logical_id, "分区尚未完成复核或修改后需复核");
    }
  }
  for (const r of results.filter((r) => r.from_name === "occupancy_type"))
    if (!ids.has(r.id)) push("pair", {}, r.id, "类别缺少配对几何");
  let logical;
  try {
    logical = logicalRegions(results);
  } catch {
    return errors.length ? errors : [{ code: "geometry", message: "轮廓无效，无法构造逻辑区域" }];
  }
  for (const region of logical) {
    const c = region.context;
    if (
      region.parts.some(
        (r) => fingerprint(context(r)) !== fingerprint(c) || labelOf(results, r.id, "occupancy_type") !== region.type,
      )
    )
      push("parts", c, region.id, "逻辑区域分块属性不一致");
    for (let i = 0; i < region.parts.length; i++)
      for (let j = i + 1; j < region.parts.length; j++)
        if (area(intersection(resultGeometry(region.parts[i]), resultGeometry(region.parts[j]))) > EPS_AREA)
          push("parts_overlap", c, region.id, "同组分块尚未归并为互不重叠的并集");
  }
  for (const p of parentList) {
    const children = logical.filter((r) => r.context.parent_zone_id === p.id);
    for (let i = 0; i < children.length; i++)
      for (let j = i + 1; j < children.length; j++) {
        // Stale automatic remainder is replaced by regeneration, not treated as a
        // conflicting manual input when generating a new remainder.
        if (partial && [children[i], children[j]].some((r) => r.context.generation === "remainder")) continue;
        if (area(intersection(children[i].geometry, children[j].geometry)) > EPS_AREA)
          push("overlap", children[i].context, children[i].id, `与 ${children[j].id} 存在正面积重叠`);
      }
    if (!partial && !equivalent(union(...children.map((r) => r.geometry)), p.geometry))
      push("coverage", { parent_zone_id: p.id }, p.id, "子区域并集未完整覆盖父区域");
  }
  return [...new Map(errors.map((e) => [`${e.code}:${e.parentId}:${e.objectId}`, e])).values()];
}
export function logicalExport(results, sourceVersion) {
  return {
    schema_version: 1,
    coordinate_system: "image_percent",
    source_version: sourceVersion,
    regions: logicalRegions(invalidateReviews(results, sourceVersion)).map((r) => ({
      ...r.context,
      occupancy_type: r.type,
      storage_ids: r.parts.map((p) => p.id),
      geometry: { type: "MultiPolygon", coordinates: r.geometry },
    })),
  };
}

// Review stamps must never claim reviewed after geometry/labels/reference change.
// Keep the old stamp as evidence; only an explicit confirm issues a new one.
export function invalidateReviews(results, sourceVersion) {
  const hashes = new Map();
  return results.map((r) => {
    const c = context(r);
    if (!GEOMETRY.has(r.from_name) || c.review_status !== "reviewed") return r;
    try {
      if (!hashes.has(c.parent_zone_id))
        hashes.set(c.parent_zone_id, parentContentFingerprint(results, c.parent_zone_id));
      if (c.source_version && c.review_fingerprint === hashes.get(c.parent_zone_id)) return r;
    } catch {
      /* unfinished/invalid geometry invalidates review too */
    }
    return { ...r, meta: { ...r.meta, occupancy_context: { ...c, review_status: "pending" } } };
  });
}
