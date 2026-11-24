"""Catalogue Hub Windmill : endpoint catalogue + téléchargement de code (réseau mocké)."""
import json

import elytras.main as main


def test_catalog(client, admin):
    r = client.get("/hub/catalog", headers={"X-Elytras-Token": admin.token})
    assert r.status_code == 200
    d = r.json()
    assert d["counts"]["actions"] > 100        # 710 attendus
    assert d["counts"]["triggers"] >= 20
    assert any(a == "airtable" for a in d["integrations"])
    # une action connue est présente
    assert any(s.get("ask_id") == 298 for s in d["actions"])


def test_catalog_requires_auth(client, admin):
    # admin créé → setup terminé → un appel sans token n'est plus toléré
    assert client.get("/hub/catalog").status_code in (401, 403)


def test_pure_helpers():
    assert main._hub_slug("Create Multiple Records", "airtable") == "create-multiple-records-airtable"
    assert main._hub_guess_lang("def main(x):\n    return x") == "python3"
    assert main._hub_guess_lang("package main\nfunc main(){}") == "go"
    assert main._hub_guess_lang('import x from "https://deno.land/std/mod.ts"') == "deno"


def test_fetch_raw_negotiation(client, admin, monkeypatch):
    """Le Hub honore la négociation → code brut directement."""
    monkeypatch.setattr(main, "_hub_get", lambda url, accept="*/*", timeout=12.0:
                        (200, "def main():\n    return 1") if url.endswith("298/create-multiple-records-airtable")
                        else (404, ""))
    r = client.get("/hub/script/298", headers={"X-Elytras-Token": admin.token})
    assert r.status_code == 200
    d = r.json()
    assert d["ok"] and d["source"] == "raw"
    assert d["language"] == "python3"
    assert "def main" in d["content"]
    assert d["app"] == "airtable"


def test_fetch_devalue_fallback(client, admin, monkeypatch):
    """Page = HTML SPA → on bascule sur __data.json (format devalue SvelteKit)."""
    devalue = {"type": "data", "nodes": [None,
               {"type": "data", "data": [{"scripts": 1}, [2],
                {"content": 3, "language": 4, "summary": 5},
                "export async function main(){ return 1 }", "deno", "Create Multiple Records"],
                "uses": {}}]}

    def fake(url, accept="*/*", timeout=12.0):
        if url.endswith("__data.json"):
            return 200, json.dumps(devalue)
        return 200, "<!doctype html><html><body>SPA</body></html>"

    monkeypatch.setattr(main, "_hub_get", fake)
    d = client.get("/hub/script/298", headers={"X-Elytras-Token": admin.token}).json()
    assert d["ok"] and d["source"] == "data"
    assert d["language"] == "deno"
    assert "export async function main" in d["content"]


def test_fetch_graceful_none(client, admin, monkeypatch):
    """Réseau injoignable → repli gracieux (métadonnées + lien, pas d'erreur)."""
    monkeypatch.setattr(main, "_hub_get", lambda *a, **k: (None, ""))
    d = client.get("/hub/script/298", headers={"X-Elytras-Token": admin.token}).json()
    assert d["ok"] and d["source"] == "none"
    assert d["content"] == ""
    assert "hub.windmill.dev" in d["url"]


def test_fetch_unknown_id(client, admin):
    r = client.get("/hub/script/999999999", headers={"X-Elytras-Token": admin.token})
    assert r.status_code == 404
