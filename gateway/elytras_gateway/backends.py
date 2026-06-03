"""Appel au backend modèles. Par défaut : OpenRouter (une facture, 300+ modèles, fallback).

`CALL(model, payload)` est une indirection : les tests la remplacent par un faux backend,
et on pourra brancher un appel DIRECT (DeepSeek/Google/OpenAI) à gros volume sans toucher
au reste. La clé OpenRouter reste côté serveur (jamais exposée au client).
"""
import httpx

from . import config


def call_openrouter(model: str, payload: dict) -> dict:
    body = dict(payload)
    body["model"] = model
    body["stream"] = False                      # v1 : non-stream (comptage des tokens fiable)
    headers = {
        "Authorization": f"Bearer {config.OPENROUTER_KEY}",
        "Content-Type": "application/json",
        "X-Title": "Elytras",
    }
    r = httpx.post(config.OPENROUTER_URL, json=body, headers=headers, timeout=120)
    r.raise_for_status()
    return r.json()


# Point d'indirection (monkeypatché dans les tests, remplaçable par un backend direct).
CALL = call_openrouter
