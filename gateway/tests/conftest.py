"""Fixtures de test de la passerelle — état isolé + backend modèle simulé (aucun réseau)."""
import os

os.environ.setdefault("GATEWAY_ADMIN_TOKEN", "admintok")
os.environ.setdefault("OPENROUTER_API_KEY", "test-key")
os.environ.setdefault("GW_MARKUP", "1.0")
os.environ.setdefault("GATEWAY_STATE_FILE", "/tmp/gw-boot.json")

import pytest                                          # noqa: E402
from fastapi.testclient import TestClient              # noqa: E402

from elytras_gateway import backends, config, main     # noqa: E402


class FakeBackend:
    """Backend modèle simulé : enregistre le modèle appelé, renvoie un usage contrôlable."""
    last_model = None
    ptok = 1000
    ctok = 500

    @staticmethod
    def call(model, payload):
        FakeBackend.last_model = model
        return {
            "id": "cmpl-test",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": FakeBackend.ptok, "completion_tokens": FakeBackend.ctok},
            "model": "REAL-" + model,            # nom réel qui NE doit PAS fuiter au client
        }


@pytest.fixture()
def gw(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "STATE_FILE", str(tmp_path / "gw.json"))
    monkeypatch.setattr(backends, "CALL", FakeBackend.call)
    FakeBackend.last_model = None
    FakeBackend.ptok, FakeBackend.ctok = 1000, 500
    yield tmp_path


@pytest.fixture()
def client(gw):
    return TestClient(main.app)


@pytest.fixture()
def admin_h():
    return {"Authorization": "Bearer admintok"}


@pytest.fixture()
def fake():
    return FakeBackend
