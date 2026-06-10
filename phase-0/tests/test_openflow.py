"""Refonte Windmill : OpenFlow natif, scripts-actions, runners, transforms, triggers.

La suite test_flows/test_flow_actions (format hérité) valide déjà la MIGRATION ;
ici on valide le NOUVEAU modèle : modules value-typés, input_transforms static/javascript,
scripts de bibliothèque (schéma auto + PathScript), sous-flows, retry retry_if,
stop_after_if error_message, suspend/resume avec payload, import/export OpenFlow,
routes HTTP et triggers email (IMAP simulé).
"""
import json

import elytras.exprs as E
import elytras.flows as F
import elytras.scripts as SC
import elytras.triggers as TR


def _mkv(client, H, tok, value, schema=None, name="Flow"):
    fid = client.post("/flows", json={"name": name}, headers=H(tok)).json()["id"]
    body = {"value": value}
    if schema:
        body["schema"] = schema
    client.patch("/flows/" + fid, json=body, headers=H(tok))
    return fid


def _run(client, H, tok, fid, inputs=None):
    return client.post("/flows/" + fid + "/run", json={"inputs": inputs or {}}, headers=H(tok)).json()


# ───────────────────────── Moteur OpenFlow natif ─────────────────────────

def test_rawscript_et_transforms_javascript(client, admin, H):
    value = {"modules": [
        {"id": "a", "summary": "a", "value": {"type": "rawscript", "language": "python3",
                                              "content": "result = 6 * 7", "input_transforms": {}}},
        {"id": "b", "summary": "b", "value": {"type": "rawscript", "language": "python3",
            "content": "def main(x, y):\n    return x + y",
            "input_transforms": {"x": {"type": "javascript", "expr": "results.a"},
                                 "y": {"type": "static", "value": 8}}}}]}
    r = _run(client, H, admin.token, _mkv(client, H, admin.token, value))
    assert r["status"] == "done" and r["results"]["b"] == 50      # main(x=42, y=8)


def test_rawscript_bash_derniere_ligne(client, admin, H):
    value = {"modules": [{"id": "sh", "summary": "sh", "value": {
        "type": "rawscript", "language": "bash",
        "content": "echo bruit\necho \"$msg\"", "input_transforms": {"msg": {"type": "static", "value": "salut bash"}}}}]}
    r = _run(client, H, admin.token, _mkv(client, H, admin.token, value))
    assert r["status"] == "done" and r["result"] == "salut bash"  # convention Windmill : dernière ligne


def test_identity_et_defauts_du_schema(client, admin, H):
    value = {"modules": [
        {"id": "a", "summary": "a", "value": {"type": "rawscript", "language": "python3",
                                              "content": "result = flow_input.n", "input_transforms": {}}},
        {"id": "i", "summary": "i", "value": {"type": "identity"}}]}
    schema = {"type": "object", "properties": {"n": {"type": "integer", "default": 9}}, "required": []}
    r = _run(client, H, admin.token, _mkv(client, H, admin.token, value, schema))
    assert r["results"]["i"] == 9                                  # identity passe le précédent ; défaut appliqué


def test_forloop_parallel_skip_failures(client, admin, H):
    value = {"modules": [{"id": "L", "summary": "L", "value": {
        "type": "forloopflow", "parallel": True, "parallelism": {"type": "static", "value": 2},
        "skip_failures": True,
        "iterator": {"type": "javascript", "expr": "[1, 0, 3]"},
        "modules": [{"id": "m", "summary": "m", "value": {"type": "rawscript", "language": "python3",
                     "content": "result = 10 // item", "input_transforms": {}}}]}}]}
    r = _run(client, H, admin.token, _mkv(client, H, admin.token, value))
    assert r["status"] == "done" and r["results"]["L"] == [10, None, 3]   # l'échec (÷0) devient None


def test_stop_after_if_error_message(client, admin, H):
    value = {"modules": [{"id": "a", "summary": "a",
                          "value": {"type": "identity"}, "mock": {"enabled": True, "return_value": 5},
                          "stop_after_if": {"expr": "result > 3", "error_message": "trop grand: {{ result }}"}}]}
    r = _run(client, H, admin.token, _mkv(client, H, admin.token, value))
    assert r["status"] == "error" and "trop grand: 5" in r["error"]


def test_skip_if_et_continue_on_error(client, admin, H):
    value = {"modules": [
        {"id": "s", "summary": "s", "skip_if": {"expr": "True"},
         "value": {"type": "rawscript", "language": "python3", "content": "result = 1/0", "input_transforms": {}}},
        {"id": "e", "summary": "e", "continue_on_error": True,
         "value": {"type": "rawscript", "language": "python3", "content": "raise Exception('x')",
                   "input_transforms": {}}},
        {"id": "ok", "summary": "ok", "value": {"type": "identity"},
         "mock": {"enabled": True, "return_value": "fini"}}]}
    r = _run(client, H, admin.token, _mkv(client, H, admin.token, value))
    assert r["status"] == "done" and r["results"]["s"] is None
    assert "error" in r["results"]["e"] and r["result"] == "fini"


def test_subflow_pathflow(client, admin, H):
    sub_v = {"modules": [{"id": "x", "summary": "x", "value": {
        "type": "rawscript", "language": "python3",
        "content": "def main(n):\n    return n * 2", "input_transforms":
        {"n": {"type": "javascript", "expr": "flow_input.n"}}}}]}
    sub_id = _mkv(client, H, admin.token, sub_v, name="Doubleur")
    main_v = {"modules": [{"id": "call", "summary": "call", "value": {
        "type": "flow", "path": sub_id,
        "input_transforms": {"n": {"type": "static", "value": 21}}}}]}
    r = _run(client, H, admin.token, _mkv(client, H, admin.token, main_v))
    assert r["status"] == "done" and r["result"] == 42


def test_suspend_resume_avec_payload(client, admin, H):
    value = {"modules": [
        {"id": "ask", "summary": "validation", "value": {"type": "identity"},
         "suspend": {"required_events": 1, "timeout": 0, "message": "Montant à valider"}},
        {"id": "fin", "summary": "fin", "value": {"type": "identity"},
         "mock": {"enabled": True, "return_value": "approuvé par {{ resume.who }}"}}]}
    r = _run(client, H, admin.token, _mkv(client, H, admin.token, value))
    assert r["status"] == "waiting" and r["resume_token"]
    r2 = client.post("/flows/resume/" + r["resume_token"],
                     json={"decision": "approve", "payload": {"who": "Léo"}}).json()
    assert r2["status"] == "done" and r2["results"]["fin"] == "approuvé par Léo"


def test_retry_openflow_et_retry_if():
    calls = {"n": 0}

    def boom():
        calls["n"] += 1
        raise ValueError("transient")
    try:
        E.with_retry(boom, {"constant": {"attempts": 2, "seconds": 0}})
    except ValueError:
        pass
    assert calls["n"] == 3                                        # 1 + 2 retries
    calls["n"] = 0
    try:
        E.with_retry(boom, {"constant": {"attempts": 2, "seconds": 0},
                            "retry_if": {"expr": "'fatal' in error.message"}})
    except ValueError:
        pass
    assert calls["n"] == 1                                        # retry_if faux → pas de retry


# ───────────────────────── Scripts : bibliothèque + schéma auto ─────────────────────────

def test_script_schema_auto_et_pathscript(client, admin, H):
    r = client.post("/scripts", json={"summary": "Additionneur", "language": "python3",
                                      "content": "def main(a: int, b: int = 10):\n    return a + b"},
                    headers=H(admin.token)).json()
    assert r["schema"]["properties"]["a"]["type"] == "integer"    # schéma déduit de main(...)
    assert r["schema"]["properties"]["b"]["default"] == 10
    assert r["schema"]["required"] == ["a"]
    value = {"modules": [{"id": "s", "summary": "s", "value": {
        "type": "script", "path": r["path"],
        "input_transforms": {"a": {"type": "static", "value": 32}}}}]}
    rr = _run(client, H, admin.token, _mkv(client, H, admin.token, value))
    assert rr["status"] == "done" and rr["result"] == 42          # 32 + défaut 10


def test_script_run_direct_et_versions(client, admin, H):
    r = client.post("/scripts", json={"summary": "Echo", "language": "python3",
                                      "content": "def main(msg):\n    return 'v1:' + msg"},
                    headers=H(admin.token)).json()
    out = client.post(f"/scripts/{r['id']}/run", json={"args": {"msg": "x"}}, headers=H(admin.token)).json()
    assert out["result"] == "v1:x"
    client.patch("/scripts/" + r["id"], json={"content": "def main(msg):\n    return 'v2:' + msg"},
                 headers=H(admin.token))
    s2 = client.get("/scripts/" + r["id"], headers=H(admin.token)).json()
    assert len(s2["versions"]) == 2                               # historique de déploiements
    out2 = client.post(f"/scripts/{r['id']}/run", json={"args": {"msg": "x"}}, headers=H(admin.token)).json()
    assert out2["result"] == "v2:x"


def test_builtins_presents_et_http_anti_ssrf(client, admin, H):
    d = client.get("/scripts", headers=H(admin.token)).json()
    paths = {s["path"] for s in d["scripts"]}
    assert {"hub/elytras/http_request", "hub/elytras/send_email",
            "hub/elytras/sql_query", "hub/elytras/poll_dedup"} <= paths
    assert d["languages"]["python3"] is True and d["languages"]["bash"] is True
    value = {"modules": [{"id": "h", "summary": "h", "value": {
        "type": "script", "path": "hub/elytras/http_request",
        "input_transforms": {"url": {"type": "static", "value": "http://127.0.0.1:9/x"}}}}]}
    r = _run(client, H, admin.token, _mkv(client, H, admin.token, value))
    assert "non autorisé" in json.dumps(r.get("results", {}), ensure_ascii=False)   # anti-SSRF actif


# ───────────────────────── Import / export OpenFlow ─────────────────────────

def test_export_import_round_trip(client, admin, H):
    fid = client.post("/flows", json={"name": "RT"}, headers=H(admin.token)).json()["id"]
    client.patch("/flows/" + fid, json={"modules": [                    # ancien format → migré
        {"id": "a", "summary": "calc", "type": "code", "content": "result = 6*7"},
        {"id": "n", "summary": "n", "type": "note", "text": "v={{ results.a }}"}],
        "inputs": [{"name": "sujet", "type": "string", "required": True}]}, headers=H(admin.token))
    exp = client.get("/flows/" + fid + "/openflow", headers=H(admin.token)).json()
    assert exp["value"]["modules"][0]["value"]["type"] == "rawscript"   # OpenFlow pur
    assert exp["value"]["modules"][0]["value"]["language"] == "python3"
    assert exp["schema"]["required"] == ["sujet"]
    imp = client.post("/flows/import-openflow", json={"openflow": exp}, headers=H(admin.token)).json()
    r = _run(client, H, admin.token, imp["id"], {"sujet": "x"})
    assert r["status"] == "done" and r["results"]["a"] == 42 and r["results"]["n"] == "v=42"


def test_import_openflow_windmill_pur(client, admin, H):
    data = {"summary": "Depuis le Hub", "value": {"modules": [
        {"id": "a", "value": {"type": "rawscript", "language": "python3",
                              "content": "def main(x):\n    return x * 3",
                              "input_transforms": {"x": {"type": "javascript", "expr": "flow_input.x"}}}}]},
        "schema": {"type": "object", "properties": {"x": {"type": "integer"}}, "required": ["x"]}}
    imp = client.post("/flows/import-openflow", json={"openflow": data}, headers=H(admin.token)).json()
    r = _run(client, H, admin.token, imp["id"], {"x": 14})
    assert r["status"] == "done" and r["result"] == 42


# ───────────────────────── Triggers : routes HTTP + email ─────────────────────────

def test_route_http_declenche_flow(client, admin, H):
    value = {"modules": [{"id": "a", "summary": "a", "value": {
        "type": "rawscript", "language": "python3",
        "content": "result = 'devis pour ' + str(flow_input.client)", "input_transforms": {}}}]}
    fid = _mkv(client, H, admin.token, value)
    t = client.post("/triggers", json={"kind": "http", "target": {"flow_id": fid},
                                       "config": {"method": "POST", "route_path": "garage/devis"}},
                    headers=H(admin.token)).json()
    assert t.get("id")
    r = client.post("/r/garage/devis", json={"client": "Dupont"}).json()
    assert r["status"] == "done" and r["result"] == "devis pour Dupont"
    assert client.post("/r/inconnu", json={}).status_code == 404


def test_trigger_email_poll_dedup(state, monkeypatch):
    class FakeIMAP:
        def login(self, u, p):
            pass

        def select(self, f):
            pass

        def search(self, c, q):
            return "OK", [b"1 2"]

        def fetch(self, num, q):
            mid = num.decode()
            raw = (f"Message-ID: <m{mid}@x>\r\nFrom: client@x.com\r\nSubject: Devis {mid}\r\n"
                   f"\r\nBonjour {mid}").encode()
            return "OK", [(b"", raw)]

        def logout(self):
            pass

    tid = TR.create("email", {"flow_id": "f1"}, {"host": "imap.x.com", "user": "u", "password": "p"})
    t = __import__("elytras.filestore", fromlist=["items"]).items(TR.SECTION)[tid]
    fresh = TR.poll_email_trigger(tid, t, imap_factory=lambda: FakeIMAP())
    assert len(fresh) == 2 and fresh[0]["subject"].startswith("Devis")
    assert fresh[0]["text"].startswith("Bonjour")
    fresh2 = TR.poll_email_trigger(tid, t, imap_factory=lambda: FakeIMAP())
    assert fresh2 == []                                           # dédup Message-ID persistante


def test_trigger_kind_declare_mais_inactif(state):
    tid = TR.create("kafka", {"flow_id": "f"}, {"topic": "t"})
    t = TR.list_triggers()[0] if TR.list_triggers() else None
    ts = {x["id"]: x for x in TR.list_triggers()}
    assert ts[tid]["active"] is False and "broker" in (ts[tid]["note"] or "")
    try:
        TR.create("inconnu", {}, {})
        assert False, "kind inconnu accepté"
    except ValueError:
        pass


# ───────────────────────── Divers : flows.py unitaire ─────────────────────────

def test_schema_vers_inputs_et_retour(state):
    schema = {"type": "object", "properties": {"a": {"type": "string", "default": "x"},
                                               "b": {"type": "string", "enum": ["u", "v"]}},
              "required": ["b"], "order": ["a", "b"]}
    ins = F.schema_to_inputs(schema)
    assert ins[0]["name"] == "a" and ins[0]["default"] == "x" and not ins[0]["required"]
    assert ins[1]["type"] == "select" and ins[1]["options"] == ["u", "v"] and ins[1]["required"]


def test_parse_schema_js_et_sql(state):
    js = SC.parse_schema("bun", "export async function main(name, count = 3) { return name; }")
    assert js["properties"]["name"]["type"] == "string" and js["properties"]["count"]["default"] == 3
    assert js["required"] == ["name"]
    sql = SC.parse_schema("postgresql", "SELECT * FROM clients WHERE ville = %(ville)s")
    assert "ville" in sql["properties"] and "database" in sql["properties"]