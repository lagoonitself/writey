import json
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any


class Store:
    """Small JSON files in the Helper's data folder, written atomically and owner-only."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(self, name: str) -> Path:
        return self.root / f"{name}.json"

    def read(self, name: str) -> dict[str, Any] | None:
        try:
            return json.loads(self._path(name).read_text("utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    def write(self, name: str, data: dict[str, Any]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.root, prefix=f".{name}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            os.chmod(tmp, 0o600)  # owner-only on Unix; %APPDATA% is per-user on Windows
            os.replace(tmp, self._path(name))
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def delete(self, name: str) -> None:
        self._path(name).unlink(missing_ok=True)

    def host_id(self) -> str:
        """An opaque id for this computer, chosen once (Sign in with ChatGPT `ext_agent_host_id`)."""
        data = self.read("host")
        if data and isinstance(data.get("ext_agent_host_id"), str):
            return data["ext_agent_host_id"]
        host_id = f"urn:uuid:{uuid.uuid4()}"
        self.write("host", {"ext_agent_host_id": host_id})
        return host_id
