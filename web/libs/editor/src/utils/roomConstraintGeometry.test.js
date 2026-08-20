import {
  clampPointToPolygon,
  clampPolygonTransform,
  clampRectangleTransform,
  collinearPositiveOverlap,
  isSimplePolygon,
  partitionContext,
  pointInPolygon,
  polygonInsidePolygon,
  rotatedRectanglePoints,
  snapSegmentToOpening,
} from "./roomConstraintGeometry";

const concaveRoom = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 6, y: 10 },
  { x: 6, y: 4 },
  { x: 4, y: 4 },
  { x: 4, y: 10 },
  { x: 0, y: 10 },
];

describe("room constraint geometry", () => {
  test("includes boundary points and rejects a concave cut-out", () => {
    expect(pointInPolygon({ x: 0, y: 5 }, concaveRoom)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 8 }, concaveRoom)).toBe(false);
  });

  test("rejects a segment that crosses a concave cut-out", () => {
    const candidate = [
      { x: 3, y: 7 },
      { x: 7, y: 7 },
      { x: 7, y: 9 },
      { x: 3, y: 9 },
    ];
    expect(polygonInsidePolygon(candidate, concaveRoom)).toBe(false);
  });

  test("detects self-intersection", () => {
    expect(
      isSimplePolygon([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
        { x: 10, y: 0 },
      ]),
    ).toBe(false);
  });

  test("builds the four corners of a rotated rectangle", () => {
    const points = rotatedRectanglePoints({ x: 2, y: 3, width: 4, height: 2, rotation: 90 });
    expect(points[1].x).toBeCloseTo(2);
    expect(points[1].y).toBeCloseTo(7);
    expect(points[2].x).toBeCloseTo(0);
    expect(points[2].y).toBeCloseTo(7);
  });

  test("stops a moving vertex at the room boundary", () => {
    const room = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const result = clampPointToPolygon({ x: 5, y: 5 }, { x: 15, y: 5 }, room);
    expect(result.x).toBeCloseTo(10, 5);
    expect(result.y).toBeCloseTo(5, 5);
  });

  test("clamps a whole transform to the last legal interpolation", () => {
    const room = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const previous = rotatedRectanglePoints({ x: 1, y: 1, width: 2, height: 2 });
    const target = previous.map((point) => ({ x: point.x + 10, y: point.y }));
    const result = clampPolygonTransform(previous, target, room);
    expect(Math.max(...result.map((point) => point.x))).toBeCloseTo(10, 5);
    expect(polygonInsidePolygon(result, room)).toBe(true);
  });

  test("clamps rectangle translation, scale, and rotation as one transform", () => {
    const room = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const previous = { x: 2, y: 2, width: 2, height: 2, rotation: 0 };
    const target = { x: 8, y: 8, width: 4, height: 4, rotation: 20 };
    const result = clampRectangleTransform(previous, target, room, rotatedRectanglePoints);
    expect(polygonInsidePolygon(rotatedRectanglePoints(result), room)).toBe(true);
    expect(result.x).toBeGreaterThan(previous.x);
    expect(result.x).toBeLessThan(target.x);
  });

  test("prefers an opening endpoint then aligns the other endpoint", () => {
    const result = snapSegmentToOpening(
      [
        { x: 0.2, y: 0.1 },
        { x: 8, y: 0.2 },
      ],
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      1,
      5,
    );
    expect(result.kind).toBe("endpoint");
    expect(result.segment).toEqual([
      { x: 0, y: 0 },
      { x: 8, y: 0 },
    ]);
  });

  test("projects to the opening line and observes the angle threshold", () => {
    expect(
      snapSegmentToOpening(
        [
          { x: 3, y: 0.4 },
          { x: 7, y: 0.4 },
        ],
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        1,
        5,
      ).kind,
    ).toBe("line");
    expect(
      snapSegmentToOpening(
        [
          { x: 3, y: 0.4 },
          { x: 7, y: 2 },
        ],
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        3,
        5,
      ),
    ).toBeNull();
  });

  test("requires positive collinear overlap", () => {
    expect(
      collinearPositiveOverlap(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        [
          { x: 5, y: 0 },
          { x: 12, y: 0 },
        ],
      ),
    ).toBe(true);
    expect(
      collinearPositiveOverlap(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        [
          { x: 10, y: 0 },
          { x: 12, y: 0 },
        ],
      ),
    ).toBe(false);
  });

  test("builds stable partition opening and connected-room metadata", () => {
    const polygon = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(
      partitionContext(polygon, "room-a", [
        {
          id: "opening-1",
          points: [
            { x: 3, y: 0 },
            { x: 7, y: 0 },
          ],
          roomIds: ["room-b", "room-a"],
        },
      ]),
    ).toEqual({
      schema_version: 1,
      parent_room_id: "room-a",
      opening_ids: ["opening-1"],
      connected_room_ids: ["room-b"],
    });
  });
});
