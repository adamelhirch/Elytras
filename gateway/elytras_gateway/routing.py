"""Traduction « gamme demandée par le client » -> modèle réel du backend.

Le client n'envoie jamais un nom de modèle technique : il demande une gamme
(« eco » / « standard » / « max »). La passerelle choisit le modèle concret et le masque.
"""
from . import config


def resolve_tier(model_field, tier_allowed):
    """(tier, model_id) si autorisé ; (None, None) si la gamme est interdite au client."""
    tier = (model_field or config.DEFAULT_TIER).strip().lower()
    if tier not in config.TIERS:
        tier = config.DEFAULT_TIER
    if tier not in (tier_allowed or list(config.TIERS.keys())):
        return None, None
    return tier, config.TIERS[tier]["model"]
