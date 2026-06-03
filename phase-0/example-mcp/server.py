"""Serveur MCP d'EXEMPLE (démo CRM) — SUPPRIMABLE.

Il existe seulement pour prouver que le cœur d'Elytras est agnostique :
toute la logique métier vit ICI, pas dans le cœur. Remplace-le par un vrai
serveur MCP (Shopify, Odoo, Gmail…) exposant les mêmes `tools` et rien ne
change côté Elytras.

Sous-ensemble HTTP/JSON-RPC du protocole MCP (initialize / tools/list / tools/call).
"""
from __future__ import annotations

import datetime as dt

from fastapi import FastAPI, Request

app = FastAPI(title="Example MCP server (CRM démo)")

TOOLS = [
    {
        "name": "list_inactive_customers",
        "description": "Clients sans commande depuis plus de `days` jours.",
        "inputSchema": {
            "type": "object",
            "properties": {"days": {"type": "integer", "default": 90}},
        },
    },
    {
        "name": "echo",
        "description": "Renvoie le texte fourni (test de connectivité).",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
]

# Données de démo (vivent dans le serveur, pas dans le cœur)
_CUSTOMERS = [
    {"name": "Alice Martin",   "email": "alice@example.fr", "last_order_at": "2025-01-10T10:00:00Z", "orders_count": 3, "total_spent": "240.00"},
    {"name": "Bruno Lefevre",  "email": "bruno@example.fr", "last_order_at": "2026-05-01T10:00:00Z", "orders_count": 1, "total_spent": "30.00"},
    {"name": "Chloe Da Silva", "email": "chloe@example.fr", "last_order_at": "2024-11-20T10:00:00Z", "orders_count": 5, "total_spent": "510.00"},
    {"name": "David Nguyen",   "email": "david@example.fr", "last_order_at": None,                    "orders_count": 0, "total_spent": "0.00"},
]


def _days_since(iso: str | None) -> int | None:
    if not iso:
        return None
    try:
        d = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (dt.datetime.now(dt.timezone.utc) - d).days


def _list_inactive(days: int) -> dict:
    out = []
    for c in _CUSTOMERS:
        n = _days_since(c["last_order_at"])
        if n is None or n > days:
            out.append({**c, "days_inactive": n})
    out.sort(key=lambda x: 10**9 if x["days_inactive"] is None else x["days_inactive"], reverse=True)
    return {"as_of": dt.date.today().isoformat(), "threshold_days": days,
            "count": len(out), "clients": out}


def _ok(pid, result):
    return {"jsonrpc": "2.0", "id": pid, "result": result}


def _err(pid, msg, code=-32601):
    return {"jsonrpc": "2.0", "id": pid, "error": {"code": code, "message": msg}}


@app.post("/")
async def rpc(req: Request):
    m = await req.json()
    method, pid, params = m.get("method"), m.get("id"), (m.get("params") or {})
    if method == "initialize":
        return _ok(pid, {"serverInfo": {"name": "example-crm", "version": "0.1"},
                         "capabilities": {"tools": {}}})
    if method == "tools/list":
        return _ok(pid, {"tools": TOOLS})
    if method == "tools/call":
        name, args = params.get("name"), (params.get("arguments") or {})
        if name == "list_inactive_customers":
            data = _list_inactive(int(args.get("days", 90)))
        elif name == "echo":
            data = {"text": args.get("text", "")}
        else:
            return _err(pid, f"outil inconnu : {name}")
        return _ok(pid, {"content": [{"type": "text", "text": str(data)}], "data": data})
    return _err(pid, f"méthode inconnue : {method}")


@app.get("/health")
def health():
    return {"status": "ok", "tools": [t["name"] for t in TOOLS]}
