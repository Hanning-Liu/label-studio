import {
  spatialProgress,
  spatialBrief,
  spatialTodoOrder,
  reviewedSpace,
  matchesSpatialFilter,
} from "@hanning/frontend/domain/furnitureInstances/spatialProgress";

const fixture = () => ({
  rooms: [
    { id: "r", label: "房间" },
    { id: "s", label: "房间" },
  ],
  zones: [
    { id: "z", roomId: "r" },
    { id: "w", roomId: "s" },
  ],
  groups: [
    { id: "a", roomId: "r", zoneId: "z" },
    { id: "b", roomId: "r", zoneId: "z" },
    { id: "c", roomId: "s", zoneId: "w" },
  ],
  issues: [],
});
const row = (id, status, group = "a", room = "r", zone = "z") => ({
  id,
  status,
  groupId: group,
  instance: { context: { group_id: group, room_id: room, zone_id: zone }, parts: [{}, {}] },
});
const build = (rows = [], scope = fixture()) => spatialProgress(scope, { rows, globalIssues: [] });

test("empty parents are visible and multipart logical instances count once through each level", () => {
  const p = build([row("i", "reviewed"), row("j", "pending")]);
  expect(p.root.counts).toEqual({ total: 2, pending: 1, reviewed: 1, blocked: 0 });
  expect(p.root.empty).toBe(2);
  expect(p.rooms.get("r").populated).toBe(1);
  expect(p.rooms.get("r").empty).toBe(1);
  expect(p.groups.get("b").empty).toBe(1);
  expect(p.zones.get("z").counts.total).toBe(2);
});
test("reviewed existing instances and empty groups coexist, never claim completeness", () => {
  const p = build([row("i", "reviewed")]);
  expect(reviewedSpace(p.rooms.get("r"))).toBe(true);
  expect(p.rooms.get("r").empty).toBe(1);
  expect(matchesSpatialFilter(p.rooms.get("r"), "empty", false)).toBe(true);
  expect(spatialBrief(p.rooms.get("r"))).toBe("空组团 1");
  expect(reviewedSpace(p.rooms.get("s"))).toBe(false);
});
test("bad chain is unassigned, suppresses empty-group claims and balances totals", () => {
  const p = build([row("i", "blocked", "a", "s", "w")]);
  expect(p.unassigned.map((r) => r.id)).toEqual(["i"]);
  expect(p.groups.get("a").empty).toBe(0);
  expect(p.groups.get("a").unresolved).toBe(1);
  expect(p.root.counts.total).toBe([...p.rooms.values()].reduce((n, r) => n + r.counts.total, 0) + p.unassigned.length);
  expect(reviewedSpace(p.rooms.get("r"))).toBe(false);
});
test("absent parent and no-zone rooms remain explicit problems; no-group zone is not complete", () => {
  const scope = fixture();
  scope.groups = [];
  scope.rooms.push({ id: "no-zone" });
  const p = build([row("lost", "blocked")], scope);
  expect(p.unassigned).toHaveLength(1);
  expect(p.rooms.get("no-zone").issues).toEqual(["无有效分区，请检查上游"]);
  expect(spatialBrief(p.zones.get("z"))).toBe("无家具组团");
  expect(p.root.empty).toBe(0);
});
test("scoped queues do not escape, global queue ranks current zone before other rooms", () => {
  const p = build([row("a1", "pending"), row("a2", "blocked"), row("c1", "pending", "c", "s", "w")]);
  expect(spatialTodoOrder(p, { within: "room:r" }).map((t) => t.key)).toEqual([
    "instance:a2",
    "empty:b",
    "instance:a1",
  ]);
  expect(spatialTodoOrder(p, { roomId: "s", zoneId: "w" })[0].key).toBe("instance:c1");
});
test("derivation and filters do not mutate results or reference objects", () => {
  const scope = fixture(),
    rows = [row("i", "pending")],
    before = JSON.stringify({ scope, rows });
  const p = build(rows, scope);
  spatialTodoOrder(p);
  matchesSpatialFilter(p.root, "blocked", true);
  expect(JSON.stringify({ scope, rows })).toBe(before);
});
