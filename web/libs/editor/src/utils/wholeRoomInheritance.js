import { isSimplePolygon, polygonArea } from "./roomConstraintGeometry";

export const ROOM_FUNCTION_MAPPING_VERSION = 1;
export const ROOM_FUNCTION_MAPPING = Object.freeze({
  Bedroom: "Sleeping",
  "Guest room": "Sleeping",
  "Children room": "Sleeping",
  Bathroom: "Sanitary/general",
  Kitchen: "Cooking/preparation",
  "Living room": "Living/social",
  "Dining room": "Dining",
  "Study room": "Study/work",
  "Dressing room": "Dressing/grooming",
  "Laundry room": "Laundry",
  Entryway: "Entry/transition",
  Hallway: "Circulation",
  "Storage room": "Storage",
  Balcony: "Balcony/leisure",
  Staircase: "Vertical circulation",
  Elevator: "Vertical circulation",
  Pipe: "Equipment/service",
  "Multipurpose room": "Unclear/other",
});
export const suggestedFunction = (roomType) => ROOM_FUNCTION_MAPPING[roomType] || "Unclear/other";

// Quantization is ONLY for change detection, never for stored coordinates.
const canonical = (value) => {
  if (typeof value === "number") return Number(value.toFixed(9));
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
};
export const fingerprint = (value) => JSON.stringify(canonical(value));
export const geometryValue = (result) => {
  const value = result?.value || {};
  if (result?.type === "rectangle" || result?.type === "rectanglelabels") {
    return { x: value.x, y: value.y, width: value.width, height: value.height, rotation: value.rotation || 0 };
  }
  return {
    points: Array.isArray(value.points) ? value.points.map((point) => (Array.isArray(point) ? [...point] : [])) : [],
    closed: value.closed !== false,
  };
};
export const geometryFingerprint = (result) =>
  fingerprint({
    value: geometryValue(result),
    original_width: result?.original_width,
    original_height: result?.original_height,
    image_rotation: result?.image_rotation || 0,
  });
export const roomFingerprint = (result, roomType) => fingerprint({ geometry: geometryFingerprint(result), roomType });
export const zoneFingerprint = (result, label) => fingerprint({ geometry: geometryFingerprint(result), label });

export function buildWholeRoomResults({ roomResult, roomType, label, context, id }) {
  const rectangle = roomResult.type === "rectanglelabels";
  const value = geometryValue(roomResult);
  const base = {
    id,
    to_name: roomResult.to_name,
    original_width: roomResult.original_width,
    original_height: roomResult.original_height,
    image_rotation: roomResult.image_rotation || 0,
    origin: "manual",
    readonly: false,
  };
  return [
    {
      ...base,
      from_name: rectangle ? "zone_rectangle" : "zone_polygon",
      type: rectangle ? "rectangle" : "polygon",
      value,
      meta: {
        partition_context: context,
        zone_inheritance: {
          schema_version: 1,
          generation_method: "whole_room",
          source_room_id: roomResult.id,
          source_room_type: roomType,
          source_reference_fingerprint: roomFingerprint(roomResult, roomType),
          mapping_version: ROOM_FUNCTION_MAPPING_VERSION,
          review_status: "pending",
        },
      },
    },
    { ...base, from_name: "function_zone", type: "labels", value: { ...geometryValue(roomResult), labels: [label] } },
  ];
}

export function inheritanceReview(geometry, label, source, sourceType) {
  const metadata = geometry.meta?.zone_inheritance;
  if (!metadata) return null;
  const sourceFingerprint = source ? roomFingerprint(source, sourceType) : null;
  const sourceChanged =
    sourceFingerprint !== (metadata.reviewed_source_fingerprint || metadata.source_reference_fingerprint);
  return {
    sourceChanged,
    wholeRoom: !!source && geometryFingerprint(geometry) === geometryFingerprint(source),
    reviewed:
      metadata.review_status === "reviewed" &&
      !sourceChanged &&
      metadata.reviewed_zone_fingerprint === zoneFingerprint(geometry, label),
    sourceFingerprint,
  };
}

export function inheritanceCandidates(rooms, zones, labels, incomplete = false, hasOrphanLabels = false) {
  const roomIds = new Set(rooms.map((room) => room.id));
  const orphan = hasOrphanLabels || zones.some((zone) => !roomIds.has(zone.parentRoomId));
  const blocked = incomplete
    ? "存在未完成的绘制，请先完成或取消"
    : orphan
      ? "存在无法归属或缺少几何的功能分区，请先修正"
      : null;
  return rooms.map((room) => {
    const label = suggestedFunction(room.roomType);
    const valid =
      !!room.result &&
      room.result.value?.closed !== false &&
      Array.isArray(room.polygon) &&
      room.polygon.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) &&
      isSimplePolygon(room.polygon) &&
      polygonArea(room.polygon) > 1e-9;
    const reason =
      blocked ||
      (zones.some((zone) => zone.parentRoomId === room.id)
        ? "已有功能分区，跳过"
        : !valid
          ? "房间几何无效"
          : !labels.includes(label)
            ? `配置缺少功能类别：${label}`
            : null);
    return {
      ...room,
      suggestedLabel: label,
      eligible: !reason,
      reason,
      sourceFingerprint: roomFingerprint(room.result, room.roomType),
    };
  });
}
