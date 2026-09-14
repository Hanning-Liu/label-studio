"""Compatibility module; keep imports, private helpers and patch targets identical."""

import sys
from importlib import import_module

sys.modules[__name__] = import_module('hanning.backend.validation.occupancy.template')
