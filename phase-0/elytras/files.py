"""Espace de fichiers scopé (perso / projet) — mode fichier, sans base.

Cloisonnement identique à la mémoire et aux sessions : un fichier « perso » n'est
visible que par son propriétaire ; un fichier « projet » par les membres du projet.
Contenu stocké en base64 dans le filestore (limite de taille — phase 0).
"""
from __future__ import annotations

import base64
import time
import uuid

from . import filestore

MAX_BYTES = 1_000_000   # 1 Mo (phase 0 : contenu en base64 dans l'état fichier)
_META = ("name", "scope", "project_id", "owner_id", "size", "mime", "created_at")


def _accessible(f: dict, user_id: str, project_ids) -> bool:
    if f.get("scope") == "projet":
        return f.get("project_id") in (project_ids or [])
    return f.get("owner_id") == user_id


def list_files(user_id: str, project_ids=None) -> list[dict]:
    out = []
    for fid, f in filestore.items("files").items():
        if _accessible(f, user_id, project_ids):
            out.append({"id": fid, **{k: f.get(k) for k in _META}})
    out.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return out


def add_file(scope: str, owner_id, project_id, name: str, data_b64: str,
             mime: str = "application/octet-stream") -> str:
    raw = base64.b64decode((data_b64 or "").encode())
    if len(raw) > MAX_BYTES:
        raise ValueError(f"fichier trop volumineux (> {MAX_BYTES // 1000} Ko)")
    scope = "projet" if scope == "projet" else "perso"
    fid = str(uuid.uuid4())
    filestore.put("files", fid, {"name": name or "fichier", "scope": scope,
                                 "project_id": project_id if scope == "projet" else None,
                                 "owner_id": None if scope == "projet" else owner_id,
                                 "size": len(raw), "mime": mime, "created_at": time.time(),
                                 "b64": data_b64})
    return fid


def get_file(fid: str, user_id: str, project_ids=None) -> dict | None:
    f = filestore.items("files").get(fid)
    if not f or not _accessible(f, user_id, project_ids):
        return None
    return {"id": fid, **f}


def get_by_name(name: str, user_id: str, project_ids=None) -> dict | None:
    for fid, f in filestore.items("files").items():
        if f.get("name") == name and _accessible(f, user_id, project_ids):
            return {"id": fid, **f}
    return None


def text_of(f: dict) -> str:
    try:
        return base64.b64decode((f.get("b64") or "").encode()).decode("utf-8", "replace")
    except Exception:
        return ""


def delete_file(fid: str, user_id: str, project_ids=None) -> bool:
    f = filestore.items("files").get(fid)
    if not f or not _accessible(f, user_id, project_ids):
        return False
    return filestore.delete("files", fid)
