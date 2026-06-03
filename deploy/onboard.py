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


def _gen(n: int = 32) -> str:
    return secrets.token_urlsafe(n)


def build_config(a: dict):
    """Réponses -> (env: dict, profiles: list, modules: list). Fonction pure (testable)."""
    company = a.get("company") or "Mon Entreprise"
    mode = (a.get("ai_mode") or "test").lower()
    domain = (a.get("domain") or "").strip()
    modules = [m for m in (a.get("modules") or []) if m in AVAILABLE_NOW]

    env = {
        "ELYTRAS_COMPANY": company,
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
    (deploy_dir / ".env").write_text(render_env(env), encoding="utf-8")
    (deploy_dir / "selection.json").write_text(
        json.dumps({"company": a.get("company"), "ai_mode": a.get("ai_mode"),
                    "modules": modules, "profiles": profiles}, ensure_ascii=False, indent=2),
        encoding="utf-8")
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
