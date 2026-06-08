<div align="center">

# Local LLM Studio

### A private, multi‑model AI workspace that runs on your own machine.

Race local and cloud models side‑by‑side, ground every answer in your own notes, and let several models collaborate on one document — all behind a glassy, offline‑first interface where nothing leaves your computer unless you say so.

![Local LLM Studio — chat with live diagrams and on‑device telemetry](docs/screenshots/01-chat.png)

[![Made with Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Flask](https://img.shields.io/badge/Flask-3.0-000000?logo=flask&logoColor=white)](https://flask.palletsprojects.com/)
[![Ollama](https://img.shields.io/badge/Engine-Ollama-0A0A0A)](https://ollama.com/)
[![Platform](https://img.shields.io/badge/macOS%20%C2%B7%20Windows-portable-6f8fcf)](#-portable-app)
![Offline‑first](https://img.shields.io/badge/Offline‑first-Private%20%C2%B7%20%240-6ee7a0)

</div>

---

## Why it exists

Most AI apps send your conversations — and your context — to someone else's server. Local LLM Studio flips that: it runs models **on your hardware** through [Ollama](https://ollama.com/), keeps your chats and notes on disk, and only touches the cloud when *you* connect a key. It's a single, polished interface for everything from a quick offline chat to a multi‑model "boardroom" working on the same document.

## ✨ Highlights

- **🏟 Model Arena** — add models from any provider and broadcast one prompt to all of them at once, each in its own scrollable chat card with live tokens/sec. Then **cross‑pollinate**: share every answer with the others and have each model reconsider.
- **✒️ One document, many minds** — open a file in the Arena and hand the *pen* to a model. Every model can **read** the document; the pen‑holder can **edit** it with a tool call — and the change appears live for everyone. Pass the pen and watch a different model take over.
- **🧠 Your second brain** — point it at your Obsidian vault and answers get grounded in *your* notes (local embeddings, never sent to the cloud). A **knowledge graph** maps how your notes connect.
- **🔌 Local + cloud, one picker** — Qwen, Gemma, Llama, NVIDIA Nemotron locally; Claude, GPT, Gemini, and Grok in the cloud. Not installed? It downloads on first use, with a progress bar.
- **📊 Live artifacts** — models can draw **Mermaid** diagrams, **Chart.js** charts, **SVG**, and sandboxed **HTML** that render right in the chat.
- **🛠 Bring your own tools** — connect any **MCP server** in Settings and its tools become available to every model (read‑only by default, for safety).
- **🔒 Private by design** — offline models cost **$0** and never phone home; a structural guard keeps your private notes out of any prompt that goes to a cloud model.

---

## 🏟 Several models, one shared document

Give one model the **pen** and broadcast a prompt — it edits the open document with a tool call while every other model reads along. The edit lands live in the panel; hand the pen to another model and it picks up where the last left off.

![The Arena: multiple models editing one shared document](docs/screenshots/02-arena-doc.png)

## 🧠 A second brain that actually connects

Connect your Obsidian vault in Settings and Local LLM Studio indexes it locally with `nomic-embed-text`. Relevant notes are pulled into every answer automatically, and the **knowledge graph** shows the web of links between them — the real structure of how you think.

![Knowledge graph of the connected vault, with index health](docs/screenshots/03-knowledge-graph.png)

## 🔌 Connect models, tools, and your vault — all in one place

Bring keys for any cloud provider, connect MCP servers whose tools reach every model, and point the second brain at your vault — no config files to edit.

![Settings: MCP tools and the Obsidian vault connector](docs/screenshots/04-settings.png)

---

## 🚀 Quick start (from source)

> Requires [Ollama](https://ollama.com/) running locally and Python 3.11.

```bash
git clone https://github.com/Panic-In-The-Distro/local-llm-studio.git
cd local-llm-studio
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

ollama pull gemma4:12b-it-qat      # a capable local default
ollama pull nomic-embed-text       # for the second brain

python supervisor.py               # opens the UI at http://127.0.0.1:5050
```

Then, optionally:
- **Cloud models** — Settings → Cloud models → paste a provider key.
- **Second brain** — Settings → Second brain → *Browse…* to your Obsidian vault → *Connect & index*.
- **MCP tools** — Settings → Tools (MCP) → add a server (copy `mcp_servers.example.json` → `mcp_servers.json`).

## 📦 Portable app

For a zero‑prerequisite build (no Python, no separate Ollama install — the engine is bundled and models download on first run), see **[PACKAGING.md](PACKAGING.md)**. A GitHub Actions workflow builds **macOS (Apple Silicon + Intel)** and **Windows** installers; macOS builds are code‑signed + notarized when signing secrets are present.

---

## 🏗 How it works

```
 Browser UI  ──►  supervisor.py ──►  app.py (Flask worker)  ──►  Ollama  (local models)
 (glass SPA)      (control plane)    proxy · RAG · tools         cloud provider APIs
                                          │
                                          ├─ second brain  (local vector index of your vault)
                                          ├─ MCP bridge    (your tools, read‑safe by default)
                                          └─ artifacts      (mermaid / chart / svg / html)
```

- **Backend** — a Flask app proxying to a local Ollama server, with second‑brain retrieval, an MCP tool bridge, and the shared‑document engine.
- **Frontend** — a single glassy SPA (vanilla JS + CSS, no framework), light/dark themes, accent presets.
- **Private** — chats, models, and config live on your machine; cloud keys stay in a gitignored local config and are never committed.

## 🔐 A note on privacy

Local models are fully offline and free. When you connect a cloud key, only the messages you send to *that* model leave your machine — and your vault's `private/` notes are **structurally excluded** from any cloud‑bound prompt, so personal information can't leak even by accident.

---

<div align="center">
<sub>Built for people who want the power of many models without giving up their privacy.</sub>
</div>
