"""Mémoire équipe + organisation : isolement, agrégation au chat, clamp policy, droits.

Garantie centrale (vision) : un agent mandaté par X ne lit JAMAIS le perso de Y ;
les équipes partagent leurs faits entre membres ; l'org est partagée à toute l'entreprise.
"""
import elytras.main as M
import elytras.memory_engine as ME
import elytras.policy as P
import elytras.rbac as R


def _user(admin, name, email, teams):
    tok = admin.mkuser(name, email, "pw", teams)
    uid, _ = R.find_by_email(email)
    return uid, tok


def _instr(uid):
    full = {"id": "f", "name": "Full", "instructions": "Agent."}
    instr, _, _ = M._agent_setup(full, [{"role": "user", "content": "contexte ?"}], "user", uid, None, uid, 0)
    return instr


# ───────────────────────── Moteur : scopes et isolement ─────────────────────────

def test_team_scope_isole_entre_equipes(state):
    ME.add_fact("team", "team-A", None, "Procédure de l'équipe A")
    ME.add_fact("team", "team-B", None, "Secret de l'équipe B")
    a = [m["content"] for m in ME.recall("team", "team-A", None, k=10)]
    assert "Procédure de l'équipe A" in a and "Secret de l'équipe B" not in a


def test_org_scope_partage_a_tous(state):
    ME.add_fact("org", None, None, "Horaires : 9h-18h")
    assert any("Horaires" in m["content"] for m in ME.recall("org", None, None, k=10))


def test_recall_many_agrege_et_dedoublonne(state):
    ME.add_fact("user", "u1", None, "Préférence perso de u1")
    ME.add_fact("team", "t1", None, "Fait d'équipe")
    ME.add_fact("org", None, None, "Fait d'entreprise")
    ME.add_fact("org", None, None, "Fait d'entreprise")           # doublon
    mem = ME.recall_many([("user", "u1", None), ("team", "t1", None), ("org", None, None)], k=12)
    contents = [m["content"] for m in mem]
    assert "Préférence perso de u1" in contents and "Fait d'équipe" in contents
    assert contents.count("Fait d'entreprise") == 1               # dédoublonné
    scopes = {m["scope"] for m in mem}
    assert scopes == {"user", "team", "org"}


def test_recall_many_ne_lit_jamais_le_perso_d_autrui(state):
    ME.add_fact("user", "u-autre", None, "Salaire de u-autre : confidentiel")
    mem = ME.recall_many([("user", "u-moi", None), ("org", None, None)], k=12)
    assert not any("confidentiel" in m["content"] for m in mem)


# ───────────────────────── Chat : agrégation bornée par la policy ─────────────────────────

def test_chat_voit_equipe_et_org(client, admin, H):
    t1 = admin.mkteam("Compta", "operateur")
    uid, _ = _user(admin, "Carla", "carla@x.com", [t1])
    ME.add_fact("team", t1, None, "Relances clients tous les lundis")
    ME.add_fact("org", None, None, "TVA : régime réel simplifié")
    ME.add_fact("user", "quelqu-un-d-autre", None, "Code carte bleue perso")
    instr = _instr(uid)
    assert "Relances clients tous les lundis" in instr            # mémoire de SON équipe
    assert "TVA : régime réel simplifié" in instr                 # mémoire d'entreprise
    assert "Code carte bleue perso" not in instr                  # jamais le perso d'autrui
    assert "[équipe]" in instr and "[entreprise]" in instr        # provenance visible par l'agent


def test_chat_membre_d_une_autre_equipe_ne_voit_pas(client, admin, H):
    t1, t2 = admin.mkteam("Compta", "operateur"), admin.mkteam("Atelier", "operateur")
    ME.add_fact("team", t1, None, "Marge fournisseur : 22%")
    uid2, _ = _user(admin, "Marc", "marc@x.com", [t2])
    assert "Marge fournisseur" not in _instr(uid2)


def test_policy_clampe_equipe_et_org(client, admin, H):
    t1 = admin.mkteam("Compta", "operateur")
    uid, _ = _user(admin, "Carla", "carla2@x.com", [t1])
    ME.add_fact("team", t1, None, "Fait d'équipe sensible")
    ME.add_fact("org", None, None, "Fait org public")
    P.set_policy("operateur", {"memory_scopes": ["user"]})        # ni équipe ni org
    instr = _instr(uid)
    assert "Fait d'équipe sensible" not in instr and "Fait org public" not in instr
    P.set_policy("operateur", {"memory_scopes": ["user", "org"]})  # org oui, équipe non
    instr = _instr(uid)
    assert "Fait org public" in instr and "Fait d'équipe sensible" not in instr


# ───────────────────────── Endpoints : ajout / suppression / listing ─────────────────────────

def test_endpoint_fact_org_admin_seulement(client, admin, H):
    t1 = admin.mkteam("Ops", "operateur")
    _, tok = _user(admin, "Bob", "bob2@x.com", [t1])
    r = client.post("/memory/fact", json={"content": "X", "scope": "org"}, headers=H(tok))
    assert r.status_code == 403                                   # org : admin requis
    r2 = client.post("/memory/fact", json={"content": "Charte qualité v2", "scope": "org"},
                     headers=H(admin.token))
    assert r2.status_code == 200
    r3 = client.post("/memory/fact", json={"content": "Procédure atelier", "scope": "team",
                                           "team_id": t1}, headers=H(tok))
    assert r3.status_code == 200                                  # membre de l'équipe : OK
    autre = admin.mkteam("Autres", "operateur")
    r4 = client.post("/memory/fact", json={"content": "X", "scope": "team", "team_id": autre},
                     headers=H(tok))
    assert r4.status_code == 403                                  # pas membre → refus


def test_endpoint_memory_liste_equipe_et_org(client, admin, H):
    t1 = admin.mkteam("Compta", "operateur")
    _, tok = _user(admin, "Lea", "lea@x.com", [t1])
    ME.add_fact("team", t1, None, "Compte 411 : clients")
    ME.add_fact("org", None, None, "Slogan : la vanille autrement")
    items = client.get("/memory", headers=H(tok)).json()["items"]
    bytext = {i["content"]: i for i in items}
    assert bytext["Compte 411 : clients"]["scope"] == "team"
    assert bytext["Compte 411 : clients"]["team"] == "Compta"     # nom d'équipe résolu
    assert bytext["Slogan : la vanille autrement"]["scope"] == "org"


def test_suppression_org_protegee(client, admin, H):
    t1 = admin.mkteam("Ops", "operateur")
    _, tok = _user(admin, "Sam", "sam@x.com", [t1])
    mid = ME.add_fact("org", None, None, "Fait protégé")
    r = client.delete("/memory/" + mid, headers=H(tok))
    assert r.status_code == 403                                   # operateur a memory.reset, mais org = admin
    assert client.delete("/memory/" + mid, headers=H(admin.token)).json()["deleted"]


def test_flow_step_memoire_equipe_recall(client, admin, H):
    """Étape agent de flow avec memory=equipe : rappelle la mémoire d'équipe du lanceur."""
    import elytras.providers as Pr
    t1 = admin.mkteam("Compta", "operateur")
    uid, tok = _user(admin, "Nina", "nina@x.com", [t1])
    ME.add_fact("team", t1, None, "Échéance URSSAF le 5 du mois")
    cap = {}
    Pr.CodexProvider.script = lambda items, instr, tools: (cap.update(instr=instr) or {"text": "ok", "tool_calls": []})
    fid = client.post("/flows", json={"name": "Test"}, headers=H(tok)).json()["id"]
    client.patch("/flows/" + fid, json={"modules": [
        {"id": "a", "summary": "agent", "type": "agent", "agent_id": "orchestrateur",
         "prompt": "échéances ?", "memory": "equipe"}]}, headers=H(tok))
    client.post("/flows/" + fid + "/run", json={}, headers=H(tok))
    assert "URSSAF" in cap.get("instr", "")                       # la mémoire d'équipe a été rappelée