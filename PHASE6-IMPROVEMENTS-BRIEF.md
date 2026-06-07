# Local LLM Studio — Phase 6 Improvements Brief

**Goal:** evolve LLS from a multi-model *chat + knowledge* studio into something closer to
**Claude Code desktop** — a project-rooted, agentic assistant that *acts* (edits code with
approval, runs commands, plans multi-step work, remembers sessions) — and make every
capability **available to all models**, local and cloud, tool-native or not.

## Cross-cutting architecture (built once, used by many features)

### A. Project root + path-jailed filesystem API  ✅ shipped (slice 1)
A settable working directory the agent operates in. All file access resolves through a
realpath jail that refuses to escape the root. Read-only endpoints:
`GET /api/project`, `POST /api/project`, `GET /api/fs/tree`, `GET /api/fs/read`,
`GET /api/fs/search`. Default root = the gitignored `workspace/` sandbox.

### B. Unified tool protocol for ALL models  (slice 2)
Tool-native models (Claude/GPT/Gemini/qwen3/gemma4) use their native tool-calling.
**Non-tool models (e.g. Gemma 3)** drive the agent via a **text protocol**: the model
emits a fenced ` ```tool ` block (`{"name": "...", "args": {...}}`); the server parses it,
runs it through the SAME approval + permission layer, and feeds the result back as a
synthetic turn. One executor (`_execute_tool`) serves both paths, so a feature added once
works everywhere.

### C. Permission + approval layer  (slice 2, safety-critical — default-DENY)
Every **write or exec** action is gated:
- An **approval card** streams to the UI (reuse the `draft_imessage` → `confirm_send`
  pattern); nothing applies until the user clicks **Approve**.
- A **permissions store** (per project, persisted) supports **allow-once / always-allow /
  deny**, keyed by (tool, scope).
- All paths are **jailed to the project root**; a **default-deny destructive list**
  (`rm -rf`, `git push --force`, `:(){:|:&};:`, writes outside root, etc.) blocks the
  obvious foot-guns even if approved by accident.
- **Exec-for-local-models stays OFF by default** until the user explicitly enables it.

---

## The 10 features

1. **Project root + file-tree sidebar** — open a folder; left-hand tree (skips
   `.git/node_modules/__pycache__`); file tools scoped to it. *(Backend ✅ slice 1; UI next.)*
2. **Diff-preview + approval before writes** — intercept `write_file`/`edit_block`, render a
   unified diff card, apply only on Approve. Depends on (C).
3. **Gated `run_command` with streamed output** — a shell tool behind (C); stdout/stderr
   streamed over NDJSON; destructive patterns default-denied; OFF for local models until enabled.
4. **Permissions model** — the (C) layer with allow-once/always/deny UI + persisted store.
5. **Server-side, resumable sessions** — SQLite (or JSON-per-session) store; `/api/sessions`
   list/load/resume/search; survives `localStorage` clears; reopen Arena panes.
6. **Visible plan / todo for multi-step tasks** — model emits a ` ```plan ` block → live
   checklist with check-offs as steps complete; loop runs against the plan (bounded by Stop).
7. **Checkpoint & revert** — auto git snapshot before an edit batch; one-click Revert. Builds on (2).
8. **`@file` mentions** — `@`-autocomplete in the prompt bar (mirror the `/`-command UI at
   app.js:688) backed by `/api/fs/search`; injects file contents as context. Depends on (A).
9. **Inline diff & syntax-highlighted file viewer** — render `edit_block` changes as colored
   diffs; a highlighted file pane (reuse the pen viewer + vendored `highlight-mini.js`).
10. **Image input + context auto-compaction** — paste/drop a screenshot (wire image parts into
    Ollama/cloud payloads; vision-gated like tools); summarize older turns instead of silently
    truncating at `num_ctx`.

## Build sequence (safety-ordered)
1. **Foundation:** (A) files API ✅ → file-tree UI (#1) + `@file` (#8).
2. **Agentic core:** (C) permissions → (2) diff+approval → (3) run_command → (7) checkpoints →
   (B) all-models tool protocol.
3. **Durability/polish:** (5) sessions, (9) diff viewer, (6) plan/todo, (10) images + compaction.

## Verification
Each slice: `python -m py_compile app.py`, restart worker, curl/UI smoke test, commit.
End-to-end gate: a non-tool model (Gemma 3) completes an approval-gated file edit via the
text protocol, and a tool-native model does the same via native tool-calling.

## Notes
- `config.local.json` (API keys) stays gitignored and out of every commit.
- Exec + write-to-local-models ship **disabled by default**; the user flips them on after review.
