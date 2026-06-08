#!/usr/bin/env python3
"""skippy-rag — query the local vault index.

Contract expected by Local LLM Studio (_retrieve_context):
  python query.py "<query text>" --top-k N
  -> prints one line per hit:  <cosine_score>\t<absolute_path_to_note.md>
     (highest score first). Scores are cosine similarity in [0,1].

Pure stdlib + Ollama's nomic-embed-text (no numpy needed). Degrades to silence
(no output) if the index or Ollama is unavailable, so the chat just proceeds
ungrounded.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, "index.json")
OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.environ.get("LLS_RAG_MODEL", "nomic-embed-text")


def embed(text: str) -> list[float]:
    body = json.dumps({"model": MODEL, "prompt": text}).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA + "/api/embeddings", data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        v = json.load(r)["embedding"]
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]  # normalized -> cosine == dot product


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--top-k", type=int, default=5)
    args = ap.parse_args()

    if not os.path.exists(INDEX):
        return
    try:
        with open(INDEX, encoding="utf-8") as f:
            idx = json.load(f)
        q = embed(args.query)
    except Exception:
        return

    scored: list[tuple[float, str]] = []
    for rec in idx:
        best = -1.0
        for e in rec.get("embeddings") or ():
            s = 0.0
            for a, b in zip(q, e):
                s += a * b
            if s > best:
                best = s
        if best > -1.0:
            scored.append((best, rec["path"]))

    scored.sort(reverse=True)
    for score, path in scored[: args.top_k]:
        sys.stdout.write(f"{score:.4f}\t{path}\n")


if __name__ == "__main__":
    main()
