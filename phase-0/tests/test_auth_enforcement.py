"""Authentification + verrous (endpoints ET dispatch des outils de l'agent)."""
import json
import elytras.providers as P


def test_no_token_locked_after_setup(client, admin):
    assert client.get("/auth/setup-needed").json()["needed"] is False
    # sans jeton après setup : plus aucun droit
    assert client.post("/flows", json={"name": "x"}).status_code == 403


def test_admin_can_create_flow(client, admin, H):
    assert client.post("/flows", json={"name": "F"}, headers=H(admin.token)).status_code == 200


def test_lecteur_blocked_on_write(client, admin, H):
    t = admin.mkteam("Lect", "lecteur")
    tok = admin.mkuser("Z", "z@x.com", "pz", [t])
    assert client.post("/flows", json={"name": "x"}, headers=H(tok)).status_code == 403          # flow.create
    assert client.post("/mcp/servers", json={"name": "n", "url": "http://x"}, headers=H(tok)).status_code == 403  # mcp.manage
    assert client.get("/admin/teams", headers=H(tok)).status_code == 403                          # admin


def test_lecteur_cannot_create_flow_via_chat(client, admin, H):
    """Faille corrigée : l'enforcement est AU DISPATCH, pas seulement à l'offre des outils."""
    t = admin.mkteam("Lect", "lecteur")
    tok = admin.mkuser("Z", "z@x.com", "pz", [t])

    def script(items, instr, tools):
        if any(it.get("type") == "function_call_output" for it in items):
            outs = [it for it in items if it.get("type") == "function_call_output"]
            return {"text": "résultat=" + outs[-1]["output"], "tool_calls": []}
        return {"text": "", "tool_calls": [{"call_id": "c", "name": "create_flow",
                                            "arguments": json.dumps({"description": "x", "name": "Pirate"})}]}
    P.CodexProvider.script = script
    n0 = len(client.get("/flows", headers=H(tok)).json()["flows"])
    d = client.post("/chat", json={"messages": [{"role": "user", "content": "crée un flow"}]}, headers=H(tok)).json()
    assert len(client.get("/flows", headers=H(tok)).json()["flows"]) == n0      # rien créé
    assert d.get("status") != "confirm" and "flow.create" in (d.get("content") or "")


def test_operator_create_flow_asks_validation(client, admin, H):
    t = admin.mkteam("Ops", "operateur")
    tok = admin.mkuser("O", "o@x.com", "po", [t])

    def script(items, instr, tools):
        return {"text": "", "tool_calls": [{"call_id": "c", "name": "create_flow",
                                            "arguments": json.dumps({"description": "x", "name": "Flux"})}]}
    P.CodexProvider.script = script
    d = client.post("/chat", json={"messages": [{"role": "user", "content": "crée un flow"}]}, headers=H(tok)).json()
    assert d.get("status") == "confirm"          # opérateur a le droit → passe par la validation (ASK)
