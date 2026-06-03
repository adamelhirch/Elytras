"""Planificateur léger : exécute des tâches récurrentes (un agent sur un objectif) en tâche de fond.

Stockage fichier ("schedules"). Un thread vérifie périodiquement les tâches dues et appelle
`run_fn(sid, schedule)` (fourni par main, qui lance l'agent). Cadences simples : intervalle
(toutes N minutes) ou quotidien (à HH:MM).
"""
from __future__ import annotations

import datetime as dt
import threading
import time
import uuid

from . import filestore


def _parse_field(expr: str, lo: int, hi: int) -> set[int]:
    vals: set[int] = set()
    for part in str(expr).split(","):
        part = part.strip()
        if not part:
            continue
        step = 1
        if "/" in part:
            rng, st = part.split("/", 1)
            step = max(1, int(st))
        else:
            rng = part
        if rng in ("*", ""):
            a, b = lo, hi
        elif "-" in rng:
            sa, sb = rng.split("-", 1)
            a, b = int(sa), int(sb)
        else:
            a = b = int(rng)
        for v in range(a, b + 1, step):
            if lo <= v <= hi:
                vals.add(v)
    return vals


def cron_next(expr: str, base: float) -> float:
    """Prochain déclenchement d'une expression cron 5 champs (min h jour mois jour-semaine)."""
    parts = str(expr).split()
    if len(parts) != 5:
        raise ValueError("cron attendu : 5 champs « min h jour mois jour-semaine »")
    mins = _parse_field(parts[0], 0, 59)
    hours = _parse_field(parts[1], 0, 23)
    doms = _parse_field(parts[2], 1, 31)
    months = _parse_field(parts[3], 1, 12)
    dows = _parse_field(parts[4], 0, 7)
    if 7 in dows:
        dows.add(0)                      # 7 = dimanche, comme 0
    dom_r = parts[2].strip() != "*"
    dow_r = parts[4].strip() != "*"
    t = dt.datetime.fromtimestamp(base).replace(second=0, microsecond=0) + dt.timedelta(minutes=1)
    for _ in range(367 * 24 * 60):       # borne de sécurité : ~1 an
        cw = t.isoweekday() % 7          # 0 = dimanche … 6 = samedi (convention cron)
        if dom_r and dow_r:
            day_ok = (t.day in doms) or (cw in dows)
        else:
            day_ok = (t.day in doms if dom_r else True) and (cw in dows if dow_r else True)
        if t.minute in mins and t.hour in hours and t.month in months and day_ok:
            return t.timestamp()
        t += dt.timedelta(minutes=1)
    return base + 3600                   # repli improbable


def compute_next(s: dict, base: float | None = None) -> float:
    base = base if base is not None else time.time()
    if s.get("kind") == "cron":
        try:
            return cron_next(s.get("cron") or "* * * * *", base)
        except Exception:
            return base + 3600
    if s.get("kind") == "daily":
        hh, mm = (str(s.get("at", "09:00")).split(":") + ["0"])[:2]
        n = dt.datetime.fromtimestamp(base)
        target = n.replace(hour=int(hh), minute=int(mm), second=0, microsecond=0)
        if target.timestamp() <= base:
            target = target + dt.timedelta(days=1)
        return target.timestamp()
    return base + max(60, int(s.get("every_min", 60)) * 60)   # intervalle


def list_schedules(user_id, project_ids=None) -> list[dict]:
    out = []
    for sid, s in filestore.items("schedules").items():
        if s.get("owner_id") == user_id or s.get("project_id") in (project_ids or []):
            out.append({"id": sid, **s})
    out.sort(key=lambda x: x.get("next_run", 0))
    return out


def create_schedule(owner_id, name, prompt, kind="daily", at="09:00", every_min=60,
                    agent_id="orchestrateur", scope="perso", project_id=None, flow_id=None,
                    cron="") -> str:
    sid = str(uuid.uuid4())
    s = {"name": name, "prompt": prompt, "kind": kind, "at": at, "every_min": every_min,
         "cron": cron, "agent_id": agent_id, "flow_id": flow_id, "scope": scope,
         "project_id": project_id, "owner_id": owner_id, "enabled": True,
         "last_run": 0, "last_result": ""}
    s["next_run"] = compute_next(s)
    filestore.put("schedules", sid, s)
    return sid


def update_schedule(sid, **fields) -> bool:
    s = filestore.items("schedules").get(sid)
    if not s:
        return False
    s.update({k: v for k, v in fields.items() if v is not None})
    if any(k in fields for k in ("kind", "at", "every_min", "cron")):
        s["next_run"] = compute_next(s)
    filestore.put("schedules", sid, s)
    return True


def delete_schedule(sid) -> bool:
    return filestore.delete("schedules", sid)


def run_now(sid, run_fn):
    s = filestore.items("schedules").get(sid)
    if not s:
        return False
    _run_one(sid, s, run_fn)
    return True


def _run_one(sid, s, run_fn):
    try:
        res = run_fn(sid, s)
        s["last_result"] = (res or "")[:300]
    except Exception as e:
        s["last_result"] = f"erreur: {e.__class__.__name__}"
    s["last_run"] = time.time()
    s["next_run"] = compute_next(s)
    filestore.put("schedules", sid, s)


def start(run_fn, interval: float = 20.0):
    def loop():
        while True:
            try:
                now = time.time()
                for sid, s in list(filestore.items("schedules").items()):
                    if s.get("enabled", True) and s.get("next_run", 0) <= now:
                        _run_one(sid, s, run_fn)
            except Exception:
                pass
            time.sleep(interval)
    threading.Thread(target=loop, daemon=True).start()
