"""Onboarding (génération de config) + provisioning (.env round-trip)."""
import json

import onboard
import provision


def test_sector_adapts_context_and_env():
    env, _, _ = onboard.build_config({"company": "Élec Pro", "ai_mode": "test", "sector": "artisan"})
    assert env["ELYTRAS_SECTOR"] == "artisan"
    ctx = onboard.sector_context("artisan", "Élec Pro")
    assert "Élec Pro" in ctx and "devis" in ctx.lower()          # contexte adapté au métier


def test_unknown_sector_falls_back():
    env, _, _ = onboard.build_config({"company": "X", "ai_mode": "test", "sector": "spatial"})
    assert env["ELYTRAS_SECTOR"] == "autre"                       # secteur inconnu -> générique


def test_write_emits_company_context(tmp_path):
    onboard.write({"company": "Resto Bel", "ai_mode": "test", "sector": "resto"}, deploy_dir=tmp_path)
    md = (tmp_path / "company-context.md").read_text()
    assert "Resto Bel" in md and "réservations" in md.lower()     # workflows du secteur


def test_build_config_test_mode_codex():
    env, profiles, modules = onboard.build_config(
        {"company": "Garage Martin", "ai_mode": "test", "modules": ["demo"]})
    assert env["ELYTRAS_PROVIDER"] == "codex"               # gratuit via abonnement
    assert "OPENROUTER_API_KEY" not in env                  # pas de frais OpenRouter
    assert env["ELYTRAS_COMPANY"] == "Garage Martin"
    assert env["CODEX_MODEL"] and "demo" in profiles and env["COMPOSE_PROFILES"] == "demo"


def test_build_config_prod_mode_gateway():
    env, profiles, _ = onboard.build_config(
        {"company": "Boutique X", "ai_mode": "prod", "openrouter_key": "sk-or-123", "markup": "1.5"})
    assert env["ELYTRAS_PROVIDER"] == "elytras-gateway"
    assert env["OPENROUTER_API_KEY"] == "sk-or-123"
    assert len(env["GATEWAY_ADMIN_TOKEN"]) > 20            # jeton admin généré
    assert env["ELYTRAS_GATEWAY_KEY"] == ""                # rempli au provisioning
    assert "prod" in profiles and env["GW_MARKUP"] == "1.5"


def test_render_env_lines():
    env, _, _ = onboard.build_config({"company": "ACME", "ai_mode": "test"})
    txt = onboard.render_env(env)
    assert "ELYTRAS_COMPANY=ACME" in txt and txt.startswith("#")


def test_write_creates_files(tmp_path):
    onboard.write({"company": "Z", "ai_mode": "test", "modules": ["demo"]}, deploy_dir=tmp_path)
    assert (tmp_path / ".env").exists()
    sel = json.loads((tmp_path / "selection.json").read_text())
    assert sel["modules"] == ["demo"] and sel["ai_mode"] == "test"


def test_provision_env_roundtrip(tmp_path, monkeypatch):
    envf = tmp_path / ".env"
    envf.write_text("ELYTRAS_PROVIDER=elytras-gateway\nELYTRAS_GATEWAY_KEY=\nGATEWAY_ADMIN_TOKEN=tok\n")
    monkeypatch.setattr(provision, "ENV", envf)
    assert provision.read_env()["ELYTRAS_GATEWAY_KEY"] == ""
    provision.set_env("ELYTRAS_GATEWAY_KEY", "elyt-abc")     # met à jour la ligne existante
    provision.set_env("EXTRA", "1")                          # ajoute une ligne absente
    e = provision.read_env()
    assert e["ELYTRAS_GATEWAY_KEY"] == "elyt-abc" and e["EXTRA"] == "1" and e["GATEWAY_ADMIN_TOKEN"] == "tok"
