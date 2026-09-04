import { TextEncoder } from "util";

global.TextEncoder = TextEncoder;

import { analyzeWindowParents, windowContextFor } from "../domain";
import { windowPairCandidate } from "../pairing";

const room = (id, x = 0) => ({
  id,
  from_name: "room_rectangle",
  to_name: "image",
  type: "rectanglelabels",
  original_width: 100,
  original_height: 100,
  image_rotation: 0,
  value: { x, y: 0, width: 50, height: 50, rotation: 0, rectanglelabels: ["Bedroom"] },
  meta: { room_graph_node: { node_id: id, room_type: "Bedroom" } },
});

const windowResult = (vertices, context = null, id = "window-a") => ({
  id,
  from_name: "window_vector",
  to_name: "image",
  type: "vectorlabels",
  original_width: 100,
  original_height: 100,
  image_rotation: 0,
  value: { closed: false, vectorlabels: ["Window"], vertices },
  ...(context ? { meta: { window_context: context } } : {}),
});

const line = (y = 0) => [
  { id: "a", x: 10, y, isBezier: false },
  { id: "b", prevPointId: "a", x: 40, y, isBezier: false },
];

test("derives exactly one parent and schema-aligned pending metadata", () => {
  const analysis = analyzeWindowParents([room("room-a"), windowResult(line())]);
  expect(analysis.issues).toEqual([]);
  expect(analysis.traces[0].assignment.id).toBe("room-a");
  const context = windowContextFor(analysis.traces[0], {
    boundaryMatchTolerancePx: 2,
    flatteningTolerancePx: 0.5,
  });
  expect(context).toMatchObject({
    schema_version: 1,
    parent_room_id: "room-a",
    source_trace_id: "window-trace:window-a",
    derivation_status: "current",
    pairing_status: "pending",
    boundary_attachment: { match_rule: "full_positive_length_room_boundary_overlap" },
    parent_derivation: { algorithm_version: "window-parent-room/1" },
  });
  expect(context.source_window_trace_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(context.source_room_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  // Expected values are generated independently by the Python canonicalizer.
  expect(context.source_window_trace_fingerprint).toBe(
    "dcbe7351b28ae766f1ebfcdad194034692f295ab3519cba0f3ac6b71e8f53e08",
  );
  expect(context.source_room_fingerprint).toBe("bec4f8f044a7c10a032001fc8168cf158fd76c429c221e280cefbee691d2d061");
  expect(context.boundary_attachment.room_boundary_segment_ids).toEqual(["room-segment:room-a:81832dc998bf055f"]);
  expect(context).not.toHaveProperty("connection");
});

test("reports no parent and ambiguous parent with backend-compatible issue codes", () => {
  const missing = analyzeWindowParents([room("room-a"), windowResult(line(20))]);
  expect(missing.issues[0]).toMatchObject({
    code: "window_parent_room_not_found",
    result_id: "window-a",
    room_ids: [],
  });

  const ambiguous = analyzeWindowParents([room("room-a"), room("room-b"), windowResult(line())]);
  expect(ambiguous.issues[0]).toMatchObject({
    code: "window_parent_room_ambiguous",
    result_id: "window-a",
    room_ids: ["room-a", "room-b"],
  });
});

test("never preserves or invents exterior before a completed unchanged pairing search", () => {
  const trace = analyzeWindowParents([room("room-a"), windowResult(line())]).traces[0];
  const previous = {
    parent_room_id: "room-a",
    source_window_trace_fingerprint: "stale",
    parent_derivation: { room_fingerprint: "stale" },
    pairing_status: "exterior",
    pairing_search: { status: "complete", candidate_count: 0 },
    connection: { connection_kind: "room_to_exterior" },
  };
  const context = windowContextFor(trace, { boundaryMatchTolerancePx: 2, flatteningTolerancePx: 0.5 }, previous);
  expect(context.pairing_status).toBe("pending");
  expect(context).not.toHaveProperty("pairing_search");
  expect(context).not.toHaveProperty("connection");
});

test("formal analysis requires stable vertex fields even though the geometry helper can read legacy points", () => {
  const analysis = analyzeWindowParents([
    room("room-a"),
    windowResult([
      { x: 10, y: 0 },
      { x: 40, y: 0 },
    ]),
  ]);
  expect(analysis.issues[0]).toMatchObject({ code: "invalid_window_geometry", result_id: "window-a" });
});

test("formal analysis rejects out-of-range vertex and Bezier control percentages", () => {
  const outsideVertex = line();
  outsideVertex[1].x = 101;
  const outsideControl = line();
  outsideControl[0] = {
    ...outsideControl[0],
    isBezier: true,
    controlPoint1: { x: -1, y: 0 },
    controlPoint2: { x: 20, y: 0 },
  };
  for (const vertices of [outsideVertex, outsideControl]) {
    expect(analyzeWindowParents([room("room-a"), windowResult(vertices)]).issues[0]).toMatchObject({
      code: "invalid_window_geometry",
      result_id: "window-a",
    });
  }
  const dormantControl = line();
  dormantControl[0].controlPoint1 = { x: -1, y: 0 };
  expect(analyzeWindowParents([room("room-a"), windowResult(dormantControl)]).issues[0]).toMatchObject({
    code: "invalid_window_geometry",
    result_id: "window-a",
  });
});

test("a trace with candidates but without a mutual-best partner blocks frontend submission", () => {
  const narrowRoom = (id, x) => ({
    ...room(id, x),
    value: { ...room(id, x).value, width: 40 },
  });
  const vertical = (x) => [
    { id: `${x}-a`, x, y: 10, isBezier: false },
    { id: `${x}-b`, prevPointId: `${x}-a`, x, y: 30, isBezier: false },
  ];
  const analysis = analyzeWindowParents([
    narrowRoom("room-a", 0),
    narrowRoom("room-b", 50),
    narrowRoom("room-c", 5),
    windowResult(vertical(40), null, "window-a"),
    windowResult(vertical(50), null, "window-b"),
    windowResult(vertical(45), null, "window-c"),
  ]);
  expect(analysis.pairing.pairs).toHaveLength(1);
  expect(analysis.issues).toContainEqual(
    expect.objectContaining({
      code: "window_pairing_not_mutual_best",
      result_id: "window-a",
      candidate_trace_ids: ["window-trace:window-b"],
    }),
  );
});

test("pair search rejects a slanted candidate whose far end exceeds the distance limit", () => {
  const trace = (traceId, roomId, start, end, inwardNormal) => {
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const segment = { start, end, length, pathStart: 0, pathEnd: length };
    return {
      traceId,
      path: { length, segments: [segment] },
      assignment: {
        id: roomId,
        room: { segments: [{ ...segment, inwardNormal }] },
      },
    };
  };
  const first = trace("window-trace:a", "room-a", { x: 40, y: 10 }, { x: 40, y: 90 }, { x: -1, y: 0 });
  const second = trace("window-trace:b", "room-b", { x: 50, y: 10 }, { x: 95, y: 90 }, { x: 1, y: 0 });
  expect(
    windowPairCandidate(first, second, {
      pairSearchLimitPx: 40,
      minimumProjectedOverlapPx: 8,
      maximumTangentDeltaDeg: 40,
    }),
  ).toBeNull();
});

test("room assignment and pairing never cross image-list items", () => {
  const roomOnItem = (id, itemIndex, x = 0) => ({ ...room(id, x), item_index: itemIndex });
  const windowOnItem = (id, itemIndex, vertices) => ({ ...windowResult(vertices, null, id), item_index: itemIndex });
  const analysis = analyzeWindowParents([
    roomOnItem("room-item-0", 0),
    roomOnItem("room-item-1", 1),
    windowOnItem("window-item-0", 0, line()),
    windowOnItem("window-item-1", 1, line()),
  ]);
  expect(analysis.issues).toEqual([]);
  expect(analysis.traces.map((trace) => trace.assignment.id)).toEqual(["room-item-0", "room-item-1"]);
  expect(analysis.pairing.candidates.get("window-trace:window-item-0")).toEqual([]);

  const first = {
    ...analysis.traces[0],
    assignment: { ...analysis.traces[0].assignment, id: "left" },
  };
  const second = {
    ...analysis.traces[1],
    assignment: { ...analysis.traces[1].assignment, id: "right" },
  };
  expect(
    windowPairCandidate(first, second, {
      pairSearchLimitPx: 40,
      minimumProjectedOverlapPx: 8,
      maximumTangentDeltaDeg: 10,
    }),
  ).toBeNull();
});
