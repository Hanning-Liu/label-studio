"""Detection and validation of the opt-in room-window label configuration."""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from dataclasses import dataclass


DEFAULT_ROOM_CONTROLS = ("room_rectangle", "room_polygon")
DEFAULT_WINDOW_CONTROLS = ("window_vector",)


@dataclass(frozen=True)
class WindowConfig:
    enabled: bool = False
    room_controls: tuple[str, ...] = DEFAULT_ROOM_CONTROLS
    window_controls: tuple[str, ...] = DEFAULT_WINDOW_CONTROLS
    boundary_match_tolerance_px: float = 2.0
    pair_search_limit_px: float = 40.0
    minimum_projected_overlap_px: float = 8.0
    maximum_tangent_delta_deg: float = 10.0
    flattening_tolerance_px: float = 0.5
    lower_level_inward_projection_limit_px: float | None = 60.0
    # Numerical tolerance only; it must remain far below the semantic room
    # boundary tolerance so it cannot bridge a visible annotation gap.
    projection_boundary_tolerance_px: float = 1e-6

    def matching_policy(self):
        return {
            "pairing_rule": "mutual_outward_projection",
            "boundary_match_tolerance_px": self.boundary_match_tolerance_px,
            "pair_search_limit_px": self.pair_search_limit_px,
            "minimum_projected_overlap_px": self.minimum_projected_overlap_px,
            "maximum_tangent_delta_deg": self.maximum_tangent_delta_deg,
            "flattening_tolerance_px": self.flattening_tolerance_px,
            "lower_level_inward_projection_limit_px": self.lower_level_inward_projection_limit_px,
        }


def _attrs(element):
    return {key.lower(): value for key, value in element.attrib.items()}


def _bool(value, default=False):
    if value is None:
        return default
    normalized = str(value).strip().lower()
    if normalized in {"true", "1", "yes"}:
        return True
    if normalized in {"false", "0", "no"}:
        return False
    raise ValueError(f"roomWindowV1 必须是布尔值，收到 {value!r}。")


def _controls(value, default):
    if value is None:
        return default
    controls = tuple(item.strip() for item in str(value).split(",") if item.strip())
    if not controls:
        raise ValueError("windowControls/roomV3Controls 不能为空。")
    return controls


def _number(attrs, key, default, *, nullable=False, maximum=None):
    raw = attrs.get(key.lower())
    if raw is None:
        return default
    if nullable and str(raw).strip().lower() in {"", "null", "none"}:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{key} 必须是数字。") from exc
    if not math.isfinite(value) or value <= 0 or (maximum is not None and value > maximum):
        suffix = f" 且不超过 {maximum}" if maximum is not None else ""
        raise ValueError(f"{key} 必须大于 0{suffix}。")
    return value


def parse_window_config(label_config: str | None) -> WindowConfig:
    """Return disabled config unless the Image explicitly enables roomWindowV1."""
    if not label_config:
        return WindowConfig()
    try:
        root = ET.fromstring(label_config)
    except ET.ParseError as exc:
        raise ValueError(f"无法解析窗户标注配置：{exc}") from exc
    image = next((element for element in root.iter() if element.tag.lower() == "image"), None)
    if image is None:
        return WindowConfig()
    attrs = _attrs(image)
    enabled = _bool(attrs.get("roomwindowv1"), False)
    if not enabled:
        return WindowConfig()
    room_controls = _controls(attrs.get("roomv3controls"), DEFAULT_ROOM_CONTROLS)
    window_controls = _controls(attrs.get("windowcontrols"), DEFAULT_WINDOW_CONTROLS)
    controls = {element.attrib.get("name"): element for element in root.iter() if element.attrib.get("name")}
    for name in room_controls:
        element = controls.get(name)
        if element is None or element.tag.lower() not in {"rectanglelabels", "polygonlabels"}:
            raise ValueError(f"房间控件 {name} 缺失或不是 RectangleLabels/PolygonLabels。")
    for name in window_controls:
        element = controls.get(name)
        if element is None or element.tag.lower() != "vectorlabels":
            raise ValueError(f"窗户控件 {name} 缺失或不是 VectorLabels。")
        labels = {
            str(child.attrib.get("value", "")).strip().lower()
            for child in element
            if child.tag.lower() == "label"
        }
        if "window" not in labels:
            raise ValueError(f"窗户控件 {name} 必须包含 Window 标签。")
    angle_raw = attrs.get("windowmaximumtangentdeltadeg")
    try:
        angle = 10.0 if angle_raw is None else float(angle_raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("windowMaximumTangentDeltaDeg 必须是数字。") from exc
    if not math.isfinite(angle) or angle < 0 or angle > 90:
        raise ValueError("windowMaximumTangentDeltaDeg 必须介于 0 和 90。")
    return WindowConfig(
        enabled=True,
        room_controls=room_controls,
        window_controls=window_controls,
        boundary_match_tolerance_px=_number(attrs, "windowBoundaryMatchTolerancePx", 2.0),
        pair_search_limit_px=_number(attrs, "windowPairSearchLimitPx", 40.0),
        minimum_projected_overlap_px=_number(attrs, "windowMinimumProjectedOverlapPx", 8.0),
        maximum_tangent_delta_deg=angle,
        flattening_tolerance_px=_number(attrs, "windowFlatteningTolerancePx", 0.5),
        lower_level_inward_projection_limit_px=_number(
            attrs, "windowInwardProjectionLimitPx", 60.0, nullable=True
        ),
    )
