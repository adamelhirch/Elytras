"""Registre d'agents (l'orchestre). En mode fichier.

Un agent = {name, role, instructions, autonomy}. L'orchestrateur peut déléguer à des
agents spécialisés (outil `delegate`, voir main.run_agent). Agents par défaut + ceux
créés par l'utilisateur (filestore "agents").
"""
from __future__ import annotations

import uuid

from . import filestore

DEFAULTS = {
    "orchestrateur": {
        "name": "Orchestrateur", "role": "superviseur",
        "instructions": ("Tu es l'orchestrateur d'Elytras. Comprends l'objectif de l'utilisateur. "
                         "Si une partie relève d'un agent spécialisé, délègue-la avec delegate(agent, tâche) "
                         "et agrège les résultats. Sinon, réponds toi-même. Sois clair et concis."),
        "autonomy": "ask"},
    "support": {
        "name": "Support", "role": "support client",
        "instructions": ("Tu es l'agent Support d'Elytras. Tu traites les demandes clients (emails, "
                         "réclamations, statut de commande) en t'appuyant sur les outils MCP et les skills."),
        "autonomy": "ask"},
    "ventes": {
        "name": "Ventes/CRM", "role": "ventes",
        "instructions": ("Tu es l'agent Ventes/CRM d'Elytras. Tu gères clients, commandes et relances "
                         "via les outils MCP et les skills disponibles."),
        "autonomy": "ask"},
}


def _all() -> dict:
    out = {k: {"id": k, **v, "builtin": True} for k, v in DEFAULTS.items()}
    for aid, o in filestore.items("agent_overrides").items():   # surcharges des builtins (autonomie, bot…)
        if aid in out:
            out[aid].update(o)
    for aid, a in filestore.items("agents").items():
        out[aid] = {"id": aid, **a, "builtin": False}
    return out


def list_agents() -> list[dict]:
    res = []
    for a in _all().values():
        a = dict(a)
        a["has_bot"] = bool(a.get("telegram_token"))   # ne JAMAIS exposer le token du bot
        a.pop("telegram_token", None)
        res.append(a)
    return res


def set_autonomy(aid: str, autonomy: str) -> bool:
    autonomy = "auto" if autonomy == "auto" else "ask"
    if aid in DEFAULTS:                                         # builtin : on stocke une surcharge
        filestore.put("agent_overrides", aid, {"autonomy": autonomy})
        return True
    a = filestore.items("agents").get(aid)
    if not a:
        return False
    a["autonomy"] = autonomy
    filestore.put("agents", aid, a)
    return True


def get_agent(id_or_name: str) -> dict | None:
    if not id_or_name:
        return None
    for a in _all().values():                  # interne : conserve telegram_token
        if a["id"] == id_or_name or a["name"].lower() == str(id_or_name).lower():
            return a
    return None


def set_telegram_token(aid: str, token: str | None) -> bool:
    token = (token or "").strip() or None
    if aid in DEFAULTS:
        ov = filestore.items("agent_overrides").get(aid) or {}
        ov["telegram_token"] = token
        filestore.put("agent_overrides", aid, ov)
        return True
    a = filestore.items("agents").get(aid)
    if not a:
        return False
    a["telegram_token"] = token
    filestore.put("agents", aid, a)
    return True


def create_agent(name: str, role: str = "", instructions: str = "", autonomy: str = "ask") -> str:
    aid = str(uuid.uuid4())
    filestore.put("agents", aid, {"name": name, "role": role,
                                  "instructions": instructions or f"Tu es l'agent {name}.",
                                  "autonomy": autonomy})
    return aid


def delete_agent(aid: str) -> bool:
    return filestore.delete("agents", aid)
