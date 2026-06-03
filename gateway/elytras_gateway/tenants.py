"""Clients de la passerelle (1 client = 1 instance Elytras).

Chaque client a une CLÉ DE SERVICE (≠ clé OpenRouter), stockée seulement sous forme de
hash : on l'affiche UNE fois à la création. Elle porte les gammes autorisées et un
plafond mensuel optionnel. La clé OpenRouter, elle, ne quitte jamais la passerelle.
"""
import hashlib
import secrets
import time

from . import config, store


def _hash(key: str) -> str:
    return hashlib.sha256((key or "").encode()).hexdigest()


def create(name: str, tier_allowed=None, monthly_cap_usd=None) -> dict:
    tid = secrets.token_hex(8)
    key = "elyt-" + secrets.token_urlsafe(32)
    store.put_dict("tenants", tid, {
        "id": tid,
        "name": name,
        "key_hash": _hash(key),
        "tier_allowed": tier_allowed or list(config.TIERS.keys()),
        "monthly_cap_usd": monthly_cap_usd,
        "active": True,
        "created": time.time(),
    })
    return {"id": tid, "name": name, "service_key": key}   # clé montrée une seule fois


def _public(t: dict) -> dict:
    return {k: v for k, v in t.items() if k != "key_hash"}


def list_all() -> list:
    return [_public(t) for t in store.get_dict("tenants").values()]


def get(tid: str):
    return store.get_dict("tenants").get(tid)


def resolve_key(key: str):
    """Retourne le client actif correspondant à la clé de service, sinon None."""
    h = _hash(key)
    for t in store.get_dict("tenants").values():
        if t.get("key_hash") == h and t.get("active"):
            return t
    return None


def update(tid: str, **fields) -> bool:
    t = get(tid)
    if not t:
        return False
    for k in ("monthly_cap_usd", "tier_allowed", "active", "name"):
        if k in fields:
            t[k] = fields[k]
    store.put_dict("tenants", tid, t)
    return True


def revoke(tid: str) -> bool:
    return update(tid, active=False)
