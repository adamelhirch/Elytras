"""Triggers email façon Windmill : boîte partagée + une adresse par flow (plus-addressing)."""
import email.message

import elytras.flows as flows
import elytras.main as main
import elytras.triggers as triggers


def _msg(to, subject="Devis", body="Bonjour", mid="<m1@x>", cc=None, delivered=None):
    m = email.message.EmailMessage()
    m["From"] = "Client <client@exemple.com>"
    m["To"] = to
    if cc:
        m["Cc"] = cc
    if delivered:
        m["Delivered-To"] = delivered
    m["Subject"] = subject
    m["Message-ID"] = mid
    m.set_content(body)
    return m


class FakeIMAP:
    """IMAP minimal : une liste de messages non lus."""
    def __init__(self, msgs):
        self.msgs = msgs

    def login(self, *a):
        return "OK", []

    def select(self, *a):
        return "OK", []

    def search(self, *a):
        return "OK", [b" ".join(str(i + 1).encode() for i in range(len(self.msgs)))]

    def fetch(self, num, *_):
        return "OK", [(num, self.msgs[int(num) - 1].as_bytes())]

    def logout(self):
        return "BYE", []


def test_settings_roundtrip_et_mdp_expurge(client, admin, H):
    r = client.put("/triggers/email-settings", headers=H(admin.token),
                   json={"host": "imap.exemple.com", "user": "flows@exemple.com",
                         "password": "secret", "address": "flows@exemple.com", "poll_s": 30})
    d = r.json()
    assert d["configured"] is True and d["has_password"] is True
    assert "password" not in d and "password_enc" not in d
    g = client.get("/triggers/email-settings", headers=H(admin.token)).json()
    assert g["address"] == "flows@exemple.com" and "password_enc" not in g


def test_settings_adresse_invalide(client, admin, H):
    r = client.put("/triggers/email-settings", headers=H(admin.token),
                   json={"host": "h", "address": "pas-une-adresse"})
    assert r.status_code == 400


def test_adresse_par_flow(client, admin, H, state):
    triggers.save_email_settings({"host": "imap.x", "address": "Flows@Exemple.com"})
    fid = client.post("/flows", json={"name": "Devis"}, headers=H(admin.token)).json()["id"]
    d = client.post(f"/flows/{fid}/email-token", headers=H(admin.token)).json()
    assert d["inbox_configured"] is True
    assert d["address"] == f"flows+{d['token']}@exemple.com"
    # idempotent : regénérer renvoie le même jeton
    assert client.post(f"/flows/{fid}/email-token", headers=H(admin.token)).json()["token"] == d["token"]
    assert flows.find_by_email_token(d["token"])["id"] == fid


def test_plus_tokens_extraction():
    m = _msg(to="Garage <flows+abc123@exemple.com>", cc="flows+def456@exemple.com",
             delivered="flows+abc123@exemple.com")
    toks = triggers._plus_tokens(m, "flows@exemple.com")
    assert toks == ["abc123", "def456"]
    assert triggers._plus_tokens(_msg(to="autre@exemple.com"), "flows@exemple.com") == []
    assert triggers._plus_tokens(_msg(to="flows+x@autredomaine.com"), "flows@exemple.com") == []


def test_poll_shared_inbox_routage_et_dedup(state):
    triggers.save_email_settings({"host": "imap.x", "address": "flows@exemple.com"})
    msgs = [_msg("flows+tok1@exemple.com", subject="A", mid="<a@x>"),
            _msg("inconnu@exemple.com", subject="B", mid="<b@x>"),
            _msg("flows+tok2@exemple.com", subject="C", mid="<c@x>")]
    out = triggers.poll_shared_inbox(imap_factory=lambda: FakeIMAP(msgs))
    assert [(t, p["subject"]) for t, p in out] == [("tok1", "A"), ("tok2", "C")]
    assert out[0][1]["from"].startswith("Client") and out[0][1]["text"].strip() == "Bonjour"
    # dédup persistante : second poll → rien de neuf
    assert triggers.poll_shared_inbox(imap_factory=lambda: FakeIMAP(msgs)) == []


def test_email_declenche_le_flow(client, admin, H, state):
    triggers.save_email_settings({"host": "imap.x", "address": "flows@exemple.com"})
    fid = client.post("/flows", json={"name": "Sur mail"}, headers=H(admin.token)).json()["id"]
    client.patch("/flows/" + fid, headers=H(admin.token), json={"value": {"modules": [
        {"id": "a", "value": {"type": "rawscript", "language": "python3",
         "content": "def main(subject):\n    return 'reçu: ' + (subject or '')",
         "input_transforms": {"subject": {"type": "javascript", "expr": "flow_input.subject"}}}}]}})
    tok = client.post(f"/flows/{fid}/email-token", headers=H(admin.token)).json()["token"]
    msgs = [_msg(f"flows+{tok}@exemple.com", subject="Urgent", mid="<u@x>")]
    routed = triggers.poll_shared_inbox(imap_factory=lambda: FakeIMAP(msgs))
    assert len(routed) == 1 and routed[0][0] == tok
    f = flows.find_by_email_token(tok)
    r = main.run_flow(f, routed[0][1], f.get("owner_id"), triggered_by="email")
    assert r["status"] == "done" and r["results"]["a"] == "reçu: Urgent"
    main._route_shared_email(tok, routed[0][1])      # le chemin du poller ne lève pas


def test_shared_inbox_due(state):
    assert triggers.shared_inbox_due() is False                      # pas configurée
    triggers.save_email_settings({"host": "imap.x", "address": "flows@exemple.com", "poll_s": 60})
    assert triggers.shared_inbox_due(now=1000.0) is True
    assert triggers.shared_inbox_due(now=1030.0) is False            # trop tôt
    assert triggers.shared_inbox_due(now=1061.0) is True
    triggers.save_email_settings({"enabled": False})
    assert triggers.shared_inbox_due(now=2000.0) is False            # désactivée
