#!/usr/bin/env python3
"""Onboarding terminal d'Elytras — configure le minimum et génère .env + profils Docker.

But : démarrer une instance pour UNE entreprise sur UN serveur, en répondant à
quelques questions. Deux modes de cerveau IA :
  - TEST  : Codex (gratuit via ton abonnement ChatGPT) — pas de frais OpenRouter.
  - PROD  : passerelle IA + OpenRouter (resell facturé).

Usage :
  python3 onboard.py            # interactif
  python3 onboard.py --show     # affiche la config sans rien écrire
"""
import argparse
import json
import pathlib
import secrets

DEPLOY_DIR = pathlib.Path(__file__).resolve().parent

MODULES = {
    "demo": "Serveur MCP d'exemple (démo, supprimable)",
    "odoo": "Odoo — gestion / factures / devis (à venir)",
    "whatsapp": "WhatsApp vocal (à venir)",
}
AVAILABLE_NOW = {"demo"}

# Profils sectoriels : adaptent l'onboarding au type d'entreprise (contexte + workflows + modules suggérés).
SECTORS = {
    "artisan": {
        "label": "Artisan / BTP (électricien, plombier, garage…)",
        "desc": "devis, factures, prise de RDV / interventions, relances, réponses aux mails",
        "modules": ["odoo"],
        "workflows": ["Relancer les devis non signés",
                      "Établir la facture après une intervention",
                      "Répondre aux demandes de devis reçues par mail"],
    },
    "commerce": {
        "label": "Commerce de détail (boutique, magasin)",
        "desc": "ventes, stock, fiches produits, fidélité / CRM, réponses clients",
        "modules": ["odoo"],
        "workflows": ["Relancer les clients inactifs",
                      "Mettre à jour les fiches produits",
                      "Répondre aux avis et messages clients"],
    },
    "services": {
        "label": "Services / professions libérales (cabinet, conseil)",
        "desc": "prise de RDV, devis / factures, suivi client, mails",
        "modules": [],
        "workflows": ["Prendre les RDV et envoyer les rappels",
                      "Émettre les factures récurrentes",
                      "Trier et répondre aux mails"],
    },
    "resto": {
        "label": "Restauration / hôtellerie",
        "desc": "réservations, commandes fournisseurs, avis, plannings",
        "modules": [],
        "workflows": ["Gérer les réservations et confirmations",
                      "Répondre aux avis en ligne",
                      "Passer les commandes fournisseurs"],
    },
    "ecommerce": {
        "label": "E-commerce / vente en ligne",
        "desc": "commandes, SAV, fiches produits, relances panier, avis",
        "modules": ["odoo"],
        "workflows": ["Relancer les paniers abandonnés",
                      "Répondre aux demandes SAV par mail",
                      "Mettre à jour et enrichir les fiches produits"],
    },
    "sante": {
        "label": "Santé / paramédical (cabinet, praticien)",
        "desc": "prise de RDV, rappels, facturation, courriers",
        "modules": [],
        "workflows": ["Prendre les RDV et envoyer les rappels",
                      "Émettre les factures et feuilles de soins",
                      "Trier et router les mails et appels"],
    },
    "immobilier": {
        "label": "Immobilier / agence",
        "desc": "annonces, RDV visites, dossiers, relances",
        "modules": [],
        "workflows": ["Planifier les visites et rappels",
                      "Constituer et relancer les dossiers",
                      "Répondre aux demandes de biens par mail"],
    },
    "autre": {
        "label": "Autre / générique",
        "desc": "mails, devis, factures, RDV, tâches administratives",
        "modules": [],
        "workflows": ["Trier et répondre aux mails",
                      "Établir devis et factures",
                      "Gérer l'agenda et les RDV"],
    },
}


def sector_context(sector: str, company: str) -> str:
    """Modèle de « contexte entreprise » (mémoire système) pré-rempli selon le secteur."""
    s = SECTORS.get(sector, SECTORS["autre"])
    wf = "\n".join(f"- {w}" for w in s["workflows"])
    return (f"# Contexte de l'entreprise — {company}\n\n"
            f"Secteur : {s['label']}.\n"
            f"Activités à automatiser en priorité : {s['desc']}.\n\n"
            f"## Workflows de départ suggérés\n{wf}\n\n"
            f"## À compléter pendant l'onboarding\n"
            f"- Présentation de l'entreprise, ton et préférences de communication.\n"
            f"- Outils utilisés (ex. Odoo, Gmail, agenda) à connecter via MCP.\n"
            f"- Règles internes et points de vigilance.\n")


def _gen(n: int = 32) -> str:
    return secrets.token_urlsafe(n)


def build_config(a: dict):
    """Réponses -> (env: dict, profiles: list, modules: list). Fonction pure (testable)."""
    company = a.get("company") or "Mon Entreprise"
    mode = (a.get("ai_mode") or "test").lower()
    domain = (a.get("domain") or "").strip()
    sector = (a.get("sector") or "autre").lower()
    if sector not in SECTORS:
        sector = "autre"
    # Modules : ceux choisis ; sinon ceux suggérés par le secteur (filtrés sur le disponible).
    chosen = a.get("modules") if a.get("modules") is not None else SECTORS[sector]["modules"]
    modules = [m for m in chosen if m in AVAILABLE_NOW]

    env = {
        "ELYTRAS_COMPANY": company,
        "ELYTRAS_SECTOR": sector,
        "ELYTRAS_SITE_ADDRESS": domain or ":80",      # Caddy : domaine => HTTPS auto ; sinon HTTP local
        "ELYTRAS_OAUTH_BIND": "0.0.0.0",              # conteneur ; port publié seulement en 127.0.0.1
    }
    profiles: list[str] = []

    if mode == "prod":
        env["ELYTRAS_PROVIDER"] = "elytras-gateway"
        env["ELYTRAS_GATEWAY_URL"] = "http://gateway:8088"
        env["ELYTRAS_GATEWAY_TIER"] = a.get("tier") or "eco"
        env["ELYTRAS_GATEWAY_KEY"] = ""               # rempli après provisioning (install.sh)
        env["OPENROUTER_API_KEY"] = a.get("openrouter_key") or ""
        env["GATEWAY_ADMIN_TOKEN"] = a.get("admin_token") or _gen(32)
        env["GW_MARKUP"] = str(a.get("markup") or "1.5")
        env["GATEWAY_COMPANY"] = company
        env["GATEWAY_CAP_USD"] = str(a.get("cap") or "")
        profiles.append("prod")
    else:
        env["ELYTRAS_PROVIDER"] = "codex"             # TEST : gratuit via abonnement ChatGPT
        env["CODEX_MODEL"] = a.get("codex_model") or "gpt-5.4-mini"

    if "demo" in modules:
        profiles.append("demo")
    if profiles:
        env["COMPOSE_PROFILES"] = ",".join(profiles)
    return env, profiles, modules


def render_env(env: dict) -> str:
    head = "# Généré par onboard.py — NE PAS committer (peut contenir des secrets).\n"
    return head + "\n".join(f"{k}={v}" for k, v in env.items()) + "\n"


def write(a: dict, deploy_dir: pathlib.Path = DEPLOY_DIR):
    env, profiles, modules = build_config(a)
    sector = env["ELYTRAS_SECTOR"]
    (deploy_dir / ".env").write_text(render_env(env), encoding="utf-8")
    (deploy_dir / "selection.json").write_text(
        json.dumps({"company": a.get("company"), "sector": sector, "ai_mode": a.get("ai_mode"),
                    "modules": modules, "profiles": profiles,
                    "suggested_workflows": SECTORS[sector]["workflows"]}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    # Modèle de contexte entreprise (à coller dans la mémoire système lors de l'onboarding).
    (deploy_dir / "company-context.md").write_text(
        sector_context(sector, env["ELYTRAS_COMPANY"]), encoding="utf-8")
    return env, profiles, modules


# ───────────────────────── Interactif ─────────────────────────
def _ask(q: str, default: str = "") -> str:
    r = input(f"{q}" + (f" [{default}]" if default else "") + " : ").strip()
    return r or default


def _ask_yn(q: str, default: bool = True) -> bool:
    r = input(f"{q} ({'O/n' if default else 'o/N'}) : ").strip().lower()
    return default if not r else r in ("o", "oui", "y", "yes")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--show", action="store_true", help="afficher sans écrire")
    args = ap.parse_args()

    print("\n=== Onboarding Elytras (1 entreprise / 1 serveur) ===\n")
    a: dict = {"company": _ask("Nom de l'entreprise", "Mon Entreprise")}

    print("\nSecteur d'activité (adapte le contexte et les workflows de départ) :")
    keys = list(SECTORS.keys())
    for i, k in enumerate(keys, 1):
        print(f"  {i}) {SECTORS[k]['label']}")
    sel = _ask("Choix", str(len(keys)))
    try:
        a["sector"] = keys[int(sel) - 1]
    except (ValueError, IndexError):
        a["sector"] = "autre"

    print("\nCerveau IA :")
    print("  1) Test — Codex, gratuit via ton abonnement ChatGPT (recommandé pour démarrer)")
    print("  2) Production — passerelle + OpenRouter (facturé)")
    a["ai_mode"] = "prod" if _ask("Choix", "1") == "2" else "test"
    if a["ai_mode"] == "prod":
        a["openrouter_key"] = _ask("Clé OpenRouter (vide = à renseigner plus tard)")
        a["markup"] = _ask("Marge refacturée (1.5 = +50 %)", "1.5")
        a["cap"] = _ask("Plafond mensuel par défaut en $ (vide = aucun)")

    a["domain"] = _ask("Domaine (vide = accès local en HTTP)")

    print("\nOptions / modules :")
    mods = []
    if _ask_yn("  Installer le serveur MCP d'exemple (démo) ?", False):
        mods.append("demo")
    for m in ("odoo", "whatsapp"):
        print(f"  - {MODULES[m]}")
    a["modules"] = mods

    if args.show:
        env, _, _ = build_config(a)
        print("\n--- .env ---\n" + render_env(env))
        return

    env, profiles, modules = write(a)
    print("\n✅ Configuration écrite (.env + selection.json).")
    if a["ai_mode"] == "test":
        print("   Mode TEST (Codex) : après le démarrage, connecte Codex depuis l'interface (carte Providers).")
    print(f"   Profils Docker : {','.join(profiles) or '(aucun)'}")
    print("   Lance ensuite : ./install.sh\n")


if __name__ == "__main__":
    main()
