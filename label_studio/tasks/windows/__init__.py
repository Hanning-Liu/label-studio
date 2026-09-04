"""Server-owned room-window derivation for formal Label Studio results."""

from .aggregate import augment_floorplan_aggregate
from .config import WindowConfig, parse_window_config
from .pairing import derive_window_connections
from .projections import derive_window_projections, projection_is_stale
from .service import WindowValidationError, prepare_formal_results

__all__ = [
    "WindowConfig",
    "WindowValidationError",
    "augment_floorplan_aggregate",
    "derive_window_connections",
    "derive_window_projections",
    "parse_window_config",
    "prepare_formal_results",
    "projection_is_stale",
]
