"""Elytras — Phase 0 — cœur modulaire + API + interface web + OAuth.

Le cœur est AGNOSTIQUE : il découvre des serveurs MCP, liste/appelle leurs outils,
gère l'OAuth (MCP + provider Codex), la mémoire scopée, l'audit. Aucune intégration codée.
"""
from __future__ import annotations

import base64
import concurrent.futures
import datetime as dt
import hashlib
import html as _htmllib
import httpx
import ipaddress
import json
import os
import pathlib
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid

try:
    import psycopg                       # Postgres optionnel : non requis en mode fichier
except Exception:                        # pragma: no cover - dépendance absente côté client
    psycopg = None
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel

from . import (agents, crypto, filestore, files, flows, memory_engine, provider_auth, providers,
               rbac, registry, scheduler, sessions, skills)
from .mcp_client import McpClient
from .mcp_oauth import McpOAuth
from .memory import FileMemoryStore, MemoryStore

DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001"
DEFAULT_USER = "00000000-0000-0000-0000-0000000000a1"
WEB_DIR = pathlib.Path(__file__).parent / "web"
REDIRECT_URI = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/") + "/oauth/callback"

app = FastAPI(title="Elytras — Phase 0")
mcp = McpClient()


# ───────────────────────── Auth / RBAC : identité & verrous ─────────────────────────
def _token_of(request: Request) -> str:
    tok = request.headers.get("x-elytras-token", "")
    if not tok:
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            tok = auth[7:]
    return tok


@app.middleware("http")
async def _identity_mw(request: Request, call_next):
    """Si un jeton valide est présent, l'identité (user_id) vient du jeton — pas du client.

    On réécrit le paramètre de requête user_id pour que TOUS les endpoints de lecture
    se cadrent sur l'utilisateur authentifié (le client ne peut plus se faire passer
    pour un autre via ?user_id=...)."""
    uid = rbac.resolve_token(_token_of(request))
    request.state.uid = uid
    if uid:
        from urllib.parse import parse_qs, urlencode
        q = parse_qs(request.scope.get("query_string", b"").decode())
        q["user_id"] = [uid]
        request.scope["query_string"] = urlencode(q, doseq=True).encode()
    return await call_next(request)


def _actor(request: Request) -> str:
    return getattr(request.state, "uid", None) or rbac.resolve_token(_token_of(request)) or DEFAULT_USER


def _need(cap: str):
    """Dépendance FastAPI : exige une capacité, sinon 403. Renvoie l'id de l'acteur."""
    def dep(request: Request) -> str:
        uid = _actor(request)
        if not rbac.has_cap(uid, cap):
            raise HTTPException(status_code=403, detail=f"Accès refusé : capacité « {cap} » requise.")
        return uid
    return dep


class _LoginReq(BaseModel):
    email: str
    password: str


class _SetupReq(BaseModel):
    name: str
    email: str
    password: str


@app.get("/auth/setup-needed")
def auth_setup_needed():
    return {"needed": rbac.setup_needed()}


@app.post("/auth/setup")
def auth_setup(req: _SetupReq):
    try:
        return rbac.setup_first_admin(req.name.strip(), req.email.strip(), req.password)
    except Exception as e:                       # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=400)


@app.post("/auth/login")
def auth_login(req: _LoginReq):
    tok = rbac.login(req.email.strip(), req.password)
    if not tok:
        return JSONResponse({"error": "email ou mot de passe invalide"}, status_code=401)
    uid = rbac.resolve_token(tok)
    return {"token": tok, "user": rbac.describe(uid)}


@app.post("/auth/logout")
def auth_logout(request: Request):
    rbac.revoke_token(_token_of(request))
    return {"ok": True}


@app.get("/auth/me")
def auth_me(request: Request):
    return rbac.describe(_actor(request))


# ── SSO (OpenID Connect générique) ──
def _sso_redirect_uri():
    base = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")
    return rbac.get_sso().get("redirect_uri") or (base + "/auth/sso/callback")


def _oidc_discover(cfg):
    if cfg.get("authorization_endpoint") and cfg.get("token_endpoint") and cfg.get("userinfo_endpoint"):
        return cfg
    iss = (cfg.get("issuer") or "").rstrip("/")
    d = httpx.get(iss + "/.well-known/openid-configuration", timeout=10).json()
    cfg["authorization_endpoint"] = d.get("authorization_endpoint")
    cfg["token_endpoint"] = d.get("token_endpoint")
    cfg["userinfo_endpoint"] = d.get("userinfo_endpoint")
    rbac.set_sso(cfg)
    return cfg


def _sso_exchange(cfg, code, redirect):
    tok = httpx.post(cfg["token_endpoint"],
                     data={"grant_type": "authorization_code", "code": code, "redirect_uri": redirect,
                           "client_id": cfg["client_id"], "client_secret": cfg.get("client_secret", "")},
                     headers={"Accept": "application/json"}, timeout=15).json()
    at = tok.get("access_token")
    if not at:
        raise RuntimeError("pas d'access_token (" + str(tok.get("error", "?")) + ")")
    return httpx.get(cfg["userinfo_endpoint"], headers={"Authorization": f"Bearer {at}"}, timeout=15).json()


@app.get("/auth/sso/config-public")
def sso_public():
    cfg = rbac.get_sso()
    return {"enabled": bool(cfg.get("enabled") and cfg.get("client_id") and cfg.get("issuer"))}


class _SsoCfgReq(BaseModel):
    enabled: bool | None = None
    issuer: str | None = None
    client_id: str | None = None
    client_secret: str | None = None
    scopes: str | None = None
    auto_provision: bool | None = None
    default_team: str | None = None
    redirect_uri: str | None = None


@app.get("/admin/sso")
def admin_get_sso(actor: str = Depends(_need("admin"))):
    c = dict(rbac.get_sso())
    c["client_secret_set"] = bool(c.pop("client_secret", ""))   # ne jamais renvoyer le secret
    return c


@app.post("/admin/sso")
def admin_set_sso(req: _SsoCfgReq, actor: str = Depends(_need("admin"))):
    patch = {k: v for k, v in {"enabled": req.enabled, "issuer": req.issuer, "client_id": req.client_id,
                               "client_secret": req.client_secret, "scopes": req.scopes,
                               "auto_provision": req.auto_provision, "default_team": req.default_team,
                               "redirect_uri": req.redirect_uri}.items() if v is not None}
    cfg = rbac.set_sso(patch)
    return {"ok": True, "redirect_uri": _sso_redirect_uri(),
            "config": {k: v for k, v in cfg.items() if k != "client_secret"}}


@app.get("/auth/sso/start")
def sso_start():
    cfg = rbac.get_sso()
    if not (cfg.get("enabled") and cfg.get("client_id") and cfg.get("issuer")):
        return JSONResponse({"error": "SSO non configuré"}, status_code=400)
    try:
        cfg = _oidc_discover(cfg)
    except Exception as e:                       # noqa: BLE001
        return JSONResponse({"error": f"découverte OIDC échouée : {e}"}, status_code=502)
    from urllib.parse import urlencode
    state = secrets.token_urlsafe(16)
    filestore.put("sso_state", state, {"ts": time.time()})
    q = urlencode({"response_type": "code", "client_id": cfg["client_id"],
                   "redirect_uri": _sso_redirect_uri(), "scope": cfg.get("scopes", "openid email profile"),
                   "state": state})
    return RedirectResponse(cfg["authorization_endpoint"] + "?" + q)


@app.get("/auth/sso/callback")
def sso_callback(code: str = "", state: str = ""):
    if not filestore.delete("sso_state", state):
        return HTMLResponse("<p>État SSO invalide ou expiré.</p>", status_code=400)
    cfg = rbac.get_sso()
    try:
        ui = _sso_exchange(cfg, code, _sso_redirect_uri())
    except Exception as e:                       # noqa: BLE001
        return HTMLResponse(f"<p>Échec de l'échange SSO : {e}</p>", status_code=502)
    email = ui.get("email")
    name = ui.get("name") or ui.get("preferred_username")
    uid = rbac.sso_resolve(email, name)
    if not uid:
        return HTMLResponse(f"<p>Aucun compte Elytras pour <b>{email}</b>. Demande à un administrateur de "
                            "te créer un compte (ou d'activer le provisionnement automatique).</p>", status_code=403)
    token = rbac.create_token(uid)
    # On stocke le jeton côté navigateur SANS le mettre dans l'URL, puis on redirige.
    return HTMLResponse("<!doctype html><meta charset=utf-8><script>"
                        "localStorage.setItem('elytras_token'," + json.dumps(token) + ");"
                        "location.replace('/');</script>Connexion réussie…")


# ── Administration (réservé à la capacité admin) ──
class _TeamReq(BaseModel):
    name: str
    role: str = "operateur"


class _TeamPatchReq(BaseModel):
    name: str | None = None
    role: str | None = None


class _AccountReq(BaseModel):
    name: str
    email: str
    password: str
    team_ids: list[str] = []


class _AccountPatchReq(BaseModel):
    team_ids: list[str] | None = None
    active: bool | None = None
    password: str | None = None
    telegram_id: str | None = None


@app.get("/admin/roles")
def admin_roles(actor: str = Depends(_need("admin"))):
    return {"roles": rbac.list_roles(), "caps": rbac.CAPS, "cap_labels": rbac.CAP_LABELS}


class _RoleReq(BaseModel):
    name: str
    caps: list[str] = []
    user_id: str = DEFAULT_USER


class _RolePatchReq(BaseModel):
    name: str | None = None
    caps: list[str] | None = None
    user_id: str = DEFAULT_USER


@app.post("/admin/roles")
def admin_role_add(req: _RoleReq, actor: str = Depends(_need("admin"))):
    return {"id": rbac.create_role(req.name.strip(), req.caps), "name": req.name}


@app.patch("/admin/roles/{rid}")
def admin_role_patch(rid: str, req: _RolePatchReq, actor: str = Depends(_need("admin"))):
    if not rbac.update_role(rid, name=req.name, caps=req.caps):
        return JSONResponse({"error": "rôle protégé ou introuvable (l'admin n'est pas modifiable)"}, status_code=400)
    return {"ok": True}


@app.delete("/admin/roles/{rid}")
def admin_role_del(rid: str, actor: str = Depends(_need("admin"))):
    if not rbac.delete_role(rid):
        return JSONResponse({"error": "suppression impossible : rôle de base ou encore utilisé par une équipe"}, status_code=400)
    return {"deleted": rid}


@app.get("/admin/teams")
def admin_teams(actor: str = Depends(_need("admin"))):
    return {"teams": rbac.list_teams()}


@app.post("/admin/teams")
def admin_team_add(req: _TeamReq, actor: str = Depends(_need("admin"))):
    return {"id": rbac.create_team(req.name.strip(), req.role), "name": req.name}


@app.patch("/admin/teams/{tid}")
def admin_team_patch(tid: str, req: _TeamPatchReq, actor: str = Depends(_need("admin"))):
    return {"ok": rbac.update_team(tid, name=req.name, role=req.role)}


@app.delete("/admin/teams/{tid}")
def admin_team_del(tid: str, actor: str = Depends(_need("admin"))):
    return {"deleted": rbac.delete_team(tid)}


@app.get("/admin/accounts")
def admin_accounts(actor: str = Depends(_need("admin"))):
    return {"accounts": rbac.list_accounts()}


@app.post("/admin/accounts")
def admin_account_add(req: _AccountReq, actor: str = Depends(_need("admin"))):
    try:
        return rbac.create_account(req.name.strip(), req.email.strip(), req.password, req.team_ids)
    except Exception as e:                       # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=400)


@app.patch("/admin/accounts/{uid}")
def admin_account_patch(uid: str, req: _AccountPatchReq, actor: str = Depends(_need("admin"))):
    if req.team_ids is not None:
        rbac.set_user_teams(uid, req.team_ids)
    if req.active is not None:
        rbac.set_active(uid, req.active)
    if req.password:
        rbac.set_password(uid, req.password)
    if req.telegram_id is not None:
        rbac.set_telegram(uid, req.telegram_id)
    return {"ok": True}


def _conn():
    if psycopg is None or not os.environ.get("DATABASE_URL"):
        raise RuntimeError("Postgres non configuré (mode fichier)")
    return psycopg.connect(os.environ["DATABASE_URL"])


def _conn_opt() -> psycopg.Connection | None:
    try:
        return _conn()
    except Exception:
        return None


# ───────────────────────── Stockage OAuth (tokens chiffrés en base) ─────────────────────────
_PENDING: dict = {}   # state -> contexte (court, en mémoire, mono-process)


class DbOAuthStore:
    def save_pending(self, state, data):
        _PENDING[state] = data
        try:
            filestore.put("oauth_pending", state, data)
        except Exception:
            pass

    def get_pending(self, state):
        d = _PENDING.pop(state, None)
        if d is None:
            d = filestore.items("oauth_pending").get(state)
        return d

    def save_tokens(self, server_id, user_id, rec):
        c = _conn_opt()
        if not c:
            filestore.put("mcp_tokens", f"{server_id}|{user_id}",
                          base64.b64encode(crypto.encrypt(json.dumps(rec))).decode())
            return
        try:
            blob = crypto.encrypt(json.dumps(rec))
            with c.cursor() as cur:
                cur.execute(
                    """INSERT INTO mcp_oauth (server_id, user_id, token_enc) VALUES (%s,%s,%s)
                       ON CONFLICT (server_id, user_id)
                       DO UPDATE SET token_enc = EXCLUDED.token_enc, updated_at = now()""",
                    (str(server_id), user_id, blob),
                )
            c.commit()
        finally:
            c.close()

    def get_tokens(self, server_id, user_id):
        c = _conn_opt()
        if not c:
            b = filestore.get("mcp_tokens", f"{server_id}|{user_id}")
            try:
                return json.loads(crypto.decrypt(base64.b64decode(b))) if b else None
            except Exception:
                return None
        try:
            with c.cursor() as cur:
                cur.execute("SELECT token_enc FROM mcp_oauth WHERE server_id=%s AND user_id=%s",
                            (str(server_id), user_id))
                row = cur.fetchone()
            return json.loads(crypto.decrypt(row[0])) if row else None
        finally:
            c.close()


oauth = McpOAuth(DbOAuthStore(), REDIRECT_URI)


# ── Providers d'abonnement : auth native (réimplémentée de CLIProxyAPI), tokens chiffrés ──
class DbProviderStore:
    def save_tokens(self, user_id, provider, rec):
        c = _conn_opt()
        if not c:
            filestore.put("provider_tokens", f"{user_id}|{provider}",
                          base64.b64encode(crypto.encrypt(json.dumps(rec))).decode())
            return
        try:
            blob = crypto.encrypt(json.dumps(rec))
            with c.cursor() as cur:
                cur.execute(
                    """INSERT INTO provider_account (user_id, provider, auth_type, secret_enc)
                       VALUES (%s,%s,'oauth',%s)
                       ON CONFLICT (user_id, provider)
                       DO UPDATE SET secret_enc = EXCLUDED.secret_enc, updated_at = now()""",
                    (user_id, provider, blob))
            c.commit()
        finally:
            c.close()

    def get_tokens(self, user_id, provider):
        c = _conn_opt()
        if not c:
            b = filestore.get("provider_tokens", f"{user_id}|{provider}")
            try:
                return json.loads(crypto.decrypt(base64.b64decode(b))) if b else None
            except Exception:
                return None
        try:
            with c.cursor() as cur:
                cur.execute("SELECT secret_enc FROM provider_account WHERE user_id=%s AND provider=%s",
                            (user_id, provider))
                row = cur.fetchone()
            return json.loads(crypto.decrypt(row[0])) if row and row[0] else None
        finally:
            c.close()


prov_auth = provider_auth.ProviderAuth(DbProviderStore())
providers.set_auth(prov_auth, DEFAULT_USER)


# Prix indicatifs ($/1000 tokens) — Codex = abonnement (≈0 marginal), ajustable.
_PRICES = {"default": {"in": 0.0, "out": 0.0},
           "gpt-5.4-mini": {"in": 0.0003, "out": 0.0012}}


def _est_tokens(s) -> int:
    return max(1, len(s or "") // 4)            # estimation grossière (≈ 4 caractères / token)


def _record_usage(user_id, provider, model, ptok, ctok, kind):
    """Journalise un appel LLM en mode fichier (pour l'observabilité), avec coût estimé."""
    p = _PRICES.get(model) or _PRICES["default"]
    cost = round(ptok / 1000 * p["in"] + ctok / 1000 * p["out"], 6)
    filestore.put("llm_usage", secrets.token_hex(8),
                  {"ts": time.time(), "user_id": user_id, "provider": provider, "model": model,
                   "ptok": int(ptok), "ctok": int(ctok), "cost": cost, "kind": kind})


def _log_usage(provider, model, pt, ct, cost, user_id, tenant_id):
    _record_usage(user_id, provider, model, pt or 0, ct or 0, "gateway")   # capture aussi en mode fichier
    c = _conn_opt()
    if not c:
        return
    try:
        with c.cursor() as cur:
            cur.execute(
                """INSERT INTO llm_usage (tenant_id, user_id, provider, model,
                       prompt_tokens, completion_tokens, cost_estimate)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                (tenant_id, user_id, provider, model, pt, ct, cost))
        c.commit()
    except Exception:
        pass
    finally:
        c.close()


gateway = providers.Gateway(log_usage=_log_usage)


SHARED_UID = "__shared__"   # connexion MCP partagée (compte commun) : jeton stocké sous cette clé


def _conn_uid(srv: dict, user_id: str) -> str:
    """Sous quelle identité le jeton OAuth d'un serveur est rangé : l'utilisateur (personnel) ou partagé."""
    return user_id if srv.get("conn_scope") == "personal" else SHARED_UID


def _can_use_server(user_id: str, srv: dict) -> bool:
    return rbac.can_access(user_id, srv.get("allow_all", False), srv.get("allowed_teams", []))


def _skill_access(name: str) -> dict:
    cfg = filestore.items("skill_access").get(name) or {}
    return {"allow_all": cfg.get("allow_all", True), "allowed_teams": cfg.get("allowed_teams", [])}


def _can_use_skill(user_id: str, name: str) -> bool:
    a = _skill_access(name)
    return rbac.can_access(user_id, a["allow_all"], a["allowed_teams"])


def _company_md() -> str:
    return (filestore.items("company").get("doc") or {}).get("md", "")


# ── Navigateur / scraping protégé (anti-SSRF) ──
def _host_allowed(host: str) -> bool:
    """Refuse les hôtes du réseau interne (loopback, privé, link-local, métadonnées cloud)."""
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except Exception:
            return False
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
                or ip.is_multicast or ip.is_unspecified):
            return False
    return True


def _html_to_text(html: str):
    html = re.sub(r"(?is)<(script|style|noscript|template|svg)[^>]*>.*?</\1>", " ", html)
    m = re.search(r"(?is)<title[^>]*>(.*?)</title>", html)
    title = re.sub(r"\s+", " ", _htmllib.unescape(m.group(1))).strip() if m else ""
    text = _htmllib.unescape(re.sub(r"(?s)<[^>]+>", " ", html))
    return title, re.sub(r"[ \t\f\v]+", " ", re.sub(r"\n\s*\n+", "\n\n", text)).strip()


def _browse(url: str, max_bytes: int = 2_000_000):
    """GET protégé : http/https only, blocage réseau interne (à chaque redirection), taille/délai limités."""
    from urllib.parse import urlparse
    cur = (url or "").strip()
    try:
        for _ in range(5):                       # suit les redirections en revalidant chaque hôte
            u = urlparse(cur)
            if u.scheme not in ("http", "https"):
                return {"error": "schéma non autorisé (http/https uniquement)"}
            if not u.hostname or not _host_allowed(u.hostname):
                return {"error": "hôte non autorisé (réseau interne bloqué)"}
            r = httpx.get(cur, follow_redirects=False, timeout=15,
                          headers={"User-Agent": "Elytras/0.1 (+scraper)"})
            if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                cur = str(httpx.URL(str(r.url)).join(r.headers["location"]))
                continue
            break
        if r.status_code >= 400:
            return {"error": f"HTTP {r.status_code}", "url": str(r.url)}
        if int(r.headers.get("content-length") or 0) > max_bytes * 3:
            return {"error": "contenu trop volumineux"}
        body = r.content[:max_bytes].decode("utf-8", "replace")
        ctype = r.headers.get("content-type", "")
        if "html" in ctype or "<html" in body[:1000].lower():
            title, text = _html_to_text(body)
        else:
            title, text = "", body
        return {"url": str(r.url), "title": title, "text": text[:8000], "truncated": len(text) > 8000}
    except Exception as e:                       # noqa: BLE001
        return {"error": str(e)[:200]}


def _with_token(srv: dict, user_id: str) -> dict:
    """Injecte le bon Bearer selon le mode d'auth ET le scope (personnel vs partagé)."""
    auth = srv.get("auth_type", "none")
    if auth == "oauth":
        srv = {**srv, "token": oauth.token_for(srv["id"], _conn_uid(srv, user_id))}
    elif auth == "bearer" and srv.get("secret_enc"):
        try:
            srv = {**srv, "token": crypto.decrypt(srv["secret_enc"])}
        except Exception:
            pass
    return srv


# ───────────────────────── Interface web ─────────────────────────
APP_VERSION = dt.datetime.now().isoformat()  # change à chaque (re)démarrage -> auto-refresh navigateur


@app.get("/", response_class=HTMLResponse)
def home():
    f = WEB_DIR / "index.html"
    html = f.read_text(encoding="utf-8") if f.exists() else "<h1>Elytras — Phase 0</h1>"
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


@app.get("/version")
def version():
    return {"v": APP_VERSION}


@app.get("/health")
def health():
    c = _conn_opt()
    db = bool(c)
    if c:
        c.close()
    return {"status": "ok", "db": "ok" if db else "down",
            "provider": os.environ.get("ELYTRAS_PROVIDER", "codex"),
            "example_mcp": bool(os.environ.get("EXAMPLE_MCP_URL"))}


# ───────────────────────── Auto-tests ─────────────────────────
@app.get("/selftest")
def selftest():
    checks: list[dict] = []
    db_ok = False
    try:
        c = _conn()
        with c.cursor() as cur:
            cur.execute("SELECT 1")
        c.close()
        db_ok = True
        checks.append({"name": "Base de données (Postgres + pgvector)", "ok": True, "detail": "connectée"})
    except Exception:
        checks.append({"name": "Base de données (Postgres + pgvector)", "ok": True,
                       "detail": "non connectée — mode local fichier (Postgres optionnel)"})

    ex = registry.example_server()
    if ex:
        try:
            tools = mcp.list_tools(ex)
            checks.append({"name": "Serveur MCP d'exemple — tools/list", "ok": True,
                           "detail": f"{len(tools)} outils : " + ", ".join(t["name"] for t in tools)})
            data = mcp.call_tool(ex, "list_inactive_customers", {"days": 90}).get("data", {})
            checks.append({"name": "Appel d'outil MCP", "ok": isinstance(data.get("count"), int),
                           "detail": f"{data.get('count', '?')} clients inactifs renvoyés"})
        except Exception as e:
            checks.append({"name": "Serveur MCP d'exemple", "ok": False, "detail": f"injoignable : {e}"})
    else:
        checks.append({"name": "Serveur MCP d'exemple", "ok": False, "detail": "EXAMPLE_MCP_URL non défini"})

    conn = [s for s in (prov_auth.status(p, DEFAULT_USER) for p in provider_auth.SPECS) if s["connected"]]
    checks.append({"name": "Providers d'abonnement (auth native)", "ok": True,
                   "detail": (", ".join(s["label"] for s in conn) + " connecté(s)") if conn
                             else "aucun connecté — clique « Se connecter » (Codex/Claude/Gemini) dans l'UI"})

    try:
        cm = _conn_opt()
        store = MemoryStore(cm) if cm else FileMemoryStore()
        if cm:
            store.set_context(DEFAULT_USER, DEFAULT_TENANT, role="admin")
        mid = store.write(DEFAULT_TENANT, "user", "selftest " + dt.datetime.now().isoformat(),
                          owner_id=DEFAULT_USER, mtype="fact", source_ref="selftest")
        hits = store.recall("selftest", k=3)
        if cm:
            cm.close()
        checks.append({"name": "Mémoire scopée (write + recall)", "ok": bool(mid),
                       "detail": f"écrit, {len(hits)} résultat(s)" + ("" if cm else " — mode fichier")})
    except Exception as e:
        checks.append({"name": "Mémoire scopée (write + recall)", "ok": False, "detail": str(e.__class__.__name__)})

    sk = skills.load_skills()
    checks.append({"name": "Skills chargées (SKILL.md)", "ok": len(sk) > 0,
                   "detail": ", ".join(s["name"] for s in sk) or "aucune"})

    return {"ok": all(c["ok"] for c in checks), "checks": checks,
            "at": dt.datetime.now().isoformat(timespec="seconds")}


# ───────────────────────── Providers ─────────────────────────
@app.get("/providers")
def providers_status():
    return {"active": {"provider": os.environ.get("ELYTRAS_PROVIDER", "codex"),
                       "model": os.environ.get("ELYTRAS_MODEL", "")},
            "providers": [prov_auth.status(p, DEFAULT_USER) for p in provider_auth.SPECS]}


class LoginReq(BaseModel):
    provider: str
    user_id: str = DEFAULT_USER


@app.post("/providers/login")
def providers_login(req: LoginReq, actor: str = Depends(_need("provider.manage"))):
    """Démarre le login OAuth d'un provider d'abonnement (Codex/Claude/Gemini).
    Renvoie l'URL à ouvrir ; le callback loopback est capté par le cœur."""
    if req.provider not in provider_auth.SPECS:
        return JSONResponse({"error": "provider inconnu"}, status_code=404)
    try:
        return {"auth_url": prov_auth.start_login(req.provider, req.user_id)}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ───────────────────────── Chat ─────────────────────────
class ChatReq(BaseModel):
    messages: list[dict] = []          # [{role: user|assistant|system, content: "..."}]
    provider: str | None = None        # défaut : ELYTRAS_PROVIDER
    model: str | None = None
    session_id: str | None = None      # si fourni : la conversation est persistée dans la session
    agent_id: str | None = None        # agent ciblé (défaut : orchestrateur)
    user_id: str = DEFAULT_USER


def _persist_session(req, content: str):
    if not getattr(req, "session_id", None):
        return
    msgs = list(req.messages) + [{"role": "assistant", "content": content}]
    s = sessions.get_session(req.user_id, req.session_id)
    title = None
    if s and (s.get("title") in (None, "", "Nouvelle session")):
        fu = next((m["content"] for m in req.messages if m.get("role") == "user"), "")
        title = fu[:60] if fu else None
    sessions.update_session(req.user_id, req.session_id, messages=msgs, title=title)


# La mémoire long terme est gérée par elytras/memory_engine.py (extraction de faits, dédup,
# rappel hybride scopé). Voir l'usage dans /chat ci-dessous.


def _gather_mcp_tools(user_id: str):
    """Outils de TOUS les serveurs MCP connectés -> format function Codex + mapping nom->(server_id, tool)."""
    tools, mapping = [], {}
    c = _conn_opt()
    servers = registry.list_servers(c)
    if c:
        c.close()
    for srv in servers:
        if not _can_use_server(user_id, srv):       # accès par équipe : ne pas exposer les outils interdits
            continue
        try:
            for t in mcp.list_tools(_with_token(srv, user_id)):
                fq = ("t_" + str(srv["id"])[:8] + "_" + t["name"]).replace("-", "_")[:64]
                mapping[fq] = (srv["id"], t["name"])
                tools.append({"type": "function", "name": fq,
                              "description": (f"[{srv['name']}] " + (t.get("description") or ""))[:1000],
                              "parameters": t.get("inputSchema") or {"type": "object", "properties": {}}})
        except Exception:
            continue
    return tools, mapping


# ───────────────────────── Audit (trace : qui a fait quoi, commandé par qui) ─────────────────────────
def _audit(action, agent="", detail="", user_id=None, project_id=None, session_id=None,
           parent_id=None, initiator=""):
    import time as _time
    import uuid as _uuid
    aid = str(_uuid.uuid4())
    filestore.put("audit", aid, {"ts": _time.time(), "action": action, "agent": agent, "detail": detail,
                                 "owner_id": user_id, "project_id": project_id, "session_id": session_id,
                                 "parent_id": parent_id, "initiator": initiator})
    return aid


def list_audit(user_id, project_ids, k=200):
    out = []
    for aid, e in filestore.items("audit").items():
        if e.get("owner_id") == user_id or e.get("project_id") in (project_ids or []):
            out.append({"id": aid, **e})
    out.sort(key=lambda e: e.get("ts", 0), reverse=True)
    return out[:k]


# ───────────────────────── Orchestre : exécute un agent (récursif pour la délégation) ─────────────────────────
_MAX_DEPTH = 2


# Actions « sensibles » (à valider en mode ASK) vs lecture seule (sûres).
_READONLY = re.compile(r"^(get|list|search|read|fetch|find|query|describe|show|count|view|lookup|stat|status)([_\-]|$)", re.I)


def _is_sensitive(name: str) -> bool:
    if name in ("use_skill", "delegate", "list_files", "read_file", "send_file", "browse"):
        return False
    if name in ("run_flow", "create_flow", "edit_flow"):
        return True
    return not bool(_READONLY.match(name or ""))      # outil MCP : sensible sauf lecture seule


def _action_allowed(user_id: str, name: str, mapping: dict) -> bool:
    """L'utilisateur a-t-il le droit d'effectuer cette action ? (sert à ne demander
    confirmation que pour une action réellement permise ; sinon refus immédiat au dispatch)."""
    if name == "create_flow":
        return rbac.has_cap(user_id, "flow.create")
    if name == "edit_flow":
        return rbac.has_cap(user_id, "flow.edit")
    if name == "run_flow":
        return rbac.has_cap(user_id, "flow.run")
    if name in ("list_files", "read_file", "send_file"):
        return rbac.has_cap(user_id, "file.read")
    if name == "write_file":
        return rbac.has_cap(user_id, "file.write")
    if name == "notify_user":
        return rbac.has_cap(user_id, "dispatch")
    if name == "browse":
        return rbac.has_cap(user_id, "web.browse")
    sid_, _tool = mapping.get(name, (None, None))
    if sid_:
        srv = registry.get_server(_conn_opt(), sid_)
        return bool(srv and _can_use_server(user_id, srv))
    return True


def _describe_action(name: str, args: dict) -> str:
    if name == "run_flow":
        return f"Exécuter le flow « {args.get('flow', '?')} »"
    if name == "create_flow":
        return "Créer un nouveau flow"
    if name == "edit_flow":
        return f"Modifier le flow « {args.get('flow', '?')} »"
    a = ", ".join(f"{k}={str(v)[:30]}" for k, v in (args or {}).items())
    return f"Appeler l'outil « {name} »" + (f" ({a})" if a else "")


def _agent_setup(agent, messages, mscope, mowner, mproj, user_id, depth):
    """Construit (instr système, tools, mapping) pour un agent — identique en run direct et reprise."""
    base_instr = agent.get("instructions") or "Tu es un assistant d'Elytras. Réponds clairement et de façon concise."
    last_user = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")
    mem = memory_engine.recall(mscope, mowner, mproj, query=last_user, k=12)
    if mem:
        label = "ce projet (partagé entre ses membres)" if mscope == "project" else "ton espace personnel"
        instr = ("Tu DISPOSES d'une mémoire persistante de " + label + ". Appuie-toi sur ces faits ; "
                 "ne dis JAMAIS que tu n'as pas de mémoire et n'invente rien.\nFaits mémorisés :\n"
                 + "\n".join("- " + m["content"] for m in mem) + "\n\n" + base_instr)
    else:
        instr = base_instr

    co = _company_md()                       # contexte entreprise (onboarding) injecté à TOUS, en lecture seule
    if co:
        instr = ("CONTEXTE DE L'ENTREPRISE (fourni par l'administration, LECTURE SEULE — ne le modifie jamais, "
                 "ne le contredis pas) :\n" + co.strip() + "\n\n" + instr)

    _caps = rbac.caps_for(user_id)
    _can_act = bool(set(_caps) - {"flow.view", "memory.view", "agent.use"})   # a-t-il des droits d'action ?
    tools, mapping = _gather_mcp_tools(user_id)
    sk = [s for s in skills.load_skills() if _can_use_skill(user_id, s["name"])]
    if sk:
        instr += ("\n\nSavoir-faire (skills) — appelle use_skill(name) pour la procédure détaillée :\n"
                  + "\n".join(f"- {s['name']} : {s['description']}" for s in sk))
        tools = tools + [{"type": "function", "name": "use_skill",
                          "description": "Charge la procédure détaillée d'une skill par son nom.",
                          "parameters": {"type": "object", "properties": {"name": {"type": "string"}},
                                         "required": ["name"]}}]
    if depth == 0 and _can_act:        # délégation réservée aux rôles qui peuvent agir (pas un lecteur)
        specialists = [a["name"] for a in agents.list_agents() if a["id"] != "orchestrateur"]
        if specialists:
            instr += "\n\nTu peux déléguer à un agent spécialisé : " + ", ".join(specialists) + " (via delegate)."
            tools = tools + [{"type": "function", "name": "delegate",
                              "description": "Délègue une sous-tâche à un agent spécialisé ; renvoie son résultat.",
                              "parameters": {"type": "object",
                                             "properties": {"agent": {"type": "string"}, "task": {"type": "string"}},
                                             "required": ["agent", "task"]}}]

    _flow_tools = []
    if "flow.create" in _caps:
        _flow_tools.append({"type": "function", "name": "create_flow",
                            "description": "Crée un nouveau flow (workflow) à partir d'une description en langage naturel.",
                            "parameters": {"type": "object",
                                           "properties": {"description": {"type": "string", "description": "ce que le flow doit faire"},
                                                          "name": {"type": "string"}}, "required": ["description"]}})
    if "flow.edit" in _caps:
        _flow_tools.append({"type": "function", "name": "edit_flow",
                            "description": "Modifie un flow existant (par nom ou id) selon une instruction en langage naturel.",
                            "parameters": {"type": "object",
                                           "properties": {"flow": {"type": "string", "description": "nom ou id du flow"},
                                                          "instruction": {"type": "string"}}, "required": ["flow", "instruction"]}})
    if _flow_tools:
        verbs = " et ".join(([" create_flow(description[, name])"] if "flow.create" in _caps else [])
                            + ([" edit_flow(flow, instruction)"] if "flow.edit" in _caps else []))
        instr += "\n\nTu peux concevoir des workflows :" + verbs + ". Ensuite, invite l'utilisateur à le vérifier dans l'onglet Flows."
        tools = tools + _flow_tools
    flow_list = flows.list_flows(user_id, [p["id"] for p in sessions.list_projects(user_id)])
    if flow_list and "flow.run" in _caps:
        def _flabel(f):
            ins = ", ".join(i.get("name", "") for i in (f.get("inputs") or []))
            return f"- {f['name']}" + (f" (entrées : {ins})" if ins else "") + (f" — {f['summary']}" if f.get("summary") else "")
        instr += ("\n\nFlows (workflows) que tu peux exécuter via run_flow(flow, inputs) — "
                  "flow = nom exact ci-dessous, inputs = objet des entrées :\n" + "\n".join(_flabel(f) for f in flow_list))
        tools = tools + [{"type": "function", "name": "run_flow",
                          "description": "Exécute un flow (workflow multi-étapes) par son nom et renvoie son résultat.",
                          "parameters": {"type": "object",
                                         "properties": {"flow": {"type": "string", "description": "nom ou id du flow"},
                                                        "inputs": {"type": "object", "description": "valeurs des entrées du flow"}},
                                         "required": ["flow"]}}]

    if "file.read" in _caps:                     # outils fichiers (espace scopé), selon les droits
        instr += ("\n\nFichiers : list_files() liste tes fichiers ; read_file(name) lit un fichier texte ; "
                  "send_file(name) ENVOIE un fichier à l'utilisateur dans la conversation (web ou Telegram).")
        tools = tools + [
            {"type": "function", "name": "list_files", "description": "Liste les fichiers accessibles.",
             "parameters": {"type": "object", "properties": {}}},
            {"type": "function", "name": "read_file", "description": "Lit le contenu texte d'un fichier par son nom.",
             "parameters": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}},
            {"type": "function", "name": "send_file",
             "description": "Livre un fichier à l'utilisateur dans le chat (téléchargement web / document Telegram).",
             "parameters": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}}]
        if "file.write" in _caps:
            instr += " write_file(name, content) crée/écrase un fichier dans ton espace."
            tools = tools + [{"type": "function", "name": "write_file",
                              "description": "Crée ou écrase un fichier texte dans l'espace de l'utilisateur.",
                              "parameters": {"type": "object",
                                             "properties": {"name": {"type": "string"}, "content": {"type": "string"}},
                                             "required": ["name", "content"]}}]

    if "web.browse" in _caps:                    # navigateur/scraping protégé
        instr += "\n\nWeb : browse(url) ouvre une page web (http/https) et renvoie son texte propre — pour consulter ou scraper des infos publiques."
        tools = tools + [{"type": "function", "name": "browse",
                          "description": "Ouvre une URL et renvoie le texte de la page (scraping/consultation d'infos publiques).",
                          "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}}]

    if "dispatch" in _caps:                      # dispatch : notifier un utilisateur (crée une session)
        instr += "\n\nDispatch : notify_user(user, message) envoie une notification à un utilisateur (par nom/email) ; cela ouvre une conversation qu'il pourra poursuivre."
        tools = tools + [{"type": "function", "name": "notify_user",
                          "description": "Notifie un utilisateur (Telegram + nouvelle session) ; il pourra questionner l'IA dessus.",
                          "parameters": {"type": "object",
                                         "properties": {"user": {"type": "string", "description": "nom ou email du destinataire"},
                                                        "message": {"type": "string"}}, "required": ["user", "message"]}}]

    # Honnêteté : l'agent connaît les droits réels de l'utilisateur et ne promet rien au-delà.
    _caps_h = sorted(rbac.CAP_LABELS.get(cp, cp) for cp in _caps)
    instr += ("\n\n[DROITS DE L'UTILISATEUR COURANT] Il a le droit de : "
              + (", ".join(_caps_h) if _caps_h else "consulter et discuter uniquement")
              + ".\nRègle stricte : n'annonce, ne propose et ne prétends pouvoir faire QUE des actions couvertes par ces droits "
              "et par les outils réellement fournis dans cette session — n'invente aucun outil. Si l'utilisateur demande une action "
              "qu'il n'a pas le droit d'effectuer (créer/modifier/exécuter un flow, connecter ou utiliser un connecteur MCP, exécuter "
              "du code, administrer…), explique-lui simplement que son rôle ne l'y autorise pas et qu'il doit voir avec un administrateur ; "
              "n'essaie pas de contourner et ne laisse pas entendre que ce serait possible.")
    return instr, tools, mapping


def _dispatch_call(name, args, agent, meta, used, mapping):
    """Exécute un appel d'outil et renvoie le résultat (sans gestion d'autonomie)."""
    user_id, mproj, session_id, parent_id, depth = (meta["user_id"], meta["mproj"], meta["session_id"],
                                                     meta["parent_id"], meta["depth"])
    mscope, mowner = meta["mscope"], meta["mowner"]
    if name == "use_skill":
        if not _can_use_skill(user_id, args.get("name", "")):
            return {"error": "accès refusé à cette skill"}
        body = skills.read_skill(args.get("name", ""))
        used.append("skill:" + str(args.get("name")))
        _audit("skill", agent=agent["name"], detail=str(args.get("name")), user_id=user_id,
               project_id=mproj, session_id=session_id, parent_id=parent_id)
        return {"skill": args.get("name"), "instructions": body} if body else {"error": "skill introuvable"}
    if name == "delegate" and depth < _MAX_DEPTH:
        sub = agents.get_agent(args.get("agent", ""))
        if not sub:
            return {"error": "agent inconnu"}
        did = _audit("delegate", agent=sub["name"], detail=(args.get("task", "") or "")[:200], user_id=user_id,
                     project_id=mproj, session_id=session_id, parent_id=parent_id, initiator=agent["name"])
        sub_ans, _su = run_agent(sub, [{"role": "user", "content": args.get("task", "")}],
                                 mscope, mowner, mproj, user_id, session_id, depth + 1, parent_id=did)
        used.append("delegate:" + sub["name"])
        return {"agent": sub["name"], "result": sub_ans}
    if name == "run_flow":
        if not rbac.has_cap(user_id, "flow.run"):
            return {"error": "non autorisé : capacité flow.run requise"}
        want = str(args.get("flow", "")).strip()
        accessible = flows.list_flows(user_id, [p["id"] for p in sessions.list_projects(user_id)])
        target = next((f for f in accessible if f["id"] == want or (f.get("name") or "").lower() == want.lower()), None)
        if not target:
            return {"error": f"flow « {want} » introuvable"}
        _audit("flow", agent=agent["name"], detail="run_flow → " + (target.get("name") or ""), user_id=user_id,
               project_id=mproj, session_id=session_id, parent_id=parent_id, initiator=agent["name"])
        r = run_flow(flows.get_flow(target["id"]), args.get("inputs") or {}, user_id)
        used.append("flow:" + (target.get("name") or target["id"]))
        res = {"flow": target.get("name"), "status": r.get("status"), "result": r.get("result"),
               "error": r.get("error"), "task_id": r.get("task_id")}
        if r.get("status") == "waiting":
            res["note"] = "flow suspendu : approbation humaine requise"
            res["approve_url"] = r.get("approve_url")
        return res
    if name == "create_flow":
        if not rbac.has_cap(user_id, "flow.create"):
            return {"error": "non autorisé : capacité flow.create requise"}
        try:
            spec = _ai_generate_flow(args.get("description", ""), user_id)
            nm = args.get("name") or spec.get("name") or "Flow IA"
            scope = "projet" if mscope == "project" else "perso"
            fid_new = flows.create_flow(user_id, nm, scope, mproj)
            flows.update_flow(fid_new, name=nm, summary=spec.get("summary"), inputs=spec.get("inputs"),
                              modules=spec.get("modules"), ui=spec.get("ui"))
            _audit("flow", agent=agent["name"], detail="create_flow → " + nm, user_id=user_id,
                   project_id=mproj, session_id=session_id, parent_id=parent_id, initiator=agent["name"])
            used.append("create_flow:" + nm)
            return {"created": nm, "flow_id": fid_new, "etapes": [m.get("summary") for m in spec.get("modules", [])]}
        except Exception as e:  # noqa: BLE001
            return {"error": str(e)}
    if name == "edit_flow":
        if not rbac.has_cap(user_id, "flow.edit"):
            return {"error": "non autorisé : capacité flow.edit requise"}
        want = str(args.get("flow", "")).strip()
        accessible = flows.list_flows(user_id, [p["id"] for p in sessions.list_projects(user_id)])
        target = next((f for f in accessible if f["id"] == want or (f.get("name") or "").lower() == want.lower()), None)
        if not target:
            return {"error": f"flow « {want} » introuvable"}
        try:
            full = flows.get_flow(target["id"])
            spec = _ai_edit_flow(full, args.get("instruction", ""), user_id)
            flows.update_flow(target["id"], name=spec.get("name") or full.get("name"), summary=spec.get("summary"),
                              inputs=spec.get("inputs"), modules=spec.get("modules"), ui=spec.get("ui"))
            _audit("flow", agent=agent["name"], detail="edit_flow → " + (target.get("name") or ""), user_id=user_id,
                   project_id=mproj, session_id=session_id, parent_id=parent_id, initiator=agent["name"])
            used.append("edit_flow:" + (target.get("name") or target["id"]))
            return {"edited": target.get("name"), "flow_id": target["id"], "etapes": [m.get("summary") for m in spec.get("modules", [])]}
        except Exception as e:  # noqa: BLE001
            return {"error": str(e)}
    if name in ("list_files", "read_file"):
        if not rbac.has_cap(user_id, "file.read"):
            return {"error": "non autorisé : capacité file.read requise"}
        fpids = [p["id"] for p in sessions.list_projects(user_id)]
        if name == "list_files":
            return {"files": [f["name"] for f in files.list_files(user_id, fpids)]}
        f = files.get_by_name(args.get("name", ""), user_id, fpids)
        return {"name": args.get("name"), "content": files.text_of(f)[:8000]} if f else {"error": "fichier introuvable"}
    if name == "send_file":
        if not rbac.has_cap(user_id, "file.read"):
            return {"error": "non autorisé : capacité file.read requise"}
        fpids = [p["id"] for p in sessions.list_projects(user_id)]
        f = files.get_by_name(args.get("name", ""), user_id, fpids)
        if not f:
            return {"error": "fichier introuvable"}
        meta.setdefault("attachments", []).append({"id": f["id"], "name": f.get("name")})
        return {"sent": f.get("name")}
    if name == "browse":
        if not rbac.has_cap(user_id, "web.browse"):
            return {"error": "non autorisé : capacité web.browse requise"}
        _audit("browse", agent=agent["name"], detail=str(args.get("url", ""))[:120], user_id=user_id,
               project_id=mproj, session_id=session_id, parent_id=parent_id)
        used.append("browse")
        return _browse(args.get("url", ""))
    if name == "notify_user":
        if not rbac.has_cap(user_id, "dispatch"):
            return {"error": "non autorisé : capacité dispatch requise"}
        want = str(args.get("user", "")).strip().lower()
        target = next((a["id"] for a in rbac.list_accounts()
                       if a["id"] == want or (a.get("email") or "").lower() == want
                       or (a.get("name") or "").lower() == want), None)
        if not target:
            return {"error": f"utilisateur « {args.get('user')} » introuvable"}
        r = dispatch_notify(target, args.get("message", ""), agent)
        _audit("dispatch", agent=agent["name"], detail="notify → " + str(args.get("user")), user_id=user_id,
               project_id=mproj, session_id=session_id, parent_id=parent_id, initiator=agent["name"])
        used.append("notify:" + str(args.get("user")))
        return {"notified": args.get("user"), **r}
    if name == "write_file":
        if not rbac.has_cap(user_id, "file.write"):
            return {"error": "non autorisé : capacité file.write requise"}
        scope, owner, proj = ("projet", None, mproj) if mscope == "project" else ("perso", user_id, None)
        fid = files.add_file(scope, owner, proj, args.get("name", "fichier"),
                             base64.b64encode((args.get("content", "") or "").encode()).decode(), "text/plain")
        _audit("file", agent=agent["name"], detail="write_file → " + args.get("name", ""), user_id=user_id,
               project_id=mproj, session_id=session_id, parent_id=parent_id)
        return {"written": args.get("name"), "id": fid}
    sid_, toolname = mapping.get(name, (None, None))
    if not sid_:
        return {"error": "outil inconnu"}
    srv = registry.get_server(_conn_opt(), sid_)
    if not srv or not _can_use_server(user_id, srv):     # accès au serveur (équipe) — défense en profondeur
        return {"error": "accès refusé à ce serveur MCP"}
    used.append(toolname)
    _audit("tool", agent=agent["name"], detail=toolname, user_id=user_id, project_id=mproj,
           session_id=session_id, parent_id=parent_id)
    try:
        return mcp.call_tool(_with_token(srv, user_id), toolname, args)
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


def _save_agent_pending(agent, meta, autonomy, input_items, queue, used, finalize):
    pid = secrets.token_urlsafe(12)
    filestore.put("agent_pending", pid, {"agent_id": agent["id"], "meta": meta, "autonomy": autonomy,
                                         "input_items": input_items, "queue": queue, "used": used,
                                         "finalize": finalize, "ts": time.time()})
    return pid


def _chat_finalize(finalize, answer):
    if not finalize:
        return
    sid = finalize.get("session_id")
    if sid:
        msgs = list(finalize.get("messages") or []) + [{"role": "assistant", "content": answer}]
        s = sessions.get_session(finalize["user_id"], sid)
        title = None
        if s and (s.get("title") in (None, "", "Nouvelle session")):
            fu = next((m["content"] for m in (finalize.get("messages") or []) if m.get("role") == "user"), "")
            title = fu[:60] if fu else None
        sessions.update_session(finalize["user_id"], sid, messages=msgs, title=title)

    def _bg():
        try:
            ex = providers.CodexProvider()
            memory_engine.remember(finalize["mscope"], finalize["mowner"], finalize["mproj"],
                                   finalize.get("last_user", ""), answer, sid or "", lambda m: ex.complete(m).text)
        except Exception:
            pass
    threading.Thread(target=_bg, daemon=True).start()


def _agent_done(answer, used, finalize, meta=None):
    _chat_finalize(finalize, answer)
    return {"done": True, "answer": answer, "used": used,
            "attachments": (meta or {}).get("attachments") or []}


def _agent_loop(agent, instr, tools, mapping, input_items, meta, used, autonomy, finalize, queue=None):
    cp = providers.CodexProvider()
    turns = 0
    while turns < 8:
        if queue is None:
            turn = cp.agent_turn(input_items, instr, tools or None)
            try:
                _record_usage(meta["user_id"], "codex", getattr(cp, "default_model", "codex"),
                              _est_tokens(instr) + sum(_est_tokens(json.dumps(it, ensure_ascii=False)) for it in input_items),
                              _est_tokens(turn.get("text", "")), "chat")
            except Exception:
                pass
            if not turn.get("tool_calls"):
                return _agent_done(turn.get("text") or "(réponse vide)", used, finalize, meta)
            queue = list(turn["tool_calls"])
            turns += 1
        while queue:
            call = queue[0]
            name = call["name"]
            try:
                args = json.loads(call.get("arguments") or "{}")
            except Exception:
                args = {}
            if autonomy == "ask" and _is_sensitive(name) and _action_allowed(meta["user_id"], name, mapping):
                pid = _save_agent_pending(agent, meta, autonomy, input_items, queue, used, finalize)
                return {"done": False, "pending_id": pid, "used": used,
                        "attachments": meta.get("attachments") or [],
                        "confirm": {"tool": name, "args": args, "summary": _describe_action(name, args)}}
            input_items.append({"type": "function_call", "call_id": call["call_id"],
                                "name": name, "arguments": call.get("arguments") or "{}"})
            result = _dispatch_call(name, args, agent, meta, used, mapping)
            input_items.append({"type": "function_call_output", "call_id": call["call_id"],
                                "output": json.dumps(result, ensure_ascii=False)[:8000]})
            queue.pop(0)
        queue = None
    return _agent_done("(trop d'étapes d'outils)", used, finalize, meta)


def _msgs_to_items(messages):
    return [{"role": m["role"],
             "content": [{"type": ("output_text" if m["role"] == "assistant" else "input_text"), "text": m["content"]}]}
            for m in messages if m.get("role") != "system"]


def run_agent(agent, messages, mscope, mowner, mproj, user_id, session_id, depth=0, parent_id=None):
    """Exécution NON interactive (délégation, flow, planif) : autonomie AUTO, jamais de pause."""
    instr, tools, mapping = _agent_setup(agent, messages, mscope, mowner, mproj, user_id, depth)
    meta = {"mscope": mscope, "mowner": mowner, "mproj": mproj, "user_id": user_id,
            "session_id": session_id, "parent_id": parent_id, "depth": depth}
    res = _agent_loop(agent, instr, tools, mapping, _msgs_to_items(messages), meta, [], "auto", None)
    return res["answer"], res["used"]


def run_agent_chat(agent, messages, mscope, mowner, mproj, user_id, session_id, parent_id=None, finalize=None):
    """Exécution INTERACTIVE (chat) : autonomie de l'agent (ASK = pause sur action sensible)."""
    instr, tools, mapping = _agent_setup(agent, messages, mscope, mowner, mproj, user_id, 0)
    meta = {"mscope": mscope, "mowner": mowner, "mproj": mproj, "user_id": user_id,
            "session_id": session_id, "parent_id": parent_id, "depth": 0}
    autonomy = (agent.get("autonomy") or "ask").lower()
    return _agent_loop(agent, instr, tools, mapping, _msgs_to_items(messages), meta, [], autonomy, finalize)


def resume_agent(pending_id, decision, actor):
    p = filestore.items("agent_pending").get(pending_id)
    if not p:
        return {"error": "demande de validation inconnue ou expirée"}
    if p["meta"].get("user_id") != actor:
        return {"error": "non autorisé"}
    filestore.delete("agent_pending", pending_id)
    agent = agents.get_agent(p["agent_id"]) or agents.get_agent("orchestrateur")
    meta = p["meta"]
    instr, tools, mapping = _agent_setup(agent, [{"role": "user", "content": p["finalize"].get("last_user", "") if p.get("finalize") else ""}],
                                         meta["mscope"], meta["mowner"], meta["mproj"], meta["user_id"], 0)
    input_items, queue, used = p["input_items"], p["queue"], p["used"]
    head = queue[0]
    try:
        args = json.loads(head.get("arguments") or "{}")
    except Exception:
        args = {}
    input_items.append({"type": "function_call", "call_id": head["call_id"],
                        "name": head["name"], "arguments": head.get("arguments") or "{}"})
    if decision == "approve":
        result = _dispatch_call(head["name"], args, agent, meta, used, mapping)
    else:
        _audit("refus", agent=agent["name"], detail=_describe_action(head["name"], args), user_id=meta["user_id"],
               project_id=meta["mproj"], session_id=meta["session_id"], parent_id=meta["parent_id"], initiator=meta["user_id"])
        result = {"refused": True, "message": "L'utilisateur a refusé cette action ; ne la réessaie pas."}
    input_items.append({"type": "function_call_output", "call_id": head["call_id"],
                        "output": json.dumps(result, ensure_ascii=False)[:8000]})
    return _agent_loop(agent, instr, tools, mapping, input_items, meta, used,
                       p["autonomy"], p.get("finalize"), queue=(queue[1:] or None))


# ───────────────────────── Tâches (suivi / kanban) ─────────────────────────
def _task_new(title, kind, steps, user_id, project_id=None):
    tid = str(uuid.uuid4())
    filestore.put("tasks", tid, {"title": title, "kind": kind, "status": "running", "steps": steps,
                                 "result": "", "owner_id": user_id, "project_id": project_id,
                                 "created_at": dt.datetime.now().timestamp(),
                                 "updated_at": dt.datetime.now().timestamp()})
    return tid


def _task_set(tid, **fields):
    t = filestore.items("tasks").get(tid)
    if not t:
        return
    t.update(fields)
    t["updated_at"] = dt.datetime.now().timestamp()
    filestore.put("tasks", tid, t)


def list_tasks(user_id, project_ids, k=100):
    out = []
    for tid, t in filestore.items("tasks").items():
        if t.get("owner_id") == user_id or t.get("project_id") in (project_ids or []):
            out.append({"id": tid, **t})
    out.sort(key=lambda e: e.get("created_at", 0), reverse=True)
    return out[:k]


# ───────────────────────── Moteur de flows (façon Windmill) ─────────────────────────
# Modèle inspiré d'OpenFlow : modules typés (agent/tool/code/note/forloop/branch*/while/approval),
# référencement par expressions sur flow_input/results/item/index, config avancée par module
# (retry, timeout, cache, mock, early-stop, skip, sleep), et suspension/reprise pour l'approbation.

class _Dot(dict):
    """Dict accessible aussi par attribut (results.maStep, item.nom…) ; clé absente → ''."""
    def __getattr__(self, k):
        try:
            return self[k]
        except KeyError:
            return ""

    def __setattr__(self, k, v):
        self[k] = v


def _wrap(x):
    if isinstance(x, dict):
        return _Dot({k: _wrap(v) for k, v in x.items()})
    if isinstance(x, list):
        return [_wrap(v) for v in x]
    return x


def _plain(x):
    try:
        return json.loads(json.dumps(x, default=str)) if x is not None else None
    except Exception:
        return str(x)


_SAFE_BUILTINS = {"len": len, "range": range, "str": str, "int": int, "float": float, "bool": bool,
                  "min": min, "max": max, "sum": sum, "sorted": sorted, "abs": abs, "round": round,
                  "any": any, "all": all, "list": list, "dict": dict, "set": set, "tuple": tuple,
                  "enumerate": enumerate, "zip": zip, "map": map, "filter": filter, "reversed": reversed,
                  "True": True, "False": False, "None": None}


def _eval(expr, ns):
    """Évalue une expression Python sur un namespace restreint (sans builtins dangereux)."""
    if expr is None or str(expr).strip() == "":
        return None
    try:
        return eval(expr, {"__builtins__": {}}, {**_SAFE_BUILTINS, **ns})  # noqa: S307 (namespace restreint)
    except Exception as e:
        raise ValueError(f"expression invalide « {expr} » : {e}")


def _render(tpl, ns):
    """Interpole {{ expr }} dans une chaîne. Repli sur l'accès par points (rétro-compat)."""
    if not isinstance(tpl, str):
        return tpl

    def sub(mm):
        expr = mm.group(1).strip()
        try:
            v = _eval(expr, ns)
        except Exception:
            cur = ns
            for p in expr.split("."):
                cur = cur.get(p, "") if isinstance(cur, dict) else getattr(cur, p, "")
            v = cur
        if v is None:
            return ""
        return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str) if isinstance(v, (dict, list)) else str(v)
    return re.sub(r"\{\{\s*([^}]+?)\s*\}\}", sub, tpl)


def _short(v):
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str)
    return s[:2000]


class _StopFlow(Exception):
    def __init__(self, value):
        self.value = value


class _Suspend(Exception):
    def __init__(self, payload):
        self.payload = payload


def _with_retry(fn, retry):
    retry = retry or {}
    attempts = max(1, int(retry.get("attempts") or 0) + 1)
    delay = float(retry.get("delay_s") or 0)
    mode = retry.get("mode", "constant")
    last = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            last = e
            if i < attempts - 1 and delay:
                time.sleep(delay * (2 ** i if mode == "exponential" else 1))
    raise last


def _with_timeout(fn, t):
    t = float(t or 0)
    if t <= 0:
        return fn()
    box = {}

    def run():
        try:
            box["r"] = fn()
        except Exception as e:  # noqa: BLE001
            box["e"] = e
    th = threading.Thread(target=run, daemon=True)
    th.start()
    th.join(t)
    if th.is_alive():
        raise TimeoutError(f"délai dépassé ({t:g}s)")
    if "e" in box:
        raise box["e"]
    return box.get("r")


# Bac à sable du code : auto = utilise sandbox-exec (macOS) / bwrap (Linux) si dispo ;
# on = exige un bac à sable (échoue sinon) ; off = sous-processus nu.
_SANDBOX_MODE = os.environ.get("ELYTRAS_CODE_SANDBOX", "auto").lower()


def _sandbox_cmd(base_cmd, script_path, work=None):
    """Enveloppe la commande dans un bac à sable (FS lecture seule + réseau coupé).

    `work` (si fourni) est monté en lecture-écriture (dossiers in/ et out/ des fichiers).
    Renvoie (cmd, sandboxed). Repli gracieux si aucun outil dispo (sauf mode 'on').
    """
    if _SANDBOX_MODE == "off":
        return base_cmd, False
    if sys.platform == "darwin" and shutil.which("sandbox-exec"):
        profile = ('(version 1)(deny default)(allow process*)(allow sysctl-read)(allow mach-lookup)'
                   '(allow file-read*)'
                   '(allow file-write* (subpath "/tmp")(subpath "/private/tmp")'
                   '(subpath "/var/folders")(subpath "/private/var/folders"))'
                   '(deny network*)')
        return ["sandbox-exec", "-p", profile] + base_cmd, True
    if sys.platform.startswith("linux") and shutil.which("bwrap"):
        cmd = ["bwrap", "--ro-bind", "/", "/"]
        if work:
            cmd += ["--bind", work, work]          # dossier de travail accessible en écriture
        else:
            cmd += ["--tmpfs", "/tmp", "--ro-bind", script_path, script_path]
        cmd += ["--proc", "/proc", "--dev", "/dev", "--unshare-net", "--die-with-parent", "--"]
        return cmd + base_cmd, True
    if _SANDBOX_MODE == "on":
        raise RuntimeError("bac à sable exigé (ELYTRAS_CODE_SANDBOX=on) mais ni sandbox-exec ni bwrap trouvés")
    return base_cmd, False


def _run_code(content, ns, timeout_s, meta=None):
    """Exécute du Python inline dans un sous-processus isolé (réseau coupé, FS lecture seule).

    Dispo dans le code : flow_input, results, item, index, ainsi que **input_dir** (fichiers
    d'entrée montés en lecture seule) et **output_dir** (y écrire des fichiers → sauvegardés
    dans l'espace scopé = sortie fichier du flow). Renvoie via `result = …` (ou `main()`).
    """
    work = tempfile.mkdtemp(prefix="elytras_")
    indir, outdir = os.path.join(work, "in"), os.path.join(work, "out")
    os.makedirs(indir)
    os.makedirs(outdir)
    for fname, frec in ((meta or {}).get("files") or {}).items():     # matérialise les fichiers d'entrée
        try:
            raw = base64.b64decode((frec.get("b64") or "").encode())
            with open(os.path.join(indir, os.path.basename(frec.get("name") or fname)), "wb") as fh:
                fh.write(raw)
        except Exception:
            pass
    payload = json.dumps({"flow_input": _plain(ns.get("flow_input")), "results": _plain(ns.get("results")),
                          "item": _plain(ns.get("item")), "index": ns.get("index"),
                          "input_dir": indir, "output_dir": outdir}, default=str)
    prog = ("import json as _j, sys as _s\n"
            "class _D(dict):\n"
            "    def __getattr__(self, k):\n"
            "        try: return self[k]\n"
            "        except KeyError: return None\n"
            "def _w(x):\n"
            "    if isinstance(x, dict): return _D({k: _w(v) for k, v in x.items()})\n"
            "    if isinstance(x, list): return [_w(v) for v in x]\n"
            "    return x\n"
            "_ctx=_j.loads(_s.stdin.read())\n"
            "flow_input=_w(_ctx['flow_input'])\nresults=_w(_ctx['results'])\nitem=_w(_ctx.get('item'))\nindex=_ctx.get('index')\n"
            "input_dir=_ctx.get('input_dir')\noutput_dir=_ctx.get('output_dir')\n"
            "result=None\n"
            "# ───── code utilisateur ─────\n"
            + (content or "") + "\n"
            "# ───── fin ─────\n"
            "_out=main() if ('main' in dir() and callable(main)) else result\n"
            "_s.stdout.write('\\x1e'+_j.dumps(_out, default=str))\n")
    path = os.path.join(work, "_run.py")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(prog)
    try:
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/tmp"),
               "LANG": os.environ.get("LANG", "C.UTF-8")}
        cmd, _sb = _sandbox_cmd([sys.executable, "-I", path], path, work)
        p = subprocess.run(cmd, input=payload, capture_output=True, text=True,
                           timeout=float(timeout_s or 30), env=env)
        rc, stdout, stderr = p.returncode, p.stdout, p.stderr
        # Sauvegarde des fichiers produits dans out/ → espace scopé (sortie fichier du flow)
        if meta is not None and "out_scope" in meta:
            for fn in sorted(os.listdir(outdir)):
                fp = os.path.join(outdir, fn)
                if os.path.isfile(fp) and os.path.getsize(fp) <= files.MAX_BYTES:
                    b64 = base64.b64encode(open(fp, "rb").read()).decode()
                    files.add_file(meta["out_scope"], meta.get("out_owner"), meta.get("out_project"), fn, b64)
                    meta.setdefault("files_out", []).append(fn)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    if rc != 0:
        raise RuntimeError((stderr or "erreur d'exécution du code").strip()[:600])
    if "\x1e" in stdout:
        _, _, tail = stdout.rpartition("\x1e")
        try:
            return json.loads(tail)
        except Exception:
            return tail.strip()
    return stdout.strip()


def _cache_key(meta, m, ns):
    raw = f"{meta.get('fid')}:{m.get('id')}:{json.dumps(_plain(ns.get('flow_input')), sort_keys=True, default=str)}"
    return hashlib.sha1(raw.encode()).hexdigest()


def _dispatch_leaf(m, ns, meta):
    t = m.get("type")
    if t == "agent":
        ag = agents.get_agent(m.get("agent_id") or "orchestrateur") or agents.get_agent("orchestrateur")
        _audit("agent", agent=ag["name"], detail=(m.get("summary") or "")[:60], user_id=meta["mowner"] or meta["user_id"],
               project_id=meta["mproj"], parent_id=meta["root"])
        out, _u = run_agent(ag, [{"role": "user", "content": _render(m.get("prompt", ""), ns)}],
                            meta["mscope"], meta["mowner"], meta["mproj"], meta["user_id"], None,
                            depth=0, parent_id=meta["root"])
        return out
    if t == "tool":
        srv = registry.get_server(_conn_opt(), m.get("server_id"))
        args = {k: (_render(v, ns) if isinstance(v, str) else v) for k, v in (m.get("args") or {}).items()}
        _audit("tool", agent=m.get("summary") or m.get("tool", ""), detail=m.get("tool", ""),
               user_id=meta["mowner"] or meta["user_id"], project_id=meta["mproj"], parent_id=meta["root"])
        if not srv:
            return {"error": "serveur MCP inconnu"}
        res = mcp.call_tool(_with_token(srv, meta["user_id"]), m.get("tool", ""), args)
        return res.get("data", res) if isinstance(res, dict) else str(res)
    if t == "code":
        if not rbac.has_cap(meta["user_id"], "code.execute"):
            raise PermissionError("exécution de code non autorisée pour cet utilisateur (capacité code.execute requise)")
        _audit("code", agent=m.get("summary") or "code", detail="python", user_id=meta["mowner"] or meta["user_id"],
               project_id=meta["mproj"], parent_id=meta["root"])
        return _run_code(m.get("content", ""), ns, m.get("timeout_s"), meta)
    # note
    return _render(m.get("text", ""), ns)


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "_", str(s).lower()).strip("_")


def _store_result(ns, m, res):
    rid = m.get("id") or m.get("summary")
    wrapped = _wrap(res)
    ns["results"][rid] = wrapped
    if m.get("summary"):                       # accessible aussi par le nom et par un slug
        ns["results"][m["summary"]] = wrapped
        sl = _slug(m["summary"])
        if sl:
            ns["results"].setdefault(sl, wrapped)
    return wrapped


def _exec_one(m, ns, meta):
    """Exécute un module et stocke son résultat dans ns['results']. Retourne (résultat, skipped)."""
    # skip conditionnel
    sk = m.get("skip_if") or {}
    if sk.get("enabled") and bool(_eval(sk.get("expr"), ns)):
        _store_result(ns, m, None)
        return None, True
    # mock / pin result
    mk = m.get("mock") or {}
    if mk.get("enabled"):
        val = mk.get("value")
        res = _render(val, ns) if isinstance(val, str) else val
        res = _store_result(ns, m, res)
    else:
        t = m.get("type")
        if t == "approval":
            raise _Suspend({"message": _render(m.get("message", ""), ns), "module": m.get("summary")})
        if t in flows.CONTAINER_TYPES:
            res = _store_result(ns, m, _exec_container(m, ns, meta))
        else:
            def call():
                return _dispatch_leaf(m, ns, meta)
            ttl = int(m.get("cache_ttl") or 0)
            if ttl > 0:
                key = _cache_key(meta, m, ns)
                c = filestore.items("flow_cache").get(key)
                if c and (time.time() - c.get("ts", 0)) < ttl:
                    res = _store_result(ns, m, c["value"])
                else:
                    out = _with_retry(lambda: _with_timeout(call, m.get("timeout_s")), m.get("retry"))
                    filestore.put("flow_cache", key, {"value": _plain(out), "ts": time.time()})
                    res = _store_result(ns, m, out)
            else:
                out = _with_retry(lambda: _with_timeout(call, m.get("timeout_s")), m.get("retry"))
                res = _store_result(ns, m, out)
    if m.get("sleep_s"):
        time.sleep(min(float(m.get("sleep_s") or 0), 30))
    st = m.get("stop_after_if") or {}
    if st.get("enabled") and bool(_eval(st.get("expr"), ns)):
        raise _StopFlow(res)
    return res, False


def _child_ns(ns):
    """Copie superficielle du namespace avec un dict 'results' indépendant (pour le // )."""
    c = dict(ns)
    c["results"] = _Dot(dict(ns.get("results") or {}))
    c["step"] = c["results"]
    return c


def _exec_container(m, ns, meta):
    t = m.get("type")
    if t == "forloop":
        items = _eval(m.get("iterator"), ns)
        if items is None:
            items = []
        if isinstance(items, dict):
            items = list(items.items())
        items = list(items)
        if m.get("parallel") and len(items) > 1:
            def _one(pair):
                idx, it = pair
                cns = _child_ns(ns)
                cns["item"] = _wrap(it)
                cns["index"] = idx
                return idx, _run_modules(m.get("modules") or [], cns, meta)
            out = [None] * len(items)
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(items))) as ex:
                for idx, val in ex.map(_one, list(enumerate(items))):
                    out[idx] = val
            return out
        results = []
        saved = (ns.get("item"), ns.get("index"))
        try:
            for idx, it in enumerate(items):
                ns["item"] = _wrap(it)
                ns["index"] = idx
                results.append(_run_modules(m.get("modules") or [], ns, meta))
        finally:
            ns["item"], ns["index"] = saved
        return results
    if t == "whileloop":
        last = None
        n = 0
        cap = int(m.get("max_iter") or 100)
        while n < cap:
            ns["index"] = n
            if not bool(_eval(m.get("condition") or "False", ns)):
                break
            last = _run_modules(m.get("modules") or [], ns, meta)
            n += 1
        return last
    if t == "branchone":
        for b in (m.get("branches") or []):
            if bool(_eval(b.get("expr") or "False", ns)):
                return _run_modules(b.get("modules") or [], ns, meta)
        return _run_modules(m.get("default_modules") or [], ns, meta)
    if t == "branchall":
        branches = m.get("branches") or []
        if m.get("parallel") and len(branches) > 1:
            def _one(b):
                return _run_modules(b.get("modules") or [], _child_ns(ns), meta)
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(branches))) as ex:
                return list(ex.map(_one, branches))
        return [_run_modules(b.get("modules") or [], ns, meta) for b in branches]
    return None


def _run_modules(modules, ns, meta):
    """Exécute une liste de sous-modules (dans une boucle/branche). Retourne le dernier résultat."""
    last = None
    for m in modules:
        if m.get("type") == "approval":
            raise ValueError("approbation autorisée au niveau racine du flow uniquement")
        res, _sk = _exec_one(m, ns, meta)
        last = res
    return last


def _new_ns(inputs):
    fi = _wrap(inputs or {})
    res = _Dot()
    return {"flow_input": fi, "input": fi, "results": res, "step": res, "item": "", "index": 0}


def _top_run(flow, ns, meta, task_steps, start=0):
    tid = meta["tid"]
    modules = flow.get("modules", [])
    last = None
    i = start
    while i < len(modules):
        m = modules[i]
        task_steps[i]["status"] = "running"
        _task_set(tid, steps=task_steps)
        try:
            res, skipped = _exec_one(m, ns, meta)
        except _Suspend as s:
            token = secrets.token_urlsafe(16)
            filestore.put("flow_suspended", token, {
                "flow_id": flow["id"], "tid": tid, "next_index": i + 1,
                "results": _plain(ns["results"]), "inputs": _plain(ns["flow_input"]),
                "meta": {k: meta[k] for k in ("mscope", "mowner", "mproj", "root", "user_id", "fid")},
                "message": s.payload.get("message", "")})
            task_steps[i]["status"] = "waiting"
            _task_set(tid, steps=task_steps, status="waiting")
            base = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")
            return {"task_id": tid, "status": "waiting", "resume_token": token,
                    "message": s.payload.get("message", ""),
                    "approve_url": f"{base}/flows/resume/{token}?decision=approve",
                    "reject_url": f"{base}/flows/resume/{token}?decision=reject"}
        except _StopFlow as st:
            task_steps[i]["status"] = "done"
            _task_set(tid, steps=task_steps, status="done", result=_short(st.value))
            return {"task_id": tid, "status": "done", "result": st.value, "stopped": True,
                    "results": _plain(ns["results"])}
        except Exception as e:  # noqa: BLE001
            if m.get("continue_on_error"):
                task_steps[i]["status"] = "error"
                task_steps[i]["error"] = str(e)
                _store_result(ns, m, {"error": str(e)})
                _task_set(tid, steps=task_steps)
                last = {"error": str(e)}
                i += 1
                continue
            task_steps[i]["status"] = "error"
            task_steps[i]["error"] = str(e)
            _task_set(tid, steps=task_steps, status="error", result=str(e))
            return {"task_id": tid, "status": "error", "error": str(e), "failed_step": m.get("summary"),
                    "results": _plain(ns["results"])}
        task_steps[i]["status"] = "skipped" if skipped else "done"
        _task_set(tid, steps=task_steps)
        last = res
        i += 1
    _task_set(tid, status="done", result=_short(last))
    return {"task_id": tid, "status": "done", "result": last, "results": _plain(ns["results"]),
            "files_out": meta.get("files_out") or []}


_flow_nest = threading.local()   # garde anti-récursion (flow → étape agent → run_flow → …)


def run_flow(flow, inputs, user_id, up_to=None):
    depth = getattr(_flow_nest, "d", 0)
    if depth >= 3:
        return {"status": "error", "error": "profondeur de flows imbriqués dépassée (max 3)"}
    _flow_nest.d = depth + 1
    try:
        flow = flows.get_flow(flow.get("id")) or flow   # fraîche + normalisée
        if flow.get("scope") == "projet":
            mscope, mowner, mproj = "project", None, flow.get("project_id")
        else:
            mscope, mowner, mproj = "user", flow.get("owner_id") or user_id, None
        modules = flow.get("modules", [])
        if up_to:                                       # « tester jusqu'à » : tronque la liste
            ids = [m.get("id") for m in modules]
            if up_to in ids:
                flow = {**flow, "modules": modules[:ids.index(up_to) + 1]}
                modules = flow["modules"]
        # entrées de type « file » : contenu texte injecté dans flow_input + fichiers montés dans le sandbox
        inputs = dict(inputs or {})
        fpids = [p["id"] for p in sessions.list_projects(user_id)]
        flow_files = {}
        for it in flow.get("inputs", []):
            if it.get("type") == "file" and inputs.get(it["name"]):
                ref = inputs[it["name"]]
                fobj = files.get_file(ref, user_id, fpids) or files.get_by_name(ref, user_id, fpids)
                inputs[it["name"]] = files.text_of(fobj) if fobj else ""
                if fobj:
                    flow_files[it["name"]] = fobj          # pour le montage dans le bac à sable du code
        task_steps = [{"name": m.get("summary") or m.get("type"), "status": "pending"} for m in modules]
        tid = _task_new(flow.get("name", "flow"), "flow", task_steps, flow.get("owner_id") or user_id, mproj)
        root = _audit("flow", agent=flow.get("name", "flow"), detail=f"{len(modules)} modules",
                      user_id=mowner or user_id, project_id=mproj, initiator=f"flow:{flow.get('id', '')}")
        ns = _new_ns(inputs or {})
        meta = {"mscope": mscope, "mowner": mowner, "mproj": mproj,
                "user_id": flow.get("owner_id") or user_id, "root": root, "tid": tid, "fid": flow.get("id", ""),
                "files": flow_files, "files_out": [],
                "out_scope": "projet" if mscope == "project" else "perso",
                "out_owner": None if mscope == "project" else (flow.get("owner_id") or user_id),
                "out_project": mproj}
        return _top_run(flow, ns, meta, task_steps, start=0)
    finally:
        _flow_nest.d = depth


def resume_flow(token, decision):
    s = filestore.items("flow_suspended").get(token)
    if not s:
        return {"error": "jeton d'approbation inconnu ou déjà utilisé"}
    filestore.delete("flow_suspended", token)
    flow = flows.get_flow(s["flow_id"])
    tid = s["tid"]
    t = filestore.items("tasks").get(tid) or {}
    task_steps = t.get("steps", [])
    idx = s["next_index"] - 1
    if decision != "approve":
        if 0 <= idx < len(task_steps):
            task_steps[idx]["status"] = "error"
            task_steps[idx]["error"] = "approbation refusée"
        _task_set(tid, steps=task_steps, status="error", result="Approbation refusée")
        return {"task_id": tid, "status": "rejected"}
    if not flow:
        return {"error": "flow introuvable"}
    if 0 <= idx < len(task_steps):
        task_steps[idx]["status"] = "done"
    _task_set(tid, steps=task_steps, status="running")
    ns = _new_ns(s.get("inputs") or {})
    ns["results"] = _wrap(s.get("results") or {})
    ns["step"] = ns["results"]
    meta = {**s["meta"], "tid": tid}
    return _top_run(flow, ns, meta, task_steps, start=s["next_index"])


# ───────────────────────── Génération de flow par IA ─────────────────────────
_FLOW_GEN_SYS = """Tu es un concepteur de workflows pour Elytras. À partir de la demande de l'utilisateur, tu produis UN flow.

Réponds UNIQUEMENT avec du JSON valide — aucun texte autour, pas de balises ``` — de la forme :
{"name":"Nom court","summary":"résumé en une phrase","inputs":[{"name":"sujet","type":"string","required":true}],"modules":[ ... ]}

Chaque module a un "id" court en snake_case (sans espace, ex. "resume_ventes"), un "summary" (nom court) et un "type". Réfère les sorties par cet id : {{ results.resume_ventes }}. Types :
- "agent"     : {"id","summary","type":"agent","agent_id":"<id d'agent ci-dessous>","prompt":"..."}
- "code"      : {"summary","type":"code","content":"# python ; définir result\\nresult = ..."}
- "tool"      : {"summary","type":"tool","server_id":"<nom de serveur>","tool":"<nom d'outil>","args":{}}
- "note"      : {"summary","type":"note","text":"..."}
- "forloop"   : {"summary","type":"forloop","iterator":"<expr liste>","modules":[...]}
- "branchone" : {"summary","type":"branchone","branches":[{"summary","expr":"<condition>","modules":[...]}],"default_modules":[...]}
- "branchall" : {"summary","type":"branchall","branches":[{"summary","modules":[...]}]}
- "whileloop" : {"summary","type":"whileloop","condition":"<expr>","modules":[...]}
- "approval"  : {"summary","type":"approval","message":"..."}  (validation humaine ; uniquement au niveau racine)

Références : dans les textes/prompts, {{ flow_input.nom }} et {{ results.<idÉtape> }}. Dans une étape code : flow_input.x et results.x. Dans les expressions (iterator/expr/condition) : du Python sur flow_input, results, item, index.

Règles : reste simple et exécutable (≤ 8 étapes) ; n'emploie une étape "tool" QUE si l'outil figure dans la liste fournie, sinon préfère "agent" ou "code" ; n'invente aucun agent/outil/serveur hors des listes. Réponds en JSON pur."""


def _parse_json_block(raw):
    s = (raw or "").strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\n?", "", s)
        s = re.sub(r"\n?```$", "", s).strip()
    try:
        return json.loads(s)
    except Exception:
        a, b = s.find("{"), s.rfind("}")
        if a >= 0 and b > a:
            return json.loads(s[a:b + 1])
        raise


def _resolve_agent_id(aid, ags):
    if any(a["id"] == aid for a in ags):
        return aid
    a = str(aid or "").strip().lower()
    for ag in ags:                                   # id ou nom exact
        if ag["id"].lower() == a or ag["name"].lower() == a:
            return ag["id"]
    for ag in ags:                                   # sous-chaîne (« Ventes » → « Ventes/CRM »)
        if a and (a in ag["name"].lower() or a in ag["id"].lower() or ag["id"].lower() in a):
            return ag["id"]
    return "orchestrateur"


def _coerce_flow_spec(data, ags, old_pos=None):
    def fix(mods):
        out = []
        for m in (mods or []):
            if not isinstance(m, dict):
                continue
            if m.get("type") not in flows.ALL_TYPES:
                m["type"] = "note"
            m.setdefault("id", flows.new_module_id())
            if m["type"] == "agent":
                m["agent_id"] = _resolve_agent_id(m.get("agent_id") or "", ags)
            for key in ("modules", "default_modules"):
                if isinstance(m.get(key), list):
                    m[key] = fix(m[key])
            if isinstance(m.get("branches"), list):
                for b in m["branches"]:
                    if isinstance(b, dict) and isinstance(b.get("modules"), list):
                        b["modules"] = fix(b["modules"])
            out.append(m)
        return out

    modules = fix(data.get("modules"))
    inputs = data.get("inputs") if isinstance(data.get("inputs"), list) else []
    old_pos = old_pos or {}
    pos = {m["id"]: (old_pos.get(m["id"]) or {"x": 40, "y": 30 + i * 86}) for i, m in enumerate(modules)}
    return {"name": data.get("name") or "Flow IA", "summary": data.get("summary", ""),
            "inputs": inputs, "modules": modules, "ui": {"pos": pos}}


def _flow_ai_context(user_id):
    """Texte (catalogue agents/outils/serveurs/skills) injecté dans le prompt système IA."""
    ags = agents.list_agents()
    sk = skills.load_skills()
    servers = registry.list_servers(_conn_opt())
    tools, _m = _gather_mcp_tools(user_id)
    ag_lines = "\n".join(f"- {a['name']} (id: {a['id']}) — {a.get('role', '')}" for a in ags) or "- orchestrateur (id: orchestrateur)"
    tool_lines = "\n".join(f"- {t['name']} : {(t.get('description') or '')[:80]}" for t in tools) or "(aucun outil MCP — n'utilise pas de module tool)"
    srv_lines = ", ".join(s["name"] for s in servers) or "(aucun)"
    sk_lines = "\n".join(f"- {s['name']}" for s in sk) or "(aucune)"
    ctx = ("\n\nAgents disponibles :\n" + ag_lines + "\n\nOutils MCP disponibles :\n" + tool_lines
           + "\n\nServeurs MCP : " + srv_lines + "\nSkills : " + sk_lines)
    return ctx, ags


def _ai_complete_flow(sys_msg, user_msg, ags, old_pos=None, _uid=DEFAULT_USER):
    raw = providers.CodexProvider().complete(
        [{"role": "system", "content": sys_msg}, {"role": "user", "content": user_msg}]).text
    try:
        _record_usage(_uid, "codex", os.environ.get("CODEX_MODEL", "gpt-5.4-mini"),
                      _est_tokens(sys_msg) + _est_tokens(user_msg), _est_tokens(raw), "flow-ai")
    except Exception:
        pass
    data = _parse_json_block(raw)
    if not isinstance(data, dict):
        raise ValueError("réponse IA non exploitable")
    return _coerce_flow_spec(data, ags, old_pos)


def _ai_generate_flow(prompt, user_id):
    ctx, ags = _flow_ai_context(user_id)
    return _ai_complete_flow(_FLOW_GEN_SYS + ctx, prompt, ags, _uid=user_id)


def _flow_for_ai(flow):
    """Vue compacte du flow (sans champs avancés par défaut) pour l'envoyer au LLM."""
    def strip(m):
        keep = {k: m[k] for k in ("id", "summary", "type", "agent_id", "prompt", "server_id",
                                   "tool", "args", "content", "text", "iterator", "condition",
                                   "max_iter", "message", "parallel") if k in m and m[k] not in (None, "", {}, [])}
        for key in ("modules", "default_modules"):
            if m.get(key):
                keep[key] = [strip(x) for x in m[key]]
        if m.get("branches"):
            keep["branches"] = [{kk: (b.get(kk) if kk != "modules" else [strip(x) for x in b.get("modules", [])])
                                 for kk in ("summary", "expr", "modules") if kk in b} for b in m["branches"]]
        return keep
    return {"name": flow.get("name"), "summary": flow.get("summary", ""),
            "inputs": flow.get("inputs", []), "modules": [strip(m) for m in flow.get("modules", [])]}


def _ai_edit_flow(flow, instruction, user_id):
    ctx, ags = _flow_ai_context(user_id)
    sys_msg = (_FLOW_GEN_SYS + ctx
               + "\n\nFLOW ACTUEL (à modifier) — JSON :\n" + json.dumps(_flow_for_ai(flow), ensure_ascii=False)
               + "\n\nApplique la modification demandée et renvoie le flow COMPLET modifié en JSON. "
                 "CONSERVE le champ \"id\" des étapes inchangées (ne les renomme pas) ; ne touche qu'à ce qui est nécessaire.")
    old_pos = (flow.get("ui") or {}).get("pos") or {}
    return _ai_complete_flow(sys_msg, instruction, ags, old_pos, _uid=user_id)


def _run_schedule(sid, s):
    """Exécute une tâche planifiée : un FLOW si flow_id, sinon un agent sur l'objectif."""
    if s.get("flow_id"):
        f = flows.get_flow(s["flow_id"])
        if not f:
            return "flow introuvable"
        r = run_flow(f, {}, s.get("owner_id"))
        return str(r.get("result") or r.get("status"))[:300]
    agent = agents.get_agent(s.get("agent_id") or "orchestrateur") or agents.get_agent("orchestrateur")
    if s.get("scope") == "projet":
        mscope, mowner, mproj = "project", None, s.get("project_id")
    else:
        mscope, mowner, mproj = "user", s.get("owner_id"), None
    root = _audit("schedule", agent=agent["name"], detail=s.get("name", ""), user_id=s.get("owner_id"),
                  project_id=mproj, initiator="planificateur")
    answer, _u = run_agent(agent, [{"role": "user", "content": s.get("prompt", "")}],
                           mscope, mowner, mproj, s.get("owner_id"), None, depth=0, parent_id=root)
    try:
        ex = providers.CodexProvider()
        memory_engine.remember(mscope, mowner, mproj, s.get("prompt", ""), answer, "",
                               lambda msgs: ex.complete(msgs).text)
    except Exception:
        pass
    return answer


scheduler.start(_run_schedule)


# ───────────────────────── Dispatch Telegram (un bot par agent) ─────────────────────────
def _tg(token, method, **params):
    r = httpx.post(f"https://api.telegram.org/bot{token}/{method}", json=params, timeout=30)
    return r.json()


def telegram_send(token, chat_id, text, reply_markup=None):
    p = {"chat_id": chat_id, "text": (text or "")[:4000]}
    if reply_markup:
        p["reply_markup"] = reply_markup
    return _tg(token, "sendMessage", **p)


def telegram_send_document(token, chat_id, name, raw):
    try:
        r = httpx.post(f"https://api.telegram.org/bot{token}/sendDocument",
                       data={"chat_id": chat_id}, files={"document": (name, raw)}, timeout=60)
        return r.json()
    except Exception as e:                       # noqa: BLE001
        return {"ok": False, "error": str(e)}


def _tg_kb(pid):
    return {"inline_keyboard": [[{"text": "✓ Approuver", "callback_data": "ok:" + pid},
                                 {"text": "✗ Refuser", "callback_data": "no:" + pid}]]}


def _tg_deliver(token, chat_id, attachments, user_id):
    pids = [p["id"] for p in sessions.list_projects(user_id)]
    for att in attachments or []:
        f = files.get_file(att.get("id"), user_id, pids)
        if f:
            telegram_send_document(token, chat_id, f.get("name", "fichier"),
                                   base64.b64decode((f.get("b64") or "").encode()))


def _tg_session_get(chat_id):
    return filestore.items("tg_current").get(str(chat_id))


def _tg_session_set(chat_id, sid):
    filestore.put("tg_current", str(chat_id), sid)


def dispatch_notify(target_uid, text, agent=None):
    """Dispatch : crée une session dont le 1er message est la notif, l'envoie sur Telegram,
    et la met en session courante du destinataire (il peut ensuite questionner l'IA dessus)."""
    sid = sessions.create_session(target_uid, ("Notif : " + (text or "")[:40]) or "Notification", "perso", None)
    sessions.update_session(target_uid, sid, messages=[{"role": "assistant", "content": text}])
    acc = rbac.get_account(target_uid) or {}
    tgid, sent = acc.get("telegram_id"), False
    if tgid:
        ag = agent if (agent and agent.get("telegram_token")) else next(
            (agents.get_agent(a["id"]) for a in agents.list_agents() if a.get("has_bot")), None)
        tok = ag.get("telegram_token") if ag else None
        if tok:
            telegram_send(tok, tgid, text)
            _tg_session_set(tgid, sid)         # le chat Telegram pointe sur la session de la notif
            sent = True
    return {"session": sid, "telegram_sent": sent}


def _tg_handle(agent, msg, send=telegram_send):
    """Message Telegram : 1 conversation = 1 session Elytras (persistée, visible côté web).
    Commandes /new (nouvelle session) et /sessions (sélecteur). Exécution SOUS l'utilisateur identifié."""
    token = agent.get("telegram_token")
    chat_id = (msg.get("chat") or {}).get("id")
    frm = str((msg.get("from") or {}).get("id") or "")
    text = (msg.get("text") or "").strip()
    uid = rbac.find_by_telegram(frm)
    if not uid:
        send(token, chat_id, "Compte non reconnu. Ouvre Elytras → « Mon Telegram » et saisis cet identifiant : " + frm)
        return {"reply": "unknown", "telegram_id": frm}
    if text.lower() in ("/new", "/nouveau"):
        sid = sessions.create_session(uid, "Telegram", "perso", None)
        _tg_session_set(chat_id, sid)
        send(token, chat_id, "✦ Nouvelle conversation. Pose ta question.")
        return {"reply": "new", "session": sid}
    if text.lower() == "/sessions":
        ss = sessions.list_sessions(uid)[:8]
        if not ss:
            send(token, chat_id, "Aucune session — écris un message pour en démarrer une.")
            return {"reply": "none"}
        kb = {"inline_keyboard": [[{"text": (s.get("title") or "session")[:40], "callback_data": "sess:" + s["id"]}] for s in ss]}
        send(token, chat_id, "Choisis une conversation :", reply_markup=kb)
        return {"reply": "sessions"}
    sid = _tg_session_get(chat_id)
    if not sid or not sessions.get_session(uid, sid):
        sid = sessions.create_session(uid, "Telegram", "perso", None)
        _tg_session_set(chat_id, sid)
    sess = sessions.get_session(uid, sid) or {}
    msgs = list(sess.get("messages") or []) + [{"role": "user", "content": text}]
    finalize = {"messages": msgs, "session_id": sid, "user_id": uid,
                "mscope": "user", "mowner": uid, "mproj": None, "last_user": text}
    res = run_agent_chat(agent, msgs, "user", uid, None, uid, sid, finalize=finalize)
    _tg_deliver(token, chat_id, res.get("attachments"), uid)
    if res.get("done"):
        send(token, chat_id, res["answer"])
        return {"reply": res["answer"], "user_id": uid, "session": sid}
    send(token, chat_id, "⏸ " + res["confirm"]["summary"] + " — approuver ?", reply_markup=_tg_kb(res["pending_id"]))
    return {"reply": "confirm", "user_id": uid, "pending_id": res["pending_id"], "session": sid}


def _tg_handle_callback(agent, cq, send=telegram_send):
    """Bouton inline (Approuver/Refuser) : reprend l'action en attente sous le bon utilisateur."""
    token = agent.get("telegram_token")
    chat_id = ((cq.get("message") or {}).get("chat") or {}).get("id")
    frm = str((cq.get("from") or {}).get("id") or "")
    data = cq.get("data") or ""
    uid = rbac.find_by_telegram(frm)
    try:
        _tg(token, "answerCallbackQuery", callback_query_id=cq.get("id"))
    except Exception:
        pass
    if not uid or ":" not in data:
        return {"reply": "ignored"}
    tag, val = data.split(":", 1)
    if tag == "sess":                            # changer de session courante (sélecteur /sessions)
        s = sessions.get_session(uid, val)
        if s:
            _tg_session_set(chat_id, val)
            send(token, chat_id, "Conversation active : " + (s.get("title") or "session"))
        return {"reply": "switch", "session": val}
    res = resume_agent(val, "approve" if tag == "ok" else "reject", uid)
    if res.get("error"):
        send(token, chat_id, "Action expirée ou non autorisée.")
        return {"reply": "error"}
    if res.get("done"):
        send(token, chat_id, ("✅ " if tag == "ok" else "❌ ") + (res.get("answer") or ""))
        _tg_deliver(token, chat_id, res.get("attachments"), uid)
    else:
        send(token, chat_id, "⏸ " + res["confirm"]["summary"] + " — approuver ?", reply_markup=_tg_kb(res["pending_id"]))
    return {"reply": "resumed", "decision": tag}


_tg_pollers = {}   # agent_id -> {"thread", "stop", "token"}


def _tg_poll_loop(agent_id, token, stop):
    offset = 0
    while not stop.is_set():
        try:
            r = _tg(token, "getUpdates", offset=offset, timeout=25)
            for up in r.get("result", []):
                offset = up["update_id"] + 1
                msg = up.get("message")
                cq = up.get("callback_query")
                ag = agents.get_agent(agent_id)
                if not (ag and ag.get("telegram_token") == token):
                    continue
                try:
                    if msg and msg.get("text"):
                        _tg_handle(ag, msg)
                    elif cq:
                        _tg_handle_callback(ag, cq)
                except Exception:
                    pass
        except Exception:
            stop.wait(5)


def _tg_sync():
    """Démarre/arrête un poller par agent selon les tokens configurés."""
    want = {a["id"]: (agents.get_agent(a["id"]) or {}).get("telegram_token")
            for a in agents.list_agents() if a.get("has_bot")}
    for aid, info in list(_tg_pollers.items()):
        if want.get(aid) != info["token"]:
            info["stop"].set()
            _tg_pollers.pop(aid, None)
    for aid, token in want.items():
        if token and aid not in _tg_pollers:
            ev = threading.Event()
            th = threading.Thread(target=_tg_poll_loop, args=(aid, token, ev), daemon=True)
            _tg_pollers[aid] = {"thread": th, "stop": ev, "token": token}
            th.start()


if os.environ.get("ELYTRAS_TELEGRAM", "1") != "0":
    try:
        _tg_sync()
    except Exception:
        pass


def _seed_company_if_empty():
    """Au 1er démarrage : si la mémoire système « entreprise » est vide et qu'un fichier de
    contexte est fourni (ELYTRAS_COMPANY_SEED_FILE), on l'injecte automatiquement — l'onboarding
    n'a plus besoin de copier-coller le contexte dans l'interface."""
    path = os.environ.get("ELYTRAS_COMPANY_SEED_FILE")
    if not path:
        return
    try:
        if (_company_md() or "").strip():
            return                                  # déjà défini : on ne touche pas
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                md = f.read().strip()
            if md:
                filestore.put("company", "doc", {"md": md})
    except Exception:
        pass


_seed_company_if_empty()


@app.post("/chat")
def chat(req: ChatReq, actor: str = Depends(_need("agent.use"))):
    if not req.messages:
        return JSONResponse({"error": "messages vide"}, status_code=400)
    req.user_id = actor                          # identité = jeton (pas le corps client)
    provider = req.provider or os.environ.get("ELYTRAS_PROVIDER", "codex")

    # Providers non-codex : chat simple (sans outils pour l'instant).
    if provider != "codex":
        try:
            c = gateway.complete(req.messages, provider=provider, model=req.model,
                                 user_id=req.user_id, tenant_id=DEFAULT_TENANT)
            _persist_session(req, c.text)
            return {"role": "assistant", "content": c.text, "provider": c.provider, "model": c.model}
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=502)

    # Codex AGENTIQUE : orchestre (run_agent = mémoire + outils MCP + skills + délégation) + audit.
    sess = sessions.get_session(req.user_id, req.session_id) if req.session_id else None
    if sess and sess.get("scope") == "projet":
        mscope, mowner, mproj = "project", None, sess.get("project_id")
    else:
        mscope, mowner, mproj = "user", req.user_id, None
    last_user = next((m["content"] for m in reversed(req.messages) if m.get("role") == "user"), "")
    agent = agents.get_agent(req.agent_id or "orchestrateur") or agents.get_agent("orchestrateur")
    root = _audit("chat", agent=agent["name"], detail=last_user[:200], user_id=req.user_id,
                  project_id=mproj, session_id=req.session_id, initiator=f"user:{req.user_id}")
    finalize = {"messages": req.messages, "session_id": req.session_id, "user_id": req.user_id,
                "mscope": mscope, "mowner": mowner, "mproj": mproj, "last_user": last_user}
    try:
        res = run_agent_chat(agent, req.messages, mscope, mowner, mproj,
                             req.user_id, req.session_id, parent_id=root, finalize=finalize)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)
    if not res["done"]:                              # pause : validation requise (mode ASK)
        return {"role": "assistant", "status": "confirm", "pending_id": res["pending_id"],
                "confirm": res["confirm"], "agent": agent["name"], "attachments": res.get("attachments") or [],
                "content": "⏸ Validation requise : " + res["confirm"]["summary"]}
    return {"role": "assistant", "content": res["answer"], "provider": "codex",
            "agent": agent["name"], "tools_used": res["used"], "attachments": res.get("attachments") or []}


class ChatConfirmReq(BaseModel):
    pending_id: str
    decision: str = "approve"          # approve | reject
    user_id: str = DEFAULT_USER


@app.post("/chat/confirm")
def chat_confirm(req: ChatConfirmReq, actor: str = Depends(_need("agent.use"))):
    res = resume_agent(req.pending_id, req.decision, actor)
    if res.get("error"):
        return JSONResponse(res, status_code=400)
    if not res["done"]:
        return {"role": "assistant", "status": "confirm", "pending_id": res["pending_id"],
                "confirm": res["confirm"], "attachments": res.get("attachments") or [],
                "content": "⏸ Validation requise : " + res["confirm"]["summary"]}
    return {"role": "assistant", "content": res["answer"], "provider": "codex",
            "tools_used": res["used"], "attachments": res.get("attachments") or []}


# ───────────────────────── MCP générique + OAuth ─────────────────────────
@app.get("/mcp/servers")
def mcp_servers(request: Request):
    actor = _actor(request)
    admin = rbac.is_admin(actor)
    c = _conn_opt()
    servers = registry.list_servers(c)
    if c:
        c.close()
    out = []
    teams = {t["id"]: t["name"] for t in rbac.list_teams()}
    for s in servers:
        if not (admin or _can_use_server(actor, s)):     # non-admin : ne voit que ses serveurs autorisés
            continue
        if s.get("auth_type") == "oauth":
            s["connected"] = bool(oauth.store.get_tokens(s["id"], _conn_uid(s, actor)))
        else:
            s["connected"] = None
        s["can_manage"] = admin            # gérer accès/connexion partagée = admin uniquement
        s["team_names"] = [teams.get(t, t) for t in (s.get("allowed_teams") or [])]
        out.append(s)
    return {"servers": out, "teams": rbac.list_teams() if admin else []}


class ServerReq(BaseModel):
    name: str
    url: str
    auth_type: str = "auto"   # auto (sonde -> OAuth si besoin) | none | bearer | oauth
    token: str | None = None  # si bearer statique
    conn_scope: str = "shared"   # shared (compte commun, admin) | personal (chacun le sien)
    user_id: str = DEFAULT_USER
    tenant_id: str = DEFAULT_TENANT


def _set_server_auth(sid: str, auth: str):
    c = _conn_opt()
    if c:
        try:
            with c.cursor() as cur:
                cur.execute("UPDATE mcp_server SET auth_type=%s WHERE id=%s", (auth, sid))
            c.commit()
        except Exception:
            pass
        finally:
            c.close()
    else:
        registry.set_server_auth_file(sid, auth)


@app.post("/mcp/servers")
def add_server(req: ServerReq, actor: str = Depends(_need("mcp.manage"))):
    auth = req.auth_type or "auto"
    c = _conn_opt()
    if c:
        try:
            secret = crypto.encrypt(req.token) if (auth == "bearer" and req.token) else None
            with c.cursor() as cur:
                cur.execute(
                    """INSERT INTO mcp_server (tenant_id, owner_id, name, transport, url, auth_type, secret_enc)
                       VALUES (%s,%s,%s,'http',%s,%s,%s) RETURNING id""",
                    (req.tenant_id, req.user_id, req.name, req.url, auth, secret),
                )
                sid = str(cur.fetchone()[0])
            c.commit()
        finally:
            c.close()
    else:
        sid = registry.add_server_file(req.name, req.url, auth, owner_id=actor, conn_scope=req.conn_scope)

    # Auto-OAuth : pas d'identifiants fournis -> on sonde, et si le serveur exige
    # une auth (401/403), on lance directement l'OAuth (sous le bon scope).
    if auth in ("auto", "oauth") and not req.token:
        srv = registry.get_server(_conn_opt(), sid)
        if srv:
            needs = False
            try:
                mcp.list_tools({**srv, "token": None})
            except Exception as e:
                code = getattr(getattr(e, "response", None), "status_code", None)
                needs = code in (401, 403) or "401" in str(e) or "nauthor" in str(e).lower()
            if needs:
                _set_server_auth(sid, "oauth")
                try:
                    return {"id": sid, "name": req.name, "needs_oauth": True,
                            "auth_url": oauth.begin({**srv, "auth_type": "oauth"}, _conn_uid(srv, actor))}
                except Exception as e:
                    return {"id": sid, "name": req.name, "needs_oauth": True, "oauth_error": str(e)}
            _set_server_auth(sid, "none")
    return {"id": sid, "name": req.name, "auth_type": auth}


@app.delete("/mcp/servers/{server_id}")
def delete_server(server_id: str, user_id: str = DEFAULT_USER, actor: str = Depends(_need("mcp.manage"))):
    if server_id == "example":
        return JSONResponse({"error": "le serveur d'exemple vient de EXAMPLE_MCP_URL (pas supprimable ici)"},
                            status_code=400)
    srv = registry.get_server(_conn_opt(), server_id)
    if srv and srv.get("url"):
        mcp.forget(srv["url"])
    c = _conn_opt()
    if c:
        try:
            with c.cursor() as cur:
                cur.execute("DELETE FROM mcp_server WHERE id=%s", (server_id,))
                cur.execute("DELETE FROM mcp_oauth WHERE server_id=%s", (server_id,))
            c.commit()
        finally:
            c.close()
    else:
        registry.delete_server_file(server_id)
        filestore.delete("mcp_tokens", f"{server_id}|{user_id}")
    return {"deleted": server_id}


class UpdateServerReq(BaseModel):
    name: str | None = None
    url: str | None = None
    allow_all: bool | None = None
    allowed_teams: list[str] | None = None
    conn_scope: str | None = None
    user_id: str = DEFAULT_USER
    tenant_id: str = DEFAULT_TENANT


@app.patch("/mcp/servers/{server_id}")
def update_server(server_id: str, req: UpdateServerReq, actor: str = Depends(_need("mcp.manage"))):
    # Réglages d'accès / scope (admin) — autorisés même pour le serveur de démo.
    if req.allow_all is not None or req.allowed_teams is not None or req.conn_scope is not None:
        registry.set_server_access_file(server_id, allow_all=req.allow_all,
                                        allowed_teams=req.allowed_teams, conn_scope=req.conn_scope)
    if server_id == "example":
        return {"id": "example", "updated": True}    # accès mis à jour ; nom/url restent fixes (démo)
    old = registry.get_server(_conn_opt(), server_id)
    reset = req.url is not None and old is not None and req.url != old.get("url")
    c = _conn_opt()
    if c:
        try:
            with c.cursor() as cur:
                if req.name is not None:
                    cur.execute("UPDATE mcp_server SET name=%s WHERE id=%s", (req.name, server_id))
                if req.url is not None:
                    cur.execute("UPDATE mcp_server SET url=%s WHERE id=%s", (req.url, server_id))
                if reset:
                    cur.execute("UPDATE mcp_server SET auth_type='auto' WHERE id=%s", (server_id,))
                    cur.execute("DELETE FROM mcp_oauth WHERE server_id=%s", (server_id,))
            c.commit()
        finally:
            c.close()
    else:
        registry.update_server_file(server_id, name=req.name, url=req.url,
                                    auth_type=("auto" if reset else None))
        if reset:
            filestore.delete("mcp_tokens", f"{server_id}|{req.user_id}")
    if old and old.get("url"):
        mcp.forget(old["url"])
    if reset:   # URL changée -> re-sonde et relance l'OAuth si besoin
        srv = registry.get_server(_conn_opt(), server_id)
        if srv:
            needs = False
            try:
                mcp.list_tools({**srv, "token": None})
            except Exception as e:
                code = getattr(getattr(e, "response", None), "status_code", None)
                needs = code in (401, 403) or "401" in str(e) or "nauthor" in str(e).lower()
            if needs:
                _set_server_auth(server_id, "oauth")
                try:
                    return {"id": server_id, "updated": True, "needs_oauth": True,
                            "auth_url": oauth.begin({**srv, "auth_type": "oauth"}, req.user_id)}
                except Exception as e:
                    return {"id": server_id, "updated": True, "needs_oauth": True, "oauth_error": str(e)}
            _set_server_auth(server_id, "none")
    return {"id": server_id, "updated": True}


@app.get("/mcp/oauth/start")
def oauth_start(server: str, request: Request, user_id: str = DEFAULT_USER):
    actor = _actor(request)
    c = _conn_opt()
    srv = registry.get_server(c, server)
    if c:
        c.close()
    if not srv:
        return JSONResponse({"error": "serveur inconnu"}, status_code=404)
    scope = srv.get("conn_scope", "shared")
    if scope == "shared":
        if not rbac.has_cap(actor, "mcp.manage"):       # connexion commune : admin uniquement
            return JSONResponse({"error": "connexion partagée : réservée à un administrateur"}, status_code=403)
    elif not _can_use_server(actor, srv):               # connexion personnelle : utilisateur autorisé
        return JSONResponse({"error": "accès refusé à ce serveur"}, status_code=403)
    try:
        return {"auth_url": oauth.begin(srv, _conn_uid(srv, actor))}
    except Exception as e:
        return JSONResponse({"error": f"OAuth indisponible : {e}"}, status_code=502)


@app.get("/oauth/callback")
def oauth_callback(state: str = "", code: str = "", error: str = ""):
    if error:
        return RedirectResponse(f"/?oauth_error={error}")
    try:
        oauth.complete(state, code)
        return RedirectResponse("/?connected=1")
    except Exception as e:
        return RedirectResponse(f"/?oauth_error={e.__class__.__name__}")


@app.get("/mcp/tools")
def mcp_tools(server: str, request: Request, user_id: str = DEFAULT_USER):
    actor = _actor(request)
    c = _conn_opt()
    srv = registry.get_server(c, server)
    if c:
        c.close()
    if not srv:
        return JSONResponse({"error": "serveur inconnu"}, status_code=404)
    if not _can_use_server(actor, srv):
        return JSONResponse({"error": "accès refusé à ce serveur"}, status_code=403)
    try:
        return {"server": srv["name"], "tools": mcp.list_tools(_with_token(srv, actor))}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)


class CallReq(BaseModel):
    server: str = "example"
    tool: str
    arguments: dict = {}
    user_id: str = DEFAULT_USER
    tenant_id: str = DEFAULT_TENANT


@app.post("/mcp/call")
def mcp_call(req: CallReq, request: Request):
    actor = _actor(request)
    c = _conn_opt()
    srv = registry.get_server(c, req.server)
    if not srv:
        if c:
            c.close()
        return JSONResponse({"error": "serveur inconnu"}, status_code=404)
    if not _can_use_server(actor, srv):
        if c:
            c.close()
        return JSONResponse({"error": "accès refusé à ce serveur"}, status_code=403)
    try:
        result = mcp.call_tool(_with_token(srv, actor), req.tool, req.arguments)
    except Exception as e:
        if c:
            c.close()
        return JSONResponse({"error": str(e)}, status_code=502)
    if c:
        try:
            with c.cursor() as cur:
                cur.execute(
                    """INSERT INTO audit_log (tenant_id, initiator, action, tools, result)
                       VALUES (%s,%s,%s,%s,%s)""",
                    (req.tenant_id, f"user:{req.user_id}", f"mcp_call:{req.tool}", [srv["name"]], "ok"),
                )
            c.commit()
        except Exception:
            pass
        c.close()
    return {"server": srv["name"], "tool": req.tool, "result": result}


# ───────────────────────── Skills & mémoire ─────────────────────────
@app.get("/skills")
def list_skills(request: Request):
    actor = _actor(request)
    admin = rbac.is_admin(actor)
    teams = {t["id"]: t["name"] for t in rbac.list_teams()}
    out = []
    for s in skills.load_skills():
        acc = _skill_access(s["name"])
        if not (admin or _can_use_skill(actor, s["name"])):
            continue
        s = {**s, "allow_all": acc["allow_all"], "allowed_teams": acc["allowed_teams"],
             "team_names": [teams.get(t, t) for t in acc["allowed_teams"]], "can_manage": admin}
        out.append(s)
    return {"skills": out, "teams": rbac.list_teams() if admin else []}


class SkillAccessReq(BaseModel):
    name: str
    allow_all: bool | None = None
    allowed_teams: list[str] | None = None
    user_id: str = DEFAULT_USER


@app.post("/admin/skill-access")
def set_skill_access(req: SkillAccessReq, actor: str = Depends(_need("admin"))):
    cfg = filestore.items("skill_access").get(req.name) or {"allow_all": True, "allowed_teams": []}
    if req.allow_all is not None:
        cfg["allow_all"] = req.allow_all
    if req.allowed_teams is not None:
        cfg["allowed_teams"] = req.allowed_teams
    filestore.put("skill_access", req.name, cfg)
    return {"ok": True, "name": req.name, **cfg}


# ── Espace de fichiers scopé ──
@app.get("/files")
def list_files_ep(request: Request, actor: str = Depends(_need("file.read"))):
    pids = [p["id"] for p in sessions.list_projects(actor)]
    return {"files": files.list_files(actor, pids)}


class FileUploadReq(BaseModel):
    name: str
    content_b64: str
    mime: str = "application/octet-stream"
    scope: str = "perso"
    project_id: str | None = None
    user_id: str = DEFAULT_USER


@app.post("/files")
def upload_file_ep(req: FileUploadReq, actor: str = Depends(_need("file.write"))):
    try:
        fid = files.add_file(req.scope, actor, req.project_id, req.name, req.content_b64, req.mime)
        return {"id": fid, "name": req.name}
    except Exception as e:                       # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=400)


@app.get("/files/{fid}/content")
def file_content_ep(fid: str, request: Request, actor: str = Depends(_need("file.read"))):
    pids = [p["id"] for p in sessions.list_projects(actor)]
    f = files.get_file(fid, actor, pids)
    if not f:
        return JSONResponse({"error": "fichier introuvable ou accès refusé"}, status_code=404)
    raw = base64.b64decode((f.get("b64") or "").encode())
    from fastapi.responses import Response
    return Response(content=raw, media_type=f.get("mime") or "application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{f.get("name", "fichier")}"'})


@app.delete("/files/{fid}")
def delete_file_ep(fid: str, request: Request, actor: str = Depends(_need("file.write"))):
    pids = [p["id"] for p in sessions.list_projects(actor)]
    return {"deleted": files.delete_file(fid, actor, pids)}


# ── Contexte entreprise (mémoire système ; lecture seule depuis les chats) ──
@app.get("/company")
def get_company(request: Request):
    doc = filestore.items("company").get("doc") or {}
    return {"md": doc.get("md", ""), "updated_at": doc.get("updated_at"), "can_edit": rbac.is_admin(_actor(request))}


class CompanyReq(BaseModel):
    md: str = ""
    user_id: str = DEFAULT_USER


@app.post("/admin/company")
def set_company(req: CompanyReq, actor: str = Depends(_need("admin"))):
    filestore.put("company", "doc", {"md": req.md, "updated_at": time.time(), "updated_by": actor})
    return {"ok": True}


@app.get("/memory")
def memory(q: str = "", user_id: str = DEFAULT_USER, tenant_id: str = DEFAULT_TENANT):
    pids = [p["id"] for p in sessions.list_projects(user_id)]
    items = memory_engine.list_for_user(user_id, pids, k=300)
    if q:
        ql = q.lower()
        items = [it for it in items if ql in (it.get("content", "").lower())]
    return {"available": True, "mode": "fichier",
            "items": [{"id": it["id"], "content": it["content"], "source": it.get("source", ""),
                       "scope": it.get("scope")} for it in items[:60]]}


# ───────────────────────── Projets / Sessions ─────────────────────────
@app.get("/projects")
def get_projects(user_id: str = DEFAULT_USER):
    return {"projects": sessions.list_projects(user_id)}


class ProjectReq(BaseModel):
    name: str
    user_id: str = DEFAULT_USER


@app.post("/projects")
def add_project(req: ProjectReq):
    return {"id": sessions.create_project(req.user_id, req.name), "name": req.name}


@app.get("/users")
def get_users(user_id: str = DEFAULT_USER):
    return {"users": sessions.list_users()}


class UserReq(BaseModel):
    name: str
    user_id: str = DEFAULT_USER


@app.post("/users")
def add_user(req: UserReq):
    return {"id": sessions.create_user(req.name), "name": req.name}


class MemberReq(BaseModel):
    member_id: str
    user_id: str = DEFAULT_USER


@app.post("/projects/{pid}/members")
def add_project_member(pid: str, req: MemberReq):
    return {"ok": sessions.add_member(req.user_id, pid, req.member_id)}


# ───────────────────────── Agents (orchestre) ─────────────────────────
@app.get("/agents")
def get_agents(user_id: str = DEFAULT_USER):
    return {"agents": agents.list_agents()}


class AgentReq(BaseModel):
    name: str
    role: str = ""
    instructions: str = ""
    autonomy: str = "ask"
    user_id: str = DEFAULT_USER


@app.post("/agents")
def add_agent(req: AgentReq, actor: str = Depends(_need("agent.manage"))):
    return {"id": agents.create_agent(req.name, req.role, req.instructions, req.autonomy), "name": req.name}


@app.delete("/agents/{aid}")
def remove_agent(aid: str, user_id: str = DEFAULT_USER, actor: str = Depends(_need("agent.manage"))):
    return {"deleted": agents.delete_agent(aid)}


class AgentPatchReq(BaseModel):
    autonomy: str | None = None
    telegram_token: str | None = None
    user_id: str = DEFAULT_USER


@app.patch("/agents/{aid}")
def patch_agent(aid: str, req: AgentPatchReq, actor: str = Depends(_need("agent.manage"))):
    if req.autonomy is not None:
        agents.set_autonomy(aid, req.autonomy)
    if req.telegram_token is not None:
        agents.set_telegram_token(aid, req.telegram_token)
        try:
            _tg_sync()
        except Exception:
            pass
    return {"ok": True}


class MyTelegramReq(BaseModel):
    telegram_id: str = ""
    user_id: str = DEFAULT_USER


@app.post("/me/telegram")
def set_my_telegram(req: MyTelegramReq, request: Request):
    actor = _actor(request)
    if not rbac.set_telegram(actor, req.telegram_id):
        return JSONResponse({"error": "connecte-toi d'abord (compte requis)"}, status_code=400)
    return {"ok": True, "telegram_id": req.telegram_id}


@app.get("/telegram/status")
def telegram_status(actor: str = Depends(_need("admin"))):
    return {"bots": [{"agent": a["name"], "id": a["id"], "running": a["id"] in _tg_pollers}
                     for a in agents.list_agents() if a.get("has_bot")]}


# ───────────────────────── Workflows / activité (audit) ─────────────────────────
@app.get("/audit")
def get_audit(user_id: str = DEFAULT_USER):
    pids = [p["id"] for p in sessions.list_projects(user_id)]
    return {"events": list_audit(user_id, pids, k=200)}


@app.get("/observability")
def observability(request: Request):
    """Tableau de bord : usage/coûts LLM, activité (audit), runs de flows.
    Admin = vue globale ; sinon, uniquement ses propres données."""
    actor = _actor(request)
    admin = rbac.is_admin(actor)
    pids = [p["id"] for p in sessions.list_projects(actor)]
    names = {a["id"]: a.get("name") for a in rbac.list_accounts()} if admin else {}

    def uname(uid):
        if uid == DEFAULT_USER:
            return "Propriétaire"
        return names.get(uid) or (str(uid)[:6] if uid else "?")

    # ── Usage / coûts LLM ──
    usage = list(filestore.items("llm_usage").values())
    if not admin:
        usage = [u for u in usage if u.get("user_id") == actor]
    tok = lambda u: u.get("ptok", 0) + u.get("ctok", 0)
    by_model, by_user_u, by_day = {}, {}, {}
    for u in usage:
        by_model[u.get("model", "?")] = by_model.get(u.get("model", "?"), 0) + 1
        by_user_u[u.get("user_id")] = by_user_u.get(u.get("user_id"), 0) + tok(u)
        d = dt.datetime.fromtimestamp(u.get("ts", 0)).strftime("%Y-%m-%d")
        by_day[d] = by_day.get(d, 0) + tok(u)
    usage_kpi = {"calls": len(usage), "ptok": sum(u.get("ptok", 0) for u in usage),
                 "ctok": sum(u.get("ctok", 0) for u in usage),
                 "cost": round(sum(u.get("cost", 0) for u in usage), 4)}

    # ── Activité (audit) ──
    ev = ([{"id": a, **e} for a, e in filestore.items("audit").items()] if admin
          else list_audit(actor, pids, k=5000))
    by_kind, by_actor = {}, {}
    for e in ev:
        k = e.get("action", "?")
        by_kind[k] = by_kind.get(k, 0) + 1
        by_actor[e.get("owner_id")] = by_actor.get(e.get("owner_id"), 0) + 1

    # ── Flows (tâches) ──
    tasks = ([{"id": t, **v} for t, v in filestore.items("tasks").items()] if admin
             else list_tasks(actor, pids, k=2000))
    by_status = {"running": 0, "done": 0, "error": 0, "waiting": 0}
    recent = []
    for t in sorted(tasks, key=lambda x: x.get("created_at", 0), reverse=True):
        s = t.get("status", "done")
        by_status[s] = by_status.get(s, 0) + 1
        if len(recent) < 12:
            recent.append({"title": t.get("title"), "status": s, "kind": t.get("kind"),
                           "dur": round((t.get("updated_at", 0) - t.get("created_at", 0)), 1)})

    srt = lambda d, lbl=False: sorted((([uname(k), v] if lbl else [k, v]) for k, v in d.items()), key=lambda x: -x[1])
    return {"admin": admin,
            "usage": {**usage_kpi, "by_model": srt(by_model),
                      "by_user": srt(by_user_u, True)[:10], "by_day": sorted(by_day.items())[-14:]},
            "activity": {"total": len(ev), "by_kind": srt(by_kind), "by_user": srt(by_actor, True)[:10]},
            "flows": {"by_status": by_status, "recent": recent}}


# ───────────────────────── Planificateur ─────────────────────────
@app.get("/schedules")
def get_schedules(user_id: str = DEFAULT_USER):
    pids = [p["id"] for p in sessions.list_projects(user_id)]
    return {"schedules": scheduler.list_schedules(user_id, pids)}


class ScheduleReq(BaseModel):
    name: str
    prompt: str = ""
    kind: str = "daily"            # daily | interval | cron
    at: str = "09:00"
    every_min: int = 60
    cron: str = ""                 # si kind == cron : « min h jour mois jour-semaine »
    agent_id: str = "orchestrateur"
    flow_id: str | None = None     # si défini : la tâche planifiée lance ce flow
    scope: str = "perso"
    project_id: str | None = None
    user_id: str = DEFAULT_USER


@app.post("/schedules")
def add_schedule(req: ScheduleReq, actor: str = Depends(_need("schedule.manage"))):
    sid = scheduler.create_schedule(req.user_id, req.name, req.prompt, req.kind, req.at,
                                    req.every_min, req.agent_id, req.scope, req.project_id,
                                    req.flow_id, cron=req.cron)
    return {"id": sid, "name": req.name}


class ScheduleUpdateReq(BaseModel):
    enabled: bool | None = None
    name: str | None = None
    prompt: str | None = None
    at: str | None = None
    every_min: int | None = None
    cron: str | None = None
    user_id: str = DEFAULT_USER


@app.patch("/schedules/{sid}")
def patch_schedule(sid: str, req: ScheduleUpdateReq, actor: str = Depends(_need("schedule.manage"))):
    return {"ok": scheduler.update_schedule(sid, enabled=req.enabled, name=req.name, prompt=req.prompt,
                                            at=req.at, every_min=req.every_min, cron=req.cron)}


@app.delete("/schedules/{sid}")
def remove_schedule(sid: str, user_id: str = DEFAULT_USER, actor: str = Depends(_need("schedule.manage"))):
    return {"deleted": scheduler.delete_schedule(sid)}


@app.post("/schedules/{sid}/run")
def run_schedule_now(sid: str, user_id: str = DEFAULT_USER, actor: str = Depends(_need("schedule.manage"))):
    return {"ran": scheduler.run_now(sid, _run_schedule)}


# ───────────────────────── Flows (workflows) ─────────────────────────
@app.get("/flows")
def get_flows(user_id: str = DEFAULT_USER):
    pids = [p["id"] for p in sessions.list_projects(user_id)]
    return {"flows": flows.list_flows(user_id, pids)}


class FlowReq(BaseModel):
    name: str = "Nouveau flow"
    scope: str = "perso"
    project_id: str | None = None
    user_id: str = DEFAULT_USER


@app.post("/flows")
def add_flow(req: FlowReq, actor: str = Depends(_need("flow.create"))):
    fid = flows.create_flow(actor, req.name, req.scope, req.project_id)   # propriétaire = acteur authentifié
    return flows.get_flow(fid)


@app.get("/flows/{fid}")
def one_flow(fid: str, user_id: str = DEFAULT_USER):
    f = flows.get_flow(fid)
    return f if f else JSONResponse({"error": "flow introuvable"}, status_code=404)


class FlowUpdateReq(BaseModel):
    name: str | None = None
    summary: str | None = None
    description: str | None = None
    inputs: list | None = None
    modules: list | None = None
    ui: dict | None = None
    scope: str | None = None
    project_id: str | None = None
    user_id: str = DEFAULT_USER


@app.patch("/flows/{fid}")
def patch_flow(fid: str, req: FlowUpdateReq, actor: str = Depends(_need("flow.edit"))):
    ok = flows.update_flow(fid, name=req.name, summary=req.summary, description=req.description,
                           inputs=req.inputs, modules=req.modules, ui=req.ui,
                           scope=req.scope, project_id=req.project_id)
    return flows.get_flow(fid) if ok else JSONResponse({"error": "flow introuvable"}, status_code=404)


@app.delete("/flows/{fid}")
def remove_flow(fid: str, user_id: str = DEFAULT_USER, actor: str = Depends(_need("flow.delete"))):
    return {"deleted": flows.delete_flow(fid)}


@app.post("/flows/{fid}/webhook-token")
def make_webhook_token(fid: str, user_id: str = DEFAULT_USER, actor: str = Depends(_need("flow.edit"))):
    tok = flows.ensure_webhook_token(fid)
    if not tok:
        return JSONResponse({"error": "flow introuvable"}, status_code=404)
    base = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")
    return {"token": tok, "url": f"{base}/flows/{fid}/webhook/{tok}"}


class FlowRunReq(BaseModel):
    inputs: dict = {}
    up_to: str | None = None
    user_id: str = DEFAULT_USER


@app.post("/flows/{fid}/run")
def run_flow_ep(fid: str, req: FlowRunReq, actor: str = Depends(_need("flow.run"))):
    f = flows.get_flow(fid)
    if not f:
        return JSONResponse({"error": "flow introuvable"}, status_code=404)
    return run_flow(f, req.inputs, actor, up_to=req.up_to)   # identité = acteur authentifié


class FlowGenReq(BaseModel):
    prompt: str
    name: str | None = None
    scope: str = "perso"
    project_id: str | None = None
    flow_id: str | None = None        # si fourni : remplit/écrase ce flow plutôt que d'en créer un
    user_id: str = DEFAULT_USER


@app.post("/flows/generate")
def generate_flow_ep(req: FlowGenReq, actor: str = Depends(_need("flow.create"))):
    try:
        spec = _ai_generate_flow(req.prompt, actor)
    except Exception as e:                       # noqa: BLE001
        return JSONResponse({"error": f"génération impossible : {e}"}, status_code=502)
    name = req.name or spec.get("name") or "Flow IA"
    fid = req.flow_id or flows.create_flow(actor, name, req.scope, req.project_id)
    flows.update_flow(fid, name=name, summary=spec.get("summary"), inputs=spec.get("inputs"),
                      modules=spec.get("modules"), ui=spec.get("ui"))
    return flows.get_flow(fid)


class FlowEditAIReq(BaseModel):
    instruction: str
    user_id: str = DEFAULT_USER


@app.post("/flows/{fid}/edit-ai")
def edit_flow_ai_ep(fid: str, req: FlowEditAIReq, actor: str = Depends(_need("flow.edit"))):
    flow = flows.get_flow(fid)
    if not flow:
        return JSONResponse({"error": "flow introuvable"}, status_code=404)
    try:
        spec = _ai_edit_flow(flow, req.instruction, req.user_id)
    except Exception as e:                       # noqa: BLE001
        return JSONResponse({"error": f"modification impossible : {e}"}, status_code=502)
    flows.update_flow(fid, name=spec.get("name") or flow.get("name"), summary=spec.get("summary"),
                      inputs=spec.get("inputs"), modules=spec.get("modules"), ui=spec.get("ui"))
    return flows.get_flow(fid)


@app.post("/flows/{fid}/webhook/{token}")
async def flow_webhook(fid: str, token: str, request: Request):
    f = flows.find_by_webhook(fid, token)
    if not f:
        return JSONResponse({"error": "webhook inconnu"}, status_code=404)
    try:
        body = await request.json()
    except Exception:
        body = {}
    return run_flow(f, body if isinstance(body, dict) else {"body": body}, f.get("owner_id"))


@app.get("/flows/resume/{token}")
def resume_flow_ep(token: str, decision: str = "approve"):
    r = resume_flow(token, decision)
    html = ("<html><body style='font-family:sans-serif;background:#0b0d12;color:#e6e8ef;padding:40px'>"
            f"<h2>Élytras — approbation</h2><p>Décision : <b>{'approuvée ✓' if decision == 'approve' else 'refusée ✗'}</b></p>"
            f"<p>Statut du flow : <b>{r.get('status', r.get('error', '?'))}</b></p>"
            "<p>Tu peux fermer cet onglet.</p></body></html>")
    return HTMLResponse(html)


# ───────────────────────── Tâches (kanban) ─────────────────────────
@app.get("/tasks")
def get_tasks(user_id: str = DEFAULT_USER):
    pids = [p["id"] for p in sessions.list_projects(user_id)]
    return {"tasks": list_tasks(user_id, pids)}


@app.get("/sessions")
def get_sessions(user_id: str = DEFAULT_USER, archived: bool = False):
    return {"sessions": sessions.list_sessions(user_id, include_archived=archived)}


class SessionReq(BaseModel):
    title: str = "Nouvelle session"
    scope: str = "perso"               # perso | projet
    project_id: str | None = None
    user_id: str = DEFAULT_USER


@app.post("/sessions")
def add_session(req: SessionReq):
    sid = sessions.create_session(req.user_id, req.title, req.scope, req.project_id)
    return sessions.get_session(req.user_id, sid)


@app.get("/sessions/{sid}")
def one_session(sid: str, user_id: str = DEFAULT_USER):
    s = sessions.get_session(user_id, sid)
    return s if s else JSONResponse({"error": "session introuvable"}, status_code=404)


class SessionUpdateReq(BaseModel):
    title: str | None = None
    status: str | None = None          # active | archived
    scope: str | None = None
    project_id: str | None = None
    user_id: str = DEFAULT_USER


@app.patch("/sessions/{sid}")
def patch_session(sid: str, req: SessionUpdateReq):
    return {"ok": sessions.update_session(req.user_id, sid, title=req.title, status=req.status,
                                          scope=req.scope, project_id=req.project_id)}


@app.delete("/sessions/{sid}")
def remove_session(sid: str, user_id: str = DEFAULT_USER):
    return {"deleted": sessions.delete_session(user_id, sid)}


# ───────────────────────── Mémoire : suppression / reset ─────────────────────────
@app.delete("/memory/{mid}")
def delete_memory(mid: str, user_id: str = DEFAULT_USER, actor: str = Depends(_need("memory.reset"))):
    c = _conn_opt()
    if c:
        try:
            with c.cursor() as cur:
                cur.execute("DELETE FROM memory WHERE id=%s", (mid,))
            c.commit()
        finally:
            c.close()
        return {"deleted": mid}
    return {"deleted": filestore.delete("memory", mid)}


@app.post("/memory/reset")
def reset_memory(user_id: str = DEFAULT_USER, tenant_id: str = DEFAULT_TENANT, actor: str = Depends(_need("memory.reset"))):
    memory_engine.reset_user(user_id)   # efface la mémoire PERSO de l'utilisateur (projets partagés conservés)
    return {"reset": True}


@app.get("/memory/{mid}/children")
def memory_children(mid: str, user_id: str = DEFAULT_USER):
    """Déplie un résumé : renvoie les faits sources qu'il a compressés (drill-down lossless)."""
    return {"children": memory_engine.expand(mid)}
