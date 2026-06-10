"""Fixtures de test Elytras — état isolé par test + provider LLM simulé.

Lancer : cd phase-0 && python -m pytest -q
"""
import os

os.environ.setdefault("APP_ENCRYPTION_KEY", "test")
os.environ.setdefault("SKILLS_DIR", "skills")
os.environ.setdefault("ELYTRAS_TELEGRAM", "0")        # ne pas démarrer les pollers Telegram
os.environ.setdefault("ELYTRAS_EMAIL_TRIGGERS", "0")  # ni le poller IMAP des triggers email
os.environ.setdefault("ELYTRAS_CODE_SANDBOX", "off")  # bwrap/sandbox-exec absents en CI
os.environ.setdefault("ELYTRAS_STATE_FILE", "/tmp/elytras-test-boot.json")

import pytest                                          # noqa: E402
import elytras.providers as providers                 # noqa: E402


class FakeProvider:
    """Provider LLM simulé. `script(input_items, instr, tools)->dict` pilote agent_turn ;
    `complete_text` pilote complete()."""
    default_model = "gpt-test"
    script = None
    complete_text = '{"facts": []}'

    def agent_turn(self, input_items, instr, tools=None):
        if FakeProvider.script:
            return FakeProvider.script(input_items, instr, tools)
        return {"text": "ok", "tool_calls": []}

    def complete(self, messages, model=None):
        class C:
            text = FakeProvider.complete_text
        return C()


providers.CodexProvider = FakeProvider

import elytras.filestore as filestore                 # noqa: E402
import elytras.main as main                           # noqa: E402
from fastapi.testclient import TestClient             # noqa: E402


@pytest.fixture()
def state(tmp_path, monkeypatch):
    monkeypatch.setattr(filestore, "_PATH", tmp_path / "state.json")
    FakeProvider.script = None
    FakeProvider.complete_text = '{"facts": []}'
    yield tmp_path


@pytest.fixture()
def client(state):
    return TestClient(main.app)


@pytest.fixture()
def H():
    return lambda tok: {"X-Elytras-Token": tok}


@pytest.fixture()
def admin(client):
    """Crée le 1er admin et renvoie (token, helpers)."""
    tok = client.post("/auth/setup", json={"name": "Admin", "email": "admin@x.com", "password": "pw"}).json()["token"]

    def mkteam(name, role):
        return client.post("/admin/teams", json={"name": name, "role": role},
                           headers={"X-Elytras-Token": tok}).json()["id"]

    def mkuser(name, email, pw, team_ids):
        client.post("/admin/accounts", json={"name": name, "email": email, "password": pw, "team_ids": team_ids},
                    headers={"X-Elytras-Token": tok})
        return client.post("/auth/login", json={"email": email, "password": pw}).json()["token"]

    return type("Adm", (), {"token": tok, "mkteam": staticmethod(mkteam), "mkuser": staticmethod(mkuser)})
