import {
  OCCUPANCY_ZONE_REFERENCE_APPEARANCE,
  isOccupancyZoneReferenceRegion,
  occupancyZoneReferenceLevel,
  occupancyZoneReferenceStyles,
  partitionOccupancyZoneReferenceRegions,
  shouldRenderOccupancyReferenceRegion,
} from "../referenceDisplay";

function setup(focusId = "focus") {
  const image = {
    occupancyEnabled: true,
    occupancyFocusId: focusId,
    occupancyShowRoomReferences: false,
    regs: [],
  };
  const zone = (id, roomId) => ({
    cleanId: id,
    parent: image,
    results: [{ meta: { partition_context: { parent_room_id: roomId } } }],
  });
  const focused = zone("focus", "room-a");
  const sameRoom = zone("same", "room-a");
  const outsideRoom = zone("outside", "room-b");
  image.regs = [focused, sameRoom, outsideRoom];
  return { image, focused, sameRoom, outsideRoom };
}

test("L2 reference levels follow Focus zone and parent room", () => {
  const { focused, sameRoom, outsideRoom } = setup();
  expect(occupancyZoneReferenceLevel(focused)).toBe("focused");
  expect(occupancyZoneReferenceLevel(sameRoom)).toBe("sameRoom");
  expect(occupancyZoneReferenceLevel(outsideRoom)).toBe("outsideRoom");
});

test("all L2 references use the outside-room level until a Focus zone is selected", () => {
  const { sameRoom } = setup("");
  expect(occupancyZoneReferenceLevel(sameRoom)).toBe("outsideRoom");
});

test("L2 display styles apply the agreed fill, stroke and label hierarchy", () => {
  const { focused, sameRoom, outsideRoom } = setup();
  const base = { fillColor: "#336699", strokeColor: "#cc3300", strokeWidth: 7 };

  expect(occupancyZoneReferenceStyles(focused, base)).toMatchObject({
    fillColor: "rgba(51, 102, 153, 0.2)",
    strokeColor: "rgba(204, 51, 0, 1)",
    labelColor: "rgba(204, 51, 0, 1)",
    strokeWidth: 2,
  });
  expect(occupancyZoneReferenceStyles(sameRoom, base)).toMatchObject({
    fillColor: "rgba(51, 102, 153, 0.1)",
    strokeColor: "rgba(204, 51, 0, 0.65)",
    labelColor: "rgba(204, 51, 0, 0.75)",
    strokeWidth: 1.5,
  });
  expect(occupancyZoneReferenceStyles(outsideRoom, base)).toMatchObject({
    fillColor: "rgba(51, 102, 153, 0.05)",
    strokeColor: "rgba(204, 51, 0, 0.3)",
    labelColor: "rgba(204, 51, 0, 0.35)",
    strokeWidth: 1,
  });
  expect(OCCUPANCY_ZONE_REFERENCE_APPEARANCE.focused.fillOpacity).toBe(0.2);
});

test("non-L3 regions keep their existing renderer style", () => {
  const { outsideRoom } = setup();
  outsideRoom.parent.occupancyEnabled = false;
  expect(occupancyZoneReferenceLevel(outsideRoom)).toBeNull();
  expect(occupancyZoneReferenceStyles(outsideRoom, { fillColor: "#fff", strokeColor: "#000" })).toBeNull();
});

test("L1 room geometry is hidden only on the L3 canvas and can be restored temporarily", () => {
  const image = { occupancyEnabled: true, occupancyShowRoomReferences: false };
  const room = { isRoomReference: true };
  const zone = { isRoomReference: false };

  expect(shouldRenderOccupancyReferenceRegion(image, room)).toBe(false);
  expect(shouldRenderOccupancyReferenceRegion(image, zone)).toBe(true);
  image.occupancyShowRoomReferences = true;
  expect(shouldRenderOccupancyReferenceRegion(image, room)).toBe(true);
  expect(shouldRenderOccupancyReferenceRegion({ occupancyEnabled: false }, room)).toBe(true);
});

test("L2 function zones are separated from interactive L3 regions by partition metadata", () => {
  const reference = { results: [{ meta: { partition_context: { parent_room_id: "room-a" } } }] };
  const furniture = { results: [{ meta: { occupancy_context: { parent_zone_id: "zone-a" } } }] };
  const barrier = { results: [{ meta: { occupancy_barrier_context: { parent_zone_id: "zone-a" } } }] };

  expect(isOccupancyZoneReferenceRegion(reference)).toBe(true);
  expect(isOccupancyZoneReferenceRegion(furniture)).toBe(false);

  expect(partitionOccupancyZoneReferenceRegions([furniture, reference, barrier])).toEqual({
    references: [reference],
    interactive: [furniture, barrier],
  });
});
