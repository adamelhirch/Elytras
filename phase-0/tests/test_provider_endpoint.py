"""Login provider à l'échelle de l'instance (clé DEFAULT_USER) + finalisation manuelle via endpoint."""
import elytras.main as M
import elytras.provider_auth as PA


def test_login_stores_pending_under_instance_key(client, admin, H, monkeypatch):
    # évite que le thread loopback ne lie le port 1455 pendant le test
    monkeypatch.setattr(PA, "_capture_code", lambda port, path, timeout=300.0: (None, None))
    r = client.post("/providers/login", json={"provider": "codex"}, headers=H(admin.token))
    assert r.status_code == 200 and "auth_url" in r.json()
    p = M.prov_auth._pending.get("codex")
    assert isinstance(p, dict) and p["user_id"] == M.DEFAULT_USER     # instance-wide, pas l'utilisateur


def test_manual_callback_connects_and_status_reflects(client, admin, H, monkeypatch):
    monkeypatch.setattr(PA, "_exchange", lambda spec, code, verifier, state: {"access_token": "AT", "refresh_token": "RT"})
    monkeypatch.setattr(PA, "_normalize", lambda spec, tok, prev=None: {"access_token": tok["access_token"], "account_id": "acc"})
    M.prov_auth._pending["codex"] = {"verifier": "v", "state": "st", "user_id": M.DEFAULT_USER, "ts": 0}
    url = "http://localhost:1455/auth/callback?code=CODE&scope=openid&state=st"
    r = client.post("/providers/manual-callback", json={"provider": "codex", "redirect_url": url}, headers=H(admin.token))
    assert r.status_code == 200 and r.json().get("ok") is True
    d = client.get("/providers", headers=H(admin.token)).json()
    codex = [p for p in d["providers"] if p["provider"] == "codex"][0]
    assert codex["connected"] is True                                # statut « connecté » cohérent
