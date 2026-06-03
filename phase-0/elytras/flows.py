"""Flows (workflows) — moteur façon Windmill (OpenFlow simplifié).

Un flow = des entrées typées (schéma) + une suite de **modules**. Types de module :
- "agent"      : lance un agent IA sur un prompt,
- "tool"       : appelle un outil MCP avec des arguments,
- "code"       : exécute du Python inline (sous-processus isolé),
- "note"       : texte/jalon (sticky note),
- "forloop"    : itère des sous-modules sur une liste (expression d'itérateur),
- "branchone"  : exécute la 1re branche dont le prédicat est vrai (sinon défaut),
- "branchall"  : exécute toutes les branches,
- "whileloop"  : répète des sous-modules tant qu'une condition est vraie,
- "approval"   : suspend le flow en attendant une validation humaine (niveau racine).

Chaque module porte une config avancée (façon onglet « Advanced » de Windmill) :
retry, timeout, cache, mock (pin result), early-stop, skip, sleep, continue-on-error.

Les modules référencent les sorties via des expressions sur `flow_input`, `results`,
`item`/`index` (dans les boucles). Déclenchable manuellement, par webhook ou par planif.
Stockage fichier (filestore "flows").
"""
from __future__ import annotations

import secrets
import uuid

from . import filestore

LEAF_TYPES = ("agent", "tool", "code", "note")
CONTAINER_TYPES = ("forloop", "branchone", "branchall", "whileloop")
ALL_TYPES = LEAF_TYPES + CONTAINER_TYPES + ("approval",)


def new_module_id() -> str:
    return uuid.uuid4().hex[:8]


def _advanced_defaults() -> dict:
    return {
        "retry": {"attempts": 0, "delay_s": 2, "mode": "constant"},
        "timeout_s": 0,
        "cache_ttl": 0,
        "mock": {"enabled": False, "value": ""},
        "stop_after_if": {"enabled": False, "expr": ""},
        "skip_if": {"enabled": False, "expr": ""},
        "sleep_s": 0,
        "continue_on_error": False,
    }


def _normalize_module(m: dict) -> dict:
    """Garantit id + champs avancés + sous-modules récursifs (rétro-compat 'steps')."""
    if not m.get("id"):
        m["id"] = new_module_id()
    if not m.get("summary"):
        m["summary"] = m.get("name") or m.get("type") or "étape"
    for k, v in _advanced_defaults().items():
        m.setdefault(k, v)
    t = m.get("type")
    if t == "forloop":
        m.setdefault("iterator", "")
        m.setdefault("parallel", False)
        m["modules"] = [_normalize_module(x) for x in (m.get("modules") or [])]
    elif t == "whileloop":
        m.setdefault("condition", "")
        m.setdefault("max_iter", 100)
        m["modules"] = [_normalize_module(x) for x in (m.get("modules") or [])]
    elif t == "branchone":
        m["branches"] = [{"summary": b.get("summary", "branche"), "expr": b.get("expr", ""),
                          "modules": [_normalize_module(x) for x in (b.get("modules") or [])]}
                         for b in (m.get("branches") or [])]
        m["default_modules"] = [_normalize_module(x) for x in (m.get("default_modules") or [])]
    elif t == "branchall":
        m.setdefault("parallel", False)
        m["branches"] = [{"summary": b.get("summary", "branche"),
                          "modules": [_normalize_module(x) for x in (b.get("modules") or [])]}
                         for b in (m.get("branches") or [])]
    elif t == "agent":
        m.setdefault("agent_id", "orchestrateur")
        m.setdefault("prompt", "")
    elif t == "tool":
        m.setdefault("server_id", "")
        m.setdefault("tool", "")
        m.setdefault("args", {})
    elif t == "code":
        m.setdefault("language", "python")
        m.setdefault("content", "result = None")
    elif t == "note":
        m.setdefault("text", "")
    elif t == "approval":
        m.setdefault("message", "Validation requise pour continuer.")
        m.setdefault("approvers", [])
    return m


def _normalize(f: dict) -> dict:
    # rétro-compat : ancien champ "steps" → "modules"
    if "modules" not in f and "steps" in f:
        f["modules"] = f.pop("steps")
    f.setdefault("modules", [])
    f.setdefault("inputs", [])
    f.setdefault("summary", "")
    f.setdefault("description", "")
    f.setdefault("ui", {"pos": {}})
    f.setdefault("webhook_token", None)
    f["modules"] = [_normalize_module(m) for m in f["modules"]]
    # normalise le schéma d'entrées
    norm_inputs = []
    for it in f["inputs"]:
        if isinstance(it, str):
            it = {"name": it, "type": "string"}
        it.setdefault("type", "string")
        it.setdefault("required", False)
        it.setdefault("default", "")
        if it["type"] == "select":
            it.setdefault("options", [])
        norm_inputs.append(it)
    f["inputs"] = norm_inputs
    return f


def list_flows(user_id, project_ids=None) -> list[dict]:
    out = []
    for fid, f in filestore.items("flows").items():
        if f.get("owner_id") == user_id or f.get("project_id") in (project_ids or []):
            out.append({"id": fid, "name": f.get("name"), "scope": f.get("scope"),
                        "project_id": f.get("project_id"), "owner_id": f.get("owner_id"),
                        "modules": f.get("modules") or f.get("steps") or [],
                        "inputs": f.get("inputs") or [], "summary": f.get("summary", ""),
                        "webhook_token": f.get("webhook_token")})
    return out


def get_flow(fid: str) -> dict | None:
    f = filestore.items("flows").get(fid)
    return _normalize({"id": fid, **f}) if f else None


def create_flow(owner_id, name, scope="perso", project_id=None) -> str:
    fid = str(uuid.uuid4())
    filestore.put("flows", fid, _normalize({
        "name": name or "Nouveau flow", "scope": scope, "project_id": project_id,
        "owner_id": owner_id,
    }))
    return fid


def update_flow(fid, **fields) -> bool:
    f = filestore.items("flows").get(fid)
    if not f:
        return False
    for k in ("name", "summary", "description", "inputs", "modules", "ui", "scope", "project_id"):
        if k in fields and fields[k] is not None:
            f[k] = fields[k]
    if "modules" in fields and fields["modules"] is not None:
        f.pop("steps", None)  # purge l'ancien champ
    filestore.put("flows", fid, _normalize(f))
    return True


def delete_flow(fid) -> bool:
    return filestore.delete("flows", fid)


def ensure_webhook_token(fid) -> str | None:
    f = filestore.items("flows").get(fid)
    if not f:
        return None
    if not f.get("webhook_token"):
        f["webhook_token"] = secrets.token_urlsafe(12)
        filestore.put("flows", fid, f)
    return f["webhook_token"]


def find_by_webhook(fid, token) -> dict | None:
    f = get_flow(fid)
    if f and token and f.get("webhook_token") == token:
        return f
    return None
