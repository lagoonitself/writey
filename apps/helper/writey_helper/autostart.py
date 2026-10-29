"""
`writey-helper install`: start the Helper hidden whenever you sign in to your computer, and
right now, so Writey's "Continue with ChatGPT" just works. `uninstall` undoes it.
"""

import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from . import __version__
from .config import HOST, PORT

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
VALUE = "Writey Helper"


def _running_version() -> str | None:
    """The version of the Helper on our port, "" for something else there, None if free."""
    try:
        with urllib.request.urlopen(f"http://{HOST}:{PORT}/health", timeout=1) as res:
            body = json.load(res)
        return str(body.get("version", "")) if body.get("service") == "writey-helper" else ""
    except (OSError, ValueError):
        return None


def _stop_old_helper() -> None:
    """Ends whatever Writey Helper process is listening on our port (an older version)."""
    out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True).stdout
    pids = {
        m.group(1)
        for m in re.finditer(rf"\s{re.escape(HOST)}:{PORT}\s+\S+\s+LISTENING\s+(\d+)", out)
    }
    for pid in pids:
        subprocess.run(["taskkill", "/PID", pid, "/F"], capture_output=True)
    for _ in range(20):
        if _running_version() is None:
            return
        time.sleep(0.25)


def _command() -> list[str]:
    # The installed tool's own Python; pythonw has no console window.
    python = Path(sys.executable)
    quiet = python.with_name("pythonw.exe")
    return [str(quiet if quiet.exists() else python), "-m", "writey_helper.server"]


def install() -> None:
    if sys.platform != "win32":
        print("Starting at sign-in is Windows-only for now. Run `writey-helper` and keep it open.")
        return
    import winreg

    command = _command()
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
        winreg.SetValueEx(key, VALUE, 0, winreg.REG_SZ, subprocess.list2cmdline(command))

    running = _running_version()
    if running == "":
        print(f"Something else is using port {PORT}. Close it, then run this again.")
        sys.exit(1)
    if running and running != __version__:
        print(f"Replacing Writey Helper {running} with {__version__}.")
        _stop_old_helper()
        running = None
    if running is None:
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        subprocess.Popen(command, creationflags=flags, close_fds=True)
    print("Writey Helper is installed. It runs in the background and starts when you sign in.")
    print("Go back to Writey and click Continue with ChatGPT.")


def uninstall() -> None:
    if sys.platform != "win32":
        return
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
            winreg.DeleteValue(key, VALUE)
    except FileNotFoundError:
        pass
    _stop_old_helper()
    print("Writey Helper is stopped and won't start at sign-in any more.")
