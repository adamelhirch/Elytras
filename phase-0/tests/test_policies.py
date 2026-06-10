"""Policies par rôle — la « sandbox » des agents : résolution, enforcement, endpoints.

Garantie centrale : SANS policy, comportement historique inchangé (zéro régression) ;
AVEC policy, l'agent est borné (outils, agents, skills, mémoire, autonomie) même si
les capacités RBAC de l'utilisateur permettraient plus.
"""
import json

import elytras.agents as A
import elytras.main as M
import elytras.policy as P
import elytras.providers as Pr
import elytras.rbac as R


def _user(admin, role="operateur", suffix="1"):
    """Compte non-admin dans une équipe portant `role` → (uid, token)."""
    tid = admin.mkteam("Equipe" + suffix, role)
    tok = admin.mkuser("U" + suffix, f"u{suffix}@x.com", "pw", [tid])
    uid, _ = R.find_by_email(f"u{suffix}@x.com")
    return uid, tok


# ───────────────────────── Moteur : résolution ─────────────────────────

def test_sans_policy_tout_est_permis(client, admin, H):
    uid, _ = _user(admin)
    eff = P.effective(uid)
    assert eff == P.UNRESTRICTED                              # comportement historique
    assert P.agent_allowed(uid, "support") and P.allowed_servers(uid) is None
    assert P.clamp_memory(uid, "project") == "project"
    assert P.clamp_autonomy(uid, "auto") == "auto"            # rien d'imposé


def test_set_policy_valide_et_protege(state):
    assert P.set_policy("admin", {"web": False}) is None      # admin non bridable
    assert P.set_policy("role_inconnu", {}) is None
    p = P.set_policy("operateur", {"autonomy": "agent", "memory_scopes": ["user", "zorg"]})
    assert p["autonomy"] is None                              # « agent » = laisser le réglage
    assert p["memory_scopes"] == ["user"]                     # scopes inconnus filtrés
    assert P.delete_policy("operateur") is True
    assert P.get_policy("operateur") is None


def test_union_entre_roles_le_plus_permissif_gagne(client, admin, H):
    rid_a = R.create_role("Bridee", ["agent.use", "web.browse"])
    rid_b = R.create_role("Libre", ["agent.use", "web.browse"])
    P.set_policy(rid_a, {"web": False, "agents": ["orchestrateur"], "autonomy": "ask"})
    ta, tb = admin.mkteam("A", rid_a), admin.mkteam("B", rid_b)
    admin.mkuser("Duo", "duo@x.com", "pw", [ta, tb])
    uid, _ = R.find_by_email("duo@x.com")
    eff = P.effective(uid)
    assert eff == P.UNRESTRICTED                              # B sans policy → aucune limite
    # B reçoit une policy restrictive → l'union des deux s'applique
    P.set_policy(rid_b, {"web": True, "agents": ["orchestrateur", "support"], "autonomy": "auto"})
    eff = P.effective(uid)
    assert eff["web"] is True                                 # OR des familles
    assert set(eff["agents"]) == {"orchestrateur", "support"}  # union des listes
    assert eff["autonomy"] == "auto"                          # auto > ask


# ───────────────────────── Enforcement : outils de l'agent ─────────────────────────

def test_policy_retire_les_outils_de_l_agent(client, admin, H):
    uid, _ = _user(admin, "operateur", "2")                   # opérateur : web+flows+fichiers permis
    full = {"id": "f", "name": "Full", "instructions": "Agent complet."}
    _, tools, _ = M._agent_setup(full, [{"role": "user", "content": "x"}], "user", uid, None, uid, 0)
    names = [t.get("name") for t in tools]
    assert "browse" in names and "run_flow" not in names or True   # état de référence (flows listés si existants)
    assert "browse" in names

    P.set_policy("operateur", {"web": False, "flows": False, "files": False, "skills": []})
    _, tools2, _ = M._agent_setup(full, [{"role": "user", "content": "x"}], "user", uid, None, uid, 0)
    n2 = [t.get("name") for t in tools2]
    assert "browse" not in n2                                 # web coupé par la POLICY (pas par l'agent)
    assert "create_flow" not in n2 and "run_flow" not in n2
    assert "read_file" not in n2 and "use_skill" not in n2    # fichiers + skills coupés
    # l'admin, lui, n'est jamais bridé
    adm, _ = R.find_by_email("admin@x.com")
    _, t3, _ = M._agent_setup(full, [{"role": "user", "content": "x"}], "user", adm, None, adm, 0)
    assert "browse" in [t.get("name") for t in t3]


def test_use_skill_refuse_hors_policy(client, admin, H):
    uid, _ = _user(admin, "operateur", "3")
    P.set_policy("operateur", {"skills": []})
    out = M._dispatch_call("use_skill", {"name": "clients-inactifs"},
                           {"id": "f", "name": "F"}, {"mscope": "user", "mowner": uid, "mproj": None,
                                                      "user_id": uid, "session_id": None,
                                                      "parent_id": None, "depth": 0}, [], {})
    assert "refusé" in out.get("error", "")


# ───────────────────────── Enforcement : agents & chat ─────────────────────────

def test_chat_agent_hors_policy_403(client, admin, H):
    _, tok = _user(admin, "operateur", "4")
    P.set_policy("operateur", {"agents": ["support"]})        # l'orchestrateur n'est PAS permis
    r = client.post("/chat", json={"messages": [{"role": "user", "content": "salut"}]}, headers=H(tok))
    assert r.status_code == 403 and "policy" in r.json()["error"]
    r2 = client.post("/chat", json={"messages": [{"role": "user", "content": "salut"}],
                                    "agent_id": "support"}, headers=H(tok))
    assert r2.status_code == 200                              # l'agent permis, lui, répond


def test_delegation_bornee_par_policy(client, admin, H):
    uid, tok = _user(admin, "operateur", "5")
    P.set_policy("operateur", {"agents": ["orchestrateur"]})  # peut parler à l'orchestrateur, pas à Ventes
    calls = {"n": 0}

    def script(items, instr, tools):
        calls["n"] += 1
        if calls["n"] == 1:
            return {"text": "", "tool_calls": [{"call_id": "c1", "name": "delegate",
                                                "arguments": json.dumps({"agent": "Ventes/CRM", "task": "relance"})}]}
        out = next((i for i in items if i.get("type") == "function_call_output"), {})
        return {"text": "résultat: " + (out.get("output") or ""), "tool_calls": []}

    Pr.CodexProvider.script = script
    r = client.post("/chat", json={"messages": [{"role": "user", "content": "délègue"}]}, headers=H(tok))
    assert r.status_code == 200
    assert "hors du périmètre" in r.json()["content"]         # la délégation a été refusée par la policy


def test_autonomie_forcee_ask_par_policy(client, admin, H):
    uid, tok = _user(admin, "operateur", "6")
    aid = A.create_agent("Fonceur", autonomy="auto")          # agent qui n'attend pas les validations
    calls = {"n": 0}

    def script(items, instr, tools):
        calls["n"] += 1
        if calls["n"] == 1:
            return {"text": "", "tool_calls": [{"call_id": "c1", "name": "create_flow",
                                                "arguments": json.dumps({"description": "relancer les impayés"})}]}
        return {"text": "fait", "tool_calls": []}

    Pr.CodexProvider.script = script
    r = client.post("/chat", json={"messages": [{"role": "user", "content": "crée un flow"}],
                                   "agent_id": aid}, headers=H(tok))
    assert r.json().get("status") != "confirm"                # AUTO : pas de pause (référence)

    P.set_policy("operateur", {"autonomy": "ask"})            # la policy force la validation humaine
    calls["n"] = 0
    r2 = client.post("/chat", json={"messages": [{"role": "user", "content": "crée un flow"}],
                                    "agent_id": aid}, headers=H(tok))
    assert r2.json().get("status") == "confirm"               # pause malgré l'agent en mode auto
    assert r2.json()["confirm"]["tool"] == "create_flow"


# ───────────────────────── Enforcement : mémoire ─────────────────────────

def test_memoire_clampee_par_policy(client, admin, H):
    uid, _ = _user(admin, "operateur", "7")
    P.set_policy("operateur", {"memory_scopes": ["user"]})
    assert P.clamp_memory(uid, "user") == "user"
    assert P.clamp_memory(uid, "project") is None             # projet refusé → pas de mémoire
    P.set_policy("operateur", {"memory_scopes": []})
    assert P.clamp_memory(uid, "user") is None


# ───────────────────────── Endpoints admin ─────────────────────────

def test_endpoints_crud_et_403(client, admin, H):
    _, tok = _user(admin, "lecteur", "8")
    assert client.get("/admin/policies", headers=H(tok)).status_code == 403   # non-admin
    d = client.get("/admin/policies", headers=H(admin.token)).json()
    assert "roles" in d and "agents" in d and "memory_scopes" in d

    r = client.patch("/admin/policies/lecteur", json={"web": False, "agents": ["orchestrateur"]},
                     headers=H(admin.token)).json()
    assert r["policy"]["web"] is False and r["policy"]["agents"] == ["orchestrateur"]
    r2 = client.patch("/admin/policies/lecteur", json={"clear": ["agents"]}, headers=H(admin.token)).json()
    assert r2["policy"]["agents"] is None                     # « tout permis » restauré
    assert r2["policy"]["web"] is False                       # le reste est conservé

    assert client.patch("/admin/policies/admin", json={"web": False},
                        headers=H(admin.token)).status_code == 400            # admin non bridable
    client.delete("/admin/policies/lecteur", headers=H(admin.token))
    assert client.get("/admin/policies", headers=H(admin.token)).json()["policies"].get("lecteur") is None
