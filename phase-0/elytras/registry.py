"""Registre des serveurs MCP (BYO — chaque utilisateur enregistre les siens).

Sources : serveur d'EXEMPLE (env EXAMPLE_MCP_URL) + base `mcp_server` si Postgres,
sinon repli FICHIER (`filestore`) pour marcher sans base.
"""
from __future__ import annotations

import os
import uuid

from . import filestore


def example_server() -> dict | None:
    url = os.environ.get("EXAMPLE_MCP_URL")
    if not url:
        return None
    # Démo : accès réservé aux admins par défaut (les rôles restreints ne le voient pas).
    # Un admin peut l'ouvrir à des équipes via « Accès… ».
    cfg = filestore.items("mcp_access").get("example") or {}
    return {"id": "example", "name": "Example CRM (serveur MCP de démo)", "transport": "http",
            "url": url, "auth_type": "none", "enabled": True, "source": "env",
            "allow_all": cfg.get("allow_all", False), "allowed_teams": cfg.get("allowed_teams", []),
            "conn_scope": "shared", "owner_id": None}


def list_servers(conn=None, tenant_id=None) -> list[dict]:
    servers: list[dict] = []
    ex = example_server()
    if ex:
        servers.append(ex)
    if conn is not None:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT id, name, transport, url, auth_type, enabled, secret_enc "
                            "FROM mcp_server WHERE enabled = true ORDER BY created_at")
                for r in cur.fetchall():
                    servers.append({"id": str(r[0]), "name": r[1], "transport": r[2], "url": r[3],
                                    "auth_type": r[4], "enabled": r[5], "secret_enc": r[6], "source": "db"})
        except Exception:
            pass
    else:  # repli fichier (mode sans base)
        for sid, s in filestore.items("mcp_servers").items():
            servers.append({"id": sid, "name": s.get("name"), "transport": "http", "url": s.get("url"),
                            "auth_type": s.get("auth_type", "auto"), "enabled": True, "source": "file",
                            "allow_all": s.get("allow_all", False), "allowed_teams": s.get("allowed_teams", []),
                            "conn_scope": s.get("conn_scope", "shared"), "owner_id": s.get("owner_id")})
    return servers


def add_server_file(name: str, url: str, auth_type: str = "auto", owner_id=None,
                    conn_scope: str = "shared") -> str:
    sid = str(uuid.uuid4())
    filestore.put("mcp_servers", sid, {"name": name, "url": url, "auth_type": auth_type,
                                       "allow_all": False, "allowed_teams": [],
                                       "conn_scope": "personal" if conn_scope == "personal" else "shared",
                                       "owner_id": owner_id})
    return sid


def set_server_access_file(server_id: str, allow_all=None, allowed_teams=None, conn_scope=None) -> bool:
    s = filestore.items("mcp_servers").get(server_id)
    if not s:
        # serveur hors fichier (ex. démo via env) → surcharge d'accès stockée à part
        cfg = filestore.items("mcp_access").get(server_id) or {}
        if allow_all is not None:
            cfg["allow_all"] = bool(allow_all)
        if allowed_teams is not None:
            cfg["allowed_teams"] = allowed_teams
        filestore.put("mcp_access", server_id, cfg)
        return True
    if allow_all is not None:
        s["allow_all"] = bool(allow_all)
    if allowed_teams is not None:
        s["allowed_teams"] = allowed_teams
    if conn_scope in ("shared", "personal"):
        s["conn_scope"] = conn_scope
    filestore.put("mcp_servers", server_id, s)
    return True


def set_server_auth_file(server_id: str, auth_type: str):
    s = filestore.items("mcp_servers").get(server_id)
    if s:
        s["auth_type"] = auth_type
        filestore.put("mcp_servers", server_id, s)


def update_server_file(server_id: str, name=None, url=None, auth_type=None) -> bool:
    s = filestore.items("mcp_servers").get(server_id)
    if not s:
        return False
    if name is not None:
        s["name"] = name
    if url is not None:
        s["url"] = url
    if auth_type is not None:
        s["auth_type"] = auth_type
    filestore.put("mcp_servers", server_id, s)
    return True


def delete_server_file(server_id: str) -> bool:
    return filestore.delete("mcp_servers", server_id)


def get_server(conn, server_id: str) -> dict | None:
    for s in list_servers(conn):
        if s["id"] == server_id or s["name"] == server_id:
            return s
    return None
