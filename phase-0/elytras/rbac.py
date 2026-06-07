"""RBAC + authentification (mode fichier, sans dépendance externe).

Modèle « équipes + rôles » :
- des **capacités** (caps) atomiques décrivent ce qu'on a le droit de faire ;
- des **rôles** (admin / opérateur / lecteur) regroupent des capacités ;
- des **équipes** (ex. « Comm », « IT ») portent chacune un rôle ;
- un **utilisateur** appartient à des équipes → ses capacités = union des rôles de ses équipes.

Authentification : comptes avec email + mot de passe (pbkdf2_hmac, sans lib externe),
jetons de session opaques. Le propriétaire local (DEFAULT_USER, sans jeton) est admin
pour permettre l'amorçage ; les autres n'ont QUE ce que leurs équipes accordent.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import re
import time
import uuid

from . import filestore, sessions

# ───────────────────────── Capacités & rôles ─────────────────────────
CAPS = [
    "mcp.manage",       # ajouter/supprimer/connecter des serveurs MCP
    "provider.manage",  # connecter des providers LLM (OAuth)
    "flow.view", "flow.create", "flow.edit", "flow.run", "flow.delete",
    "code.execute",     # exécuter des étapes code Python (sensible)
    "agent.use",        # discuter avec les agents (chat)
    "agent.manage",     # créer/modifier des agents
    "memory.view", "memory.reset",
    "file.read", "file.write",   # espace de fichiers scopé
    "web.browse",       # ouvrir/scraper une page web (récupérateur protégé)
    "dispatch",         # envoyer des notifications/dispatch à des utilisateurs (Telegram…)
    "schedule.manage",  # planificateur
    "admin",            # gérer utilisateurs / équipes / rôles
]

CAP_LABELS = {
    "mcp.manage": "Gérer les connecteurs MCP", "provider.manage": "Connecter les providers LLM",
    "flow.view": "Voir les flows", "flow.create": "Créer des flows", "flow.edit": "Modifier des flows",
    "flow.run": "Exécuter des flows", "flow.delete": "Supprimer des flows",
    "code.execute": "Exécuter du code Python", "agent.use": "Discuter avec les agents (chat)",
    "agent.manage": "Gérer les agents", "memory.view": "Consulter la mémoire",
    "memory.reset": "Réinitialiser la mémoire", "schedule.manage": "Planificateur",
    "file.read": "Lire les fichiers", "file.write": "Écrire/déposer des fichiers",
    "web.browse": "Naviguer / scraper le web",
    "dispatch": "Notifier/dispatcher des utilisateurs",
    "admin": "Administration (tout)",
}

# Rôles de base (éditables : une surcharge est stockée dans filestore "roles").
_BUILTIN_ROLES: dict[str, set[str]] = {
    "admin": set(CAPS),
    "operateur": {"flow.view", "flow.create", "flow.edit", "flow.run", "agent.use", "memory.view",
                  "schedule.manage", "file.read", "file.write", "dispatch", "web.browse"},
    "lecteur": {"flow.view", "memory.view", "agent.use", "file.read"},
}
ROLE_LABELS = {"admin": "Admin (tous droits)", "operateur": "Opérateur", "lecteur": "Lecteur"}


def role_caps(role_id: str) -> set[str]:
    if role_id == "admin":
        return set(CAPS)                       # admin protégé : toujours toutes les capacités
    stored = filestore.items("roles").get(role_id)
    if stored is not None:
        return {c for c in stored.get("caps", []) if c in CAPS}
    return set(_BUILTIN_ROLES.get(role_id, set()))


def role_exists(role_id: str) -> bool:
    return role_id == "admin" or role_id in _BUILTIN_ROLES or role_id in filestore.items("roles")


def list_roles() -> list[dict]:
    stored = filestore.items("roles")
    out: dict[str, dict] = {}
    for rid in _BUILTIN_ROLES:
        out[rid] = {"id": rid, "name": ROLE_LABELS.get(rid, rid), "caps": sorted(role_caps(rid)),
                    "builtin": True, "protected": rid == "admin"}
    for rid, r in stored.items():
        out[rid] = {"id": rid, "name": r.get("name", rid), "caps": sorted(role_caps(rid)),
                    "builtin": rid in _BUILTIN_ROLES, "protected": rid == "admin"}
    if "admin" in out:
        out["admin"]["caps"] = sorted(CAPS)
    return list(out.values())


def create_role(name: str, caps: list[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "_", (name or "role").lower()).strip("_") or "role"
    rid, n = base, 2
    existing = set(filestore.items("roles")) | set(_BUILTIN_ROLES) | {"admin"}
    while rid in existing:
        rid = f"{base}_{n}"; n += 1
    filestore.put("roles", rid, {"name": name or rid, "caps": [c for c in caps if c in CAPS]})
    return rid


def update_role(role_id: str, name=None, caps=None) -> bool:
    if role_id == "admin":
        return False                           # admin non modifiable (anti-verrouillage)
    cur = filestore.items("roles").get(role_id)
    if cur is None:
        if role_id in _BUILTIN_ROLES:
            cur = {"name": ROLE_LABELS.get(role_id, role_id), "caps": sorted(_BUILTIN_ROLES[role_id])}
        else:
            return False
    if name is not None:
        cur["name"] = name
    if caps is not None:
        cur["caps"] = [c for c in caps if c in CAPS]
    filestore.put("roles", role_id, cur)
    return True


def delete_role(role_id: str) -> bool:
    if role_id == "admin" or role_id in _BUILTIN_ROLES:
        return False                           # rôles de base non supprimables (on peut les éditer)
    if any(t.get("role") == role_id for t in filestore.items("teams").values()):
        return False                           # rôle utilisé par une équipe : refuser (réassigner d'abord)
    return filestore.delete("roles", role_id)


# ───────────────────────── Mots de passe (pbkdf2) ─────────────────────────
def hash_pw(pw: str, salt: str | None = None, iters: int = 200_000) -> tuple[str, str, int]:
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), iters).hex()
    return h, salt, iters


def verify_pw(pw: str, h: str, salt: str, iters: int) -> bool:
    try:
        calc = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), iters).hex()
        return hmac.compare_digest(calc, h)
    except Exception:
        return False


# ───────────────────────── Jetons de session ─────────────────────────
def create_token(user_id: str) -> str:
    tok = secrets.token_urlsafe(24)
    filestore.put("auth_tokens", tok, {"user_id": user_id, "created": time.time()})
    return tok


def resolve_token(tok: str) -> str | None:
    rec = filestore.items("auth_tokens").get(tok or "")
    return rec.get("user_id") if rec else None


def revoke_token(tok: str) -> bool:
    return filestore.delete("auth_tokens", tok)


# ───────────────────────── Comptes ─────────────────────────
def _accounts() -> dict:
    return filestore.items("user_auth")


def get_account(user_id: str) -> dict | None:
    return _accounts().get(user_id)


def find_by_email(email: str):
    for uid, a in _accounts().items():
        if (a.get("email") or "").lower() == (email or "").lower():
            return uid, a
    return None, None


def create_account(name: str, email: str, password: str, team_ids: list[str] | None = None) -> dict:
    if find_by_email(email)[0]:
        raise ValueError("un compte existe déjà avec cet email")
    uid = sessions.create_user(name)
    h, salt, iters = hash_pw(password)
    filestore.put("user_auth", uid, {"email": email, "pwd_hash": h, "salt": salt, "iters": iters,
                                     "team_ids": team_ids or [], "active": True, "name": name})
    return {"id": uid, "email": email, "name": name, "team_ids": team_ids or []}


def set_password(user_id: str, password: str) -> bool:
    a = get_account(user_id)
    if not a:
        return False
    a["pwd_hash"], a["salt"], a["iters"] = hash_pw(password)
    filestore.put("user_auth", user_id, a)
    return True


def set_user_teams(user_id: str, team_ids: list[str]) -> bool:
    a = get_account(user_id)
    if not a:
        return False
    a["team_ids"] = team_ids
    filestore.put("user_auth", user_id, a)
    return True


def set_telegram(user_id: str, telegram_id: str) -> bool:
    a = get_account(user_id)
    if not a:
        return False
    a["telegram_id"] = str(telegram_id or "").strip()
    filestore.put("user_auth", user_id, a)
    return True


# ── Profil utilisateur (personnalisation : l'agent sait qui est l'utilisateur) ──
PROFILE_FIELDS = ("job_title", "department", "bio", "preferences", "tone")


def get_profile(user_id: str) -> dict:
    return dict(filestore.items("user_profiles").get(user_id) or {})


def set_profile(user_id: str, fields: dict) -> dict:
    p = get_profile(user_id)
    for k, v in (fields or {}).items():
        if k in PROFILE_FIELDS and v is not None:
            p[k] = v
    filestore.put("user_profiles", user_id, p)
    return p


def find_by_telegram(telegram_id: str) -> str | None:
    tid = str(telegram_id or "").strip()
    if not tid:
        return None
    for uid, a in _accounts().items():
        if str(a.get("telegram_id") or "") == tid and a.get("active"):
            return uid
    return None


def set_active(user_id: str, active: bool) -> bool:
    a = get_account(user_id)
    if not a:
        return False
    a["active"] = active
    filestore.put("user_auth", user_id, a)
    return True


def login(email: str, password: str) -> str | None:
    uid, a = find_by_email(email)
    if not a or not a.get("active"):
        return None
    if not verify_pw(password, a.get("pwd_hash", ""), a.get("salt", ""), int(a.get("iters", 200_000))):
        return None
    return create_token(uid)


# ───────────────────────── Équipes ─────────────────────────
def list_teams() -> list[dict]:
    return [{"id": tid, "name": t.get("name"), "role": t.get("role", "operateur")}
            for tid, t in filestore.items("teams").items()]


def create_team(name: str, role: str = "operateur") -> str:
    tid = str(uuid.uuid4())
    filestore.put("teams", tid, {"name": name, "role": role if role_exists(role) else "operateur"})
    return tid


def update_team(tid: str, name: str | None = None, role: str | None = None) -> bool:
    t = filestore.items("teams").get(tid)
    if not t:
        return False
    if name is not None:
        t["name"] = name
    if role and role_exists(role):
        t["role"] = role
    filestore.put("teams", tid, t)
    return True


def delete_team(tid: str) -> bool:
    return filestore.delete("teams", tid)


# ───────────────────────── Capacités effectives ─────────────────────────
def caps_for(user_id: str) -> set[str]:
    if user_id == sessions.DEFAULT_USER:
        # Amorçage : tant qu'aucun admin n'existe, le propriétaire local a tous les droits
        # (pour pouvoir créer le 1er compte). Une fois le setup fait → aucun droit sans login.
        return set(CAPS) if setup_needed() else set()
    a = get_account(user_id)
    if not a or not a.get("active"):
        return set()
    teams = filestore.items("teams")
    caps: set[str] = set()
    for tid in a.get("team_ids", []):
        caps |= role_caps((teams.get(tid) or {}).get("role"))
    return caps


def user_team_ids(user_id: str) -> list[str]:
    a = get_account(user_id)
    return a.get("team_ids", []) if a else []


def can_access(user_id: str, allow_all: bool, allowed_teams: list[str]) -> bool:
    """Accès à une ressource (MCP/skill) : admin, ou ouvert à tous, ou via une équipe autorisée."""
    if is_admin(user_id):
        return True
    if allow_all:
        return True
    return bool(set(allowed_teams or []) & set(user_team_ids(user_id)))


def has_cap(user_id: str, cap: str) -> bool:
    return cap in caps_for(user_id)


def is_admin(user_id: str) -> bool:
    return has_cap(user_id, "admin")


def setup_needed() -> bool:
    """Vrai tant qu'aucun compte admin (membre d'une équipe rôle admin) n'existe."""
    admin_teams = {tid for tid, t in filestore.items("teams").items() if t.get("role") == "admin"}
    for a in _accounts().values():
        if a.get("active") and set(a.get("team_ids", [])) & admin_teams:
            return False
    return True


def setup_first_admin(name: str, email: str, password: str) -> dict:
    """Crée la première équipe Admin + le premier compte admin (uniquement si besoin)."""
    if not setup_needed():
        raise ValueError("un administrateur existe déjà")
    admin_team = next((tid for tid, t in filestore.items("teams").items() if t.get("role") == "admin"), None)
    if not admin_team:
        admin_team = create_team("Administration", "admin")
    acc = create_account(name, email, password, [admin_team])
    return {**acc, "token": create_token(acc["id"])}


def describe(user_id: str) -> dict:
    a = get_account(user_id) or {}
    teams = filestore.items("teams")
    my_teams = [{"id": tid, "name": (teams.get(tid) or {}).get("name"),
                 "role": (teams.get(tid) or {}).get("role")} for tid in a.get("team_ids", [])]
    name = a.get("name")
    if user_id == sessions.DEFAULT_USER:
        name = name or "Léo (propriétaire)"
    return {"id": user_id, "name": name, "email": a.get("email"), "telegram_id": a.get("telegram_id", ""),
            "teams": my_teams, "caps": sorted(caps_for(user_id)), "is_admin": is_admin(user_id)}


# ───────────────────────── SSO (OpenID Connect) ─────────────────────────
def get_sso() -> dict:
    return filestore.items("sso_config").get("cfg") or {"enabled": False}


def set_sso(patch: dict) -> dict:
    cfg = get_sso()
    cfg.update({k: v for k, v in (patch or {}).items() if v is not None})
    # si l'issuer change, on oublie les endpoints découverts
    if "issuer" in patch:
        cfg.pop("authorization_endpoint", None)
        cfg.pop("token_endpoint", None)
        cfg.pop("userinfo_endpoint", None)
    filestore.put("sso_config", "cfg", cfg)
    return cfg


def create_account_sso(name: str, email: str, team_ids: list[str] | None = None) -> str:
    """Crée un compte authentifié par SSO (sans mot de passe : login local désactivé)."""
    uid = sessions.create_user(name)
    filestore.put("user_auth", uid, {"email": email, "pwd_hash": "", "salt": "", "iters": 0,
                                     "team_ids": team_ids or [], "active": True, "name": name, "sso": True})
    return uid


def sso_resolve(email: str, name: str | None) -> str | None:
    """Rattache un email SSO à un compte ; provisionne si activé. Renvoie l'uid ou None."""
    if not email:
        return None
    uid, a = find_by_email(email)
    if uid:
        return uid if a.get("active") else None
    cfg = get_sso()
    if cfg.get("auto_provision"):
        team = [cfg["default_team"]] if cfg.get("default_team") else []
        return create_account_sso(name or email.split("@")[0], email, team)
    return None


def list_accounts() -> list[dict]:
    teams = filestore.items("teams")
    out = []
    for uid, a in _accounts().items():
        out.append({"id": uid, "name": a.get("name"), "email": a.get("email"),
                    "active": a.get("active", True), "telegram_id": a.get("telegram_id", ""),
                    "team_ids": a.get("team_ids", []),
                    "teams": [(teams.get(t) or {}).get("name") for t in a.get("team_ids", [])]})
    return out
