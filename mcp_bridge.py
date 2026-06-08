"""A tiny, read-only MCP host for Local LLM Studio.

Speaks MCP over stdio (newline-delimited JSON-RPC) to one or more local MCP
servers listed in mcp_servers.json, lists their tools, and lets the chat route
call them. Two hard rules keep this safe to wire to an autonomous local model:

  1. READ-ONLY by default — only tools whose names start with a READ prefix are
     ever exposed or callable. Every create/update/delete/set/send/... tool is
     filtered out, so the model cannot mutate anything (e.g. your finances).
  2. No credentials here — auth lives inside each server (the Monarch session is
     reused from however you authenticated it). This module never sees secrets.

Run standalone to test:  python mcp_bridge.py --list
                         python mcp_bridge.py --call get_net_worth '{}'
"""
from __future__ import annotations

import json
import os
import select
import subprocess
import threading
from typing import Any

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mcp_servers.json")
PROTOCOL_VERSION = "2024-11-05"
RPC_TIMEOUT = 30.0  # seconds to wait for a single JSON-RPC response

# A tool is exposed only if its name starts with one of these — default-deny, so
# an unknown or mutating tool is never reachable by the model.
READ_PREFIXES: tuple[str, ...] = (
    "get", "list", "search", "check", "read", "describe", "find", "query", "summarize",
)


def _is_read_only(tool_name: str) -> bool:
    n = tool_name.lower()
    return any(n.startswith(p) for p in READ_PREFIXES)


class MCPServer:
    """One stdio MCP server, kept alive across calls. All I/O is lock-guarded."""

    def __init__(self, name: str, command: str, args: list[str],
                 allowed_tools: set[str] | None = None, env: dict[str, str] | None = None):
        self.name = name
        self.command = command
        self.args = args
        # allowed_tools: explicit whitelist (e.g. file read/create/edit for Desktop
        # Commander — never exec/delete). None ⇒ default read-only-by-prefix.
        self.allowed_tools = allowed_tools
        self.env = env
        self.proc: subprocess.Popen | None = None
        self.tools: list[dict[str, Any]] = []  # only tools that pass _allowed()
        self.all_tools: list[dict[str, Any]] = []  # every advertised tool (for privileged lookup)
        self._id = 0
        self._lock = threading.Lock()
        self._failed = False

    def _allowed(self, name: str) -> bool:
        if self.allowed_tools is not None:
            return name in self.allowed_tools
        return _is_read_only(name)

    # -- framing helpers --------------------------------------------------
    def _write(self, msg: dict[str, Any]) -> None:
        assert self.proc and self.proc.stdin
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def _read_until(self, want_id: int) -> dict[str, Any]:
        """Read JSON-RPC lines until the response with id == want_id; skip
        notifications and noise. Raises on timeout / dead process."""
        assert self.proc and self.proc.stdout
        while True:
            ready, _, _ = select.select([self.proc.stdout], [], [], RPC_TIMEOUT)
            if not ready:
                raise TimeoutError(f"{self.name}: no response in {RPC_TIMEOUT}s")
            line = self.proc.stdout.readline()
            if line == "":
                raise RuntimeError(f"{self.name}: server closed the pipe")
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue  # stray non-JSON line
            if msg.get("id") == want_id:
                return msg

    def _request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self._id += 1
        rid = self._id
        self._write({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        msg = self._read_until(rid)
        if "error" in msg:
            raise RuntimeError(f"{method} error: {msg['error']}")
        return msg.get("result", {})

    # -- lifecycle --------------------------------------------------------
    def connect(self) -> None:
        """Spawn + handshake + load the read-only tool list. Idempotent."""
        with self._lock:
            if self.proc and self.proc.poll() is None:
                return
            self.proc = subprocess.Popen(
                [self.command, *self.args],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, text=True, bufsize=1,
                env={**os.environ, **(self.env or {})},
            )
            self._request("initialize", {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "local-llm-studio", "version": "1.0"},
            })
            self._write({"jsonrpc": "2.0", "method": "notifications/initialized"})
            result = self._request("tools/list")
            self.all_tools = result.get("tools", [])
            self.tools = [t for t in self.all_tools if self._allowed(t.get("name", ""))]

    def call_tool(self, name: str, arguments: dict[str, Any]) -> str:
        if not self._allowed(name):
            return f"Refused: '{name}' is not in this server's allow-list."
        return self.call_tool_unchecked(name, arguments)

    def call_tool_unchecked(self, name: str, arguments: dict[str, Any]) -> str:
        """Call a tool WITHOUT the allow-list gate. Reserved for explicit,
        user-confirmed actions invoked by a trusted server-side endpoint (never
        reachable by the model, which only ever sees read-only tools)."""
        with self._lock:
            if not (self.proc and self.proc.poll() is None):
                raise RuntimeError(f"{self.name} is not running")
            result = self._request("tools/call", {"name": name, "arguments": arguments or {}})
        parts = [c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"]
        text = "\n".join(p for p in parts if p)
        if result.get("isError"):
            return f"Tool error: {text or 'unknown'}"
        return text or "(no output)"

    def close(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


class MCPBridge:
    """Loads the config, connects enabled servers lazily, routes tool calls."""

    def __init__(self, config_path: str = CONFIG_PATH):
        self.config_path = config_path
        self.servers: list[MCPServer] = []
        self._tool_owner: dict[str, MCPServer] = {}
        self._ready = False
        self._lock = threading.Lock()

    def _ensure_ready(self) -> None:
        if self._ready:
            return
        with self._lock:
            if self._ready:
                return
            try:
                cfg = json.load(open(self.config_path, encoding="utf-8"))
            except (OSError, ValueError):
                self._ready = True
                return
            for spec in cfg.get("servers", []):
                if not spec.get("enabled", True):
                    continue
                allowed = spec.get("allowed_tools")
                srv = MCPServer(
                    spec["name"], spec["command"], spec.get("args", []),
                    allowed_tools=set(allowed) if allowed else None,
                    env=spec.get("env"),
                )
                try:
                    srv.connect()
                except Exception:
                    continue  # degrade silently: a dead server just offers no tools
                self.servers.append(srv)
                for tool in srv.tools:
                    self._tool_owner[tool["name"]] = srv
            self._ready = True

    def ollama_tools(self) -> list[dict[str, Any]]:
        """All read-only tools, in Ollama's function-tool schema."""
        self._ensure_ready()
        out = []
        for srv in self.servers:
            for tool in srv.tools:
                out.append({
                    "type": "function",
                    "function": {
                        "name": tool["name"],
                        "description": (tool.get("description") or "")[:1024],
                        "parameters": tool.get("inputSchema") or {"type": "object", "properties": {}},
                    },
                })
        return out

    def call(self, name: str, arguments: dict[str, Any]) -> str:
        self._ensure_ready()
        srv = self._tool_owner.get(name)
        if not srv:
            return f"Unknown or non-exposed tool: {name}"
        try:
            return srv.call_tool(name, arguments)
        except Exception as exc:
            return f"Tool call failed: {exc}"

    # -- iMessage send (confirmation-gated, user-initiated only) ----------
    def _imessage_server(self) -> MCPServer | None:
        self._ensure_ready()
        for srv in self.servers:
            if "imessage" in srv.name.lower():
                return srv
        return None

    def _imessage_send_tool(self, srv: MCPServer) -> dict[str, Any] | None:
        """Find the server's send tool from its full advertised list (the model
        never sees it, since it is filtered out of the read-only set)."""
        sends = [t for t in srv.all_tools if "send" in t.get("name", "").lower()]
        for t in sends:  # prefer an explicit iMessage sender
            if "imessage" in t["name"].lower() or "message" in t["name"].lower():
                return t
        return sends[0] if sends else None

    def imessage_available(self) -> bool:
        srv = self._imessage_server()
        return bool(srv and self._imessage_send_tool(srv))

    def send_imessage(self, recipient: str, message: str) -> str:
        """Send an iMessage via the iMessage server, mapping our (recipient,
        message) onto whatever the send tool's schema actually names its fields.
        ONLY called by the user-confirmed /api/imessage/send endpoint."""
        srv = self._imessage_server()
        if not srv:
            return "Tool error: no iMessage server is connected."
        tool = self._imessage_send_tool(srv)
        if not tool:
            return "Tool error: the iMessage server exposes no send tool."
        props = ((tool.get("inputSchema") or {}).get("properties") or {})
        keys = list(props.keys())

        def pick(patterns: tuple[str, ...], fallback: str) -> str:
            for k in keys:
                kl = k.lower()
                if any(p in kl for p in patterns):
                    return k
            return fallback

        to_key = pick(("recipient", "phone", "address", "number", "contact", "chat", "to"), "recipient")
        msg_key = pick(("message", "text", "body", "content"), "message")
        args = {to_key: recipient, msg_key: message}
        try:
            return srv.call_tool_unchecked(tool["name"], args)
        except Exception as exc:
            return f"Tool call failed: {exc}"

    def server_status(self) -> list[dict[str, Any]]:
        """Configured servers + live connection/tool info, for the Settings UI."""
        self._ensure_ready()
        try:
            cfg = json.load(open(self.config_path, encoding="utf-8"))
        except (OSError, ValueError):
            cfg = {"servers": []}
        live = {s.name: s for s in self.servers}
        out: list[dict[str, Any]] = []
        for spec in cfg.get("servers", []):
            srv = live.get(spec.get("name", ""))
            out.append({
                "name": spec.get("name", ""),
                "command": spec.get("command", ""),
                "args": spec.get("args", []),
                "enabled": spec.get("enabled", True),
                "connected": srv is not None,
                "tools": [t["name"] for t in srv.tools] if srv else [],
            })
        return out

    def reload(self) -> None:
        """Re-read the config and reconnect — after the user edits MCP settings."""
        with self._lock:
            try:
                self.close()
            except Exception:
                pass
            self.servers = []
            self._tool_owner = {}
            self._ready = False
        self._ensure_ready()

    def close(self) -> None:
        for srv in self.servers:
            srv.close()


if __name__ == "__main__":
    import sys

    bridge = MCPBridge()
    if len(sys.argv) >= 2 and sys.argv[1] == "--list":
        for t in bridge.ollama_tools():
            print(t["function"]["name"], "—", (t["function"]["description"] or "")[:70])
        print(f"\n{len(bridge.ollama_tools())} read-only tools exposed.")
    elif len(sys.argv) >= 3 and sys.argv[1] == "--call":
        args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
        print(bridge.call(sys.argv[2], args)[:1500])
    else:
        print("usage: mcp_bridge.py --list | --call <tool> '<json-args>'")
    bridge.close()
