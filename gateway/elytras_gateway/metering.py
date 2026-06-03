"""Comptage des tokens, coût et plafond — base de la facturation par client.

Chaque appel est journalisé (tokens, coût réel, coût refacturé avec marge), agrégé par
mois et par client. Le plafond mensuel optionnel coupe le service au dépassement.
"""
import datetime
import time

from . import config, store


def _month(ts: float | None = None) -> str:
    d = datetime.datetime.utcfromtimestamp(ts or time.time())
    return f"{d.year:04d}-{d.month:02d}"


def cost(tier: str, ptok: int, ctok: int):
    t = config.TIERS[tier]
    real = ptok / 1e6 * t["in"] + ctok / 1e6 * t["out"]
    billed = real * config.MARKUP
    return real, billed


def record(tenant_id: str, tier: str, model: str, ptok: int, ctok: int):
    real, billed = cost(tier, ptok, ctok)
    store.append_list("usage", {
        "ts": time.time(), "month": _month(), "tenant": tenant_id,
        "tier": tier, "model": model, "ptok": int(ptok), "ctok": int(ctok),
        "cost_real": round(real, 6), "cost_billed": round(billed, 6),
    })
    return real, billed


def month_usage(tenant_id: str, month: str | None = None) -> dict:
    month = month or _month()
    rows = [u for u in store.get_list("usage")
            if u.get("tenant") == tenant_id and u.get("month") == month]
    return {
        "tenant": tenant_id, "month": month, "calls": len(rows),
        "ptok": sum(u["ptok"] for u in rows), "ctok": sum(u["ctok"] for u in rows),
        "cost_real": round(sum(u["cost_real"] for u in rows), 4),
        "cost_billed": round(sum(u["cost_billed"] for u in rows), 4),
    }


def over_cap(tenant: dict) -> bool:
    cap = tenant.get("monthly_cap_usd")
    if not cap:
        return False
    return month_usage(tenant["id"])["cost_billed"] >= float(cap)
