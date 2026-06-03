"""Moteur de flows : types de modules, config avancée, fichiers."""
import base64


def _mk(client, H, tok, modules, inputs=None):
    fid = client.post("/flows", json={"name": "F"}, headers=H(tok)).json()["id"]
    client.patch("/flows/" + fid, json={"inputs": inputs or [], "modules": modules}, headers=H(tok))
    return fid


def test_code_and_chaining(client, admin, H):
    fid = _mk(client, H, admin.token, [
        {"id": "a", "summary": "a", "type": "code", "content": "result = 21 * 2"},
        {"id": "b", "summary": "b", "type": "note", "text": "val={{ results.a }}"}])
    r = client.post("/flows/" + fid + "/run", json={"inputs": {}}, headers=H(admin.token)).json()
    assert r["status"] == "done" and r["results"]["b"] == "val=42"


def test_forloop_branch_while_mock_earlystop(client, admin, H):
    fid = _mk(client, H, admin.token, [
        {"id": "L", "summary": "L", "type": "forloop", "iterator": "[1,2,3]",
         "modules": [{"id": "m", "summary": "m", "type": "code", "content": "result = item*10"}]},
        {"id": "br", "summary": "br", "type": "branchone",
         "branches": [{"summary": "p", "expr": "results.L == [10,20,30]",
                       "modules": [{"id": "n", "summary": "n", "type": "note", "text": "ok"}]}],
         "default_modules": []},
        {"id": "mk", "summary": "mk", "type": "note", "text": "ignored", "mock": {"enabled": True, "value": "PIN"}},
        {"id": "stop", "summary": "stop", "type": "note", "text": "S", "stop_after_if": {"enabled": True, "expr": "True"}},
        {"id": "after", "summary": "after", "type": "note", "text": "jamais"}])
    r = client.post("/flows/" + fid + "/run", json={}, headers=H(admin.token)).json()
    assert r["status"] == "done"
    assert r["results"]["L"] == [10, 20, 30] and r["results"]["br"] == "ok" and r["results"]["mk"] == "PIN"
    assert r.get("stopped") is True


def test_file_input_and_output_in_sandbox(client, admin, H):
    up = client.post("/files", json={"name": "data.txt", "content_b64": base64.b64encode(b"l1\nl2\nl3").decode(),
                                     "mime": "text/plain", "scope": "perso"}, headers=H(admin.token)).json()
    code = ("import os\n"
            "n = len(open(os.path.join(input_dir,'data.txt'),'rb').read().splitlines())\n"
            "open(os.path.join(output_dir,'rapport.txt'),'w').write('lignes='+str(n))\n"
            "result = n")
    fid = _mk(client, H, admin.token,
              [{"id": "k", "summary": "k", "type": "code", "content": code}],
              inputs=[{"name": "doc", "type": "file"}])
    r = client.post("/flows/" + fid + "/run", json={"inputs": {"doc": up["id"]}}, headers=H(admin.token)).json()
    assert r["status"] == "done" and r["results"]["k"] == 3
    assert "rapport.txt" in (r.get("files_out") or [])
    assert any(f["name"] == "rapport.txt" for f in client.get("/files", headers=H(admin.token)).json()["files"])


def test_approval_suspend_resume(client, admin, H):
    fid = _mk(client, H, admin.token, [
        {"id": "av", "summary": "av", "type": "note", "text": "avant"},
        {"id": "ok", "summary": "validation", "type": "approval", "message": "OK ?"},
        {"id": "ap", "summary": "ap", "type": "code", "content": "result = 'repris:' + str(results.get('av'))"}])
    r = client.post("/flows/" + fid + "/run", json={}, headers=H(admin.token)).json()
    assert r["status"] == "waiting" and r.get("resume_token")
    client.get("/flows/resume/" + r["resume_token"], params={"decision": "approve"})
    task = [t for t in client.get("/tasks", headers=H(admin.token)).json()["tasks"] if t["id"] == r["task_id"]][0]
    assert task["status"] == "done" and "repris:avant" in task["result"]


def test_code_blocked_without_capability(client, admin, H):
    """Un opérateur (sans code.execute) ne peut pas exécuter un flow contenant du code."""
    t = admin.mkteam("Ops", "operateur")
    tok = admin.mkuser("O", "o@x.com", "po", [t])
    fid = _mk(client, H, tok, [{"id": "k", "summary": "k", "type": "code", "content": "result=1"}])
    r = client.post("/flows/" + fid + "/run", json={}, headers=H(tok)).json()
    assert r["status"] == "error" and "code.execute" in (r.get("error") or "")
