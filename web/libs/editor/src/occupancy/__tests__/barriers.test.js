import {
  barrierContextFor,
  barrierPairsEqual,
  isOccupancyBarrierRegion,
  matchOccupancyBarrier,
  partitionOccupancyBarrierRegions,
  sharedFurnitureBoundaries,
} from "../barriers";

const parent = {
  id: "zone-z",
  from_name: "zone_rectangle",
  to_name: "image",
  type: "rectangle",
  original_width: 200,
  original_height: 100,
  value: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
};

const furniture = (id, logicalId, x, y, width, height, groupType) => [
  {
    id,
    from_name: "occupancy_rectangle",
    to_name: "image",
    type: "rectangle",
    original_width: 200,
    original_height: 100,
    value: { x, y, width, height, rotation: 0 },
    meta: { occupancy_context: { logical_id: logicalId, group_id: logicalId, group_type: groupType, parent_zone_id: parent.id } },
  },
  { id, from_name: "occupancy_type", to_name: "image", type: "labels", value: { labels: ["furniture_group"] } },
];

const results = () => [
  parent,
  ...furniture("a-part", "f43", 0, 0, 50, 100, "shower_fixtures"),
  ...furniture("b-part", "f44", 50, 0, 50, 50, "washbasin"),
  ...furniture("c-part", "f45", 50, 50, 50, 50, "laundry_drying"),
];

const barrier = (x = 50, y1 = 0, y2 = 100) => ({
  id: "barrier-result",
  from_name: "occupancy_barrier_vector",
  to_name: "image",
  type: "vectorlabels",
  original_width: 200,
  original_height: 100,
  value: { closed: false, vectorlabels: ["wall_barrier"], vertices: [{ x, y: y1 }, { x, y: y2 }] },
  meta: { occupancy_barrier_context: { parent_zone_id: parent.id } },
});

test("one wall Vector matches every positive-length furniture pair on one continuous support", () => {
  const match = matchOccupancyBarrier(results(), barrier());

  expect(match.reason).toBe("");
  expect(match.snappedVertices).toEqual([{ x: 50, y: 0 }, { x: 50, y: 100 }]);
  expect(match.matchedPairs).toMatchObject([
    { source_group_id: "f43", target_group_id: "f44", shared_boundary_length_px: 50, barrier_overlap_length_px: 50 },
    { source_group_id: "f43", target_group_id: "f45", shared_boundary_length_px: 50, barrier_overlap_length_px: 50 },
  ]);
  expect(sharedFurnitureBoundaries(results(), parent.id, 200, 100)).toHaveLength(3);
});

test("nearby endpoints snap to the shared boundary and movement recomputes the match", () => {
  const match = matchOccupancyBarrier(results(), barrier(52), { screenWidth: 200, screenHeight: 100, threshold: 10 });

  expect(match.matchedPairs).toHaveLength(2);
  expect(match.snappedVertices).toEqual([{ x: 50, y: 0 }, { x: 50, y: 100 }]);
  expect(matchOccupancyBarrier(results(), barrier(60), { screenWidth: 200, screenHeight: 100, threshold: 10 }).matchedPairs).toEqual([]);
});

test("point contact and a missing parent never create a barrier match", () => {
  expect(matchOccupancyBarrier(results(), barrier(50, 50, 50)).matchedPairs).toEqual([]);
  expect(matchOccupancyBarrier(results(), { ...barrier(), meta: { occupancy_barrier_context: { parent_zone_id: "other" } } }).matchedPairs).toEqual([]);
});

test("stored pair comparison is stable by logical ID and rejects stale measurements", () => {
  const matched = matchOccupancyBarrier(results(), barrier()).matchedPairs;
  expect(barrierPairsEqual([...matched].reverse(), matched)).toBe(true);
  expect(barrierPairsEqual(matched, matched.map((pair, index) => index ? pair : { ...pair, barrier_overlap_length_px: 1 }))).toBe(false);
  expect(barrierContextFor(barrier(), { id: parent.id, roomId: "room-r", fingerprint: "fp" }, "source-v1", matched)).toMatchObject({
    schema_version: 1,
    barrier_id: "barrier-result",
    barrier_type: "wall",
    parent_zone_id: parent.id,
    parent_room_id: "room-r",
    source_version: "source-v1",
    parent_fingerprint: "fp",
    match_rule: "shared_boundary_overlap",
    matched_pairs: matched,
  });
});

test("barrier regions are identified for foreground rendering with serialized or MST control names", () => {
  const firstBarrier = { id: "first", results: [barrier()] };
  const furnitureRegion = { id: "furniture", results: results() };
  expect(isOccupancyBarrierRegion(firstBarrier)).toBe(true);
  expect(
    isOccupancyBarrierRegion({
      results: [{ ...barrier(), from_name: { name: "occupancy_barrier_vector" } }],
    }),
  ).toBe(true);
  expect(isOccupancyBarrierRegion(furnitureRegion)).toBe(false);
  expect(isOccupancyBarrierRegion(null)).toBe(false);

  const secondBarrier = {
    id: "second",
    results: [{ ...barrier(), from_name: { name: "occupancy_barrier_vector" } }],
  };
  expect(partitionOccupancyBarrierRegions([furnitureRegion, firstBarrier, secondBarrier])).toEqual({
    foreground: [firstBarrier, secondBarrier],
    background: [furnitureRegion],
  });
});
