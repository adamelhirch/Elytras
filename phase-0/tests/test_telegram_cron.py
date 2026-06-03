"""Telegram (sessions, dispatch, routage) et cron."""
import elytras.main as M
import elytras.agents as A
import elytras.rbac as R
import elytras.sessions as S
import elytras.scheduler as SCH
import datetime as dt


def _bot(state):
    A.set_telegram_token("orchestrateur", "TOK")
    return A.get_agent("orchestrateur")


def test_telegram_unknown_sender(state):
    ag = _bot(state)
    sent = []
    M._tg_handle(ag, {"chat": {"id": 1}, "from": {"id": 999}, "text": "salut"},
                 send=lambda *a, **k: sent.append(a))
    assert any("non reconnu" in str(a).lower() for a in sent)


def test_telegram_conversation_is_a_session(state, client, admin):
    ag = _bot(state)
    adm, _ = R.find_by_email("admin@x.com")
    R.set_telegram(adm, "42")
    M._tg_handle(ag, {"chat": {"id": 42}, "from": {"id": 42}, "text": "bonjour"}, send=lambda *a, **k: None)
    sids = S.list_sessions(adm)
    assert len(sids) == 1
    msgs = S.get_session(adm, sids[0]["id"])["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]      # persisté → visible côté web
    # /new crée une 2e session
    M._tg_handle(ag, {"chat": {"id": 42}, "from": {"id": 42}, "text": "/new"}, send=lambda *a, **k: None)
    M._tg_handle(ag, {"chat": {"id": 42}, "from": {"id": 42}, "text": "autre"}, send=lambda *a, **k: None)
    assert len(S.list_sessions(adm)) == 2


def test_dispatch_creates_notif_session(state, monkeypatch):
    ag = _bot(state)
    R.create_account("Cible", "c@x.com", "pw", [])
    uid, _ = R.find_by_email("c@x.com")
    R.set_telegram(uid, "77")
    monkeypatch.setattr(M, "telegram_send", lambda *a, **k: {"ok": True})   # pas de réseau
    r = M.dispatch_notify(uid, "Alerte stock bas.", ag)
    ns = S.get_session(uid, r["session"])
    assert ns["messages"][0]["role"] == "assistant" and "stock bas" in ns["messages"][0]["content"]
    assert M._tg_session_get("77") == r["session"]               # session courante = la notif


def test_cron_next():
    base = dt.datetime(2026, 6, 1, 10, 17, 0).timestamp()
    assert dt.datetime.fromtimestamp(SCH.cron_next("*/5 * * * *", base)).minute == 20
    t = dt.datetime.fromtimestamp(SCH.cron_next("0 9 * * 1-5", base))
    assert t.hour == 9 and t.minute == 0 and t.isoweekday() <= 5
    t2 = dt.datetime.fromtimestamp(SCH.cron_next("30 8 1 * *", base))
    assert t2.day == 1 and t2.hour == 8 and t2.minute == 30
