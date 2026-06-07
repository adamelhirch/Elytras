"""Choix de la mémoire par étape agent dans un flow (flow / perso / projet / aucune)."""
import elytras.memory_engine as ME
import elytras.providers as P
import elytras.rbac as R


def _mk(client, H, tok, modules):
    fid = client.post("/flows", json={"name": "F"}, headers=H(tok)).json()["id"]
    client.patch("/flows/" + fid, json={"modules": modules}, headers=H(tok))
    return fid


def _agent_step(memory):
    return [{"id": "a", "summary": "a", "type": "agent", "agent_id": "orchestrateur",
             "prompt": "qui ?", "memory": memory}]


def test_agent_step_memory_scope(client, admin, H):
    adm, _ = R.find_by_email("admin@x.com")
    ME.add_fact("user", adm, None, "Le client favori s'appelle Zaza.")
    cap = {}
    P.CodexProvider.script = lambda items, instr, tools: (cap.update(instr=instr) or {"text": "ok", "tool_calls": []})

    fid = _mk(client, H, admin.token, _agent_step("perso"))     # perso → rappelle la mémoire utilisateur
    client.post("/flows/" + fid + "/run", json={}, headers=H(admin.token))
    assert "Zaza" in cap.get("instr", "")

    cap.clear()
    fid2 = _mk(client, H, admin.token, _agent_step("none"))      # aucune → pas de mémoire rappelée
    client.post("/flows/" + fid2 + "/run", json={}, headers=H(admin.token))
    assert "Zaza" not in cap.get("instr", "")
