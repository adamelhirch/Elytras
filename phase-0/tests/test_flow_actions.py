"""Actions de flow « toutes faites » : http, email, sql, trigger + on_error / early_return.

Aucun réseau réel : on vérifie l'anti-SSRF, les caps, et les chemins « non configuré ».
"""
import elytras.main as main


def _mk(client, H, tok, modules, inputs=None, on_error=None):
    fid = client.post("/flows", json={"name": "F"}, headers=H(tok)).json()["id"]
    body = {"inputs": inputs or [], "modules": modules}
    if on_error is not None:
        body["on_error"] = on_error
    client.patch("/flows/" + fid, json=body, headers=H(tok))
    return fid


# ───────────────────────── http ─────────────────────────
def test_http_blocks_internal_ssrf(client, admin, H):
    """Une URL interne (localhost) est refusée par la garde anti-SSRF (_host_allowed)."""
    assert main._host_allowed("localhost") is False
    fid = _mk(client, H, admin.token, [
        {"id": "h", "summary": "h", "type": "http", "method": "GET", "url": "http://localhost/secret"}])
    r = client.post("/flows/" + fid + "/run", json={}, headers=H(admin.token)).json()
    assert r["status"] == "done"
    assert "error" in r["results"]["h"]
    assert "interne" in r["results"]["h"]["error"] or "hôte" in r["results"]["h"]["error"]


def test_http_blocks_bad_scheme(client, admin, H):
    fid = _mk(client, H, admin.token, [
        {"id": "h", "summary": "h", "type": "http", "url": "file:///etc/passwd"}])
    r = client.post("/flows/" + fid + "/run", json={}, headers=H(admin.token)).json()
    assert "error" in r["results"]["h"] and "schéma" in r["results"]["h"]["error"]


def test_http_requires_web_browse_cap(client, admin, H):
    """Un utilisateur SANS web.browse ne peut pas exécuter une étape http (cap gating)."""
    # rôle sur-mesure : peut créer/exécuter des flows mais SANS web.browse
    rid = client.post("/admin/roles", json={"name": "flowonly",
        "caps": ["flow.view", "flow.create", "flow.edit", "flow.run"]},
        headers=H(admin.token)).json()["id"]
    t = admin.mkteam("FlowOnly", rid)
    tok = admin.mkuser("F", "f@x.com", "pf", [t])
    fid = _mk(client, H, tok, [
        {"id": "h", "summary": "h", "type": "http", "url": "https://example.com"}])
    r = client.post("/flows/" + fid + "/run", json={}, headers=H(tok)).json()
    assert r["status"] == "error" and "web.browse" in (r.get("error") or "")


# ───────────────────────── email ─────────────────────────
def test_email_smtp_not_configured(client, admin, H, monkeypatch):
    monkeypatch.delenv("SMTP_HOST", raising=False)
    fid = _mk(client, H, admin.token, [
        {"id": "e", "summary": "e", "type": "email", "to": "x@y.com", "subject": "Hi", "body": "yo"}])
    r = client.post("/flows/" + fid + "/run", json={}, headers=H(admin.token)).json()
    assert r["status"] == "done"
    assert "error" in r["results"]["e"] and "SMTP" in r["results"]["e"]["error"]


# ───────────────────────── sql ─────────────────────────
def test_sql_not_configured(client, admin, H, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    fid = _mk(client, H, admin.token, [
        {"id": "q", "summary": "q", "type": "sql", "query": "SELECT 1"}])
    r = client.post("/flows/" + fid + "/run", json={}, headers=H(admin.token)).json()
    assert r["status"] == "done"
    res = r["results"]["q"]
    assert "error" in res
    # psycopg absent → "non installé" ; présent mais pas de connexion → "base non configurée"
    assert ("psycopg" in res["error"]) or ("base non configurée" in res["error"])


# ───────────────────────── trigger ─────────────────────────
def test_trigger_dedupes_and_stops(client, admin, H):
    """1er run : tous les items ; 2e run identique : [] + flow stoppé ; nouvel item au 2e run : seulement lui."""
    code = "result = [{'id': 1, 'v': 'a'}, {'id': 2, 'v': 'b'}]"
    fid = _mk(client, H, admin.token, [
        {"id": "tg", "summary": "tg", "type": "trigger", "language": "python", "content": code, "key": "id"},
        {"id": "after", "summary": "after", "type": "note", "text": "vu {{ results.tg }}"}])
    r1 = client.post("/flows/" + fid + "/run", json={}, headers=H(admin.token)).json()
    assert r1["status"] == "done"
    assert r1["results"]["tg"] == [{"id": 1, "v": "a"}, {"id": 2, "v": "b"}]
    assert "after" in r1["results"]                 # l'étape suivante a tourné (nouveaux items)

    # 2e run, mêmes items → rien de neuf → flow stoppé, résultat []
    r2 = client.post("/flows/" + fid + "/run", json={}, headers=H(admin.token)).json()
    assert r2["status"] == "done" and r2.get("stopped") is True
    assert r2["result"] == []
    assert "after" not in (r2.get("results") or {})  # l'étape suivante n'a PAS tourné

    # 3e run avec un item supplémentaire → seul le nouveau remonte
    code2 = "result = [{'id': 1, 'v': 'a'}, {'id': 2, 'v': 'b'}, {'id': 3, 'v': 'c'}]"
    client.patch("/flows/" + fid, json={"modules": [
        {"id": "tg", "summary": "tg", "type": "trigger", "language": "python", "content": code2, "key": "id"},
        {"id": "after", "summary": "after", "type": "note", "text": "vu {{ results.tg }}"}]},
        headers=H(admin.token))
    r3 = client.post("/flows/" + fid + "/run", json={}, headers=H(admin.token)).json()
    assert r3["status"] == "done"
    assert r3["results"]["tg"] == [{"id": 3, "v": "c"}]


# ───────────────────────── on_error ─────────────────────────
def test_on_error_handler_runs(client, admin, H):
    """Une étape code qui lève + un on_error (note) → le handler tourne, le flow ne plante pas."""
    fid = _mk(client, H, admin.token,
              [{"id": "boom", "summary": "boom", "type": "code", "content": "raise Exception('boom')"},
               {"id": "never", "summary": "never", "type": "note", "text": "jamais"}],
              on_error=[{"id": "rescue", "summary": "rescue", "type": "note",
                         "text": "récupéré: {{ error.message }}"}])
    r = client.post("/flows/" + fid + "/run", json={}, headers=H(admin.token)).json()
    assert r["status"] == "error_handled"
    assert "boom" in (r.get("error") or "")
    assert r["results"]["rescue"].startswith("récupéré:") and "boom" in r["results"]["rescue"]
    assert "never" not in r["results"]              # l'étape suivante du flow principal n'a pas tourné


def test_no_on_error_still_errors(client, admin, H):
    """Sans on_error → comportement actuel : le flow remonte l'erreur."""
    fid = _mk(client, H, admin.token,
              [{"id": "boom", "summary": "boom", "type": "code", "content": "raise Exception('kaboom')"}])
    r = client.post("/flows/" + fid + "/run", json={}, headers=H(admin.token)).json()
    assert r["status"] == "error" and "kaboom" in (r.get("error") or "")


# ───────────────────────── early_return ─────────────────────────
def test_early_return_stops_flow(client, admin, H):
    """early_return.enabled sur une étape → les étapes suivantes ne tournent pas."""
    fid = _mk(client, H, admin.token, [
        {"id": "a", "summary": "a", "type": "code", "content": "result = 7",
         "early_return": {"enabled": True, "expr": ""}},
        {"id": "b", "summary": "b", "type": "code", "content": "result = 99"}])
    r = client.post("/flows/" + fid + "/run", json={}, headers=H(admin.token)).json()
    assert r["status"] == "done" and r.get("stopped") is True
    assert r["result"] == 7
    assert "b" not in (r.get("results") or {})


def test_early_return_conditional(client, admin, H):
    """early_return avec expr fausse → ne stoppe pas ; expr vraie → stoppe."""
    fid = _mk(client, H, admin.token, [
        {"id": "a", "summary": "a", "type": "code", "content": "result = 0",
         "early_return": {"enabled": True, "expr": "results.a > 0"}},
        {"id": "b", "summary": "b", "type": "code", "content": "result = 42"}])
    r = client.post("/flows/" + fid + "/run", json={}, headers=H(admin.token)).json()
    assert r["status"] == "done"
    assert r["results"]["b"] == 42                  # expr fausse → la suite tourne
