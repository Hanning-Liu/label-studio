import { boundaryOverlap, flattenWindowPath, roomBoundarySegments } from "./geometry";
import { windowFingerprint } from "./fingerprint";
import { analyzeWindowPairing } from "./pairing";

export const WINDOW_PARENT_ALGORITHM_VERSION = "window-parent-room/1";
export const WINDOW_PAIRING_PENDING = "pending";

export const DEFAULT_WINDOW_OPTIONS = Object.freeze({
  roomControls: ["room_rectangle", "room_polygon"],
  windowControls: ["window_vector"],
  boundaryMatchTolerancePx: 2,
  pairSearchLimitPx: 40,
  minimumProjectedOverlapPx: 8,
  maximumTangentDeltaDeg: 10,
  flatteningTolerancePx: 0.5,
});

const compareIds = (first, second) => (first.id < second.id ? -1 : first.id > second.id ? 1 : 0);

const surfaceKey = (result) => JSON.stringify([String(result?.to_name || ""), result?.item_index ?? null]);

const roomFingerprintValue = (result, id) => ({
  id,
  type: result.type,
  value: result.value,
  width: Number(result.original_width),
  height: Number(result.original_height),
  image_rotation: result.image_rotation ?? 0,
  room_graph_node: result.meta?.room_graph_node ?? null,
});

export const windowTraceFingerprint = (result) =>
  windowFingerprint({
    closed: false,
    value: { vertices: result.value?.vertices || [] },
    label: "window",
    width: Number(result.original_width),
    height: Number(result.original_height),
  });

function roomGroups(results, controls) {
  return results
    .filter((result) => controls.has(result.from_name))
    .map((result) => {
      const id = result.meta?.room_graph_node?.node_id || result.id;
      const room = { id, results: [result], surfaceKey: surfaceKey(result) };
      try {
        return {
          ...room,
          segments: roomBoundarySegments(result, id),
          fingerprint: windowFingerprint(roomFingerprintValue(result, id)),
        };
      } catch (error) {
        return { ...room, segments: [], error: error.message };
      }
    })
    .sort(compareIds);
}

const matchingWindowResults = (results, controls) => results.filter((result) => controls.has(result.from_name));

function issueForInvalidTrace(result, traceId, error) {
  return {
    code: "invalid_window_geometry",
    trace_id: traceId,
    result_id: result.id,
    room_ids: [],
    candidates: [],
    message: `窗线 ${result.id} 不是有效的开放 Vector：${error.message}`,
  };
}

const validPercentPoint = (point) =>
  point &&
  [point.x, point.y].every((value) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 100;
  });

function validateFormalVertices(result) {
  const vertices = result.value?.vertices;
  if (!Array.isArray(vertices) || vertices.length < 2) throw new Error("至少需要两个顶点");
  const identifiers = new Set();
  for (const vertex of vertices) {
    if (!vertex || typeof vertex !== "object") throw new Error("顶点格式无效");
    if (typeof vertex.id !== "string" || !vertex.id) throw new Error("每个顶点必须包含稳定 ID");
    if (identifiers.has(vertex.id)) throw new Error(`顶点 ID 重复：${vertex.id}`);
    identifiers.add(vertex.id);
    if (!validPercentPoint(vertex)) throw new Error("顶点 x/y 必须是 0 到 100 的有限百分比");
    if (typeof vertex.isBezier !== "boolean") throw new Error("每个顶点必须包含布尔 isBezier");
    if (vertex.disconnected === true || vertex.isBranching === true)
      throw new Error("不允许 disconnected 或 branching 顶点");
    for (const key of ["controlPoint1", "controlPoint2"]) {
      if (vertex[key] !== undefined && !validPercentPoint(vertex[key])) {
        throw new Error(`${key} 必须是 0 到 100 的有限百分比坐标`);
      }
    }
    if (vertex.isBezier && ![vertex.controlPoint1, vertex.controlPoint2].every(validPercentPoint)) {
      throw new Error("Bezier 顶点必须包含 0 到 100 范围内的 controlPoint1 和 controlPoint2");
    }
  }
}

export function analyzeWindowParents(results, options = {}) {
  const config = { ...DEFAULT_WINDOW_OPTIONS, ...options };
  const controls = new Set(config.windowControls || DEFAULT_WINDOW_OPTIONS.windowControls);
  const roomControls = new Set(config.roomControls || DEFAULT_WINDOW_OPTIONS.roomControls);
  const rooms = roomGroups(results || [], roomControls);
  const traces = [];
  const issues = [];
  for (const result of matchingWindowResults(results || [], controls)) {
    const traceId = `window-trace:${result.id}`;
    const traceSurfaceKey = surfaceKey(result);
    let fingerprint = null;
    try {
      validateFormalVertices(result);
      fingerprint = windowTraceFingerprint(result);
      const labels = result.value?.vectorlabels || [];
      if (labels.length !== 1 || String(labels[0]).trim().toLowerCase() !== "window") {
        throw new Error("必须且只能使用 Window 标签");
      }
      const path = flattenWindowPath(result, config.flatteningTolerancePx);
      const candidates = rooms
        .filter((room) => !room.error && room.surfaceKey === traceSurfaceKey)
        .map((room) => ({
          id: room.id,
          room,
          roomFingerprint: room.fingerprint,
          ...boundaryOverlap(path, room.segments, config),
        }))
        .filter((candidate) => candidate.overlapLength > 1e-9)
        .sort(compareIds);
      const matches = candidates.filter((candidate) => candidate.full);
      if (matches.length === 1) {
        traces.push({
          result,
          traceId,
          surfaceKey: traceSurfaceKey,
          fingerprint,
          path,
          candidates,
          assignment: matches[0],
        });
        continue;
      }
      const issue = matches.length
        ? {
            code: "window_parent_room_ambiguous",
            trace_id: traceId,
            result_id: result.id,
            room_ids: matches.map((candidate) => candidate.id),
            candidates,
            message: `窗线 ${result.id} 同时完整重叠多个房间边界：${matches.map((candidate) => candidate.id).join("、")}`,
          }
        : {
            code: "window_parent_room_not_found",
            trace_id: traceId,
            result_id: result.id,
            room_ids: [],
            candidates,
            message: candidates.length
              ? `窗线 ${result.id} 仅部分重叠房间边界，必须整条位于一个房间的内轮廓线上。`
              : `窗线 ${result.id} 未与任何房间内轮廓形成正长度重叠。`,
          };
      traces.push({ result, traceId, surfaceKey: traceSurfaceKey, fingerprint, path, candidates, issue });
      issues.push(issue);
    } catch (error) {
      const issue = issueForInvalidTrace(result, traceId, error);
      traces.push({ result, traceId, surfaceKey: traceSurfaceKey, fingerprint, issue });
      issues.push(issue);
    }
  }
  const pairing = analyzeWindowPairing(
    traces.filter((trace) => trace.assignment),
    config,
  );
  pairing.unresolved.forEach((unresolved) => {
    const issue = {
      code: "window_pairing_not_mutual_best",
      trace_id: unresolved.trace_id,
      result_id: unresolved.result_id,
      room_ids: unresolved.room_ids,
      candidate_trace_ids: unresolved.candidate_trace_ids,
      message: `窗线 ${unresolved.result_id} 存在对侧候选 ${unresolved.candidate_trace_ids.join(
        "、",
      )}，但未形成互为最佳配对。`,
    };
    const trace = traces.find((candidate) => candidate.traceId === unresolved.trace_id);
    if (trace) trace.pairingIssue = issue;
    issues.push(issue);
  });
  return { rooms, traces, issues, pairing };
}

function validBaseContext(trace) {
  const assignment = trace.assignment;
  return {
    schema_version: 1,
    parent_room_id: assignment.id,
    source_trace_id: trace.traceId,
    source_window_trace_fingerprint: trace.fingerprint,
    source_room_fingerprint: assignment.roomFingerprint,
    boundary_attachment: {
      match_rule: "full_positive_length_room_boundary_overlap",
      path_length_px: trace.path.length,
      overlap_length_px: assignment.overlapLength,
      room_boundary_segment_ids: assignment.roomBoundarySegmentIds,
    },
    parent_derivation: {
      algorithm_version: WINDOW_PARENT_ALGORITHM_VERSION,
      source_window_trace_fingerprint: trace.fingerprint,
      room_fingerprint: assignment.roomFingerprint,
      boundary_match_tolerance_px: trace.options?.boundaryMatchTolerancePx,
      flattening_tolerance_px: trace.options?.flatteningTolerancePx,
    },
    derivation_status: "current",
  };
}

export function windowContextFor(trace, options = {}) {
  if (!trace.assignment) {
    return {
      schema_version: 1,
      source_trace_id: trace.traceId,
      ...(trace.fingerprint ? { source_window_trace_fingerprint: trace.fingerprint } : {}),
      pairing_status: WINDOW_PAIRING_PENDING,
      derivation_error: {
        code: trace.issue.code,
        message: trace.issue.message,
        room_ids: trace.issue.room_ids,
      },
    };
  }
  const withOptions = { ...trace, options };
  const base = validBaseContext(withOptions);
  // Only the server's complete, all-trace search may classify exterior or
  // persist a pair. The editor always sends parent evidence as pending.
  return { ...base, pairing_status: WINDOW_PAIRING_PENDING };
}
