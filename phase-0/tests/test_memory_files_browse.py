"""Mémoire (isolement + contexte entreprise), fichiers (RBAC/scope), browse (anti-SSRF)."""
import base64
import elytras.memory_engine as ME
import elytras.main as M
import elytras.providers as P


def test_memory_isolation_between_users(state):
    ME.add_fact("user", "uA", None, "A préfère les rapports le lundi.")
    ME.add_fact("user", "uB", None, "B s'appelle Carla.")
    ME.add_fact("project", None, "projA", "Projet A cible la France.")
    a = [m["content"] for m in ME.recall("user", "uA", None)]
    b = [m["content"] for m in ME.recall("user", "uB", None)]
    assert any("rapports" in x for x in a) and not any("Carla" in x for x in a)
    assert any("Carla" in x for x in b) and not any("rapports" in x for x in b)
    # projet visible seulement aux membres
    assert any("France" in x for x in (m["content"] for m in ME.list_for_user("uB", ["projA"])))
    assert not any("France" in x for x in (m["content"] for m in ME.list_for_user("uB", [])))


def test_company_context_injected_and_readonly(client, admin, H):
    client.post("/admin/company", json={"md": "Vanille Désire vend des arômes."}, headers=H(admin.token))
    t = admin.mkteam("L", "lecteur")
    tok = admin.mkuser("Z", "z@x.com", "pz", [t])
    captured = {}
    P.CodexProvider.script = lambda items, instr, tools: (captured.update(instr=instr) or {"text": "ok", "tool_calls": []})
    client.post("/chat", json={"messages": [{"role": "user", "content": "salut"}]}, headers=H(tok))
    assert "Vanille Désire vend des arômes" in captured["instr"] and "LECTURE SEULE" in captured["instr"]
    assert client.post("/admin/company", json={"md": "pirate"}, headers=H(tok)).status_code == 403  # non modifiable


def test_files_scope_and_rbac(client, admin, H):
    up = client.post("/files", json={"name": "n.txt", "content_b64": base64.b64encode(b"hi").decode(),
                                     "scope": "perso"}, headers=H(admin.token)).json()
    assert any(f["name"] == "n.txt" for f in client.get("/files", headers=H(admin.token)).json()["files"])
    assert client.get("/files/" + up["id"] + "/content", headers=H(admin.token)).content == b"hi"
    t = admin.mkteam("L", "lecteur")
    tok = admin.mkuser("Z", "z@x.com", "pz", [t])
    assert client.get("/files", headers=H(tok)).status_code == 200                       # file.read
    assert client.post("/files", json={"name": "x", "content_b64": "YQ=="}, headers=H(tok)).status_code == 403  # file.write
    assert "n.txt" not in [f["name"] for f in client.get("/files", headers=H(tok)).json()["files"]]   # cloisonné


def test_browse_ssrf_guard(state):
    assert not M._host_allowed("localhost") and not M._host_allowed("127.0.0.1")
    assert not M._host_allowed("169.254.169.254")
    assert "interne" in M._browse("http://localhost:8000/")["error"]
    assert "schéma" in M._browse("file:///etc/passwd")["error"]


def test_browse_html_to_text(state):
    title, text = M._html_to_text("<title>T</title><body><script>x=1</script><h1>Bonjour</h1><p>le monde &amp; co</p>")
    assert title == "T" and "Bonjour" in text and "le monde & co" in text and "x=1" not in text
