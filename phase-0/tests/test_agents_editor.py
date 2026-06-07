"""Éditeur d'agents : champs détaillés + périmètre d'outils par agent (effet réel)."""
import elytras.agents as A
import elytras.main as M
import elytras.rbac as R


def test_agent_crud_extended(state):
    aid = A.create_agent("Vendeur", "ventes", "Tu vends.", "auto",
                         emoji="🛍️", color="#4f46e5", tools={"web": False}, tier="eco")
    a = A.get_agent(aid)
    assert a["emoji"] == "🛍️" and a["autonomy"] == "auto" and a["tools"]["web"] is False and a["tier"] == "eco"
    assert A.update_agent(aid, {"instructions": "Nouveau persona", "tier": "max"})
    a = A.get_agent(aid)
    assert a["instructions"] == "Nouveau persona" and a["tier"] == "max"
    # surcharge d'un agent intégré (builtin)
    assert A.update_agent("support", {"emoji": "🎧", "autonomy": "auto"})
    assert A.get_agent("support")["emoji"] == "🎧" and A.get_agent("support")["autonomy"] == "auto"
    # le token du bot n'est jamais exposé dans la liste
    assert all("telegram_token" not in x for x in A.list_agents())


def test_agent_tool_scope_applied(client, admin, H):
    adm, _ = R.find_by_email("admin@x.com")            # admin = toutes les capacités
    restricted = {"id": "r", "name": "Resto", "instructions": "Tu gères un resto.",
                  "tools": {"files": True, "web": False, "flows": False, "delegate": False, "mcp": False, "skills": False}}
    _, tools, _ = M._agent_setup(restricted, [{"role": "user", "content": "bonjour"}], "user", adm, None, adm, 0)
    names = [t.get("name") for t in tools]
    assert "read_file" in names                        # fichiers autorisés pour cet agent
    assert "browse" not in names                       # web coupé au niveau de l'agent
    assert "create_flow" not in names                  # flows coupés au niveau de l'agent
    assert "delegate" not in names

    full = {"id": "f", "name": "Full", "instructions": "Agent complet."}   # défaut : tout autorisé
    _, tools2, _ = M._agent_setup(full, [{"role": "user", "content": "x"}], "user", adm, None, adm, 0)
    n2 = [t.get("name") for t in tools2]
    assert "browse" in n2 and "read_file" in n2 and "create_flow" in n2


def test_agent_endpoints_extended(client, admin, H):
    r = client.post("/agents", json={"name": "Compta", "role": "comptable",
                                     "instructions": "Tu gères la compta.", "emoji": "🧾",
                                     "tools": {"web": False}}, headers=H(admin.token))
    aid = r.json()["id"]
    a = [x for x in client.get("/agents", headers=H(admin.token)).json()["agents"] if x["id"] == aid][0]
    assert a["emoji"] == "🧾" and a["tools"]["web"] is False and a["role"] == "comptable"
    client.patch("/agents/" + aid, json={"instructions": "MAJ persona", "tier": "max"}, headers=H(admin.token))
    a = [x for x in client.get("/agents", headers=H(admin.token)).json()["agents"] if x["id"] == aid][0]
    assert a["instructions"] == "MAJ persona" and a["tier"] == "max"
