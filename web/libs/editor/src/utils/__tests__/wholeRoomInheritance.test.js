import {
  buildWholeRoomResults,
  geometryValue,
  inheritanceCandidates,
  inheritanceReview,
  ROOM_FUNCTION_MAPPING,
  roomFingerprint,
  suggestedFunction,
  zoneFingerprint,
} from "../wholeRoomInheritance";

const room = {
  id: "room-a",
  from_name: "room_rectangle",
  to_name: "image",
  type: "rectanglelabels",
  original_width: 1234,
  original_height: 987,
  image_rotation: 0,
  readonly: true,
  value: {
    x: 1.12345678901234,
    y: 2.23456789012345,
    width: 20.9876543210123,
    height: 11.4567890123456,
    rotation: 32.12345678901234,
    rectanglelabels: ["Bathroom"],
  },
};
const context = { schema_version: 3, parent_room_id: "room-a", opening_ids: ["door"], connected_room_ids: ["room-b"] };
const make = (source = room) =>
  buildWholeRoomResults({
    roomResult: source,
    roomType: "Bathroom",
    label: "Sanitary/general",
    id: "new-zone",
    context,
  });

test.each(Object.entries(ROOM_FUNCTION_MAPPING))("maps %s to %s", (type, label) =>
  expect(suggestedFunction(type)).toBe(label),
);
test("unknown room types remain explicit suggestions", () =>
  expect(suggestedFunction("unknown")).toBe("Unclear/other"));
test.each([0, 32.12345678901234])("copies rectangle coordinates and rotation exactly (%s)", (rotation) => {
  const source = { ...room, value: { ...room.value, rotation } };
  const [geometry, label] = make(source);
  expect(geometry.value).toEqual(geometryValue(source));
  expect(geometry.id).not.toBe(source.id);
  expect(geometry.id).toBe(label.id);
  expect(geometry.meta.partition_context).toEqual(context);
  expect(geometry.meta.zone_inheritance.review_status).toBe("pending");
  expect(label.value.labels).toEqual(["Sanitary/general"]);
  expect(geometry.origin).toBe("manual");
  expect(source.readonly).toBe(true);
});
test("copies concave polygon vertices, never substitutes a bounding box, and survives JSON reload", () => {
  const source = {
    ...room,
    type: "polygonlabels",
    value: {
      closed: true,
      points: [
        [1.123456789123, 2],
        [40, 2],
        [40, 15],
        [15, 15],
        [15, 40],
        [1, 40],
      ],
      polygonlabels: ["Bathroom"],
    },
  };
  const results = make(source);
  expect(results[0].type).toBe("polygon");
  expect(results[0].value.points).toEqual(source.value.points);
  expect(JSON.parse(JSON.stringify(results))).toEqual(results);
  expect(results[0].value.points).not.toBe(source.value.points);
});
test("requires separate confirmation and invalidates on label, geometry, or source changes", () => {
  const [geometry] = make();
  expect(inheritanceReview(geometry, "Sanitary/general", room, "Bathroom").reviewed).toBe(false);
  Object.assign(geometry.meta.zone_inheritance, {
    review_status: "reviewed",
    reviewed_zone_fingerprint: zoneFingerprint(geometry, "Sanitary/general"),
    reviewed_source_fingerprint: roomFingerprint(room, "Bathroom"),
  });
  expect(inheritanceReview(geometry, "Sanitary/general", room, "Bathroom").reviewed).toBe(true);
  expect(inheritanceReview(geometry, "Toilet", room, "Bathroom").reviewed).toBe(false);
  expect(inheritanceReview(geometry, "Sanitary/general", room, "Kitchen").sourceChanged).toBe(true);
  geometry.value.x += 1;
  expect(inheritanceReview(geometry, "Sanitary/general", room, "Bathroom")).toMatchObject({
    reviewed: false,
    wholeRoom: false,
  });
  expect(inheritanceReview({ value: room.value }, "Sleeping", room, "Bathroom")).toBeNull();
});
test("skips any existing zone including partial coverage; blocks orphan and unfinished results", () => {
  const rooms = [
    {
      id: "room-a",
      roomType: "Bathroom",
      result: room,
      polygon: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
        { x: 0, y: 20 },
      ],
    },
  ];
  const labels = ["Sanitary/general"];
  expect(inheritanceCandidates(rooms, [], labels)[0].eligible).toBe(true);
  expect(inheritanceCandidates(rooms, [{ parentRoomId: "room-a" }], labels)[0].reason).toContain("已有");
  expect(inheritanceCandidates(rooms, [{ parentRoomId: "missing" }], labels)[0].eligible).toBe(false);
  expect(inheritanceCandidates(rooms, [], labels, true)[0].eligible).toBe(false);
  expect(inheritanceCandidates(rooms, [], labels, false, true)[0].eligible).toBe(false);
  expect(inheritanceCandidates([{ ...rooms[0], result: null, polygon: null }], [], labels)[0].reason).toContain(
    "几何无效",
  );
});
