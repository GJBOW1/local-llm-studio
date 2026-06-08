#!/usr/bin/env python3
"""Local LLM Studio — single entry point for the packaged (frozen) app.

One binary, two roles:
  • lls                → supervisor (control plane). Starts the bundled Ollama
                          engine if needed, brings up the chat worker, opens the UI.
  • lls --worker       → the Flask chat worker (app.run_worker), spawned by the
                          supervisor as a managed subprocess.

In dev you still run `python supervisor.py` / `python app.py` directly; this file
is what PyInstaller freezes.
"""
from __future__ import annotations

import os
import sys
import threading
import time
import webbrowser


def _open_ui_when_ready(port: int) -> None:
    """Open the browser to the chat UI once the worker is serving."""
    import urllib.request

    url = f"http://127.0.0.1:{port}/"
    for _ in range(120):  # up to ~60s
        try:
            with urllib.request.urlopen(url, timeout=1):
                break
        except Exception:
            time.sleep(0.5)
    try:
        webbrowser.open(url)
    except Exception:
        pass


def main() -> None:
    import ollama_runtime as ort

    ort.apply_frozen_paths()

    args = sys.argv[1:]
    if args and args[0] in ("--worker", "worker"):
        import app
        app.run_worker()
        return

    # Supervisor role: bring up the bundled engine, open the UI, run the control plane.
    ort.start_bundled_ollama()
    port = int(os.environ.get("LLS_WORKER_PORT", "5050"))
    threading.Thread(target=_open_ui_when_ready, args=(port,), daemon=True).start()
    import supervisor
    supervisor.run()


if __name__ == "__main__":
    main()
