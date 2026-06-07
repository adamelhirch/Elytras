"""Finalisation manuelle du login provider (collage du code) — déploiements distants."""
import elytras.provider_auth as PA


class FakeStore:
    def __init__(self):
        self.saved = {}

    def save_tokens(self, uid, prov, rec):
        self.saved[(uid, prov)] = rec

    def get_tokens(self, uid, prov):
        return self.saved.get((uid, prov))


def test_manual_exchange_ok_and_guards(monkeypatch):
    pa = PA.ProviderAuth(FakeStore())
    monkeypatch.setattr(PA, "_exchange", lambda spec, code, verifier, state: {"access_token": "AT", "refresh_token": "RT"})
    monkeypatch.setattr(PA, "_normalize", lambda spec, tok, prev=None: {"access_token": tok["access_token"]})

    # sans login en cours -> refus
    ok, _ = pa.manual_exchange("codex", "u1", "CODE", "st")
    assert ok is False

    # login en cours (simulé) + bon state -> connecté
    pa._pending["codex"] = {"verifier": "v", "state": "st", "user_id": "u1", "ts": 0}
    ok, msg = pa.manual_exchange("codex", "u1", "CODE", "st")
    assert ok and pa.store.saved[("u1", "codex")]["access_token"] == "AT"
    assert "codex" not in pa._pending                      # session consommée

    # mauvais state -> refus (anti-CSRF)
    pa._pending["codex"] = {"verifier": "v", "state": "st", "user_id": "u1", "ts": 0}
    ok, _ = pa.manual_exchange("codex", "u1", "CODE", "AUTRE")
    assert ok is False
