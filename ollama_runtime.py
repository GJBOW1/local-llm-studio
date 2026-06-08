"""Bundled-Ollama lifecycle + frozen resource paths for Local LLM Studio.

In a packaged build we ship the `ollama` engine inside the app and store models /
sessions / config in a writable per-user directory (never inside the read-only
bundle). In dev (unfrozen) this is mostly a no-op: a system Ollama is used.
"""
from __future__ import annotations

import atexit
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Optional

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def bundle_dir() -> Path:
    """Directory holding bundled resources (PyInstaller _MEIPASS when frozen)."""
    return Path(getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__))))


def data_dir() -> Path:
    """Writable per-user directory for models, sessions, and config — created on
    first run, kept OUTSIDE the app bundle so an end user owns their data."""
    if sys.platform == "darwin":
        d = Path.home() / "Library" / "Application Support" / "Local LLM Studio"
    elif os.name == "nt":
        d = Path(os.environ.get("APPDATA") or Path.home()) / "Local LLM Studio"
    else:
        d = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")) / "local-llm-studio"
    d.mkdir(parents=True, exist_ok=True)
    return d


def apply_frozen_paths() -> None:
    """Point Ollama's model store + the app's working dir at the writable data dir."""
    if is_frozen():
        os.environ.setdefault("OLLAMA_MODELS", str(data_dir() / "models"))
        os.environ.setdefault("LLS_DATA_DIR", str(data_dir()))


def _ollama_binary() -> Optional[Path]:
    name = "ollama.exe" if os.name == "nt" else "ollama"
    candidates = [
        bundle_dir() / name,
        bundle_dir() / "ollama" / name,
        Path(sys.executable).resolve().parent / name,
        Path(sys.executable).resolve().parent / "ollama" / name,
    ]
    for c in candidates:
        if c.exists():
            return c
    return None


def ollama_up(host: str = OLLAMA_HOST) -> bool:
    try:
        with urllib.request.urlopen(host + "/api/version", timeout=2):
            return True
    except Exception:
        return False


_proc: Optional[subprocess.Popen] = None


def start_bundled_ollama() -> None:
    """Start the bundled `ollama serve` if nothing is already serving on 11434.
    No-op when a system Ollama is already running, or when no bundled binary is
    present (dev mode)."""
    global _proc
    if ollama_up():
        return
    binp = _ollama_binary()
    if not binp:
        return
    env = dict(os.environ)
    env.setdefault("OLLAMA_MODELS", str(data_dir() / "models"))
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    try:
        _proc = subprocess.Popen(
            [str(binp), "serve"], env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs,
        )
    except Exception:
        return
    atexit.register(stop_bundled_ollama)
    for _ in range(60):  # wait up to ~30s for the engine to come up
        if ollama_up():
            break
        time.sleep(0.5)


def stop_bundled_ollama() -> None:
    global _proc
    if _proc and _proc.poll() is None:
        try:
            _proc.terminate()
            _proc.wait(timeout=5)
        except Exception:
            try:
                _proc.kill()
            except Exception:
                pass
    _proc = None
