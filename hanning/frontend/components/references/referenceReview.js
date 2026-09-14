const PRIMARY_CONTROLS = new Set(["zone_rectangle", "zone_polygon", "connection_vector", "visual_connection_vector"]);
const INVALID_REVIEW_REASONS = new Set(["source_missing", "outside_parent_room"]);

const controlName = (result) => result?.from_name?.name || result?.from_name || "";
const areaId = (result) => result?.area?.cleanId || result?.id || "";
const values = (result) => {
  const direct = result?.mainValue?.toJSON?.() ?? result?.mainValue;
  if (Array.isArray(direct)) return direct;
  const value = result?.value || {};
  for (const key of [result?.type, "labels", "rectanglelabels", "polygonlabels", "vectorlabels", "choices"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
};

const roomType = (room) => room?.meta?.room_graph_node?.room_type || values(room)[0] || "未知房间";

export const referenceTriggerLabel = (review = {}) => {
  if (review.reason === "source_missing") return "父房间参考已删除";
  if (review.reason === "outside_parent_room") return "父房间边界发生变化，当前分区已越界";
  if (review.reason === "geometry_or_label_changed") return "本对象的几何或类别已改变";
  if (review.reason === "geometry_corrected_needs_review") return "几何问题已修正";
  const kinds = new Set(review.changed_reference_types || []);
  if (kinds.has("room") && kinds.has("portal")) return "房间参考和开口参考均发生变化";
  if (kinds.has("room")) return "房间参考发生变化";
  if (kinds.has("portal")) return "开口参考发生变化";
  if (review.reason === "room_or_portal_changed") return "上游参考发生变化（历史记录未区分具体来源）";
  return "参考变化待复核";
};

export function buildReferenceReviewRows(results = [], statusPending = []) {
  const statusById = new Map(statusPending.map((entry) => [entry.id, entry]));
  const rows = [];
  const seen = new Set();
  for (const result of results) {
    const control = controlName(result);
    const id = areaId(result);
    const storedReview = result?.meta?.reference_review;
    if (!PRIMARY_CONTROLS.has(control) || storedReview?.status !== "pending" || !id || seen.has(id)) continue;
    seen.add(id);
    const statusReview = statusById.get(id) || {};
    const review = {
      ...statusReview,
      ...storedReview,
      changed_reference_ids: storedReview.changed_reference_ids || statusReview.changed_reference_ids || [],
      changed_reference_types: storedReview.changed_reference_types || statusReview.changed_reference_types || [],
      affected_room_ids: storedReview.affected_room_ids || statusReview.affected_room_ids || [],
    };
    let targetType = "区域";
    let targetLabel = "未命名区域";
    let parentRoomId = "";
    let color = result?.area?.getOneColor?.() || "#7b8a83";
    if (control === "zone_rectangle" || control === "zone_polygon") {
      parentRoomId = result?.meta?.partition_context?.parent_room_id || "";
      const room = results.find(
        (candidate) => areaId(candidate) === parentRoomId && /^room_(rectangle|polygon)$/.test(controlName(candidate)),
      );
      const category = results.find(
        (candidate) => areaId(candidate) === id && controlName(candidate) === "function_zone",
      );
      targetType = "功能分区";
      targetLabel = `${roomType(room)} · ${values(category)[0] || "未知功能"}`;
      color = room?.area?.getOneColor?.() || color;
    } else if (control === "connection_vector") {
      targetType = "交通连通 Vector";
      targetLabel = `交通连通 Vector · ${values(result)[0] || "未分类"}`;
    } else if (control === "visual_connection_vector") {
      targetType = "视觉连通 Vector";
      targetLabel = `视觉连通 Vector · ${values(result)[0] || "未分类"}`;
    }
    rows.push({
      id,
      result,
      review,
      targetType,
      targetLabel,
      parentRoomId,
      color,
      triggerLabel: referenceTriggerLabel(review),
      eligible: !INVALID_REVIEW_REASONS.has(review.reason),
    });
  }
  return rows;
}

export function referenceReviewSummary(rows = []) {
  const counts = { zones: 0, connections: 0, visuals: 0 };
  for (const row of rows) {
    if (row.targetType === "功能分区") counts.zones += 1;
    else if (row.targetType === "交通连通 Vector") counts.connections += 1;
    else if (row.targetType === "视觉连通 Vector") counts.visuals += 1;
  }
  return counts;
}
