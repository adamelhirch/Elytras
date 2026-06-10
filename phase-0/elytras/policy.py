"""Sensibilité d'action + autonomie (ASK / AUTO) + POLICIES par rôle.

Règle (décidée avec Léo) : les actions READ passent direct ; les actions SENSIBLES
exigent une validation humaine SAUF si l'agent est en mode AUTO (opt-in).

Couche « policy » (vision sandbox d'agents) : à chaque RÔLE d'équipe on associe ce que
les agents pilotés par ce rôle peuvent faire — agents utilisables, serveurs MCP, skills,
familles d'outils (code/web/flows/fichiers/dispatch/délégation), scopes mémoire, autonomie.
C'est la FUSION en un seul objet de briques déjà existantes (caps RBAC, périmètre d'outils
par agent, accès MCP/skill par équipe, ASK/AUTO) — pas un système parallèle.

Sémantique (zéro régression par défaut) :
- aucune policy stockée pour un rôle → ce rôle est SANS restriction (comportement historique) ;
- listes (`agents`, `mcp`, `skills`, `memory_scopes`) : None = tout permis ; [] = rien ;
- l'utilisateur CUMULE les policies de ses rôles (union, comme les caps) ; admin = sans limite ;
- la policy se combine aux gardes existantes (caps, accès par équipe, périmètre d'agent) :
  elle ne peut que RESTREINDRE, jamais accorder ce que le RBAC refuse.
"""
from __future__ import annotations

from enum import Enum

from . import filestore, rbac


class Sensitivity(str, Enum):
    READ = "read"            # lister, calculer — aucun effet de bord
    SENSITIVE = "sensitive"  # envoyer un mail, modifier, supprimer, dépenser


# Classement par défaut des tools (extensible par connecteur/skill)
TOOL_SENSITIVITY: dict[str, Sensitivity] = {
    "list_customers": Sensitivity.READ,
    "list_orders": Sensitivity.READ,
    "compute": Sensitivity.READ,
    "recall_memory": Sensitivity.READ,
    "send_email": Sensitivity.SENSITIVE,
    "update_setting": Sensitivity.SENSITIVE,
    "delete": Sensitivity.SENSITIVE,
    "create_order": Sensitivity.SENSITIVE,
    "issue_refund": Sensitivity.SENSITIVE,
}


def sensitivity_of(tool: str) -> Sensitivity:
    # Par prudence, un tool inconnu est traité comme SENSIBLE.
    return TOOL_SENSITIVITY.get(tool, Sensitivity.SENSITIVE)


def decide(tool: str, autonomy_level: str) -> str:
    """Retourne 'execute' ou 'need_approval'."""
    if sensitivity_of(tool) == Sensitivity.READ:
        return "execute"
    return "execute" if autonomy_level == "auto" else "need_approval"


# ───────────────────────── Policies par rôle ─────────────────────────
SECTION = "policies"                                    # filestore : role_id -> policy
LIST_FIELDS = ("agents", "mcp", "skills", "memory_scopes")
BOOL_FIELDS = ("code", "web", "flows", "files", "dispatch", "delegate")
MEMORY_SCOPES = ("user", "project")                     # équipe/org : prochain chantier
AUTONOMY_VALUES = (None, "agent", "ask", "auto")        # agent/None = respecter le réglage de l'agent

UNRESTRICTED: dict = {**{f: None for f in LIST_FIELDS},
                      **{f: True for f in BOOL_FIELDS}, "autonomy": None}


def get_policy(role_id: str) -> dict | None:
    """La policy STOCKÉE d'un rôle (None si aucune = rôle sans restriction)."""
    p = filestore.items(SECTION).get(role_id)
    return dict(p) if p else None


def set_policy(role_id: str, patch: dict) -> dict | None:
    """Crée/édite la policy d'un rôle. Champs hors modèle ignorés. Admin reste non bridable."""
    if role_id == "admin" or not rbac.role_exists(role_id):
        return None
    cur = get_policy(role_id) or dict(UNRESTRICTED)
    for f in LIST_FIELDS:
        if f in patch:
            v = patch[f]
            cur[f] = None if v is None else [str(x) for x in v]
    for f in BOOL_FIELDS:
        if f in patch and patch[f] is not None:
            cur[f] = bool(patch[f])
    if "autonomy" in patch:
        a = patch["autonomy"] or None
        cur["autonomy"] = a if a in AUTONOMY_VALUES else None
        if cur["autonomy"] == "agent":
            cur["autonomy"] = None
    if cur.get("memory_scopes") is not None:
        cur["memory_scopes"] = [s for s in cur["memory_scopes"] if s in MEMORY_SCOPES]
    filestore.put(SECTION, role_id, cur)
    return cur


def delete_policy(role_id: str) -> bool:
    """Supprime la policy → le rôle redevient sans restriction."""
    return filestore.delete(SECTION, role_id)


def list_policies() -> dict[str, dict]:
    return {rid: dict(p) for rid, p in filestore.items(SECTION).items()}


def _merge(policies: list[dict | None]) -> dict:
    """Union (le plus permissif gagne, comme les caps) : un rôle sans policy = sans restriction."""
    if not policies or any(p is None for p in policies):
        return dict(UNRESTRICTED)
    out: dict = {}
    for f in LIST_FIELDS:
        vals = [p.get(f) for p in policies]
        out[f] = None if any(v is None for v in vals) else sorted({x for v in vals for x in v})
    for f in BOOL_FIELDS:
        out[f] = any(p.get(f, True) for p in policies)
    # Autonomie : auto > agent(None) > ask — le rôle le plus permissif l'emporte.
    autos = [p.get("autonomy") for p in policies]
    out["autonomy"] = "auto" if "auto" in autos else (None if None in autos else "ask")
    return out


def effective(user_id: str) -> dict:
    """Policy EFFECTIVE d'un utilisateur = union des policies des rôles de ses équipes."""
    if rbac.is_admin(user_id):
        return dict(UNRESTRICTED)
    teams = filestore.items("teams")
    roles = [(teams.get(tid) or {}).get("role") for tid in rbac.user_team_ids(user_id)]
    roles = [r for r in roles if r]
    if not roles:                                       # hors équipe (ex. propriétaire à l'amorçage)
        return dict(UNRESTRICTED)
    return _merge([get_policy(r) for r in roles])


# ── Aides d'enforcement (appelées par main.py sur le chemin AGENT uniquement) ──
def allowed_servers(user_id: str) -> set[str] | None:
    v = effective(user_id)["mcp"]
    return None if v is None else {str(x) for x in v}


def allowed_skills(user_id: str) -> set[str] | None:
    v = effective(user_id)["skills"]
    return None if v is None else set(v)


def family_allowed(user_id: str, fam: str) -> bool:
    return bool(effective(user_id).get(fam, True)) if fam in BOOL_FIELDS else True


def agent_allowed(user_id: str, agent_id: str) -> bool:
    v = effective(user_id)["agents"]
    return True if v is None else str(agent_id) in {str(x) for x in v}


def clamp_memory(user_id: str, mscope: str | None) -> str | None:
    """Restreint le scope mémoire demandé à ce que la policy permet (None = pas de mémoire)."""
    if not mscope:
        return mscope
    v = effective(user_id)["memory_scopes"]
    return mscope if (v is None or mscope in v) else None


def clamp_autonomy(user_id: str, agent_autonomy: str) -> str:
    """ask = forcer la validation ; auto = imposer l'autonomie ; sinon réglage de l'agent."""
    o = effective(user_id)["autonomy"]
    return o if o in ("ask", "auto") else ("auto" if agent_autonomy == "auto" else "ask")
