import { formatFunctionZoneRoomLabel } from "../functionZoneValidationLabels";

describe("formatFunctionZoneRoomLabel", () => {
  it("shows room type, geometry, annotation index, and full id", () => {
    expect(
      formatFunctionZoneRoomLabel({
        cleanId: "UJBdiAK5uU",
        region_index: 14,
        type: "polygonregion",
        roomGraphNode: { room_type: "Study room", geometry_type: "polygon" },
      }),
    ).toBe("Study room（标注序号 14，Polygon，ID UJBdiAK5uU）");
  });

  it("falls back to the visible label and rectangle model type", () => {
    expect(
      formatFunctionZoneRoomLabel({ cleanId: "room-2", labelName: "Bedroom", type: "rectangleregion" }),
    ).toBe("Bedroom（Rectangle，ID room-2）");
  });

  it("keeps a missing parent room id visible", () => {
    expect(formatFunctionZoneRoomLabel(null, "missing-room")).toBe(
      "未知房间类型（未知几何，ID missing-room）",
    );
  });
});
