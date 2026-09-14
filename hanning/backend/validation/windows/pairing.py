"""Mutual outward-projection pairing and terminal exterior classification."""

from __future__ import annotations

import math
from dataclasses import dataclass

from shapely.geometry import LineString, Point
from .geometry import PAIRING_ALGORITHM_VERSION, WindowTrace, angle_delta_deg, fingerprint, inward_normal, merge_intervals


@dataclass(frozen=True)
class PairCandidate:
    first_id: str
    second_id: str
    projected_overlap_length_px: float
    mean_separation_px: float
    maximum_separation_px: float
    maximum_tangent_delta_deg: float
    first_intervals: tuple[tuple[float, float], ...]
    second_intervals: tuple[tuple[float, float], ...]

    def other(self, trace_id):
        return self.second_id if trace_id == self.first_id else self.first_id

    def rank(self, trace_id):
        return (
            round(self.mean_separation_px, 9),
            round(self.maximum_separation_px, 9),
            -round(self.projected_overlap_length_px, 9),
            round(self.maximum_tangent_delta_deg, 9),
            self.other(trace_id),
        )


def _dot(first, second):
    return first[0] * second[0] + first[1] * second[1]


def _segment_candidate(first, first_index, second, second_index, config):
    a0, a1 = first.points[first_index : first_index + 2]
    b0, b1 = second.points[second_index : second_index + 2]
    av = (a1[0] - a0[0], a1[1] - a0[1])
    bv = (b1[0] - b0[0], b1[1] - b0[1])
    al, bl = math.hypot(*av), math.hypot(*bv)
    if al <= 1e-12 or bl <= 1e-12:
        return None
    angle = angle_delta_deg(av, bv)
    if angle > config.maximum_tangent_delta_deg:
        return None
    au, bu = (av[0] / al, av[1] / al), (bv[0] / bl, bv[1] / bl)
    a_projection = sorted((_dot((b0[0] - a0[0], b0[1] - a0[1]), au), _dot((b1[0] - a0[0], b1[1] - a0[1]), au)))
    a_start, a_end = max(0.0, a_projection[0]), min(al, a_projection[1])
    b_projection = sorted((_dot((a0[0] - b0[0], a0[1] - b0[1]), bu), _dot((a1[0] - b0[0], a1[1] - b0[1]), bu)))
    b_start, b_end = max(0.0, b_projection[0]), min(bl, b_projection[1])
    overlap = min(a_end - a_start, b_end - b_start)
    if overlap <= 1e-9:
        return None
    amid = (a0[0] + au[0] * (a_start + a_end) / 2, a0[1] + au[1] * (a_start + a_end) / 2)
    bmid = (b0[0] + bu[0] * (b_start + b_end) / 2, b0[1] + bu[1] * (b_start + b_end) / 2)
    outward_a = tuple(-value for value in inward_normal(first.room, a0, a1))
    outward_b = tuple(-value for value in inward_normal(second.room, b0, b1))
    delta = (bmid[0] - amid[0], bmid[1] - amid[1])
    if _dot(delta, outward_a) <= 1e-9 or _dot((-delta[0], -delta[1]), outward_b) <= 1e-9:
        return None
    line_a, line_b = LineString((a0, a1)), LineString((b0, b1))
    separation = line_a.distance(line_b)
    if separation > config.pair_search_limit_px + 1e-9:
        return None
    samples = []
    for fraction in (0.0, 0.5, 1.0):
        point = Point(amid[0] + au[0] * overlap * (fraction - 0.5), amid[1] + au[1] * overlap * (fraction - 0.5))
        samples.append(point.distance(line_b))
    if max(samples) > config.pair_search_limit_px + 1e-9:
        return None
    return {
        "overlap": overlap,
        "mean_separation": sum(samples) / len(samples),
        "maximum_separation": max(samples),
        "angle": angle,
        "first_interval": (
            first.parameters[first_index] + a_start / al * (first.parameters[first_index + 1] - first.parameters[first_index]),
            first.parameters[first_index] + a_end / al * (first.parameters[first_index + 1] - first.parameters[first_index]),
        ),
        "second_interval": (
            second.parameters[second_index] + b_start / bl * (second.parameters[second_index + 1] - second.parameters[second_index]),
            second.parameters[second_index] + b_end / bl * (second.parameters[second_index + 1] - second.parameters[second_index]),
        ),
    }


def pair_candidate(first: WindowTrace, second: WindowTrace, config):
    if first.surface_key != second.surface_key:
        return None
    if first.parent_room_id == second.parent_room_id:
        return None
    pieces = []
    for first_index in range(len(first.points) - 1):
        for second_index in range(len(second.points) - 1):
            piece = _segment_candidate(first, first_index, second, second_index, config)
            if piece:
                pieces.append(piece)
    if not pieces:
        return None
    first_intervals = merge_intervals(piece["first_interval"] for piece in pieces)
    second_intervals = merge_intervals(piece["second_interval"] for piece in pieces)
    first_overlap = sum((end - start) * first.line.length for start, end in first_intervals)
    second_overlap = sum((end - start) * second.line.length for start, end in second_intervals)
    overlap = min(first_overlap, second_overlap)
    if overlap + 1e-9 < config.minimum_projected_overlap_px:
        return None
    weights = [piece["overlap"] for piece in pieces]
    return PairCandidate(
        first_id=first.trace_id,
        second_id=second.trace_id,
        projected_overlap_length_px=overlap,
        mean_separation_px=sum(piece["mean_separation"] * weight for piece, weight in zip(pieces, weights)) / sum(weights),
        maximum_separation_px=max(piece["maximum_separation"] for piece in pieces),
        maximum_tangent_delta_deg=max(piece["angle"] for piece in pieces),
        first_intervals=tuple(first_intervals),
        second_intervals=tuple(second_intervals),
    )


def _connection_id(trace_ids):
    return "window-connection:" + fingerprint({"trace_ids": sorted(trace_ids)})[:24]


def derive_window_connections(traces, config, *, search_complete=True):
    """Enumerate every pair before deriving any exterior connection.

    ``search_complete=False`` is exposed for callers that display intermediate
    state; it deliberately never emits exterior classifications.
    """
    traces = sorted(traces, key=lambda trace: trace.trace_id)
    by_id = {trace.trace_id: trace for trace in traces}
    candidates = {trace.trace_id: [] for trace in traces}
    for index, first in enumerate(traces):
        for second in traces[index + 1 :]:
            candidate = pair_candidate(first, second, config)
            if candidate:
                candidates[first.trace_id].append(candidate)
                candidates[second.trace_id].append(candidate)
    best = {
        trace_id: min(items, key=lambda candidate: candidate.rank(trace_id))
        for trace_id, items in candidates.items()
        if items
    }
    matched, connections = set(), []
    for trace in traces:
        if trace.trace_id in matched or trace.trace_id not in best:
            continue
        candidate = best[trace.trace_id]
        other_id = candidate.other(trace.trace_id)
        if other_id not in best or best[other_id] is not candidate:
            continue
        other = by_id[other_id]
        trace_ids = sorted((trace.trace_id, other_id))
        room_ids = sorted((trace.parent_room_id, other.parent_room_id))
        connections.append({
            "kind": "window_connection",
            "id": _connection_id(trace_ids),
            "connection_kind": "room_to_room",
            "trace_ids": trace_ids,
            "connected_room_ids": room_ids,
            "connects_to_exterior": False,
            "review_status": "candidate",
            "evidence": {
                "match_rule": "mutual_outward_projection",
                "pair_search_limit_px": config.pair_search_limit_px,
                "projected_overlap_length_px": candidate.projected_overlap_length_px,
                "mean_separation_px": candidate.mean_separation_px,
                "maximum_separation_px": candidate.maximum_separation_px,
                "maximum_tangent_delta_deg": candidate.maximum_tangent_delta_deg,
                "mutual_nearest": True,
                "trace_fingerprints": sorted((trace.source_fingerprint, other.source_fingerprint)),
                "algorithm_version": PAIRING_ALGORITHM_VERSION,
            },
            "read_only": True,
        })
        matched.update(trace_ids)
    unresolved = []
    if search_complete:
        for trace in traces:
            if trace.trace_id in matched:
                continue
            trace_candidates = candidates[trace.trace_id]
            if trace_candidates:
                unresolved.append({
                    "trace_id": trace.trace_id,
                    "result_id": trace.result_id,
                    "room_ids": sorted({by_id[item.other(trace.trace_id)].parent_room_id for item in trace_candidates}),
                    "candidate_trace_ids": sorted(item.other(trace.trace_id) for item in trace_candidates),
                    "bbox": trace.bbox,
                })
                continue
            connections.append({
                "kind": "window_connection",
                "id": _connection_id([trace.trace_id]),
                "connection_kind": "room_to_exterior",
                "trace_ids": [trace.trace_id],
                "connected_room_ids": [trace.parent_room_id],
                "connects_to_exterior": True,
                "review_status": "derived",
                "evidence": {
                    "match_rule": "no_opposite_window_trace_within_search_limit",
                    "pair_search_limit_px": config.pair_search_limit_px,
                    "candidate_count": 0,
                    "automatically_classified": True,
                    "trace_fingerprints": [trace.source_fingerprint],
                    "algorithm_version": PAIRING_ALGORITHM_VERSION,
                },
                "read_only": True,
            })
    searches = {
        trace.trace_id: {
            "status": "complete" if search_complete else "pending",
            "candidate_count": len(candidates[trace.trace_id]) if search_complete else None,
            "candidate_trace_ids": sorted(item.other(trace.trace_id) for item in candidates[trace.trace_id]) if search_complete else [],
            "pair_search_limit_px": config.pair_search_limit_px,
            "algorithm_version": PAIRING_ALGORITHM_VERSION,
        }
        for trace in traces
    }
    return sorted(connections, key=lambda item: item["id"]), searches, unresolved
