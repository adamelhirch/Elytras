"""Triggers — déclencheurs façon Windmill, unifiés.

Kinds couverts (catalogue Windmill complet ; actifs en mode fichier marqués ✓) :
  ✓ webhook    : URL à jeton par flow (existant, conservé)
  ✓ http       : route HTTP custom {méthode, chemin} → flow ou script  (/r/<chemin>)
  ✓ schedule   : cron (planificateur Elytras)
  ✓ email      : boîte IMAP scrutée (host/user/pass chiffrés, dossier, intervalle) ;
                 chaque nouveau message (dédup Message-ID) lance la cible avec
                 {from, subject, text} en entrée — équivalent des email triggers Windmill
  ◌ websocket / kafka / nats / sqs / mqtt / postgres / gcp / azure : déclarables
    (modèle + endpoints) mais inactifs en mode fichier — nécessitent un broker/runtime
    dédié ; statut explicite « inactive » renvoyé à l'UI.

Un trigger = {id, kind, target:{flow_id | script_path}, enabled, config{...}}.
Le payload du déclencheur passe par le preprocessor_module du flow s'il existe.
"""
from __future__ import annotations

import base64
import email as email_mod
import email.header
import email.utils
import imaplib
import time
import uuid

from . import crypto, filestore


def _enc(text: str) -> str:
    return base64.b64encode(crypto.encrypt(text)).decode()


def _dec(blob: str) -> str:
    return crypto.decrypt(base64.b64decode(blob))

SECTION = "triggers"
ACTIVE_KINDS = ("webhook", "http", "schedule", "email")
DECLARED_KINDS = ACTIVE_KINDS + ("websocket", "kafka", "nats", "sqs", "mqtt",
                                 "postgres", "gcp", "azure")
HTTP_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")


def create(kind: str, target: dict, config: dict | None = None, owner_id: str = "") -> str:
    if kind not in DECLARED_KINDS:
        raise ValueError(f"kind inconnu : {kind} (connus : {', '.join(DECLARED_KINDS)})")
    tid = str(uuid.uuid4())
    cfg = dict(config or {})
    if kind == "email" and cfg.get("password"):
        cfg["password_enc"] = _enc(cfg.pop("password"))
    if kind == "http":
        cfg["route_path"] = (cfg.get("route_path") or "").strip().strip("/")
        cfg["method"] = (cfg.get("method") or "POST").upper()
        if cfg["method"] not in HTTP_METHODS:
            cfg["method"] = "POST"
        if not cfg["route_path"]:
            raise ValueError("route_path requis pour un trigger http")
    filestore.put(SECTION, tid, {"kind": kind, "target": target or {}, "config": cfg,
                                 "enabled": kind in ACTIVE_KINDS, "owner_id": owner_id,
                                 "created_at": time.time(),
                                 "active": kind in ACTIVE_KINDS,
                                 "note": None if kind in ACTIVE_KINDS else
                                 "inactif en mode fichier : nécessite un broker/runtime dédié"})
    return tid


def update(tid: str, **fields) -> bool:
    t = filestore.items(SECTION).get(tid)
    if not t:
        return False
    cfg = fields.pop("config", None)
    if cfg is not None:
        if cfg.get("password"):
            cfg["password_enc"] = _enc(cfg.pop("password"))
        t["config"] = {**t.get("config", {}), **cfg}
    for k in ("enabled", "target"):
        if fields.get(k) is not None:
            t[k] = fields[k]
    filestore.put(SECTION, tid, t)
    return True


def delete(tid: str) -> bool:
    return filestore.delete(SECTION, tid)


def list_triggers(flow_id: str | None = None) -> list[dict]:
    out = []
    for tid, t in filestore.items(SECTION).items():
        if flow_id and (t.get("target") or {}).get("flow_id") != flow_id:
            continue
        cfg = {k: v for k, v in (t.get("config") or {}).items() if k != "password_enc"}
        out.append({"id": tid, "kind": t.get("kind"), "target": t.get("target"),
                    "enabled": t.get("enabled"), "active": t.get("active"),
                    "note": t.get("note"), "config": cfg})
    return out


def find_http_route(method: str, path: str) -> dict | None:
    path = (path or "").strip().strip("/")
    for tid, t in filestore.items(SECTION).items():
        if t.get("kind") != "http" or not t.get("enabled"):
            continue
        cfg = t.get("config") or {}
        if cfg.get("route_path") == path and cfg.get("method") == method.upper():
            return {"id": tid, **t}
    return None


# ───────────────────────── Email (IMAP poll + dédup Message-ID) ─────────────────────────
def _decode(s):
    try:
        parts = email.header.decode_header(s or "")
        return "".join(p.decode(c or "utf-8", "replace") if isinstance(p, bytes) else p
                       for p, c in parts)
    except Exception:
        return s or ""


def _body_text(msg) -> str:
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                try:
                    return part.get_payload(decode=True).decode(
                        part.get_content_charset() or "utf-8", "replace")[:8000]
                except Exception:
                    continue
        return ""
    try:
        return (msg.get_payload(decode=True) or b"").decode(
            msg.get_content_charset() or "utf-8", "replace")[:8000]
    except Exception:
        return ""


def poll_email_trigger(tid: str, t: dict, imap_factory=None) -> list[dict]:
    """Scrute la boîte IMAP du trigger ; renvoie les NOUVEAUX messages (dédup persistante).
    `imap_factory` permet d'injecter un faux IMAP dans les tests."""
    cfg = t.get("config") or {}
    host = cfg.get("host")
    if not host:
        return []
    user = cfg.get("user", "")
    pwd = _dec(cfg.get("password_enc")) if cfg.get("password_enc") else ""
    folder = cfg.get("folder") or "INBOX"
    factory = imap_factory or (lambda: imaplib.IMAP4_SSL(host, int(cfg.get("port") or 993)))
    seen_key = f"emailtrig:{tid}"
    seen = set((filestore.items("flow_trigger_state").get(seen_key) or {}).get("seen") or [])
    fresh = []
    M = factory()
    try:
        M.login(user, pwd)
        M.select(folder)
        _typ, data = M.search(None, "UNSEEN")
        for num in (data[0].split() if data and data[0] else [])[:20]:
            _t, msg_data = M.fetch(num, "(RFC822)")
            if not msg_data or not msg_data[0]:
                continue
            msg = email_mod.message_from_bytes(msg_data[0][1])
            mid = msg.get("Message-ID") or f"{num.decode()}:{msg.get('Date', '')}"
            if mid in seen:
                continue
            seen.add(mid)
            fresh.append({"from": _decode(msg.get("From")), "subject": _decode(msg.get("Subject")),
                          "text": _body_text(msg), "message_id": mid, "date": msg.get("Date", "")})
    finally:
        try:
            M.logout()
        except Exception:
            pass
    if fresh:
        filestore.put("flow_trigger_state", seen_key, {"seen": list(seen)[-5000:]})
    return fresh


# ───────────── Boîte partagée : une adresse par flow (plus-addressing, façon Windmill) ─────────────
# L'admin configure UNE boîte IMAP (ex : flows@entreprise.com). Chaque flow reçoit une
# adresse dérivée `flows+<token>@entreprise.com` ; le poller route par destinataire.
SETTINGS_SECTION = "trigger_settings"
EMAIL_KEY = "email_inbox"
_ADDR_HEADERS = ("To", "Cc", "Delivered-To", "X-Original-To", "Envelope-To", "Resent-To")


def email_settings() -> dict:
    """Réglages de la boîte partagée, mot de passe expurgé (pour l'UI/API)."""
    cfg = filestore.items(SETTINGS_SECTION).get(EMAIL_KEY) or {}
    out = {k: v for k, v in cfg.items() if k not in ("password_enc", "last_poll")}
    out["configured"] = bool(cfg.get("host") and cfg.get("address"))
    out["has_password"] = bool(cfg.get("password_enc"))
    return out


def save_email_settings(cfg: dict) -> dict:
    cur = filestore.items(SETTINGS_SECTION).get(EMAIL_KEY) or {}
    new = dict(cur)
    for k in ("host", "user", "folder", "address"):
        if cfg.get(k) is not None:
            new[k] = str(cfg[k]).strip()
    for k in ("port", "poll_s"):
        if cfg.get(k) is not None:
            new[k] = int(cfg[k])
    if cfg.get("enabled") is not None:
        new["enabled"] = bool(cfg["enabled"])
    if cfg.get("password"):
        new["password_enc"] = _enc(cfg["password"])
    addr = (new.get("address") or "").lower()
    if addr and "@" not in addr:
        raise ValueError("address doit être une adresse email complète (ex : flows@entreprise.com)")
    new["address"] = addr
    filestore.put(SETTINGS_SECTION, EMAIL_KEY, new)
    return email_settings()


def flow_address(token: str, settings: dict | None = None) -> str | None:
    """Adresse email dédiée d'un flow : base `local@dom` + token → `local+token@dom`."""
    s = settings if settings is not None else email_settings()
    addr = (s.get("address") or "").strip().lower()
    if not addr or "@" not in addr or not token:
        return None
    local, dom = addr.split("@", 1)
    return f"{local}+{token}@{dom}"


def _plus_tokens(msg, base_addr: str) -> list[str]:
    """Jetons `+<token>` trouvés dans les destinataires correspondant à l'adresse de base."""
    if "@" not in (base_addr or ""):
        return []
    local, dom = base_addr.lower().split("@", 1)
    raw = []
    for h in _ADDR_HEADERS:
        raw += msg.get_all(h) or []
    out = []
    for _n, a in email.utils.getaddresses(raw):
        a = (a or "").lower().strip()
        if "@" not in a:
            continue
        loc, d = a.split("@", 1)
        if d == dom and loc.startswith(local + "+"):
            tok = loc[len(local) + 1:]
            if tok and tok not in out:
                out.append(tok)
    return out


def shared_inbox_due(now=None) -> bool:
    """La boîte partagée est-elle à scruter maintenant ? (met à jour last_poll si oui)"""
    cfg = filestore.items(SETTINGS_SECTION).get(EMAIL_KEY) or {}
    if not cfg.get("host") or not cfg.get("address") or cfg.get("enabled") is False:
        return False
    now = now or time.time()
    if now - float(cfg.get("last_poll") or 0) < int(cfg.get("poll_s") or 60):
        return False
    cfg["last_poll"] = now
    filestore.put(SETTINGS_SECTION, EMAIL_KEY, cfg)
    return True


def poll_shared_inbox(imap_factory=None) -> list[tuple[str, dict]]:
    """Scrute la boîte partagée ; renvoie [(token, payload)] des nouveaux messages,
    un couple par adresse `+token` destinataire (dédup persistante par Message-ID)."""
    cfg = filestore.items(SETTINGS_SECTION).get(EMAIL_KEY) or {}
    base = cfg.get("address") or ""
    if not cfg.get("host") or not base:
        return []
    pwd = _dec(cfg["password_enc"]) if cfg.get("password_enc") else ""
    factory = imap_factory or (lambda: imaplib.IMAP4_SSL(cfg["host"], int(cfg.get("port") or 993)))
    seen_key = "emailtrig:shared"
    seen = set((filestore.items("flow_trigger_state").get(seen_key) or {}).get("seen") or [])
    fresh = []
    M = factory()
    try:
        M.login(cfg.get("user", ""), pwd)
        M.select(cfg.get("folder") or "INBOX")
        _typ, data = M.search(None, "UNSEEN")
        for num in (data[0].split() if data and data[0] else [])[:20]:
            _t, msg_data = M.fetch(num, "(RFC822)")
            if not msg_data or not msg_data[0]:
                continue
            msg = email_mod.message_from_bytes(msg_data[0][1])
            mid = msg.get("Message-ID") or f"{num.decode()}:{msg.get('Date', '')}"
            if mid in seen:
                continue
            seen.add(mid)
            payload = {"from": _decode(msg.get("From")), "to": _decode(msg.get("To")),
                       "subject": _decode(msg.get("Subject")), "text": _body_text(msg),
                       "message_id": mid, "date": msg.get("Date", "")}
            for tok in _plus_tokens(msg, base):
                fresh.append((tok, payload))
    finally:
        try:
            M.logout()
        except Exception:
            pass
    if fresh:
        filestore.put("flow_trigger_state", seen_key, {"seen": list(seen)[-5000:]})
    return fresh


def email_triggers_due(now=None, interval_default: int = 120) -> list[tuple[str, dict]]:
    """Triggers email à scruter maintenant (selon leur intervalle)."""
    now = now or time.time()
    out = []
    for tid, t in filestore.items(SECTION).items():
        if t.get("kind") != "email" or not t.get("enabled"):
            continue
        cfg = t.get("config") or {}
        every = int(cfg.get("poll_s") or interval_default)
        if now - float(t.get("last_poll") or 0) >= every:
            t["last_poll"] = now
            filestore.put(SECTION, tid, t)
            out.append((tid, t))
    return out
