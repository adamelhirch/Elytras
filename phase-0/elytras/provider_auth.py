"""Gestion native des providers d'abonnement (Codex / Claude / Gemini).

Technique RÉIMPLÉMENTÉE d'après le projet open-source CLIProxyAPI (MIT) — on NE dépend
PAS de leur binaire : on parle directement aux endpoints OAuth officiels des CLIs, comme
eux. Login (Authorization Code + PKCE, redirect loopback), refresh, et appel d'inférence
vers le vrai backend de chaque provider.

⚠️  ToS : on réutilise les client_id des applications CLI officielles (Codex/Claude/Gemini)
et, pour Codex, un endpoint interne. À réserver à un usage personnel / self-host. Les
fournisseurs peuvent révoquer ces accès sans préavis. Voir Phase-0.md.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

import httpx


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _pkce() -> tuple[str, str]:
    verifier = _b64url(secrets.token_bytes(96))
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge


@dataclass
class ProviderSpec:
    name: str
    label: str
    auth_url: str
    token_url: str
    client_id: str
    redirect_uri: str
    scopes: str
    callback_port: int
    callback_path: str
    token_mode: str = "form"            # form (Codex/Gemini) | json (Claude)
    client_secret: str | None = None    # Gemini (client "public" installé)
    extra_auth: dict = field(default_factory=dict)
    send_state_in_token: bool = False   # Claude renvoie le state à l'échange
    refresh_scope: str | None = None
    inference_url: str = ""


# Constantes extraites du code source de CLIProxyAPI (voir Phase-0.md).
SPECS: dict[str, ProviderSpec] = {
    "codex": ProviderSpec(
        name="codex", label="OpenAI Codex (ChatGPT)",
        auth_url="https://auth.openai.com/oauth/authorize",
        token_url="https://auth.openai.com/oauth/token",
        client_id="app_EMoamEEZ73f0CkXaXp7hrann",
        redirect_uri="http://localhost:1455/auth/callback",
        scopes="openid email profile offline_access",
        callback_port=1455, callback_path="/auth/callback",
        token_mode="form",
        extra_auth={"prompt": "login", "id_token_add_organizations": "true",
                    "codex_cli_simplified_flow": "true"},
        refresh_scope="openid profile email",
        inference_url="https://chatgpt.com/backend-api/codex/responses",
    ),
    "claude": ProviderSpec(
        name="claude", label="Claude (Anthropic)",
        auth_url="https://claude.ai/oauth/authorize",
        token_url="https://api.anthropic.com/v1/oauth/token",
        client_id="9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        redirect_uri="http://localhost:54545/callback",
        scopes="user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
        callback_port=54545, callback_path="/callback",
        token_mode="json", send_state_in_token=True,
        extra_auth={"code": "true"},
        inference_url="https://api.anthropic.com/v1/messages",
    ),
    "gemini": ProviderSpec(
        name="gemini", label="Gemini (Google)",
        auth_url="https://accounts.google.com/o/oauth2/auth",
        token_url="https://oauth2.googleapis.com/token",
        # Identifiants OAuth « desktop » du CLI Google (publics, mais NON committés) :
        # à fournir via l'environnement pour activer la connexion Gemini. Voir .env.example.
        client_id=os.environ.get("GEMINI_OAUTH_CLIENT_ID", ""),
        client_secret=os.environ.get("GEMINI_OAUTH_CLIENT_SECRET") or None,
        redirect_uri="http://localhost:8085/oauth2callback",
        scopes=("https://www.googleapis.com/auth/cloud-platform "
                "https://www.googleapis.com/auth/userinfo.email "
                "https://www.googleapis.com/auth/userinfo.profile"),
        callback_port=8085, callback_path="/oauth2callback",
        token_mode="form",
        extra_auth={"access_type": "offline", "prompt": "consent"},
    ),
}


def _auth_url(spec: ProviderSpec, challenge: str, state: str) -> str:
    params = {"client_id": spec.client_id, "response_type": "code",
              "redirect_uri": spec.redirect_uri, "scope": spec.scopes, "state": state,
              "code_challenge": challenge, "code_challenge_method": "S256"}
    params.update(spec.extra_auth)
    return spec.auth_url + "?" + urlencode(params)


def _token_request(spec: ProviderSpec, data: dict) -> dict:
    if spec.token_mode == "json":
        r = httpx.post(spec.token_url, json=data, timeout=30)
    else:
        r = httpx.post(spec.token_url, data=data,
                       headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=30)
    r.raise_for_status()
    return r.json()


def _exchange(spec: ProviderSpec, code: str, verifier: str, state: str) -> dict:
    data = {"grant_type": "authorization_code", "client_id": spec.client_id,
            "code": code, "redirect_uri": spec.redirect_uri, "code_verifier": verifier}
    if spec.send_state_in_token:
        data["state"] = state
    if spec.client_secret:
        data["client_secret"] = spec.client_secret
    return _token_request(spec, data)


def _refresh(spec: ProviderSpec, refresh_token: str) -> dict:
    data = {"client_id": spec.client_id, "grant_type": "refresh_token",
            "refresh_token": refresh_token}
    if spec.refresh_scope:
        data["scope"] = spec.refresh_scope
    if spec.client_secret:
        data["client_secret"] = spec.client_secret
    return _token_request(spec, data)


def _decode_jwt(tok: str) -> dict:
    payload = tok.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))


def _normalize(spec: ProviderSpec, tok: dict, prev: dict | None = None) -> dict:
    rec = dict(prev or {})
    rec["provider"] = spec.name
    if tok.get("access_token"):
        rec["access_token"] = tok["access_token"]
    if tok.get("refresh_token"):
        rec["refresh_token"] = tok["refresh_token"]
    rec["expires_at"] = time.time() + int(tok.get("expires_in", 3600))
    if tok.get("id_token"):
        rec["id_token"] = tok["id_token"]
        try:
            auth = _decode_jwt(tok["id_token"]).get("https://api.openai.com/auth", {})
            if auth.get("chatgpt_account_id"):
                rec["account_id"] = auth["chatgpt_account_id"]
        except Exception:
            pass
    if isinstance(tok.get("account"), dict):
        rec["email"] = tok["account"].get("email_address")
    return rec


def _capture_code(port: int, path: str, timeout: float = 300.0) -> tuple[str | None, str | None]:
    """Écoute en loopback le redirect OAuth (one-shot) et renvoie (code, state)."""
    got: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            u = urlparse(self.path)
            if u.path == path:
                q = parse_qs(u.query)
                got["code"] = q.get("code", [None])[0]
                got["state"] = q.get("state", [None])[0]
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write("<h2>Connexion reussie. Tu peux fermer cet onglet.</h2>".encode())
            else:
                self.send_response(404)
                self.end_headers()

    # OAuth loopback (RFC 8252) : 127.0.0.1 en local. En conteneur, ELYTRAS_OAUTH_BIND=0.0.0.0
    # (le port n'est publié QUE sur 127.0.0.1 de l'hôte → pas d'exposition réseau).
    srv = HTTPServer((os.environ.get("ELYTRAS_OAUTH_BIND", "127.0.0.1"), port), Handler)
    deadline = time.time() + timeout
    while time.time() < deadline and not got.get("code"):
        srv.timeout = max(1.0, deadline - time.time())
        srv.handle_request()
    srv.server_close()
    return got.get("code"), got.get("state")


class MemoryProviderStore:
    """Store en mémoire (tests). Le store applicatif chiffre en base."""
    def __init__(self):
        self._t: dict = {}

    def save_tokens(self, user_id, provider, rec):
        self._t[(user_id, provider)] = rec

    def get_tokens(self, user_id, provider):
        return self._t.get((user_id, provider))


class ProviderAuth:
    def __init__(self, store):
        self.store = store
        self._pending: dict = {}   # provider -> "en cours" (un login à la fois par provider)

    def providers(self) -> list[dict]:
        return [{"name": s.name, "label": s.label} for s in SPECS.values()]

    def start_login(self, provider: str, user_id: str) -> str:
        """Démarre le login : lance l'écouteur loopback en tâche de fond et renvoie l'URL d'auth."""
        spec = SPECS[provider]
        if not spec.client_id:
            raise ValueError(
                f"Provider « {provider} » non configuré : renseigne ses identifiants OAuth "
                "dans l'environnement (voir .env.example).")
        verifier, challenge = _pkce()
        state = secrets.token_hex(16)
        url = _auth_url(spec, challenge, state)

        def run():
            self._pending[provider] = True
            try:
                code, got_state = _capture_code(spec.callback_port, spec.callback_path)
                if not code or got_state != state:
                    return
                tok = _exchange(spec, code, verifier, state)
                self.store.save_tokens(user_id, provider, _normalize(spec, tok))
            except Exception:
                pass
            finally:
                self._pending.pop(provider, None)

        threading.Thread(target=run, daemon=True).start()
        return url

    def access_token(self, provider: str, user_id: str) -> str | None:
        rec = self.store.get_tokens(user_id, provider)
        if not rec:
            return None
        if rec.get("expires_at", 0) > time.time() + 60:
            return rec.get("access_token")
        if rec.get("refresh_token"):
            try:
                tok = _refresh(SPECS[provider], rec["refresh_token"])
                rec = _normalize(SPECS[provider], tok, prev=rec)
                self.store.save_tokens(user_id, provider, rec)
            except Exception:
                pass
        return rec.get("access_token")

    def status(self, provider: str, user_id: str) -> dict:
        rec = self.store.get_tokens(user_id, provider) or {}
        return {
            "provider": provider,
            "label": SPECS[provider].label,
            "connected": bool(rec.get("access_token")),
            "account": rec.get("account_id") or rec.get("email"),
            "expires_at": rec.get("expires_at"),
            "logging_in": provider in self._pending,
        }
