import { TextEncoder } from "util";
import { equivalent } from "../../occupancy/geometry";
import {
  canonicalizeParentGeometry,
  context,
  CONTROLS,
  effectiveFurnitureInstanceSelection,
  FURNITURE_TYPES,
  furnitureGroupFingerprint,
  furnitureInstances,
  instanceReviewFingerprint,
  parentFingerprintPayload,
  sameFurnitureResultKeys,
} from "../domain";
import { furnitureInstanceMultiRegionSelection } from "../referenceDisplay";
import { makeInstance, makeOccupancy, resetIds, square } from "./helpers";

global.TextEncoder = TextEncoder;

beforeEach(resetIds);

test("stable English furniture aliases have the locked 26-item Chinese display map", () => {
  expect(Object.keys(FURNITURE_TYPES)).toHaveLength(26);
  expect(FURNITURE_TYPES).toMatchObject({
    desk: "书桌",
    armchair: "扶手椅",
    washing_machine: "洗衣机",
    other: "其他",
  });
});

test("parent geometry canonicalization is invariant to ring starts, winding and component order", () => {
  const first = [
    [
      [
        [0, 0],
        [0, 10],
        [10, 10],
        [10, 0],
        [0, 0],
      ],
      [
        [2, 2],
        [8, 2],
        [8, 8],
        [2, 8],
        [2, 2],
      ],
    ],
    [
      [
        [20, 0],
        [25, 0],
        [25, 5],
        [20, 5],
        [20, 0],
      ],
    ],
  ];
  const reversedAndRotated = [
    [
      [
        [25, 5],
        [25, 0],
        [20, 0],
        [20, 5],
        [25, 5],
      ],
    ],
    [
      [
        [10, 10],
        [0, 10],
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      [
        [8, 8],
        [8, 2],
        [2, 2],
        [2, 8],
        [8, 8],
      ],
    ],
  ];
  expect(canonicalizeParentGeometry(reversedAndRotated)).toEqual(canonicalizeParentGeometry(first));
});

test("parent fingerprint matches the fixed cross-language SHA fixture", () => {
  const geometry = [
    [
      [
        [0, 0],
        [0, 10],
        [10, 10],
        [10, 0],
        [0, 0],
      ],
      [
        [2, 2],
        [8, 2],
        [8, 8],
        [2, 8],
        [2, 2],
      ],
    ],
    [
      [
        [20, 0],
        [25, 0],
        [25, 5],
        [20, 5],
        [20, 0],
      ],
    ],
  ];
  const group = {
    roomId: "room-r",
    zoneId: "zone-z",
    groupId: "group-g",
    groupType: "study_work",
    groupNote: "desk alcove",
    zoneParentFingerprint: "a".repeat(64),
    geometry,
  };
  expect(parentFingerprintPayload(group)).toEqual({
    schema_version: 1,
    room_id: "room-r",
    zone_id: "zone-z",
    group_id: "group-g",
    group_type: "study_work",
    group_note: "desk alcove",
    zone_parent_fingerprint: "a".repeat(64),
    geometry: canonicalizeParentGeometry(geometry),
  });
  expect(furnitureGroupFingerprint(group)).toBe("dfffaf6f7467a730f94c7b4499ca7613f292078ceb8c609042839d3b50f61296");
});

test("review fingerprint matches the fixed backend payload and canonical geometry", () => {
  const instance = {
    id: "instance-i",
    context: {
      schema_version: 1,
      instance_id: "instance-i",
      instance_type: "desk",
      note: "",
      room_id: "room-r",
      zone_id: "zone-z",
      group_id: "group-g",
      source_version: "b".repeat(64),
      parent_fingerprint: "c".repeat(64),
    },
    geometry: [square(1, 1, 3, 2)],
  };
  const orientation = {
    status: "front_direction",
    origin: { x: 1, y: 1.5 },
    direction_vector: { dx: 1, dy: 0 },
  };
  expect(instanceReviewFingerprint(instance, orientation)).toBe(
    "3d8654893d8bb870d79cbfa9ebe2394ecf3ec1bdde6897c649f35070b6d1daf9",
  );
});

test("rectangle storage is preserved but its rotation never invents an orientation", () => {
  const occupancy = makeOccupancy();
  const results = makeInstance(occupancy, {
    rectangle: { x: 25, y: 25, width: 20, height: 10, rotation: 37 },
  });
  const instance = furnitureInstances(JSON.parse(JSON.stringify(results)))[0];
  expect(instance.parts).toHaveLength(1);
  expect(instance.parts[0].from_name).toBe(CONTROLS.rectangle);
  expect(instance.parts[0].value.rotation).toBe(37);
  expect(instance.orientationResults).toEqual([]);
  expect(context(instance.parts[0])).toMatchObject({
    schema_version: 1,
    instance_id: "instance-i",
    instance_type: "desk",
    room_id: "room-r",
    zone_id: "zone-z",
    group_id: "group-g",
    review_status: "pending",
    role: "geometry",
  });
});

test("multiple components and holes survive storage decomposition and JSON reload", () => {
  const occupancy = makeOccupancy();
  const geometry = [[square(20, 20, 60, 60)[0], square(30, 30, 40, 40)[0]], square(70, 20, 80, 30)];
  const stored = makeInstance(occupancy, { geometry });
  const instance = furnitureInstances(JSON.parse(JSON.stringify(stored)))[0];
  expect(instance.parts.length).toBeGreaterThan(2);
  expect(equivalent(instance.geometry, geometry)).toBe(true);
  expect(instance.geometry).toHaveLength(2);
  expect(instance.geometry[0]).toHaveLength(2);
  expect(instance.categories).toHaveLength(instance.parts.length);
  expect(new Set(instance.parts.map((part) => part.id)).size).toBe(instance.parts.length);
});

test("canonical parent geometry uses natural Polygon for one component", () => {
  expect(canonicalizeParentGeometry([square(1, 2, 3, 4)])).toMatchObject({ type: "Polygon" });
});

test("canvas selection safely overrides a stale logical selection only when it identifies one instance", () => {
  const region = (instanceId) => ({
    results: [{ meta: { furniture_instance_context: { instance_id: instanceId } } }],
  });
  expect(effectiveFurnitureInstanceSelection([region("new")], "old")).toBe("new");
  expect(effectiveFurnitureInstanceSelection([region("first"), region("second")], "old")).toBe("");
  expect(effectiveFurnitureInstanceSelection([{ results: [] }], "old")).toBe("old");
});

test("import completeness compares the exact result ID/control key multiset", () => {
  const first = { id: "a", from_name: CONTROLS.polygon };
  const second = { id: "a", from_name: CONTROLS.type };
  expect(sameFurnitureResultKeys([first, second], [second, first])).toBe(true);
  expect(sameFurnitureResultKeys([first], [first, second])).toBe(false);
});

test("multiple selected L4 regions disable the generic multi-region transformer", () => {
  const region = { results: [{ meta: { furniture_instance_context: { instance_id: "instance-i" } } }] };
  expect(
    furnitureInstanceMultiRegionSelection({ furnitureInstancesEnabled: true, selectedRegions: [region, region] }),
  ).toBe(true);
  expect(furnitureInstanceMultiRegionSelection({ furnitureInstancesEnabled: true, selectedRegions: [region] })).toBe(
    false,
  );
  expect(
    furnitureInstanceMultiRegionSelection({ furnitureInstancesEnabled: false, selectedRegions: [region, region] }),
  ).toBe(false);
});
