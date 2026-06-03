"""Client MCP générique (Streamable HTTP / JSON-RPC).

Le cœur d'Elytras ne connaît AUCUNE intégration : il parle à n'importe quel serveur
MCP via `initialize` puis `tools/list` / `tools/call`. Gère :
- l'auth Bearer (statique ou OAuth, injectée par l'app via server["token"]),
- le handshake `initialize` + l'en-tête de session `Mcp-Session-Id`,
- les réponses JSON **ou** SSE (text/event-stream).
Brancher un nouveau système = enregistrer un serveur MCP, rien à coder ici.
"""
from __future__ import annotations

import itertools
import json

import httpx

_id = itertools.count(1)


class McpClient:
    def __init__(self, timeout: float = 60.0):
        self.timeout = timeout
        self._session: dict = {}   # url -> Mcp-Session-Id
        self._inited: set = set()  # urls déjà initialisés

    def _post(self, server: dict, payload: dict) -> dict | None:
        url = server["url"]
        headers = {"Content-Type": "application/json",
                   "Accept": "application/json, text/event-stream"}
        if server.get("token"):
            headers["Authorization"] = f"Bearer {server['token']}"
        if self._session.get(url):
            headers["Mcp-Session-Id"] = self._session[url]
        r = httpx.post(url, headers=headers, json=payload, timeout=self.timeout)
        sid = r.headers.get("mcp-session-id")
        if sid:
            self._session[url] = sid
        r.raise_for_status()
        if not payload.get("id"):       # notification : pas de réponse attendue
            return None
        ct = r.headers.get("content-type", "")
        if "text/event-stream" in ct:   # réponse SSE -> on prend le dernier objet "data:"
            out = None
            for line in r.text.splitlines():
                if line.startswith("data:"):
                    try:
                        out = json.loads(line[5:].strip())
                    except Exception:
                        pass
            return out or {}
        return r.json()

    def _ensure_init(self, server: dict):
        url = server["url"]
        if url in self._inited:
            return
        try:
            self._post(server, {"jsonrpc": "2.0", "id": next(_id), "method": "initialize",
                                "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                           "clientInfo": {"name": "elytras", "version": "0.1"}}})
            try:
                self._post(server, {"jsonrpc": "2.0", "method": "notifications/initialized"})
            except Exception:
                pass
        except Exception:
            pass  # certains serveurs simples n'exigent pas initialize
        self._inited.add(url)

    def _rpc(self, server: dict, method: str, params: dict | None = None) -> dict:
        self._ensure_init(server)
        d = self._post(server, {"jsonrpc": "2.0", "id": next(_id), "method": method, "params": params or {}}) or {}
        if d.get("error"):
            raise RuntimeError(d["error"])
        return d.get("result", {})

    def list_tools(self, server: dict) -> list[dict]:
        return self._rpc(server, "tools/list").get("tools", [])

    def call_tool(self, server: dict, name: str, arguments: dict | None = None) -> dict:
        return self._rpc(server, "tools/call", {"name": name, "arguments": arguments or {}})

    def forget(self, url: str):
        """Oublie la session/cache d'un serveur (après suppression ou changement d'URL/token)."""
        self._session.pop(url, None)
        self._inited.discard(url)
