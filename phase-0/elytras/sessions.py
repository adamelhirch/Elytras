"""Sessions de chat + projets (workspaces), en mode fichier.

Une session = une conversation. Deux portées :
- "perso"  : privée à l'utilisateur (owner).
- "projet" : partagée avec les membres d'un projet/workspace.
Statut : active | archived. L'accès est filtré par owner / membres de projet
(même logique de scopes que la mémoire — voir la vision §13/§14).
"""
from __future__ import annotations

import time
import uuid

from . import filestore


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


DEFAULT_USER = "00000000-0000-0000-0000-0000000000a1"


# ───────────────────────── Utilisateurs (mode test, sans auth réelle) ─────────────────────────
def list_users() -> list[dict]:
    users = {DEFAULT_USER: {"id": DEFAULT_USER, "name": "Léo"}}
    for uid, u in filestore.items("users").items():
        users[uid] = {"id": uid, "name": u.get("name") or uid[:6]}
    return list(users.values())


def create_user(name: str) -> str:
    uid = str(uuid.uuid4())
    filestore.put("users", uid, {"name": name})
    return uid


def add_member(user_id: str, project_id: str, member_id: str) -> bool:
    p = filestore.items("projects").get(project_id)
    if not p or not (p.get("owner_id") == user_id or user_id in p.get("members", [])):
        return False
    members = p.setdefault("members", [])
    if member_id not in members:
        members.append(member_id)
    filestore.put("projects", project_id, p)
    return True


# ───────────────────────── Projets / workspaces ─────────────────────────
def list_projects(user_id: str) -> list[dict]:
    out = []
    for pid, p in filestore.items("projects").items():
        if p.get("owner_id") == user_id or user_id in p.get("members", []):
            out.append({"id": pid, "name": p.get("name"), "owner_id": p.get("owner_id"),
                        "members": p.get("members", [])})
    return out


def create_project(user_id: str, name: str) -> str:
    pid = str(uuid.uuid4())
    filestore.put("projects", pid, {"name": name, "owner_id": user_id,
                                    "members": [user_id], "created_at": _now()})
    return pid


def _is_project_member(user_id: str, project_id: str | None) -> bool:
    if not project_id:
        return False
    p = filestore.items("projects").get(project_id)
    return bool(p) and (p.get("owner_id") == user_id or user_id in p.get("members", []))


# ───────────────────────── Sessions ─────────────────────────
def _accessible(s: dict, user_id: str) -> bool:
    if s.get("scope") == "projet":
        return _is_project_member(user_id, s.get("project_id"))
    return s.get("owner_id") == user_id


def list_sessions(user_id: str, include_archived: bool = False) -> list[dict]:
    out = []
    for sid, s in filestore.items("sessions").items():
        if not _accessible(s, user_id):
            continue
        if s.get("status") == "archived" and not include_archived:
            continue
        out.append({"id": sid, "title": s.get("title"), "scope": s.get("scope"),
                    "project_id": s.get("project_id"), "status": s.get("status", "active"),
                    "owner_id": s.get("owner_id"), "updated_at": s.get("updated_at"),
                    "count": len(s.get("messages", []))})
    out.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
    return out


def get_session(user_id: str, sid: str) -> dict | None:
    s = filestore.items("sessions").get(sid)
    if not s or not _accessible(s, user_id):
        return None
    return {**s, "id": sid}


def create_session(user_id: str, title: str = "Nouvelle session",
                   scope: str = "perso", project_id: str | None = None) -> str:
    if scope == "projet" and not _is_project_member(user_id, project_id):
        scope, project_id = "perso", None
    sid = str(uuid.uuid4())
    filestore.put("sessions", sid, {"title": title or "Nouvelle session", "scope": scope,
                                    "project_id": project_id, "owner_id": user_id, "status": "active",
                                    "created_at": _now(), "updated_at": _now(), "messages": []})
    return sid


def update_session(user_id: str, sid: str, **fields) -> bool:
    s = filestore.items("sessions").get(sid)
    if not s or not _accessible(s, user_id):
        return False
    for k in ("title", "status", "scope", "project_id", "messages"):
        if k in fields and fields[k] is not None:
            s[k] = fields[k]
    s["updated_at"] = _now()
    filestore.put("sessions", sid, s)
    return True


def delete_session(user_id: str, sid: str) -> bool:
    s = filestore.items("sessions").get(sid)
    if not s or not _accessible(s, user_id):
        return False
    return filestore.delete("sessions", sid)
