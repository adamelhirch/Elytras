"""API de la passerelle IA d'Elytras.

- POST /v1/chat/completions : appelé par les instances Elytras avec leur CLÉ DE SERVICE.
  Auth → plafond → routage de la gamme → backend (OpenRouter) → comptage → réponse
  (modèle réel masqué). Compatible OpenAI : on relaie le corps tel quel.
- /admin/* : gestion des clients et lecture de l'usage (jeton admin requis).
- /health : sonde.
"""
import httpx
from fastapi import Depends, FastAPI, Header, HTTPException

from . import backends, config, metering, routing, tenants

app = FastAPI(title="Elytras LLM Gateway", version="0.1.0")


def _bearer(authorization: str | None) -> str | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    return authorization.split(" ", 1)[1].strip()


def _admin(authorization: str | None = Header(default=None)) -> bool:
    # Admin verrouillé tant que GATEWAY_ADMIN_TOKEN n'est pas défini (défaut sûr).
    if not config.ADMIN_TOKEN or _bearer(authorization) != config.ADMIN_TOKEN:
        raise HTTPException(403, "jeton admin requis")
    return True


@app.get("/health")
def health():
    return {"ok": True, "tiers": list(config.TIERS.keys()), "default_tier": config.DEFAULT_TIER}


@app.post("/v1/chat/completions")
def chat_completions(body: dict, authorization: str | None = Header(default=None)):
    tenant = tenants.resolve_key(_bearer(authorization) or "")
    if not tenant:
        raise HTTPException(401, "clé de service invalide ou client désactivé")

    tier, model = routing.resolve_tier(body.get("model"), tenant.get("tier_allowed"))
    if not tier:
        raise HTTPException(403, "gamme non autorisée pour ce client")

    if metering.over_cap(tenant):
        raise HTTPException(402, "plafond mensuel atteint")

    try:
        resp = backends.CALL(model, body)
    except httpx.HTTPStatusError as e:
        raise HTTPException(502, f"backend modèle : {e.response.status_code}")
    except httpx.HTTPError as e:
        raise HTTPException(502, f"backend modèle injoignable : {e}")

    usage = resp.get("usage") or {}
    ptok = usage.get("prompt_tokens", 0) or 0
    ctok = usage.get("completion_tokens", 0) or 0
    metering.record(tenant["id"], tier, model, ptok, ctok)

    resp["model"] = tier                      # on masque le modèle réel au client
    resp.setdefault("elytras", {})["tier"] = tier
    return resp


@app.post("/admin/tenants")
def admin_create_tenant(body: dict, _=Depends(_admin)):
    if not body.get("name"):
        raise HTTPException(400, "nom requis")
    return tenants.create(body["name"], body.get("tier_allowed"), body.get("monthly_cap_usd"))


@app.get("/admin/tenants")
def admin_list_tenants(_=Depends(_admin)):
    return {"tenants": tenants.list_all()}


@app.patch("/admin/tenants/{tid}")
def admin_update_tenant(tid: str, body: dict, _=Depends(_admin)):
    if not tenants.update(tid, **body):
        raise HTTPException(404, "client introuvable")
    return {"ok": True, "tenant": {k: v for k, v in tenants.get(tid).items() if k != "key_hash"}}


@app.delete("/admin/tenants/{tid}")
def admin_revoke_tenant(tid: str, _=Depends(_admin)):
    return {"ok": tenants.revoke(tid)}


@app.get("/admin/usage")
def admin_usage(tenant: str, month: str | None = None, _=Depends(_admin)):
    if not tenants.get(tenant):
        raise HTTPException(404, "client introuvable")
    return metering.month_usage(tenant, month)
