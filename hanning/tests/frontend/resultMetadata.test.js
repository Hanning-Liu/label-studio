import { applyResultMetadataOwnership } from "@hanning/frontend/domain/resultMetadata";

function serializeMetadata(meta, areaMeta, type, fromName = "zone_rectangle", image = {}) {
  const data = { meta: { ...meta, ...areaMeta } };
  applyResultMetadataOwnership(data, { meta, areaMeta, type, fromName, image });
  return data.meta;
}

test("geometry retains its current review/context over an imported area snapshot", () => {
  const current = { occupancy_context: { review: "pending" }, zone_inheritance: { status: "confirmed" },
    partition_context: { id: "current" }, window_projections: [{ id: "current-window" }] };
  const stale = { occupancy_context: { review: "confirmed" }, zone_inheritance: { status: "pending" },
    partition_context: { id: "stale" }, window_projections: [{ id: "stale-window" }], note: "preserved" };
  expect(serializeMetadata(current, stale, "polygon")).toEqual({ ...stale, ...current });
  expect(serializeMetadata({}, stale, "labels", "function_zone", { wholeRoomInheritanceEnabled: true }))
    .toEqual({ note: "preserved" });
});

test.each(["rectangle", "polygon", "choices", "vectorlabels"])("L4 %s retains only its own role and provenance", (type) => {
  const meta = { furniture_instance_context: { instance_id: "fixture", role: type } };
  const area = { furniture_instance_context: { instance_id: "stale" }, furniture_instance_provenance: { stale: true } };
  expect(serializeMetadata(meta, area, type)).toEqual(meta);
  const stamped = { ...meta, furniture_instance_provenance: { source: "fixture" } };
  expect(serializeMetadata(stamped, area, type)).toEqual(stamped);
});

test("window evidence never leaks to paired labels and ordinary metadata is preserved", () => {
  const area = { window_context: { id: "stale" }, window_projection_state: { status: "ready" }, note: "keep" };
  expect(serializeMetadata({}, area, "labels", "labels", { windowEnabled: true })).toEqual({ note: "keep" });
  expect(serializeMetadata({ window_context: { id: "current" } }, area, "vectorlabels", "window_vector", { windowEnabled: true }))
    .toEqual({ window_context: { id: "current" }, note: "keep" });
  expect(serializeMetadata({ note: "result" }, { note: "area" }, "textarea")).toEqual({ note: "area" });
});
