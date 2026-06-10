"""Moteur d'exécution OpenFlow — sémantique Windmill complète, en mode fichier.

Couvre, par module : input_transforms (static/javascript), skip_if, mock (pin result),
cache_ttl, retry (constant/exponential + random_factor + retry_if), timeout (transform),
sleep avant exécution (transform), continue_on_error, stop_after_if (+ skip_if_stopped
+ error_message), stop_after_all_iters_if (boucles), suspend (required_events, timeout,
resume_form) au niveau racine, priorité (stockée).

Par flow : skip_expr, cache_ttl global, early_return, failure_module (try/catch),
preprocessor_module (déclencheurs externes), flow_env, concurrent_limit (par flow),
same_worker (no-op : mono-processus), notes (documentation).

Types de modules : rawscript (runners 23 langages), script (bibliothèque + builtins
hub/elytras), flow (sous-flow, profondeur max 5), forloopflow (parallel + parallelism +
skip_failures), whileloopflow, branchone, branchall (parallel + skip_failure), identity,
aiagent (agents Elytras), mcptool (outil MCP direct).

Les appels dépendants du cœur (agents, MCP, builtins http/email/sql, audit, RBAC)
sont INJECTÉS par main.py via `HOOKS` — pas d'import circulaire.
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import json
import threading
import time

from . import filestore, flows, runners, scripts
from .exprs import (Dot, StopFlow, Suspend, eval_expr, eval_transform, eval_transforms,
                    plain, render, with_retry, with_timeout, wrap)

# Hooks injectés par main.py : agent(agent_id, prompt, memory, meta) ; mcp_tool(server_id,
# tool, args, meta) ; builtin(name, args, meta) ; audit(...) ; has_cap(user, cap).
HOOKS: dict = {}

_RUNNING: dict[str, int] = {}            # fid -> exécutions en cours (concurrent_limit)
_RUN_LOCK = threading.Lock()


def new_ns(inputs):
    fi = wrap(inputs or {})
    res = Dot()
    return {"flow_input": fi, "input": fi, "results": res, "step": res,
            "item": "", "index": 0, "previous": None, "resume": None, "resumes": []}


def child_ns(ns):
    c = dict(ns)
    c["results"] = Dot(dict(ns.get("results") or {}))
    c["step"] = c["results"]
    return c


def _store(ns, m, res):
    rid = m.get("id") or m.get("summary")
    w = wrap(res)
    ns["results"][rid] = w
    if m.get("summary"):
        ns["results"].setdefault(m["summary"], w)
    ns["previous"] = w
    return w


def _cache_key(meta, m, ns):
    raw = f"{meta.get('fid')}:{m.get('id')}:{json.dumps(plain(ns.get('flow_input')), sort_keys=True, default=str)}"
    return hashlib.sha1(raw.encode()).hexdigest()


# ───────────────────────── Dispatch par type de module ─────────────────────────
def _exec_value(m, ns, meta):
    v = m.get("value") or {}
    t = v.get("type")
    if t == "identity":
        return plain(ns.get("previous"))
    if t == "rawscript":
        if not HOOKS["has_cap"](meta["user_id"], "code.execute"):
            raise PermissionError("exécution de code non autorisée (capacité code.execute requise)")
        args = eval_transforms(v.get("input_transforms"), ns)
        HOOKS["audit"]("code", v.get("language", ""), m, meta)
        return runners.run(v.get("content", ""), v.get("language", "python3"), args, ns,
                           _tf_num(m.get("timeout"), ns) or 30, meta, files_mod=HOOKS.get("files_mod"))
    if t == "script":
        sc = scripts.get(v.get("path") or "")
        if not sc:
            raise ValueError(f"script introuvable : {v.get('path')}")
        args = eval_transforms(v.get("input_transforms"), ns)
        HOOKS["audit"]("script", sc.get("path", ""), m, meta)
        if sc.get("builtin"):                                   # actions toutes faites, en-process
            return HOOKS["builtin"](sc["builtin"], args, ns, {**meta, "_mid": m.get("id")})
        if not HOOKS["has_cap"](meta["user_id"], "code.execute"):
            raise PermissionError("exécution de script non autorisée (capacité code.execute requise)")
        return runners.run(sc.get("content", ""), sc.get("language", "python3"), args, ns,
                           _tf_num(m.get("timeout"), ns) or 30, meta, files_mod=HOOKS.get("files_mod"))
    if t == "flow":
        depth = int(meta.get("subflow_depth") or 0)
        if depth >= 5:
            raise ValueError("profondeur de sous-flows dépassée (max 5)")
        sub = flows.get_flow(v.get("path") or "") or _flow_by_name(v.get("path"), meta)
        if not sub:
            raise ValueError(f"sous-flow introuvable : {v.get('path')}")
        if sub["id"] in (meta.get("flow_stack") or []):
            raise ValueError("cycle de sous-flows détecté")
        args = eval_transforms(v.get("input_transforms"), ns)
        HOOKS["audit"]("subflow", sub.get("name", ""), m, meta)
        sm = {**meta, "subflow_depth": depth + 1, "fid": sub["id"],
              "flow_stack": (meta.get("flow_stack") or []) + [meta.get("fid")]}
        r = run_flow_inner(sub, args, sm)
        if r.get("status") == "waiting":
            raise ValueError("un sous-flow ne peut pas contenir d'approbation (suspend racine uniquement)")
        if r.get("status") == "error":
            raise RuntimeError(str(r.get("error"))[:400])
        return r.get("result")
    if t == "aiagent":
        prompt = eval_transform((v.get("input_transforms") or {}).get("user_message"), ns)
        HOOKS["audit"]("agent", v.get("agent_id", ""), m, meta)
        opts = {"system_prompt": v.get("system_prompt"), "output_schema": v.get("output_schema"),
                "max_iterations": v.get("max_iterations")}
        return HOOKS["agent"](v.get("agent_id") or "orchestrateur", str(prompt or ""),
                              v.get("memory") or "flow", meta, opts)
    if t == "mcptool":
        args = eval_transforms(v.get("input_transforms"), ns)
        HOOKS["audit"]("tool", v.get("tool", ""), m, meta)
        return HOOKS["mcp_tool"](v.get("server_id"), v.get("tool", ""), args, meta)
    if t in flows.CONTAINER_TYPES:
        return _exec_container(m, v, t, ns, meta)
    raise ValueError(f"type de module inconnu : {t}")


def _flow_by_name(name, meta):
    if not name:
        return None
    for fid, f in filestore.items("flows").items():
        if (f.get("name") or "").lower() == str(name).lower():
            return flows.get_flow(fid)
    return None


def _exec_container(m, v, t, ns, meta):
    if t == "forloopflow":
        items = eval_transform(v.get("iterator"), ns)
        items = list(items.items()) if isinstance(items, dict) else list(items or [])
        skip_fail = bool(v.get("skip_failures"))

        def one(idx_it):
            idx, it = idx_it
            cns = child_ns(ns)
            cns["item"], cns["index"] = wrap(it), idx
            cns["flow_input"] = wrap({**plain(ns.get("flow_input") or {}),
                                      "iter": {"value": plain(it), "index": idx}})
            try:
                return _run_list(v.get("modules") or [], cns, meta)
            except (StopFlow, Suspend):
                raise
            except Exception as e:  # noqa: BLE001
                if skip_fail:
                    return None
                raise e
        if v.get("parallel") and len(items) > 1:
            par = _tf_num(v.get("parallelism"), ns)
            workers = min(int(par) if par else 8, max(1, len(items)), 16)
            out = [None] * len(items)
            with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
                for idx, val in zip(range(len(items)), ex.map(one, list(enumerate(items)))):
                    out[idx] = val
            res = out
        else:
            res = []
            saved = (ns.get("item"), ns.get("index"), ns.get("flow_input"))
            try:
                for pair in enumerate(items):
                    res.append(one(pair))
            finally:
                ns["item"], ns["index"], ns["flow_input"] = saved
        _stop_all_iters(m, ns, res)
        return res
    if t == "whileloopflow":
        last, n = None, 0
        cap = int(v.get("max_iter") or 100)
        cond = (v.get("condition") or "").strip()
        while n < cap:
            ns["index"] = n
            if cond and not bool(eval_expr(cond, ns)):
                break
            try:
                last = _run_list(v.get("modules") or [], ns, meta)
            except StopFlow as st:
                if st.skipped:
                    last = st.value
                    break
                raise
            n += 1
            if not cond and n >= cap:                     # sans condition : stop_after_if interne attendu
                break
        _stop_all_iters(m, ns, last)
        return last
    if t == "branchone":
        for b in (v.get("branches") or []):
            if bool(eval_expr(b.get("expr") or "False", ns)):
                return _run_list(b.get("modules") or [], ns, meta)
        return _run_list(v.get("default") or [], ns, meta)
    if t == "branchall":
        branches = v.get("branches") or []

        def oneb(b):
            try:
                return _run_list(b.get("modules") or [], child_ns(ns), meta)
            except (StopFlow, Suspend):
                raise
            except Exception as e:  # noqa: BLE001
                if b.get("skip_failure"):
                    return {"error": str(e)[:300]}
                raise
        if v.get("parallel") and len(branches) > 1:
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(branches))) as ex:
                return list(ex.map(oneb, branches))
        return [oneb(b) for b in branches]
    return None


def _stop_all_iters(m, ns, res):
    sa = m.get("stop_after_all_iters_if") or {}
    if sa.get("expr"):
        loc = {**ns, "result": wrap(res)}
        if bool(eval_expr(sa["expr"], loc)):
            raise StopFlow(res, skipped=bool(sa.get("skip_if_stopped")))


def _tf_num(t, ns):
    if t in (None, "", 0):
        return None
    try:
        return float(eval_transform(t, ns) or 0) or None
    except Exception:
        return None


# ───────────────────────── Exécution d'un module (wrappers FlowModule) ─────────────────────────
def exec_module(m, ns, meta):
    """Exécute un FlowModule complet. Retourne (résultat, skipped)."""
    # rétro-compat champs avancés hérités (UI/flows anciens)
    if m.get("timeout_s") and not m.get("timeout"):
        m["timeout"] = {"type": "static", "value": m["timeout_s"]}
    if m.get("sleep_s") and not m.get("sleep"):
        m["sleep"] = {"type": "static", "value": m["sleep_s"]}
    sk = m.get("skip_if") or {}
    if sk.get("expr") and bool(eval_expr(sk["expr"], ns)):
        _store(ns, m, None)
        return None, True
    slp = _tf_num(m.get("sleep"), ns)
    if slp:
        time.sleep(min(slp, 30))                          # sleep AVANT l'étape (spec OpenFlow)
    mk = m.get("mock") or {}
    if mk.get("enabled"):
        val = mk.get("return_value", mk.get("value"))
        res = _store(ns, m, render(val, ns) if isinstance(val, str) else val)
    else:
        def call():
            return _exec_value(m, ns, meta)
        ttl = float(m.get("cache_ttl") or 0)
        try:
            if ttl > 0:
                key = _cache_key(meta, m, ns)
                c = filestore.items("flow_cache").get(key)
                if c and (time.time() - c.get("ts", 0)) < ttl:
                    res = _store(ns, m, c["value"])
                else:
                    out = with_retry(lambda: with_timeout(call, _tf_num(m.get("timeout"), ns)),
                                     m.get("retry"), ns)
                    filestore.put("flow_cache", key, {"value": plain(out), "ts": time.time()})
                    res = _store(ns, m, out)
            else:
                out = with_retry(lambda: with_timeout(call, _tf_num(m.get("timeout"), ns)),
                                 m.get("retry"), ns)
                res = _store(ns, m, out)
        except (StopFlow, Suspend):
            raise
        except Exception as e:  # noqa: BLE001
            if m.get("continue_on_error"):
                res = _store(ns, m, {"error": str(e)[:300]})
                return res, False
            raise
    st = m.get("stop_after_if") or {}
    if st.get("expr"):
        loc = {**ns, "result": wrap(res)}
        if bool(eval_expr(st["expr"], loc)):
            msg = st.get("error_message")
            if msg:
                raise StopFlow({"error": render(msg, loc)}, error=render(msg, loc))
            raise StopFlow(res, skipped=bool(st.get("skip_if_stopped")))
    if m.get("suspend"):
        raise Suspend({"module": m, "result": plain(res)})
    return res, False


def _run_list(modules, ns, meta):
    last = None
    for m in modules:
        if m.get("suspend"):
            raise ValueError("suspend/approbation : uniquement au niveau racine du flow")
        res, _sk = exec_module(m, ns, meta)
        last = res
    return last


# ───────────────────────── Exécution d'un flow complet ─────────────────────────
def run_flow_inner(flow, inputs, meta, start: int = 0, ns=None, on_step=None):
    """Cœur d'exécution (sans gestion de tâche UI). Retourne {status, result, results, …}.
    `on_step(i, état)` est notifié pour l'observabilité."""
    v = flow.get("value") or {}
    fid = flow.get("id")
    meta = {**meta, "fid": fid}
    notify = on_step or (lambda *a: None)

    # défauts du schéma appliqués aux entrées
    inputs = dict(inputs or {})
    for name, p in ((flow.get("schema") or {}).get("properties") or {}).items():
        if name not in inputs and "default" in (p or {}):
            inputs[name] = p["default"]

    ns = ns or new_ns(inputs)
    if v.get("flow_env"):
        ns["flow_env"] = wrap(v["flow_env"])

    # concurrent_limit (par flow, en-process)
    limit = int(v.get("concurrent_limit") or 0)
    if limit > 0 and start == 0:
        with _RUN_LOCK:
            if _RUNNING.get(fid, 0) >= limit:
                return {"status": "error",
                        "error": f"limite de concurrence atteinte ({limit} exécution(s) en cours)"}
            _RUNNING[fid] = _RUNNING.get(fid, 0) + 1

    def _release():
        if limit > 0 and start == 0:
            with _RUN_LOCK:
                _RUNNING[fid] = max(0, _RUNNING.get(fid, 1) - 1)

    try:
        # skip_expr : saute tout le flow
        if start == 0 and v.get("skip_expr") and bool(eval_expr(v["skip_expr"], ns)):
            return {"status": "done", "result": {"skipped": True}, "results": {}}
        # cache du flow entier
        fttl = float(v.get("cache_ttl") or 0)
        ckey = None
        if fttl > 0 and start == 0:
            ckey = "flow:" + _cache_key({"fid": fid}, {"id": "__flow__"}, ns)
            c = filestore.items("flow_cache").get(ckey)
            if c and (time.time() - c.get("ts", 0)) < fttl:
                return {"status": "done", "result": c["value"], "results": {}, "cached": True}
        # preprocessor (déclencheur externe) : son résultat DEVIENT flow_input
        if start == 0 and v.get("preprocessor_module") and meta.get("triggered_by"):
            pre, _ = exec_module(v["preprocessor_module"], ns, meta)
            if isinstance(pre, dict):
                ns["flow_input"] = wrap({**plain(ns["flow_input"]), **plain(pre)})
                ns["input"] = ns["flow_input"]

        modules = v.get("modules") or []
        last = None
        i = start
        try:
            while i < len(modules):
                m = modules[i]
                notify(i, "running")
                res, skipped = exec_module(m, ns, meta)
                last = res
                notify(i, "skipped" if skipped else "done")
                # early_return (niveau flow) : si l'expr devient vraie → retour anticipé
                if v.get("early_return"):
                    loc = {**ns, "result": wrap(last)}
                    try:
                        if bool(eval_expr(v["early_return"], loc)):
                            return {"status": "done", "result": plain(last),
                                    "results": plain(ns["results"]), "early_return": True}
                    except Exception:
                        pass
                i += 1
        except Suspend as s:
            notify(i, "waiting")
            return {"status": "waiting", "suspend": s.payload, "next_index": i + 1,
                    "ns": {"results": plain(ns["results"]), "flow_input": plain(ns["flow_input"]),
                           "resumes": plain(ns.get("resumes") or [])},
                    "results": plain(ns["results"])}
        except StopFlow as st:
            notify(i, "done")
            out = {"status": "done", "result": plain(st.value), "results": plain(ns["results"]),
                   "stopped": True, "skipped": st.skipped}
            if st.error:
                out = {"status": "error", "error": st.error, "results": plain(ns["results"])}
            return out
        except Exception as e:  # noqa: BLE001
            notify(i, "error")
            fm = v.get("failure_module")
            if fm:
                ns["error"] = wrap({"message": str(e)[:500], "name": type(e).__name__,
                                    "step_id": modules[i].get("id") if i < len(modules) else ""})
                try:
                    fres, _ = exec_module(fm, ns, meta)
                    return {"status": "error_handled", "error": str(e)[:500],
                            "failure_result": plain(fres), "results": plain(ns["results"])}
                except Exception as e2:  # noqa: BLE001
                    return {"status": "error", "error": str(e)[:500],
                            "failure_error": str(e2)[:300], "results": plain(ns["results"])}
            return {"status": "error", "error": str(e)[:500], "results": plain(ns["results"])}
        if ckey:
            filestore.put("flow_cache", ckey, {"value": plain(last), "ts": time.time()})
        return {"status": "done", "result": plain(last), "results": plain(ns["results"])}
    finally:
        _release()
