#!/usr/bin/env python3
"""Compatibility entry for hanning.scripts.room_layout_predictions; CLI parameters are unchanged."""
import sys
from importlib import import_module
from pathlib import Path

_root = str(Path(__file__).resolve().parents[1])
if _root not in sys.path:
    sys.path.insert(0, _root)
_implementation = import_module("hanning.scripts.room_layout_predictions")
__all__ = [name for name in dir(_implementation) if not name.startswith("_")]


def __getattr__(name):
    return getattr(_implementation, name)


if __name__ != "__main__":
    sys.modules[__name__] = _implementation
else:
    raise SystemExit(_implementation.main())
