"""Blocs de code multi-langage : Python (déjà couvert), JavaScript et TypeScript."""


def _mk(client, H, tok, modules):
    fid = client.post("/flows", json={"name": "F"}, headers=H(tok)).json()["id"]
    client.patch("/flows/" + fid, json={"modules": modules}, headers=H(tok))
    return fid


def test_js_and_ts_code_steps(client, admin, H):
    fid = _mk(client, H, admin.token, [
        {"id": "a", "summary": "js", "type": "code", "language": "javascript",
         "content": "let result = 6 * 7;"},
        {"id": "b", "summary": "ts", "type": "code", "language": "typescript",
         "content": "function main(): number { const r: number = results.a; return r + 1; }"},
    ])
    r = client.post("/flows/" + fid + "/run", json={}, headers=H(admin.token)).json()
    assert r["status"] == "done"
    assert r["results"]["a"] == 42          # JavaScript (result = …)
    assert r["results"]["b"] == 43          # TypeScript (main() typé, chaîne results.a)


def test_js_chains_flow_input(client, admin, H):
    fid = client.post("/flows", json={"name": "G"}, headers=H(admin.token)).json()["id"]
    client.patch("/flows/" + fid, json={
        "inputs": [{"name": "x", "type": "number", "default": 10}],
        "modules": [{"id": "c", "summary": "js", "type": "code", "language": "javascript",
                     "content": "async function main(){ return (flow_input.x||0) + 5; }"}]},
        headers=H(admin.token))
    r = client.post("/flows/" + fid + "/run", json={"inputs": {"x": 37}}, headers=H(admin.token)).json()
    assert r["status"] == "done" and r["results"]["c"] == 42
