# Local LLM Studio

A polished, **100% offline** chat web app for your local [Ollama](https://ollama.com)
server. It's a small Flask app that proxies the browser to Ollama, so there are
no CORS headaches — and once your models are pulled, it needs **no internet at
all**. Offline, private, $0.

Dark-luxury aesthetic: `#0D1117` canvas, gold accents, Cormorant Garamond +
DM Sans (with system fallbacks so it still looks intentional with no network),
live token streaming, a pulsing connection dot, markdown rendering with
copy-able code blocks, a temperature slider, and a tokens/sec readout.

## How it works

```
Browser  ──>  worker  app.py    (:5050)  ──>  Ollama (:11434)
         <──  NDJSON stream             <──
                  ▲
                  │ start / stop / change port
              supervisor.py (:4747, always on)
```

Two processes:

- **`app.py`** — the chat worker. A Flask app that proxies the browser to Ollama
  (no CORS), serves the UI, and streams replies. Routes:
  - `GET  /`            — the chat UI
  - `GET  /api/models`  — installed models (name + size) from Ollama's `/api/tags`
  - `GET  /api/health`  — is Ollama reachable?
  - `POST /api/chat`    — proxies to Ollama's `/api/chat` and **streams** the reply
- **`supervisor.py`** — a tiny always-on manager on a fixed control port (4747).
  It owns the worker's lifecycle so the GUI can **Start**, **Stop**, and **change
  the port** of the server — even after a full stop, when the (dead) worker page
  could no longer revive itself. Routes: `GET /` (control panel + `/status`),
  `POST /start`, `POST /stop`, `POST /restart`.

## Prerequisites

1. **Ollama installed and running.** Download from <https://ollama.com>, then
   confirm it's up: `ollama list`. Pull at least one model, e.g.:
   ```bash
   ollama pull llama3.2
   ```
2. **Python deps** (Flask + requests):
   ```bash
   pip install flask requests
   ```
   (Optionally use a virtualenv: `python -m venv .venv && source .venv/bin/activate` first.)

## Run

Double-click **Local LLM Studio.app** on the Desktop, or from a terminal:

```bash
python supervisor.py
```

This starts the supervisor, which auto-launches the chat server on port 5050.
Then open <http://127.0.0.1:5050>.

> **Why 5050 and `127.0.0.1`, not 5000 / `localhost`?** macOS AirPlay Receiver
> squats on `*:5000` (including IPv6 `::1`, which `localhost` resolves to first),
> so a worker bound to `127.0.0.1` there gets shadowed and the page fails to load.
> 5050 sidesteps it; use the IPv4 address to be safe. Change the port any time via
> ⚙ Settings.

Pick a model from the dropdown (the connection dot turns green when Ollama is
reachable) and start chatting. Enter sends; Shift+Enter adds a newline; **Stop**
aborts an in-flight stream; **New chat** clears the conversation. Your last-used
model and your conversations are remembered in `localStorage`.

### Server controls

- **⚙ Settings** — change the port the server runs on (handy if 5000 is taken by
  another app or macOS AirPlay). Applying a new port restarts the server and
  reloads the app there.
- **End** — stops the server; you land on the supervisor's control page with a
  **Start server** button to bring it back, no relaunch needed.

> Running `python app.py` directly still works for a one-off, but the in-app
> Start/Stop/port controls only appear when launched via the supervisor.

## Configuration

- `OLLAMA_HOST` — base URL of your Ollama server. Defaults to
  `http://localhost:11434`. Override if Ollama runs elsewhere:
  ```bash
  OLLAMA_HOST=http://192.168.1.50:11434 python app.py
  ```

## Fully offline

There are **no runtime CDN dependencies**. The markdown renderer is vendored
locally (`static/markdown.js`). Google Fonts are loaded as a progressive
enhancement only — if there's no network, the app falls back to Georgia (serif)
and the system sans-serif and still looks intentional. Once your models are
pulled, you can disconnect entirely.
