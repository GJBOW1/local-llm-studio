#!/usr/bin/env python3
"""skippy-rag — (re)build index.json from the Obsidian vault.

Walks the vault for .md notes, chunks each, embeds the chunks with Ollama's
nomic-embed-text, and writes a normalized index that query.py scores against.

  python build.py               # index the default vault
  LLS_VAULT_ROOT=/path build.py  # override the vault

index.json shape:  [ {"path": "/abs/note.md", "chunks": N, "embeddings": [[...],...]}, ... ]
(len(index) == number of notes, which the app's health panel reports.)
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, "index.json")
VAULT = os.environ.get(
    "LLS_VAULT_ROOT",
    os.path.expanduser("~/Obsidian"),
)
OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.environ.get("LLS_RAG_MODEL", "nomic-embed-text")
CHUNK = 1200      # chars per chunk
OVERLAP = 150
MAX_CHUNKS = 8    # cap per note (keeps long notes from dominating the build)


def embed(text: str) -> list[float]:
    body = json.dumps({"model": MODEL, "prompt": text}).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA + "/api/embeddings", data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        v = json.load(r)["embedding"]
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def read_body(path: str) -> str:
    with open(path, encoding="utf-8", errors="ignore") as f:
        text = f.read()
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
    return (m.group(2) if m else text).strip()


def chunk(text: str) -> list[str]:
    text = re.sub(r"[ \t]+", " ", text)
    if len(text) <= CHUNK:
        return [text] if text.strip() else []
    out, i = [], 0
    while i < len(text) and len(out) < MAX_CHUNKS:
        out.append(text[i : i + CHUNK])
        i += CHUNK - OVERLAP
    return out


def main() -> None:
    md: list[str] = []
    for root, _dirs, files in os.walk(VAULT):
        for fn in files:
            if fn.endswith(".md"):
                md.append(os.path.join(root, fn))
    md.sort()
    print(f"vault: {VAULT}\nnotes: {len(md)}\nembedding with {MODEL} via {OLLAMA} …", file=sys.stderr)

    idx, t0 = [], time.time()
    for n, path in enumerate(md, 1):
        try:
            body = read_body(path)
        except OSError:
            continue
        embs = []
        for c in chunk(body):
            if c.strip():
                try:
                    embs.append(embed(c))
                except Exception as e:  # noqa: BLE001
                    print(f"  ! embed failed {os.path.basename(path)}: {e}", file=sys.stderr)
        if embs:
            idx.append({"path": os.path.abspath(path), "chunks": len(embs), "embeddings": embs})
        if n % 25 == 0:
            print(f"  {n}/{len(md)} notes ({len(idx)} indexed, {time.time()-t0:.0f}s)", file=sys.stderr)

    tmp = INDEX + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(idx, f)
    os.replace(tmp, INDEX)
    print(f"done: indexed {len(idx)} notes in {time.time()-t0:.0f}s -> {INDEX}", file=sys.stderr)


if __name__ == "__main__":
    main()
