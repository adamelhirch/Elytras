"""Options de l'étape Agent IA (façon Windmill) : system_prompt, output_schema, max_iterations."""
import elytras.providers as P


def _mk(client, H, tok, module):
    fid = client.post("/flows", json={"name": "F"}, headers=H(tok)).json()["id"]
    client.patch("/flows/" + fid, json={"modules": [module]}, headers=H(tok))
    return fid


def _run(client, H, tok, fid):
    return client.post("/flows/" + fid + "/run", json={}, headers=H(tok)).json()


def test_system_prompt_et_output_schema(client, admin, H):
    cap = {}

    def script(items, instr, tools):
        cap["instr"] = instr
        return {"text": '```json\n{"prix": 42, "devise": "EUR"}\n```', "tool_calls": []}
    P.CodexProvider.script = script

    fid = _mk(client, H, admin.token, {
        "id": "a", "summary": "a", "type": "agent", "agent_id": "orchestrateur",
        "prompt": "estime le prix", "system_prompt": "Tu es un expert en devis garage.",
        "output_schema": {"type": "object", "properties": {"prix": {"type": "number"}}},
        "max_iterations": 3})
    r = _run(client, H, admin.token, fid)
    assert r["status"] == "done"
    assert r["results"]["a"] == {"prix": 42, "devise": "EUR"}     # JSON parsé, exploitable en aval
    assert "expert en devis garage" in cap["instr"]               # instructions système injectées
    assert "JSON valide conforme" in cap["instr"]                 # consigne de schéma injectée


def test_max_iterations_borne_les_tours_outils(client, admin, H):
    calls = {"n": 0}

    def script(items, instr, tools):
        calls["n"] += 1
        # demande sans fin des appels d'outil → doit être coupé par max_iterations
        return {"text": "", "tool_calls": [{"call_id": f"c{calls['n']}", "name": "outil_inconnu",
                                            "arguments": "{}"}]}
    P.CodexProvider.script = script
    fid = _mk(client, H, admin.token, {
        "id": "a", "summary": "a", "type": "agent", "agent_id": "orchestrateur",
        "prompt": "boucle", "max_iterations": 2})
    r = _run(client, H, admin.token, fid)
    assert r["status"] == "done"
    assert calls["n"] == 2                                        # 2 tours, pas 8
    assert "trop d'étapes" in str(r["results"]["a"])


def test_sans_schema_texte_brut(client, admin, H):
    P.CodexProvider.script = lambda items, instr, tools: {"text": "réponse libre", "tool_calls": []}
    fid = _mk(client, H, admin.token, {"id": "a", "summary": "a", "type": "agent",
                                       "agent_id": "orchestrateur", "prompt": "dis bonjour"})
    r = _run(client, H, admin.token, fid)
    assert r["status"] == "done" and r["results"]["a"] == "réponse libre"
