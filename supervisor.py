"""Local LLM Studio — supervisor.

A tiny always-on process that owns the chat server's lifecycle, so the GUI can
Start, Stop, and change the port of the server — even after a full stop. A web
page can't revive the server that served it once that process is dead, so this
supervisor stays alive on a fixed control port and manages the chat worker
(app.py) as a subprocess on the user-chosen port.

  • supervisor  → control port (default 4747), always alive
  • worker      → app.py on the chosen port (default 5000), managed subprocess

Launched by the Desktop app; it auto-starts the worker on boot.
"""

from __future__ import annotations

import atexit
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path
from typing import Optional

from flask import Flask, Response, jsonify, redirect, render_template_string, request

HERE = Path(__file__).resolve().parent
PYTHON = sys.executable
HOST = "127.0.0.1"
CONTROL_PORT = int(os.environ.get("LLS_CONTROL_PORT", "4747"))
# 5050, not 5000: macOS AirPlay Receiver squats on *:5000 (incl. IPv6 ::1, where
# "localhost" resolves first), which collides with a 127.0.0.1-only worker.
DEFAULT_WORKER_PORT = int(os.environ.get("LLS_WORKER_PORT", "5050"))
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")

app = Flask(__name__)

# --- managed worker state ---
_worker: Optional[subprocess.Popen] = None
_worker_port: int = DEFAULT_WORKER_PORT


def _control_url() -> str:
    return f"http://{HOST}:{CONTROL_PORT}"


def _worker_url(port: Optional[int] = None) -> str:
    return f"http://{HOST}:{port or _worker_port}/"


def _coerce_port(raw: object, fallback: int) -> int:
    """Parse a user-supplied port, falling back if it's missing or out of range."""
    try:
        port = int(str(raw).strip())
    except (TypeError, ValueError):
        return fallback
    return port if 1024 <= port <= 65535 else fallback


def _port_free(port: int) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((HOST, port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def _worker_running() -> bool:
    return _worker is not None and _worker.poll() is None


def _wait_for_port(port: int, timeout: float = 8.0) -> bool:
    """Block until the worker is accepting connections, or time out."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((HOST, port), timeout=0.4):
                return True
        except OSError:
            time.sleep(0.15)
    return False


def _start_worker(port: int) -> tuple[bool, str]:
    """Spawn the chat worker on `port`. Returns (ok, message)."""
    global _worker, _worker_port
    if _worker_running():
        return True, "already running"
    if not _port_free(port):
        return False, f"Port {port} is already in use — pick another."
    env = {**os.environ, "PORT": str(port), "LLS_CONTROL_URL": _control_url()}
    _worker = subprocess.Popen([PYTHON, "app.py"], cwd=str(HERE), env=env)
    _worker_port = port
    if not _wait_for_port(port):
        return False, "The server did not come up in time."
    return True, "started"


def _stop_worker() -> None:
    """Terminate the worker if it's running (graceful, then forced)."""
    global _worker
    if _worker_running():
        assert _worker is not None
        _worker.terminate()
        try:
            _worker.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _worker.kill()
    _worker = None


def _unload_ollama_models() -> None:
    """Free RAM on a full stop: ask Ollama to unload any resident model (keep_alive
    0). Ollama is a separate process, so killing the worker alone leaves the model
    parked for its keep_alive window — this reclaims that memory immediately.
    Best-effort: any failure is swallowed (nothing to clean up if Ollama is down)."""
    try:
        with urllib.request.urlopen(f"{OLLAMA_HOST}/api/ps", timeout=4) as resp:
            models = json.loads(resp.read()).get("models", [])
    except Exception:
        return
    for m in models:
        name = m.get("name") or m.get("model")
        if not name:
            continue
        try:
            req = urllib.request.Request(
                f"{OLLAMA_HOST}/api/generate",
                data=json.dumps({"model": name, "keep_alive": 0}).encode(),
                headers={"Content-Type": "application/json"}, method="POST",
            )
            urllib.request.urlopen(req, timeout=8).read()
        except Exception:
            pass


def _terminal_tty() -> Optional[str]:
    """The /dev/ttys… this supervisor is attached to, so we can close exactly that
    Terminal window on a full quit (and never someone else's)."""
    try:
        return os.ttyname(sys.stdin.fileno())
    except OSError:
        try:
            out = subprocess.check_output(
                ["ps", "-o", "tty=", "-p", str(os.getpid())], text=True
            ).strip()
            return "/dev/" + out if out and out != "??" else None
        except Exception:
            return None


def _close_terminal_and_exit() -> None:
    """Full quit: close the launching Terminal window, then exit. We detach the
    AppleScript with a short delay so the supervisor process has already exited by
    the time `close` fires — the tab is then process-free, so Terminal won't pop a
    "processes are running" prompt (`saving no` covers the rest)."""
    tty = _terminal_tty()
    if tty:
        script = (
            "delay 0.6\n"
            'tell application "Terminal"\n'
            "  repeat with w in windows\n"
            "    try\n"
            "      repeat with t in tabs of w\n"
            f'        if tty of t is "{tty}" then close w saving no\n'
            "      end repeat\n"
            "    end try\n"
            "  end repeat\n"
            "end tell"
        )
        try:
            subprocess.Popen(
                ["osascript", "-e", script], start_new_session=True,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass
    time.sleep(0.2)  # let osascript get scheduled before we vanish
    os._exit(0)


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.get("/")
def control() -> str:
    """The control panel — Start/Stop the server and choose its port."""
    return render_template_string(
        CONTROL_HTML,
        running=_worker_running(),
        port=_worker_port,
        worker_url=_worker_url(),
        error=request.args.get("error", ""),
    )


@app.get("/status")
def status() -> Response:
    return jsonify({"running": _worker_running(), "port": _worker_port})


@app.post("/start")
def start() -> Response:
    port = _coerce_port(request.form.get("port"), _worker_port)
    ok, msg = _start_worker(port)
    if ok:
        return redirect(_worker_url(port), code=303)
    return redirect(f"/?error={msg}", code=303)


@app.post("/stop")
def stop() -> Response:
    _stop_worker()
    _unload_ollama_models()  # End = free the model's RAM too, not just kill the server
    return redirect("/", code=303)


@app.post("/restart")
def restart() -> Response:
    port = _coerce_port(request.form.get("port"), _worker_port)
    _stop_worker()
    ok, msg = _start_worker(port)
    if ok:
        return redirect(_worker_url(port), code=303)
    return redirect(f"/?error={msg}", code=303)


@app.post("/quit")
def quit_app() -> Response:
    """Full quit (the app's End button): stop the worker, free the model's RAM,
    then close the launching Terminal window and exit. The shutdown is deferred a
    beat so this response reaches the browser first."""
    _stop_worker()
    _unload_ollama_models()
    threading.Timer(0.4, _close_terminal_and_exit).start()
    return render_template_string(GOODBYE_HTML)


# --------------------------------------------------------------------------- #
# Lifecycle: stop the worker when the supervisor itself goes away.
# --------------------------------------------------------------------------- #
def _graceful_exit(signum: int, frame: object) -> None:
    _stop_worker()
    _unload_ollama_models()  # quitting the whole app frees the model's RAM too
    sys.exit(0)


atexit.register(_stop_worker)
for _sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(_sig, _graceful_exit)


CONTROL_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Local LLM Studio — Server Control</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
  <style>
    :root{ --bg:#0d1117; --panel:#161b22; --text:#c9d1d9; --muted:#8b949e;
      --hair:#30363d; --gold:#d4a853; --gold-soft:rgba(212,168,83,.16);
      --green:#3fb950; --red:#f0506e;
      --serif:"Cormorant Garamond",Georgia,serif;
      --sans:"DM Sans",-apple-system,BlinkMacSystemFont,system-ui,"Segoe UI",sans-serif; }
    *{box-sizing:border-box}
    html,body{height:100%;margin:0}
    body{ background:radial-gradient(1000px 500px at 80% -10%,rgba(212,168,83,.06),transparent 60%),var(--bg);
      color:var(--text); font-family:var(--sans); display:flex; align-items:center;
      justify-content:center; padding:24px; -webkit-font-smoothing:antialiased; }
    .card{ width:min(440px,94vw); background:linear-gradient(180deg,rgba(22,27,34,.9),rgba(13,17,23,.5));
      border:1px solid var(--hair); border-radius:18px; padding:34px 30px; text-align:center;
      box-shadow:0 28px 70px rgba(0,0,0,.5); }
    .mark{ font-size:46px; color:var(--gold); opacity:.9; line-height:1 }
    h1{ font-family:var(--serif); font-weight:700; font-size:30px; color:var(--gold);
      margin:12px 0 2px; letter-spacing:.5px }
    .tag{ font-size:11px; letter-spacing:2.5px; text-transform:uppercase; color:var(--muted); margin:0 0 22px }
    .status{ display:inline-flex; align-items:center; gap:9px; font-size:13px; color:var(--muted);
      padding:7px 14px; border:1px solid var(--hair); border-radius:999px; margin-bottom:24px }
    .status .dot{ width:9px; height:9px; border-radius:50%; background:var(--muted) }
    .status.on .dot{ background:var(--green); box-shadow:0 0 10px rgba(63,185,80,.6) }
    .status.on{ color:var(--text) }
    .status.off .dot{ background:var(--red) }
    .error{ background:rgba(240,80,110,.12); border:1px solid rgba(240,80,110,.4); color:#ffc2cf;
      border-radius:10px; padding:10px 12px; font-size:13px; margin-bottom:20px }
    form{ margin:0 }
    .port-form{ display:flex; flex-direction:column; gap:14px; align-items:center }
    label{ display:flex; flex-direction:column; gap:7px; font-size:11px; letter-spacing:1.5px;
      text-transform:uppercase; color:var(--muted) }
    input[type=number]{ width:140px; text-align:center; background:var(--bg); border:1px solid var(--hair);
      border-radius:10px; color:var(--text); font-family:var(--sans); font-size:18px; padding:10px 12px }
    input[type=number]:focus{ outline:none; border-color:var(--gold); box-shadow:0 0 0 3px var(--gold-soft) }
    .btn{ display:inline-block; border:none; border-radius:10px; padding:11px 22px; font-family:var(--sans);
      font-size:14px; font-weight:600; cursor:pointer; text-decoration:none; transition:all .18s ease }
    .btn.primary{ background:var(--gold); color:#1a1206 }
    .btn.primary:hover{ box-shadow:0 0 16px rgba(212,168,83,.5); transform:translateY(-1px) }
    .btn.danger{ background:transparent; color:var(--red); border:1px solid var(--red); margin-top:14px }
    .btn.danger:hover{ background:rgba(240,80,110,.12) }
    .row{ display:flex; flex-direction:column; gap:0; align-items:center }
  </style>
</head>
<body>
  <div class="card">
    <div class="mark">&#9673;</div>
    <h1>Local LLM Studio</h1>
    <p class="tag">server control</p>

    {% if error %}<div class="error">{{ error }}</div>{% endif %}

    <div class="status {{ 'on' if running else 'off' }}">
      <span class="dot"></span>
      {% if running %}Running on port {{ port }}{% else %}Server stopped{% endif %}
    </div>

    {% if running %}
      <div class="row">
        <a class="btn primary" href="{{ worker_url }}">Open app</a>
        <form method="POST" action="/stop">
          <button class="btn danger" type="submit">Stop server</button>
        </form>
      </div>
    {% else %}
      <form method="POST" action="/start" class="port-form">
        <label>Port<input type="number" name="port" min="1024" max="65535" value="{{ port }}" /></label>
        <button class="btn primary" type="submit">Start server</button>
      </form>
    {% endif %}
  </div>
</body>
</html>
"""


GOODBYE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Local LLM Studio — Shut down</title>
  <style>
    :root{ --bg:#0d1117; --text:#c9d1d9; --muted:#8b949e; --hair:#30363d; --gold:#d4a853;
      --serif:Georgia,serif; --sans:-apple-system,BlinkMacSystemFont,system-ui,"Segoe UI",sans-serif; }
    html,body{height:100%;margin:0}
    body{ background:radial-gradient(1000px 500px at 80% -10%,rgba(212,168,83,.06),transparent 60%),var(--bg);
      color:var(--text); font-family:var(--sans); display:flex; align-items:center;
      justify-content:center; padding:24px; -webkit-font-smoothing:antialiased; }
    .card{ width:min(440px,94vw); border:1px solid var(--hair); border-radius:18px;
      padding:40px 30px; text-align:center; background:rgba(22,27,34,.6); }
    .mark{ font-size:46px; color:var(--gold); line-height:1 }
    h1{ font-family:var(--serif); font-weight:700; font-size:28px; color:var(--gold); margin:14px 0 8px }
    p{ color:var(--muted); font-size:14px; line-height:1.6; margin:0 }
  </style>
</head>
<body>
  <div class="card">
    <div class="mark">&#9673;</div>
    <h1>Shutting down</h1>
    <p>The server has stopped and the model's memory has been freed.<br />
       This window can be closed.</p>
  </div>
</body>
</html>
"""


if __name__ == "__main__":
    # Bring the chat server up on boot so launching feels instant, then serve
    # the control panel. The worker is a managed subprocess from here on.
    _start_worker(DEFAULT_WORKER_PORT)
    app.run(host=HOST, port=CONTROL_PORT, debug=False, use_reloader=False)
