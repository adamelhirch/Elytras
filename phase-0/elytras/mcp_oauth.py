"""OAuth 2.1 + PKCE pour les serveurs MCP (spec MCP authorization).

Flux : découverte des métadonnées (Protected Resource Metadata RFC 9728 →
Authorization Server Metadata RFC 8414) → enregistrement dynamique du client
(RFC 7591) si supporté → Authorization Code + PKCE → échange du code → refresh.
Le `store` (injecté) gère l'état temporaire et le stockage chiffré des tokens.
"""
from __future__ import annotations

import base64
import hashlib
import secrets
import time
from urllib.parse import urlencode, urljoin, urlparse

import httpx


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _pkce() -> tuple[str, str]:
    verifier = _b64url(secrets.token_bytes(32))
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge


def _origin(url: str) -> str:
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}"


class MemoryOAuthStore:
    """Store en mémoire (tests / fallback sans base). Le store applicatif chiffre en base."""
    def __init__(self):
        self._pending: dict = {}
        self._tokens: dict = {}

    def save_pending(self, state, data):
        self._pending[state] = data

    def get_pending(self, state):
        return self._pending.pop(state, None)

    def save_tokens(self, server_id, user_id, rec):
        self._tokens[(server_id, user_id)] = rec

    def get_tokens(self, server_id, user_id):
        return self._tokens.get((server_id, user_id))


class McpOAuth:
    def __init__(self, store, redirect_uri: str, timeout: float = 20.0):
        self.store = store
        self.redirect_uri = redirect_uri
        self.timeout = timeout

    # ── découverte ──
    def discover(self, server_url: str) -> dict:
        origin = _origin(server_url)
        issuer = origin
        try:
            r = httpx.get(urljoin(origin + "/", ".well-known/oauth-protected-resource"), timeout=self.timeout)
            if r.status_code == 200:
                as_list = (r.json().get("authorization_servers") or [])
                if as_list:
                    issuer = as_list[0].rstrip("/")
        except Exception:
            pass
        for path in (".well-known/oauth-authorization-server", ".well-known/openid-configuration"):
            try:
                r = httpx.get(urljoin(issuer + "/", path), timeout=self.timeout)
                if r.status_code == 200:
                    md = r.json()
                    return {
                        "authorization_endpoint": md["authorization_endpoint"],
                        "token_endpoint": md["token_endpoint"],
                        "registration_endpoint": md.get("registration_endpoint"),
                        "scopes_supported": md.get("scopes_supported", []),
                        "issuer": md.get("issuer", issuer),
                    }
            except Exception:
                continue
        raise RuntimeError(f"Métadonnées OAuth introuvables pour {server_url}")

    def register_client(self, registration_endpoint: str) -> dict:
        body = {
            "client_name": "Elytras",
            "redirect_uris": [self.redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        }
        r = httpx.post(registration_endpoint, json=body, timeout=self.timeout)
        r.raise_for_status()
        d = r.json()
        return {"client_id": d["client_id"], "client_secret": d.get("client_secret")}

    # ── démarrage : renvoie l'URL d'autorisation à ouvrir dans le navigateur ──
    def begin(self, server: dict, user_id: str, client_id: str | None = None,
              client_secret: str | None = None, scope: str | None = None) -> str:
        md = self.discover(server["url"])
        if not client_id and md.get("registration_endpoint"):
            reg = self.register_client(md["registration_endpoint"])
            client_id, client_secret = reg["client_id"], reg.get("client_secret")
        if not client_id:
            raise RuntimeError("client_id requis (enregistrement dynamique non supporté par ce serveur)")
        verifier, challenge = _pkce()
        state = _b64url(secrets.token_bytes(16))
        if not scope:
            supported = set(md.get("scopes_supported", []))
            order = ["openid", "offline_access", "mcp.connect", "mcp", "email", "profile"]
            scope = " ".join(s for s in order if s in supported) \
                or " ".join(x for x in md.get("scopes_supported", []) if x != "offline") \
                or "openid"
        self.store.save_pending(state, {
            "server_id": server["id"], "server_url": server["url"], "user_id": user_id,
            "verifier": verifier, "token_endpoint": md["token_endpoint"],
            "client_id": client_id, "client_secret": client_secret, "scope": scope,
        })
        params = {
            "response_type": "code", "client_id": client_id,
            "redirect_uri": self.redirect_uri, "scope": scope, "state": state,
            "code_challenge": challenge, "code_challenge_method": "S256",
            "resource": server["url"],
        }
        return md["authorization_endpoint"] + "?" + urlencode(params)

    # ── callback : échange le code contre des tokens ──
    def complete(self, state: str, code: str) -> dict:
        p = self.store.get_pending(state)
        if not p:
            raise RuntimeError("state OAuth inconnu ou expiré")
        data = {
            "grant_type": "authorization_code", "code": code,
            "redirect_uri": self.redirect_uri, "client_id": p["client_id"],
            "code_verifier": p["verifier"], "resource": p["server_url"],
        }
        if p.get("client_secret"):
            data["client_secret"] = p["client_secret"]
        r = httpx.post(p["token_endpoint"], data=data, timeout=self.timeout)
        r.raise_for_status()
        tok = r.json()
        rec = {
            "access_token": tok["access_token"],
            "refresh_token": tok.get("refresh_token"),
            "expires_at": time.time() + int(tok.get("expires_in", 3600)),
            "token_endpoint": p["token_endpoint"], "client_id": p["client_id"],
            "client_secret": p.get("client_secret"), "scope": p.get("scope"),
            "server_url": p["server_url"],
        }
        self.store.save_tokens(p["server_id"], p["user_id"], rec)
        return rec

    # ── token valide (refresh automatique si expiré) ──
    def token_for(self, server_id: str, user_id: str) -> str | None:
        rec = self.store.get_tokens(server_id, user_id)
        if not rec:
            return None
        if rec.get("expires_at", 0) > time.time() + 30:
            return rec["access_token"]
        if not rec.get("refresh_token"):
            return rec["access_token"]
        data = {
            "grant_type": "refresh_token", "refresh_token": rec["refresh_token"],
            "client_id": rec["client_id"], "resource": rec.get("server_url"),
        }
        if rec.get("client_secret"):
            data["client_secret"] = rec["client_secret"]
        try:
            r = httpx.post(rec["token_endpoint"], data=data, timeout=self.timeout)
            r.raise_for_status()
            tok = r.json()
            rec["access_token"] = tok["access_token"]
            rec["refresh_token"] = tok.get("refresh_token", rec["refresh_token"])
            rec["expires_at"] = time.time() + int(tok.get("expires_in", 3600))
            self.store.save_tokens(server_id, user_id, rec)
        except Exception:
            pass
        return rec["access_token"]
