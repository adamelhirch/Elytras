"""Sensibilité d'action + autonomie (ASK / AUTO).

Règle (décidée avec Léo) : les actions READ passent direct ; les actions SENSIBLES
exigent une validation humaine SAUF si l'agent est en mode AUTO (opt-in).
"""
from __future__ import annotations

from enum import Enum


class Sensitivity(str, Enum):
    READ = "read"            # lister, calculer — aucun effet de bord
    SENSITIVE = "sensitive"  # envoyer un mail, modifier, supprimer, dépenser


# Classement par défaut des tools (extensible par connecteur/skill)
TOOL_SENSITIVITY: dict[str, Sensitivity] = {
    "list_customers": Sensitivity.READ,
    "list_orders": Sensitivity.READ,
    "compute": Sensitivity.READ,
    "recall_memory": Sensitivity.READ,
    "send_email": Sensitivity.SENSITIVE,
    "update_setting": Sensitivity.SENSITIVE,
    "delete": Sensitivity.SENSITIVE,
    "create_order": Sensitivity.SENSITIVE,
    "issue_refund": Sensitivity.SENSITIVE,
}


def sensitivity_of(tool: str) -> Sensitivity:
    # Par prudence, un tool inconnu est traité comme SENSIBLE.
    return TOOL_SENSITIVITY.get(tool, Sensitivity.SENSITIVE)


def decide(tool: str, autonomy_level: str) -> str:
    """Retourne 'execute' ou 'need_approval'."""
    if sensitivity_of(tool) == Sensitivity.READ:
        return "execute"
    return "execute" if autonomy_level == "auto" else "need_approval"
