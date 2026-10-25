import os
import sys
from pathlib import Path

HOST = "127.0.0.1"
PORT = int(os.environ.get("WRITEY_HELPER_PORT", "47823"))

# Only these sites may talk to the Helper (docs/ARCHITECTURE.md §7.3).
DEFAULT_ORIGINS = "https://writey.writey.workers.dev,http://localhost:5173"
ORIGINS = frozenset(
    o.strip().rstrip("/")
    for o in os.environ.get("WRITEY_ORIGINS", DEFAULT_ORIGINS).split(",")
    if o.strip()
)


def data_dir() -> Path:
    """Per-user folder for the Helper's private files (tokens, pairing, host id)."""
    override = os.environ.get("WRITEY_HELPER_HOME")
    if override:
        return Path(override)
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "Writey" / "helper"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Writey" / "helper"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "writey-helper"
