import { instanceReviewFingerprint } from "./domain";
import { orientationForInstance } from "./constraints";

export const REVIEW_LABELS = { pending: "待复核", reviewed: "已复核", blocked: "需处理" };
export const emptyReviewCounts = () => ({ total: 0, pending: 0, reviewed: 0, blocked: 0 });

export function furnitureReviewSnapshot(instances, parents, issues) {
  const ids = new Set(instances.map((instance) => instance.id));
  const globalIssues = issues.filter((issue) => !ids.has(issue.instanceId));
  const parentIds = new Set(parents.map((parent) => parent.id));
  const total = emptyReviewCounts();
  const groups = {};
  const rows = instances.map((instance) => {
    const errors = issues.filter((issue) => issue.instanceId === instance.id && issue.code !== "review");
    let token = "";
    try {
      token = instanceReviewFingerprint(instance, orientationForInstance(instance));
    } catch (error) {
      errors.push({ message: error.message || "家具内容不可复核" });
    }
    if (!parentIds.has(instance.context.group_id)) errors.push({ message: "父组团已不存在" });
    const status =
      errors.length || instance.context.review_status === "stale"
        ? "blocked"
        : instance.context.review_status === "reviewed" && instance.context.review_fingerprint === token
          ? "reviewed"
          : "pending";
    const group = (groups[instance.context.group_id] ||= emptyReviewCounts());
    total.total++;
    total[status]++;
    group.total++;
    group[status]++;
    return { id: instance.id, groupId: instance.context.group_id, status, token, errors, instance };
  });
  return { rows, groups, total, globalIssues };
}

export function furnitureReviewOrder(snapshot, parents, focusId) {
  const groups = [focusId, ...parents.map((parent) => parent.id).filter((id) => id !== focusId)];
  return groups.flatMap((id) => snapshot.rows.filter((row) => row.groupId === id).map((row) => row.id));
}

export function nextFurnitureReviewId(snapshot, order, currentId, preferCurrent = false) {
  const pending = new Set(snapshot.rows.filter((row) => row.status === "pending").map((row) => row.id));
  if (preferCurrent && pending.has(currentId)) return currentId;
  const at = order.indexOf(currentId);
  const remaining = [...order.slice(at + 1), ...order.slice(0, at + 1)];
  return remaining.find((id) => pending.has(id)) || "";
}

export function furnitureReferenceBlock(item, status) {
  if (status?.lineage?.ready === false) {
    return status.lineage.issues?.[0]?.message || "L1—L4 来源链未就绪，请先处理上游参考";
  }
  if (
    status?.enabled &&
    (status.sync_type !== "occupancy_to_furniture_instances" ||
      status.error ||
      status.source_version !== item.annotation.referenceVersion ||
      status.reference_version !== item.annotation.referenceVersion)
  ) {
    return "L3 参考有更新或异常；请先保存、备份并手动应用最新参考";
  }
  return "";
}
