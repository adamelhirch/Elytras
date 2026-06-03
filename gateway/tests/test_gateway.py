"""Passerelle : auth, routage par gamme, masquage du modèle, metering, plafond, admin."""
from elytras_gateway import config


def _mk_tenant(client, admin_h, **body):
    body.setdefault("name", "Client")
    return client.post("/admin/tenants", json=body, headers=admin_h).json()


def test_health(client):
    r = client.get("/health").json()
    assert r["ok"] is True and {"eco", "standard", "max"} <= set(r["tiers"])


def test_admin_locked_without_token(client):
    assert client.post("/admin/tenants", json={"name": "X"}).status_code == 403
    assert client.post("/admin/tenants", json={"name": "X"},
                       headers={"Authorization": "Bearer faux"}).status_code == 403


def test_create_tenant_then_call(client, admin_h, fake):
    t = _mk_tenant(client, admin_h)
    assert t["service_key"].startswith("elyt-")
    h = {"Authorization": "Bearer " + t["service_key"]}
    r = client.post("/v1/chat/completions",
                    json={"model": "eco", "messages": [{"role": "user", "content": "salut"}]},
                    headers=h)
    assert r.status_code == 200
    data = r.json()
    assert fake.last_model == config.TIERS["eco"]["model"]      # routé vers le vrai modèle Éco
    assert data["model"] == "eco" and "REAL-" not in str(data["model"])   # modèle réel masqué
    u = client.get("/admin/usage", params={"tenant": t["id"]}, headers=admin_h).json()
    assert u["calls"] == 1 and u["ptok"] == 1000 and u["ctok"] == 500


def test_no_key_rejected(client):
    assert client.post("/v1/chat/completions", json={"model": "eco", "messages": []}).status_code == 401
    assert client.post("/v1/chat/completions", json={"model": "eco", "messages": []},
                       headers={"Authorization": "Bearer elyt-faux"}).status_code == 401


def test_default_tier_when_model_omitted(client, admin_h, fake):
    t = _mk_tenant(client, admin_h)
    h = {"Authorization": "Bearer " + t["service_key"]}
    r = client.post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "x"}]}, headers=h)
    assert r.status_code == 200 and r.json()["model"] == config.DEFAULT_TIER
    assert fake.last_model == config.TIERS[config.DEFAULT_TIER]["model"]


def test_tier_not_allowed(client, admin_h):
    t = _mk_tenant(client, admin_h, tier_allowed=["eco"])
    h = {"Authorization": "Bearer " + t["service_key"]}
    r = client.post("/v1/chat/completions", json={"model": "max", "messages": []}, headers=h)
    assert r.status_code == 403


def test_monthly_cap_enforced(client, admin_h):
    t = _mk_tenant(client, admin_h, monthly_cap_usd=0.0001)   # plafond minuscule
    h = {"Authorization": "Bearer " + t["service_key"]}
    first = client.post("/v1/chat/completions", json={"model": "eco", "messages": []}, headers=h)
    assert first.status_code == 200                          # 1er appel passe
    second = client.post("/v1/chat/completions", json={"model": "eco", "messages": []}, headers=h)
    assert second.status_code == 402                         # plafond atteint → coupe


def test_metering_aggregates(client, admin_h):
    t = _mk_tenant(client, admin_h)
    h = {"Authorization": "Bearer " + t["service_key"]}
    for _ in range(2):
        client.post("/v1/chat/completions", json={"model": "eco", "messages": []}, headers=h)
    u = client.get("/admin/usage", params={"tenant": t["id"]}, headers=admin_h).json()
    assert u["calls"] == 2 and u["ptok"] == 2000 and u["ctok"] == 1000
    assert u["cost_real"] > 0


def test_revoke_blocks_access(client, admin_h):
    t = _mk_tenant(client, admin_h)
    h = {"Authorization": "Bearer " + t["service_key"]}
    assert client.post("/v1/chat/completions", json={"model": "eco", "messages": []}, headers=h).status_code == 200
    client.delete("/admin/tenants/" + t["id"], headers=admin_h)
    assert client.post("/v1/chat/completions", json={"model": "eco", "messages": []}, headers=h).status_code == 401
