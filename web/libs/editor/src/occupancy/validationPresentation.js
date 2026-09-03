import { GROUP_TYPES, TYPES } from "./domain";

export const shortOccupancyId = (id) => {
  if (!id) return "未知 ID";
  if (id.length <= 14) return id;
  return `${id.slice(0, 10)}…${id.slice(-4)}`;
};

export const logicalForIssue = (issue, logicals) =>
  logicals.find((region) => region.id === issue.objectId || region.parts.some((part) => part.id === issue.objectId));

const regionName = (region) => {
  if (!region) return "未识别的 L3 对象";
  return region.type === "furniture_group"
    ? GROUP_TYPES[region.context.group_type] || "类别异常的家具组团"
    : TYPES[region.type] || "类别异常的 L3 区域";
};

const objectIdentity = (region, fallbackId) => ({
  label: regionName(region),
  id: region?.id || fallbackId || "",
  text: `${regionName(region)} · ${shortOccupancyId(region?.id || fallbackId)}`,
});

const barrierIdentity = (barrier, fallbackId) => ({
  label: "人工隔墙",
  id: barrier?.id || fallbackId || "",
  text: `人工隔墙 · ${shortOccupancyId(barrier?.id || fallbackId)}`,
});

export function presentOccupancyIssue(issue, parents, logicals, barriers = []) {
  const parent = parents.find((candidate) => candidate.id === issue.parentId);
  const region = logicalForIssue(issue, logicals);
  const barrier = barriers.find((candidate) => candidate.id === issue.barrierId || candidate.id === issue.objectId);
  const relatedRegion = issue.relatedObjectId
    ? logicals.find(
        (candidate) =>
          candidate.id === issue.relatedObjectId || candidate.parts.some((part) => part.id === issue.relatedObjectId),
      )
    : null;
  const object = barrier ? barrierIdentity(barrier, issue.objectId) : objectIdentity(region, issue.objectId);
  const related = issue.relatedObjectId ? objectIdentity(relatedRegion, issue.relatedObjectId) : null;
  const parentText = parent
    ? `${parent.roomLabel} · ${parent.functionLabel}`
    : `父分区 ${shortOccupancyId(issue.parentId)}`;
  const common = { issue, parent, region, barrier, relatedRegion, object, related, parentText };

  switch (issue.code) {
    case "barrier_invalid":
      return {
        ...common,
        title: "隔墙 Vector 格式无效",
        detail: `${object.text} 不是开放的两点“隔墙” Vector。请定位后调整或删除。`,
        action: "修正或删除隔墙后重试",
      };
    case "barrier_parent_missing":
      return {
        ...common,
        title: "隔墙所属功能分区已不存在",
        detail: `${object.text} 的原父功能分区已删除、拆分或合并；系统不会把它自动映射到当前 Focus。`,
        action: "删除并在正确功能分区内重画",
      };
    case "barrier_source":
      return {
        ...common,
        title: "隔墙父参考已变化",
        detail: `${object.text} 保存时对应的父功能分区与当前 ${parentText} 不一致。请定位并重新匹配。`,
        action: "移动任一端点触发重新吸附",
      };
    case "barrier_unmatched":
    case "barrier_unsnapped":
    case "barrier_stale":
      return {
        ...common,
        title: issue.code === "barrier_stale" ? "隔墙匹配家具对已过期" : "隔墙未命中有效公共边界",
        detail: `${object.text} 没有与当前分区内家具组团的正长度公共边界精确重合。点接触、近似靠近和跨分区均不算命中。`,
        action: "定位隔墙并沿真实公共边界重画或调整端点",
      };
    case "source":
      return {
        ...common,
        title: "父功能分区参考已变化",
        detail: `${object.text} 保存时对应的父分区边界、类别或所属房间与当前 ${parentText} 不一致。请先接受当前父参考；系统不会自动移动轮廓。`,
        action: "接受当前父参考后重试",
      };
    case "parent_missing":
      return {
        ...common,
        title: "原父功能分区已不存在",
        detail: `${object.text} 原来所属的功能分区已被删除、拆分或合并。请明确选择新的父分区，系统不会用当前 Focus 自动替代。`,
        action: "重新绑定父分区后重试",
      };
    case "outside":
      return {
        ...common,
        title: "轮廓超出父功能分区",
        detail: `${object.text} 有正面积越过 ${parentText} 的边界。请定位该组团并将越界边或顶点移回边界内。`,
        action: "调整轮廓后重试",
      };
    case "overlap":
      return {
        ...common,
        title: "两个 L3 区域发生重叠",
        detail: related
          ? `${object.text} 与 ${related.text} 存在正面积重叠。请调整其中一个轮廓；共享边界可以接触。`
          : `${object.text} 与另一个 L3 区域存在正面积重叠。请定位并调整轮廓；共享边界可以接触。`,
        action: "消除重叠后重试",
      };
    case "parts_overlap":
      return {
        ...common,
        title: "同一逻辑区域的存储分块重叠",
        detail: `${object.text} 的内部存储分块发生正面积重叠，需要先恢复为互不重叠的并集。`,
        action: "修复分块后重试",
      };
    case "parts":
      return {
        ...common,
        title: "同一逻辑区域的分块属性不一致",
        detail: `${object.text} 的分块在类别、归属或组团信息上不一致。`,
        action: "统一分块属性后重试",
      };
    case "group":
      return {
        ...common,
        title: "家具组团信息不完整",
        detail: `${object.text} 的组团 ID、类别、归属或“其他”说明不符合要求。`,
        action: "修正组团信息后重试",
      };
    case "pair":
      return {
        ...common,
        title: "几何与类别配对异常",
        detail: `${object.text} 缺少配对类别、存在重复 ID，或逻辑区域 ID 无效。`,
        action: "修复数据配对后重试",
      };
    case "geometry":
      return {
        ...common,
        title: "轮廓几何无效",
        detail: `${object.text} 无法参与差集计算。原始校验信息：${issue.message || "未知几何错误"}`,
        action: "修复轮廓后重试",
      };
    default:
      return {
        ...common,
        title: "当前对象未通过生成前校验",
        detail: `${object.text}：${issue.message || issue.code}`,
        action: "处理后重试",
      };
  }
}

export function presentGenerationIssues(issues, parents, logicals, barriers = []) {
  const seen = new Set();

  return issues
    .map((issue) => presentOccupancyIssue(issue, parents, logicals, barriers))
    .filter((presentation) => {
      const key = [
        presentation.issue.code,
        presentation.region?.id || presentation.issue.objectId,
        presentation.relatedRegion?.id || presentation.issue.relatedObjectId,
      ].join("|");

      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

const REVIEW_ISSUE_PRIORITY = {
  stale: 0,
  source: 1,
  parent_missing: 1,
  geometry: 2,
  pair: 2,
  group: 2,
  parts: 2,
  parts_overlap: 2,
  outside: 2,
  overlap: 2,
  coverage: 2,
  unclassified: 2,
  pending_draw: 2,
  barrier_invalid: 2,
  barrier_parent_missing: 2,
  barrier_source: 2,
  barrier_unmatched: 2,
  barrier_unsnapped: 2,
  barrier_stale: 2,
  review: 3,
};

/**
 * Group task-wide validation errors by their owning L2 parent.
 *
 * The validator intentionally emits review/stale errors per logical L3 region.
 * The review dialog is parent-oriented, so showing those raw rows hides the
 * actionable parent state in a long list. Keep every raw issue for counts and
 * diagnostics, but expose one parent row with explicit stale/review summaries.
 */
export function groupReviewIssues(issues, parents, logicals) {
  const parentMap = new Map(parents.map((parent) => [parent.id, parent]));
  const groups = new Map();

  issues.forEach((issue, index) => {
    const key = issue.parentId || `__unassigned_${index}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        parentId: issue.parentId || "",
        parent: parentMap.get(issue.parentId),
        issues: [],
        staleIssues: [],
        reviewIssues: [],
        otherIssues: [],
      });
    }
    const group = groups.get(key);
    group.issues.push(issue);
    if (issue.code === "stale") group.staleIssues.push(issue);
    else if (issue.code === "review") group.reviewIssues.push(issue);
    else group.otherIssues.push(issue);
  });

  return [...groups.values()]
    .map((group) => {
      const logicalIds = (source) =>
        new Set(
          source.map((issue) => logicalForIssue(issue, logicals)?.id || issue.objectId).filter(Boolean),
        );
      return {
        ...group,
        staleCount: logicalIds(group.staleIssues).size,
        reviewCount: logicalIds(group.reviewIssues).size,
      };
    })
    .sort((left, right) => {
      const priority = (group) =>
        Math.min(...group.issues.map((issue) => REVIEW_ISSUE_PRIORITY[issue.code] ?? 2));
      return (
        priority(left) - priority(right) ||
        (left.parent?.label || left.parentId).localeCompare(right.parent?.label || right.parentId)
      );
    });
}
