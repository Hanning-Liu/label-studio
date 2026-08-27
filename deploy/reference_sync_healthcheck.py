"""No Django startup or network calls in the container heartbeat probe."""
import time
from pathlib import Path

try:
    recent = time.time() - float(Path('/tmp/room-reference-sync.heartbeat').read_text()) < 15
except (OSError, ValueError):
    recent = False
raise SystemExit(0 if recent else 1)
