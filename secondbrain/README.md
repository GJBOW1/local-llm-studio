# Second brain (vault RAG)

Local LLM Studio grounds chats in your Obsidian vault by shelling out to a tiny
local index at **`~/skippy-rag`** (configurable via `LLS_RAG_DIR`). The app calls
`query.py` for each message; relevant notes (cosine ≥ `LLS_RAG_MIN_SCORE`, default
0.6) are injected into the prompt. Private notes (`vault/private/`) are retrieved for
**local** models but never for **cloud** models (a structural PII guard).

These scripts are version-controlled here so the index is **recoverable** — the
`~/skippy-rag` folder itself is machine-local data, not in git.

## Rebuild / reindex
```bash
bash secondbrain/setup.sh          # recreate ~/skippy-rag + reindex the vault
```
Run it after adding/editing a lot of notes, or if the index is ever lost.

## Pieces
- `build.py` — walks `LLS_VAULT_ROOT` for `.md`, chunks + embeds each note with
  Ollama's `nomic-embed-text`, writes `index.json`.
- `query.py` — embeds a query, scores notes by best chunk cosine, prints
  `score⇥/abs/path.md` (the contract the app's `_retrieve_context` parses).
- `setup.sh` — installs both into `~/skippy-rag`, makes the venv, builds the index.

## Config (env or `config.local.json`)
| Var | Default | Meaning |
|---|---|---|
| `LLS_VAULT_ROOT` | `…/the user/Bobiverse` | the vault to index |
| `LLS_RAG_DIR` | `~/skippy-rag` | where the index/scripts live |
| `LLS_RAG_MIN_SCORE` | `0.6` | retrieval threshold (higher = stricter) |
| `LLS_RAG_TOP_K` | `5` | notes considered per message |

The knowledge-graph tab additionally reads `~/skippy-rag/graphify-out/graph.json`
(not rebuilt here); without it the graph shows an honest empty state.
