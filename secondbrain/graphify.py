#!/usr/bin/env python3
"""skippy-rag graphify — build a wikilink knowledge graph from the vault.

Writes graphify-out/graph.json next to this script, in the node-link shape the app's
/api/graph reads:
  nodes: [{id, label, community, source_file}]   (source_file relative to wiki/)
  links: [{source, target, relation, confidence_score}]

Nodes are sorted by degree (most-connected first) so the app's compact graph shows
the real hubs. Edges come from Obsidian [[wikilinks]] (aliases/headers stripped).
"""
from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "graphify-out")
VAULT = os.environ.get(
    "LLS_VAULT_ROOT",
    "~/Obsidian",
)
WIKI = os.path.join(VAULT, "wiki")
WIKILINK = re.compile(r"\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]")


def read(path: str) -> str:
    with open(path, encoding="utf-8", errors="ignore") as f:
        return f.read()


def title_of(text: str, stem: str) -> str:
    m = re.match(r"^---\n(.*?)\n---", text, re.S)
    if m:
        tm = re.search(r"^title:\s*(.+)$", m.group(1), re.M)
        if tm:
            return tm.group(1).strip()
    return stem


def main() -> None:
    wiki_real = os.path.realpath(WIKI)
    info: dict[str, dict] = {}     # path -> record
    by_stem: dict[str, str] = {}   # stem -> first path
    for root, _dirs, files in os.walk(VAULT):
        for fn in files:
            if not fn.endswith(".md"):
                continue
            p = os.path.join(root, fn)
            stem = os.path.splitext(fn)[0]
            text = read(p)
            rel_vault = os.path.relpath(p, VAULT)
            community = rel_vault.split(os.sep)[0] if os.sep in rel_vault else "root"
            in_wiki = os.path.realpath(p).startswith(wiki_real + os.sep)
            info[p] = {
                "stem": stem,
                "title": title_of(text, stem)[:48],
                "text": text,
                "community": community,
                "source_file": os.path.relpath(p, WIKI) if in_wiki else "",
            }
            by_stem.setdefault(stem, p)

    comms = sorted({r["community"] for r in info.values()})
    comm_idx = {c: i for i, c in enumerate(comms)}

    links: list[dict] = []
    deg: dict[str, int] = {}
    seen_edges: set[tuple[str, str]] = set()
    for p, r in info.items():
        for m in WIKILINK.finditer(r["text"]):
            target = m.group(1).strip()
            tp = by_stem.get(target) or by_stem.get(os.path.splitext(target)[0])
            if not tp or tp == p:
                continue
            s, t = r["stem"], info[tp]["stem"]
            if s == t or (s, t) in seen_edges:
                continue
            seen_edges.add((s, t))
            links.append({"source": s, "target": t, "relation": "links to", "confidence_score": 1})
            deg[s] = deg.get(s, 0) + 1
            deg[t] = deg.get(t, 0) + 1

    best: dict[str, dict] = {}
    for r in info.values():
        node = {
            "id": r["stem"],
            "label": r["title"],
            "community": comm_idx[r["community"]],
            "source_file": r["source_file"],
            "_deg": deg.get(r["stem"], 0),
        }
        if r["stem"] not in best or node["_deg"] > best[r["stem"]]["_deg"]:
            best[r["stem"]] = node
    nodes = sorted(best.values(), key=lambda n: -n["_deg"])
    for n in nodes:
        n.pop("_deg", None)

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "graph.json"), "w", encoding="utf-8") as f:
        json.dump({"nodes": nodes, "links": links}, f)
    print(f"graph: {len(nodes)} nodes, {len(links)} links -> {OUT_DIR}/graph.json", file=sys.stderr)


if __name__ == "__main__":
    main()
