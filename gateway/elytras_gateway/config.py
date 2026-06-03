"""Configuration de la passerelle — tout par variables d'environnement.

Les IDs de modèles et les prix sont CONFIGURABLES (ils évoluent) : on ne fige rien
dans le code. Trois gammes exposées au client (Éco / Standard / Max) ; le modèle réel
derrière chacune et son prix sont réglés ici, donc ajustables sans toucher au code.
"""
import os


def _f(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# Gamme -> { modèle backend (id OpenRouter), prix $/1M tokens entrée/sortie }.
# Valeurs par défaut = ordres de grandeur de juin 2026 ; à ajuster aux tarifs réels.
TIERS = {
    "eco": {
        "model": os.environ.get("GW_ECO_MODEL", "deepseek/deepseek-chat"),
        "in": _f("GW_ECO_IN", 0.14), "out": _f("GW_ECO_OUT", 0.28),
    },
    "standard": {
        "model": os.environ.get("GW_STD_MODEL", "openai/gpt-5-mini"),
        "in": _f("GW_STD_IN", 0.25), "out": _f("GW_STD_OUT", 2.00),
    },
    "max": {
        "model": os.environ.get("GW_MAX_MODEL", "anthropic/claude-haiku-4.5"),
        "in": _f("GW_MAX_IN", 1.00), "out": _f("GW_MAX_OUT", 5.00),
    },
}

DEFAULT_TIER = os.environ.get("GW_DEFAULT_TIER", "eco")

# Backend par défaut = OpenRouter (une facture, tous les modèles, fallback).
OPENROUTER_URL = os.environ.get("OPENROUTER_URL", "https://openrouter.ai/api/v1/chat/completions")
OPENROUTER_KEY = os.environ.get("OPENROUTER_API_KEY", "")

# Marge appliquée au coût refacturé au client (1.0 = au coût ; 2.0 = ×2).
MARKUP = _f("GW_MARKUP", 1.0)

# Persistance (mode fichier, comme Elytras) et jeton admin de la passerelle.
STATE_FILE = os.environ.get("GATEWAY_STATE_FILE", ".gateway-state.json")
ADMIN_TOKEN = os.environ.get("GATEWAY_ADMIN_TOKEN", "")
