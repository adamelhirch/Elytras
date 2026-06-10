"""Webhooks nommés : un par service externe (Shopify, Stripe…), URL dédiée /hooks/<token>."""


def _flow_echo(client, H, tok):
    fid = client.post("/flows", json={"name": "Hook"}, headers=H(tok)).json()["id"]
    client.patch("/flows/" + fid, headers=H(tok), json={"value": {"modules": [
        {"id": "a", "value": {"type": "rawscript", "language": "python3",
         "content": "def main(ev):\n    return 'evt: ' + str(ev)",
         "input_transforms": {"ev": {"type": "javascript", "expr": "flow_input.event"}}}}]}})
    return fid


def test_webhook_nomme_cree_et_declenche(client, admin, H):
    fid = _flow_echo(client, H, admin.token)
    d = client.post("/triggers", headers=H(admin.token),
                    json={"kind": "webhook", "target": {"flow_id": fid},
                          "config": {"label": "Shopify — commande créée"}}).json()
    t = [x for x in client.get("/triggers?flow_id=" + fid, headers=H(admin.token)).json()["triggers"]
         if x["kind"] == "webhook"][0]
    assert t["config"]["label"].startswith("Shopify") and t["config"]["token"]
    r = client.post("/hooks/" + t["config"]["token"], json={"event": "orders/create"}).json()
    assert r["status"] == "done" and r["results"]["a"] == "evt: orders/create"


def test_webhook_desactive_ou_inconnu(client, admin, H):
    fid = _flow_echo(client, H, admin.token)
    client.post("/triggers", headers=H(admin.token),
                json={"kind": "webhook", "target": {"flow_id": fid}, "config": {"label": "Stripe"}})
    t = [x for x in client.get("/triggers?flow_id=" + fid, headers=H(admin.token)).json()["triggers"]
         if x["kind"] == "webhook"][0]
    client.patch("/triggers/" + t["id"], json={"enabled": False}, headers=H(admin.token))
    assert client.post("/hooks/" + t["config"]["token"], json={}).status_code == 404
    assert client.post("/hooks/jeton-bidon", json={}).status_code == 404


def test_payload_query_et_corps(client, admin, H):
    fid = _flow_echo(client, H, admin.token)
    client.post("/triggers", headers=H(admin.token),
                json={"kind": "webhook", "target": {"flow_id": fid}, "config": {"label": "X"}})
    t = [x for x in client.get("/triggers?flow_id=" + fid, headers=H(admin.token)).json()["triggers"]
         if x["kind"] == "webhook"][0]
    r = client.post("/hooks/" + t["config"]["token"] + "?event=ping", json={}).json()
    assert r["results"]["a"] == "evt: ping"                      # query params fusionnés
