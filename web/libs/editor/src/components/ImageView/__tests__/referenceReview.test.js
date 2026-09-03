import { buildReferenceReviewRows, referenceReviewSummary, referenceTriggerLabel } from "../referenceReview";

const result = (id, from_name, mainValue = [], meta = {}) => ({
  id,
  from_name,
  mainValue,
  meta,
  area: { cleanId: id },
});

test("describes zones with their room and function type and deduplicates paired results", () => {
  const room = result("room-a", "room_rectangle", ["Living room"], {
    room_graph_node: { room_type: "Living room" },
  });
  const zone = result("zone-a", "zone_rectangle", [], {
    partition_context: { parent_room_id: "room-a" },
    reference_review: { status: "pending", reason: "room_or_portal_changed" },
  });
  const category = result("zone-a", "function_zone", ["Dining"], {
    reference_review: { status: "pending", reason: "room_or_portal_changed" },
  });
  const rows = buildReferenceReviewRows(
    [room, zone, category],
    [
      {
        id: "zone-a",
        changed_reference_types: ["room"],
      },
    ],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: "zone-a",
    targetType: "功能分区",
    targetLabel: "Living room · Dining",
    triggerLabel: "房间参考发生变化",
  });
});

test("distinguishes traffic and visual vectors without ambiguous wording", () => {
  const traffic = result("traffic", "connection_vector", ["Open passage"], {
    reference_review: { status: "pending", reason: "room_or_portal_changed", changed_reference_types: ["portal"] },
  });
  const visual = result("visual", "visual_connection_vector", ["Visual only"], {
    reference_review: {
      status: "pending",
      reason: "room_or_portal_changed",
      changed_reference_types: ["room", "portal"],
    },
  });
  const rows = buildReferenceReviewRows([traffic, visual]);
  expect(rows.map((row) => row.targetType)).toEqual(["交通连通 Vector", "视觉连通 Vector"]);
  expect(rows.map((row) => row.triggerLabel)).toEqual(["开口参考发生变化", "房间参考和开口参考均发生变化"]);
  expect(referenceReviewSummary(rows)).toEqual({ zones: 0, connections: 1, visuals: 1 });
});

test("legacy reviews avoid the old room-or-opening phrase and invalid rows are excluded from bulk review", () => {
  expect(referenceTriggerLabel({ reason: "room_or_portal_changed" })).toBe(
    "上游参考发生变化（历史记录未区分具体来源）",
  );
  const row = buildReferenceReviewRows([
    result("zone", "zone_polygon", [], {
      partition_context: { parent_room_id: "missing" },
      reference_review: { status: "pending", reason: "source_missing" },
    }),
  ])[0];
  expect(row.eligible).toBe(false);
});
