const geometryTypeLabel = (room) => {
  const geometryType = String(room?.roomGraphNode?.geometry_type || room?.type || "").toLowerCase();

  if (geometryType.includes("polygon")) return "Polygon";
  if (geometryType.includes("rectangle") || geometryType.includes("rect")) return "Rectangle";
  return "未知几何";
};

export const formatFunctionZoneRoomLabel = (room, fallbackId = null) => {
  const roomId = room?.cleanId || fallbackId || "未知 ID";
  const roomType = room?.roomGraphNode?.room_type || room?.labelName || "未知房间类型";
  const regionIndex = Number.isFinite(room?.region_index) ? `标注序号 ${room.region_index}，` : "";

  return `${roomType}（${regionIndex}${geometryTypeLabel(room)}，ID ${roomId}）`;
};
