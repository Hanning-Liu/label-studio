import { emptyReviewCounts } from "@hanning/frontend/domain/furnitureInstances/review";

const node = (kind, source) => ({
  key: `${kind}:${source.id}`,
  kind,
  id: source.id,
  source,
  children: [],
  rows: [],
  issues: [],
  counts: emptyReviewCounts(),
  groupTotal: 0,
  populated: 0,
  empty: 0,
  unresolved: 0,
});
const count = (target, row) => {
  target.counts.total++;
  target.counts[row.status]++;
};
const merge = (target, child) => {
  for (const key of Object.keys(target.counts)) target.counts[key] += child.counts[key];
  for (const key of ["groupTotal", "populated", "empty", "unresolved"]) target[key] += child[key];
};

// No geometry/label based attribution: only the complete saved parent chain is accepted.
export function spatialProgress(scope, snapshot) {
  const root = node("task", { id: "task" });
  const rooms = new Map(),
    zones = new Map(),
    groups = new Map(),
    nodes = new Map();
  const anomalies = [],
    unassigned = [],
    tasks = [];
  const add = (kind, source, index) => {
    if (index.has(source.id)) {
      anomalies.push(`重复 ${kind} ID：${source.id}`);
      return null;
    }
    const value = node(kind, source);
    index.set(source.id, value);
    nodes.set(value.key, value);
    return value;
  };
  for (const source of scope.rooms) {
    const value = add("room", source, rooms);
    if (value) root.children.push(value);
  }
  for (const source of scope.zones) {
    const value = add("zone", source, zones);
    if (!value) continue;
    const parent = rooms.get(source.roomId);
    if (parent) {
      value.parent = parent.key;
      parent.children.push(value);
    } else {
      value.issues.push("原父房间缺失");
      anomalies.push(`分区 ${source.id}：原父房间缺失`);
    }
  }
  for (const source of scope.groups) {
    const value = add("group", source, groups);
    if (!value) continue;
    value.groupTotal = 1;
    const parent = zones.get(source.zoneId);
    if (parent?.parent && parent.source.roomId === source.roomId) {
      value.parent = parent.key;
      parent.children.push(value);
    } else {
      value.issues.push("原父分区链不一致");
      anomalies.push(`组团 ${source.id}：原父分区链不一致`);
    }
  }
  for (const row of snapshot.rows) {
    const context = row.instance.context;
    const group = groups.get(row.groupId);
    const valid = group?.parent && context.room_id === group.source.roomId && context.zone_id === group.source.zoneId;
    if (valid) {
      group.rows.push(row);
      count(group, row);
    } else {
      unassigned.push(row);
      if (group) group.issues.push(`实例 ${row.id}：保存的父级链不一致`);
      const room = rooms.get(context.room_id);
      if (room) room.issues.push(`实例 ${row.id}：归属异常，未计入本房间实例数`);
    }
  }
  const visit = (value) => {
    if (value.kind === "group") {
      value.populated = value.rows.length ? 1 : 0;
      value.unresolved = value.issues.length ? 1 : 0;
      value.empty = !value.rows.length && !value.issues.length ? 1 : 0;
      if (value.empty) tasks.push({ key: `empty:${value.id}`, type: "empty", groupId: value.id, nodeKey: value.key });
      for (const row of value.rows)
        if (row.status !== "reviewed")
          tasks.push({
            key: `instance:${row.id}`,
            type: row.status,
            id: row.id,
            groupId: value.id,
            nodeKey: value.key,
          });
    }
    for (const child of value.children) {
      visit(child);
      merge(value, child);
    }
    if (value.issues.length || (value.kind === "room" && !value.children.length)) {
      if (!value.issues.length) value.issues.push("无有效分区，请检查上游");
      tasks.push({ key: `issue:${value.key}`, type: "issue", nodeKey: value.key, message: value.issues.join("；") });
    }
  };
  visit(root);
  for (const row of unassigned) count(root, row);
  root.issues.push(...anomalies, ...(scope.issues || []), ...snapshot.globalIssues.map((i) => i.message));
  for (const row of unassigned)
    tasks.push({
      key: `unassigned:${row.id}`,
      type: "issue",
      message: `实例 ${row.id}：父级归属异常，请检查原父级`,
      id: row.id,
    });
  if (root.issues.length)
    tasks.push({ key: "issue:global", type: "issue", message: [...new Set(root.issues)].join("；") });
  return { root, rooms, zones, groups, nodes, tasks, unassigned };
}

export const reviewedSpace = (n) =>
  n.counts.total > 0 && n.counts.reviewed === n.counts.total && !n.issues.length && !n.unresolved;
export const hasSpatialTodo = (n) =>
  !!(
    n.empty ||
    n.counts.pending ||
    n.counts.blocked ||
    n.unresolved ||
    n.issues.length ||
    n.children.some(hasSpatialTodo)
  );
export function matchesSpatialFilter(n, filter, onlyTodo) {
  if (onlyTodo && !hasSpatialTodo(n)) return false;
  return (
    filter === "all" ||
    (filter === "empty" && n.empty > 0) ||
    (filter === "pending" && n.counts.pending > 0) ||
    (filter === "blocked" &&
      !!(
        n.counts.blocked ||
        n.unresolved ||
        n.issues.length ||
        n.children.some((c) => matchesSpatialFilter(c, "blocked", false))
      )) ||
    (filter === "reviewed" && reviewedSpace(n))
  );
}
export function spatialBrief(n) {
  if (!n) return "";
  const parts = [];
  if (n.counts.blocked) parts.push(`需处理 ${n.counts.blocked}`);
  if (n.issues.length || n.unresolved) parts.push("归属/来源需检查");
  if (n.empty) parts.push(`空组团 ${n.empty}`);
  if (n.counts.pending) parts.push(`待复核 ${n.counts.pending}`);
  if (!parts.length)
    parts.push(
      reviewedSpace(n)
        ? `已有 ${n.counts.reviewed} 个实例均已复核`
        : n.kind === "room" && !n.children.length
          ? "无有效分区"
          : "无家具组团",
    );
  return parts.join(" / ");
}
export function spatialPath(progress, key) {
  const keys = [];
  for (let value = progress.nodes.get(key); value; value = progress.nodes.get(value.parent)) keys.push(value.key);
  return keys;
}
export function spatialBadge(n) {
  if (!n) return "";
  const parts = [];
  if (n.counts.blocked || n.unresolved || n.issues.length)
    parts.push(n.counts.blocked ? `需处理${n.counts.blocked}` : "需检查");
  if (n.empty) parts.push(`空组团${n.empty}`);
  if (n.counts.pending) parts.push(`待复核${n.counts.pending}`);
  return parts.length ? parts.join(" · ") : reviewedSpace(n) ? `已有${n.counts.reviewed}均复核` : "无家具组团";
}
export function spatialTodoOrder(progress, { within = "", roomId = "", zoneId = "" } = {}) {
  const rank = { issue: 0, blocked: 0, empty: 1, pending: 2 };
  const scopeRank = (entry) => {
    const path = spatialPath(progress, entry.nodeKey);
    return zoneId && path.includes(`zone:${zoneId}`) ? 0 : roomId && path.includes(`room:${roomId}`) ? 1 : 2;
  };
  return progress.tasks
    .filter((entry) => !within || spatialPath(progress, entry.nodeKey).includes(within))
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        (within ? 0 : scopeRank(a.entry) - scopeRank(b.entry)) ||
        rank[a.entry.type] - rank[b.entry.type] ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);
}

export function uniqueSpaceName(value, peers) {
  const label = value.label || value.groupNote || value.groupType || value.id;
  let size = 6;
  while (size < value.id.length && peers.some((p) => p.id !== value.id && p.id.slice(-size) === value.id.slice(-size)))
    size++;
  return `${label} · ${value.id.slice(-size)}`;
}
