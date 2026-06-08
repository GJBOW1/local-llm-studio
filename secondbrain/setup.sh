#!/usr/bin/env bash
# Recreate the local second-brain RAG index that Local LLM Studio reads.
#
# The app shells out to ~/skippy-rag (RAG_DIR) for vault retrieval. If that folder
# is ever lost, run this to rebuild it from the version-controlled scripts here and
# re-index your Obsidian vault. Requires Ollama running with nomic-embed-text pulled.
#
#   bash secondbrain/setup.sh
#   LLS_VAULT_ROOT="/path/to/vault" bash secondbrain/setup.sh   # custom vault
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RAG_DIR="${LLS_RAG_DIR:-$HOME/skippy-rag}"

echo "==> Ensuring nomic-embed-text is available"
if ! curl -sf -m 5 http://127.0.0.1:11434/api/tags | grep -q nomic-embed-text; then
  echo "   pulling nomic-embed-text …"; ollama pull nomic-embed-text
fi

echo "==> Installing scripts into $RAG_DIR"
mkdir -p "$RAG_DIR"
cp "$HERE/query.py" "$HERE/build.py" "$RAG_DIR/"
[ -x "$RAG_DIR/.venv/bin/python" ] || python3 -m venv "$RAG_DIR/.venv"

echo "==> Building the index (embeds every vault note; a few minutes)"
"$RAG_DIR/.venv/bin/python" "$RAG_DIR/build.py"

echo "==> Done. Verify:"
echo "   curl -s http://127.0.0.1:5050/api/secondbrain/health"
echo "   (expect available:true, notes:>0). Re-run this script anytime to reindex."
