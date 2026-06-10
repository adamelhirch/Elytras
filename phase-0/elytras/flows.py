"""Flows — modèle **OpenFlow natif** (openflow.openapi.yaml v1.721, Windmill).

Un flow = { summary, description, value: FlowValue, schema } + métadonnées Elytras
(scope perso/projet, owner, webhook, ui.pos). Le JSON stocké EST de l'OpenFlow :
l'import/export (et donc le Hub Windmill) est une quasi-identité.

FlowValue : modules[], failure_module, preprocessor_module, same_worker,
concurrent_limit/key/window, skip_expr, cache_ttl, early_return, priority,
flow_env, chat_input_enabled, notes[] (sticky notes), groups[].

FlowModule : id, value, summary, stop_after_if{expr,skip_if_stopped,error_message},
stop_after_all_iters_if, skip_if{expr}, sleep(transform), cache_ttl, timeout(transform),
mock{enabled,return_value}, suspend{required_events,timeout,resume_form,...},
priority, continue_on_error, retry{constant|exponential(+random_factor)|retry_if}.

value.type ∈ rawscript (23 langages) | script (PathScript, dont hub/) | flow (sous-flow)
| forloopflow (parallel, parallelism, skip_failures) | whileloopflow | branchone
| branchall (parallel, skip_failure) | identity | aiagent (nos agents Elytras)
| mcptool (extension Elytras : outil MCP direct, exportée en x_elytras).

Les transforms d'entrées sont des InputTransform : {type:'static',value} ou
{type:'javascript',expr} — le prop-picker côté UI s'appuie dessus.

`migrate_legacy` convertit l'ancien format Elytras (code/tool/http/email/sql/note/
approval/forloop/...) — aucune perte, les flows existants continuent de tourner.
"""
from __future__ import annotations

import secrets
import uuid

from . import filestore

RAW_LANGS = ("python3", "deno", "bun", "nativets", "bash", "powershell", "nu", "go", "php",
             "rust", "csharp", "java", "ruby", "rlang", "ansible", "graphql",
             "postgresql", "mysql", "bigquery", "snowflake", "mssql", "oracledb", "duckdb")
MODULE_TYPES = ("rawscript", "script", "flow", "forloopflow", "whileloopflow",
                "branchone", "branchall", "identity", "aiagent", "mcptool")
CONTAINER_TYPES = ("forloopflow", "whileloopflow", "branchone", "branchall")


def new_module_id() -> str:
    return uuid.uuid4().hex[:8]


def _tf(v, default_static=True):
    """Normalise un InputTransform ; valeur nue → static."""
    if isinstance(v, dict) and v.get("type") in ("static", "javascript", "ai"):
        return v
    return {"type": "static", "value": v}


def _norm_transforms(t: dict | None) -> dict:
    return {k: _tf(v) for k, v in (t or {}).items()}


def normalize_module(m: dict) -> dict:
    """Garantit id/summary + value typée + normalisation récursive."""
    m = dict(m or {})
    if "value" not in m and m.get("type"):               # forme aplatie → enveloppe value
        v = {k: m.pop(k) for k in list(m.keys())
             if k not in ("id", "summary", "stop_after_if", "stop_after_all_iters_if", "skip_if",
                          "sleep", "cache_ttl", "timeout", "mock", "suspend", "priority",
                          "continue_on_error", "retry", "delete_after_secs")}
        m["value"] = v
    m.setdefault("id", new_module_id())
    v = m.get("value") or {"type": "identity"}
    t = v.get("type") or "identity"
    if t not in MODULE_TYPES:
        t = "identity"
        v = {"type": "identity"}
    v["type"] = t
    m.setdefault("summary", v.get("summary") or t)
    if t == "rawscript":
        lang = (v.get("language") or "python3")
        v["language"] = lang if lang in RAW_LANGS else {"python": "python3", "javascript": "bun",
                                                        "typescript": "deno"}.get(lang, "python3")
        v.setdefault("content", "")
        v["input_transforms"] = _norm_transforms(v.get("input_transforms"))
    elif t == "script":
        v.setdefault("path", "")
        v["input_transforms"] = _norm_transforms(v.get("input_transforms"))
    elif t == "flow":
        v.setdefault("path", "")
        v["input_transforms"] = _norm_transforms(v.get("input_transforms"))
    elif t == "forloopflow":
        v["iterator"] = _tf(v.get("iterator") if not isinstance(v.get("iterator"), str)
                            else {"type": "javascript", "expr": v["iterator"]})
        v.setdefault("skip_failures", False)
        v.setdefault("parallel", False)
        v.setdefault("parallelism", None)
        v["modules"] = [normalize_module(x) for x in (v.get("modules") or [])]
    elif t == "whileloopflow":
        v.setdefault("skip_failures", False)
        v.setdefault("parallel", False)
        v.setdefault("condition", v.get("condition") or "")     # extension Elytras (sinon stop_after_if)
        v.setdefault("max_iter", int(v.get("max_iter") or 100))
        v["modules"] = [normalize_module(x) for x in (v.get("modules") or [])]
    elif t == "branchone":
        v["branches"] = [{"summary": b.get("summary", "branche"), "expr": b.get("expr", ""),
                          "modules": [normalize_module(x) for x in (b.get("modules") or [])]}
                         for b in (v.get("branches") or [])]
        v["default"] = [normalize_module(x) for x in (v.get("default") or v.get("default_modules") or [])]
    elif t == "branchall":
        v.setdefault("parallel", False)
        v["branches"] = [{"summary": b.get("summary", "branche"),
                          "skip_failure": bool(b.get("skip_failure")),
                          "modules": [normalize_module(x) for x in (b.get("modules") or [])]}
                         for b in (v.get("branches") or [])]
    elif t == "aiagent":
        v.setdefault("agent_id", "orchestrateur")
        v.setdefault("memory", "flow")
        v["input_transforms"] = _norm_transforms(v.get("input_transforms"))
        v["input_transforms"].setdefault("user_message", {"type": "static", "value": ""})
        v.setdefault("tools", [])
    elif t == "mcptool":
        v.setdefault("server_id", "")
        v.setdefault("tool", "")
        v["input_transforms"] = _norm_transforms(v.get("input_transforms") or v.get("args"))
        v.pop("args", None)
    m["value"] = v
    # champs FlowModule optionnels normalisés
    if isinstance(m.get("stop_after_if"), dict) and "enabled" in m["stop_after_if"]:
        m["stop_after_if"] = ({"expr": m["stop_after_if"].get("expr", "")}
                              if m["stop_after_if"].get("enabled") else None)
    if isinstance(m.get("skip_if"), dict) and "enabled" in m["skip_if"]:
        m["skip_if"] = {"expr": m["skip_if"].get("expr", "")} if m["skip_if"].get("enabled") else None
    for k in ("stop_after_if", "skip_if", "suspend", "mock", "retry",
              "stop_after_all_iters_if"):
        if not m.get(k):
            m.pop(k, None)
    return m


# ───────────────────────── Migration de l'ancien format Elytras ─────────────────────────
_LEGACY_LANG = {"python": "python3", "javascript": "bun", "typescript": "deno"}


def _legacy_adv(m: dict, out: dict):
    """Convertit les champs avancés hérités vers les champs FlowModule OpenFlow."""
    r = m.get("retry") or {}
    if int(r.get("attempts") or 0) > 0:
        if r.get("mode") == "exponential":
            out["retry"] = {"exponential": {"attempts": int(r["attempts"]), "multiplier": 2,
                                            "seconds": max(1, int(float(r.get("delay_s") or 1)))}}
        else:
            out["retry"] = {"constant": {"attempts": int(r["attempts"]),
                                         "seconds": int(float(r.get("delay_s") or 0))}}
    if float(m.get("timeout_s") or 0) > 0:
        out["timeout"] = {"type": "static", "value": float(m["timeout_s"])}
    if float(m.get("cache_ttl") or 0) > 0:
        out["cache_ttl"] = float(m["cache_ttl"])
    mk = m.get("mock") or {}
    if mk.get("enabled"):
        out["mock"] = {"enabled": True, "return_value": mk.get("value")}
    st = m.get("stop_after_if") or {}
    if st.get("enabled"):
        out["stop_after_if"] = {"expr": st.get("expr", ""), "skip_if_stopped": False}
    er = m.get("early_return") or {}
    if er.get("enabled"):                                # legacy early_return ≈ stop_after_if
        out["stop_after_if"] = {"expr": er.get("expr") or "True", "skip_if_stopped": False}
    sk = m.get("skip_if") or {}
    if sk.get("enabled"):
        out["skip_if"] = {"expr": sk.get("expr", "")}
    if float(m.get("sleep_s") or 0) > 0:
        out["sleep"] = {"type": "static", "value": float(m["sleep_s"])}
    if m.get("continue_on_error"):
        out["continue_on_error"] = True


def _legacy_module(m: dict, notes: list, pos: dict):
    """Ancien module → FlowModule OpenFlow (ou None si transformé en note)."""
    t = m.get("type")
    out = {"id": m.get("id") or new_module_id(), "summary": m.get("summary") or t}
    _legacy_adv(m, out)
    tmplt = lambda s: {"type": "static", "value": s}     # les {{ }} restent interpolés par static
    if t == "note":
        # Compat : la note historique est EXÉCUTABLE (texte interpolé, adressable via results.id).
        # → identity + mock (pin result), l'équivalent OpenFlow le plus proche.
        out["value"] = {"type": "identity"}
        if not (out.get("mock") or {}).get("enabled"):       # un mock explicite garde la priorité
            out["mock"] = {"enabled": True, "return_value": m.get("text") or ""}
        return out
    if t == "code":
        lang = m.get("language") or "python3"
        out["value"] = {"type": "rawscript",
                        "language": _LEGACY_LANG.get(lang, lang if lang in RAW_LANGS else "python3"),
                        "content": m.get("content", ""), "input_transforms": {}}
    elif t == "script":                                  # étape « script de la bibliothèque »
        out["value"] = {"type": "script", "path": m.get("path", ""),
                        "input_transforms": {k: tmplt(v) if isinstance(v, str) else _tf(v)
                                             for k, v in (m.get("args") or {}).items()}}
    elif t == "subflow":                                 # étape « sous-flow »
        out["value"] = {"type": "flow", "path": m.get("flow") or m.get("path", ""),
                        "input_transforms": {k: tmplt(v) if isinstance(v, str) else _tf(v)
                                             for k, v in (m.get("args") or {}).items()}}
    elif t == "identity":
        out["value"] = {"type": "identity"}
    elif t == "agent":
        out["value"] = {"type": "aiagent", "agent_id": m.get("agent_id") or "orchestrateur",
                        "memory": m.get("memory") or "flow", "tools": [],
                        "input_transforms": {"user_message": tmplt(m.get("prompt", ""))}}
    elif t == "tool":
        out["value"] = {"type": "mcptool", "server_id": m.get("server_id"), "tool": m.get("tool"),
                        "input_transforms": {k: tmplt(v) if isinstance(v, str) else _tf(v)
                                             for k, v in (m.get("args") or {}).items()}}
    elif t == "http":
        out["value"] = {"type": "script", "path": "hub/elytras/http_request",
                        "input_transforms": {"url": tmplt(m.get("url", "")), "method": _tf(m.get("method", "GET")),
                                             "headers": _tf(m.get("headers") or {}),
                                             "body": tmplt(m.get("body", "")),
                                             "timeout_s": _tf(m.get("timeout_s_http", 15))}}
    elif t == "email":
        out["value"] = {"type": "script", "path": "hub/elytras/send_email",
                        "input_transforms": {"to": tmplt(m.get("to", "")), "cc": tmplt(m.get("cc", "")),
                                             "subject": tmplt(m.get("subject", "")),
                                             "body": tmplt(m.get("body", "")), "html": _tf(bool(m.get("html")))}}
    elif t == "sql":
        out["value"] = {"type": "script", "path": "hub/elytras/sql_query",
                        "input_transforms": {"query": tmplt(m.get("query", "")),
                                             "params": _tf(m.get("params") or {}),
                                             "connection_url": tmplt(m.get("connection_url", ""))}}
    elif t == "trigger":
        out["value"] = {"type": "script", "path": "hub/elytras/poll_dedup",
                        "input_transforms": {"code": _tf(m.get("content", "")),
                                             "language": _tf(_LEGACY_LANG.get(m.get("language"), "python3")),
                                             "key": _tf(m.get("key", ""))}}
        out["summary"] = out["summary"] or "trigger"
    elif t == "approval":
        out["value"] = {"type": "identity"}
        out["suspend"] = {"required_events": 1, "timeout": 0,
                          "message": m.get("message", "Validation requise pour continuer.")}
    elif t == "forloop":
        out["value"] = {"type": "forloopflow",
                        "iterator": {"type": "javascript", "expr": m.get("iterator", "")},
                        "skip_failures": False, "parallel": bool(m.get("parallel")),
                        "modules": [x for x in (_legacy_module(c, notes, pos)
                                                for c in (m.get("modules") or [])) if x]}
    elif t == "whileloop":
        out["value"] = {"type": "whileloopflow", "condition": m.get("condition", ""),
                        "max_iter": int(m.get("max_iter") or 100), "skip_failures": False,
                        "parallel": False,
                        "modules": [x for x in (_legacy_module(c, notes, pos)
                                                for c in (m.get("modules") or [])) if x]}
    elif t == "branchone":
        out["value"] = {"type": "branchone",
                        "branches": [{"summary": b.get("summary", "branche"), "expr": b.get("expr", ""),
                                      "modules": [x for x in (_legacy_module(c, notes, pos)
                                                              for c in (b.get("modules") or [])) if x]}
                                     for b in (m.get("branches") or [])],
                        "default": [x for x in (_legacy_module(c, notes, pos)
                                                for c in (m.get("default_modules") or [])) if x]}
    elif t == "branchall":
        out["value"] = {"type": "branchall", "parallel": bool(m.get("parallel")),
                        "branches": [{"summary": b.get("summary", "branche"), "skip_failure": False,
                                      "modules": [x for x in (_legacy_module(c, notes, pos)
                                                              for c in (b.get("modules") or [])) if x]}
                                     for b in (m.get("branches") or [])]}
    else:
        out["value"] = {"type": "identity"}
    return out


def _legacy_inputs_to_schema(inputs: list) -> dict:
    props, req, order = {}, [], []
    for it in (inputs or []):
        if isinstance(it, str):
            it = {"name": it, "type": "string"}
        name = it.get("name") or "champ"
        p = {"type": {"select": "string", "text": "string"}.get(it.get("type"), it.get("type") or "string")}
        if it.get("default") not in (None, ""):
            p["default"] = it["default"]
        if it.get("type") == "select" and it.get("options"):
            p["enum"] = it["options"]
        props[name] = p
        order.append(name)
        if it.get("required"):
            req.append(name)
    return {"type": "object", "properties": props, "required": req, "order": order} if props else \
        {"type": "object", "properties": {}, "required": []}


def migrate_legacy(f: dict) -> dict:
    """Ancien enregistrement de flow → OpenFlow natif. Idempotent."""
    if "value" in f and isinstance(f["value"], dict):
        return f                                          # déjà au nouveau format
    notes, pos = [], (f.get("ui") or {}).get("pos") or {}
    modules = [x for x in (_legacy_module(m, notes, pos)
                           for m in (f.get("modules") or f.get("steps") or [])) if x]
    on_error = [x for x in (_legacy_module(m, notes, pos) for m in (f.get("on_error") or [])) if x]
    failure = on_error[0] if len(on_error) == 1 else (
        {"id": "failure", "summary": "gestion d'erreur",
         "value": {"type": "branchall", "parallel": False,
                   "branches": [{"summary": m.get("summary", ""), "skip_failure": True, "modules": [m]}
                                for m in on_error]}} if on_error else None)
    out = {k: f.get(k) for k in ("name", "scope", "project_id", "owner_id", "webhook_token", "ui") if k in f}
    out.update({
        "summary": f.get("name") or f.get("summary") or "Flow",
        "description": f.get("description", ""),
        "schema": _legacy_inputs_to_schema(f.get("inputs")),
        "value": {"modules": modules, "same_worker": False, "notes": notes,
                  **({"failure_module": failure} if failure else {})}})
    return out


# ───────────────────────── Normalisation + CRUD ─────────────────────────
def _normalize(f: dict) -> dict:
    f = migrate_legacy(f)
    f.setdefault("summary", f.get("name") or "Flow")
    f["name"] = f.get("name") or f["summary"]
    f.setdefault("description", "")
    f.setdefault("schema", {"type": "object", "properties": {}, "required": []})
    f.setdefault("ui", {"pos": {}})
    f.setdefault("webhook_token", None)
    v = f.setdefault("value", {})
    v.setdefault("modules", [])
    v["modules"] = [normalize_module(m) for m in v["modules"]]
    if v.get("failure_module"):
        v["failure_module"] = normalize_module(v["failure_module"])
    if v.get("preprocessor_module"):
        v["preprocessor_module"] = normalize_module(v["preprocessor_module"])
    v.setdefault("same_worker", False)
    v.setdefault("notes", [])
    return f


def list_flows(user_id, project_ids=None) -> list[dict]:
    out = []
    for fid, f in filestore.items("flows").items():
        if f.get("owner_id") == user_id or f.get("project_id") in (project_ids or []):
            n = _normalize(dict(f))
            out.append({"id": fid, "name": n.get("name"), "summary": n.get("summary"),
                        "scope": n.get("scope"), "project_id": n.get("project_id"),
                        "owner_id": n.get("owner_id"), "schema": n.get("schema"),
                        "modules": n["value"]["modules"],
                        "webhook_token": n.get("webhook_token"),
                        "inputs": schema_to_inputs(n.get("schema"))})
    return out


def schema_to_inputs(schema: dict) -> list[dict]:
    """Vue « liste d'entrées » dérivée du JSON Schema (compat UI/agents)."""
    schema = schema or {}
    props = schema.get("properties") or {}
    req = set(schema.get("required") or [])
    order = schema.get("order") or list(props.keys())
    out = []
    for name in order:
        if name not in props:
            continue
        p = props[name] or {}
        it = {"name": name, "type": p.get("type", "string"), "required": name in req,
              "default": p.get("default", "")}
        if p.get("enum"):
            it["type"], it["options"] = "select", p["enum"]
        out.append(it)
    return out


def get_flow(fid: str) -> dict | None:
    f = filestore.items("flows").get(fid)
    if not f:
        return None
    n = _normalize({"id": fid, **f})
    n["inputs"] = schema_to_inputs(n.get("schema"))
    n["modules"] = n["value"]["modules"]                 # alias pratique (UI/moteur)
    return n


def create_flow(owner_id, name, scope="perso", project_id=None) -> str:
    fid = str(uuid.uuid4())
    filestore.put("flows", fid, _normalize({
        "name": name or "Nouveau flow", "scope": scope, "project_id": project_id,
        "owner_id": owner_id, "value": {"modules": []}}))
    return fid


def update_flow(fid, **fields) -> bool:
    f = filestore.items("flows").get(fid)
    if f is None:
        return False
    f = _normalize(dict(f))
    for k in ("name", "summary", "description", "ui", "scope", "project_id", "schema"):
        if fields.get(k) is not None:
            f[k] = fields[k]
    if fields.get("name") is not None:
        f["summary"] = fields["name"]
    if fields.get("inputs") is not None:                 # compat héritée : liste → schéma
        f["schema"] = _legacy_inputs_to_schema(fields["inputs"])
    if fields.get("value") is not None:                  # nouveau format complet
        f["value"] = fields["value"]
    elif fields.get("modules") is not None:              # compat : liste de modules (ancien OU nouveau)
        probe = {"modules": fields["modules"], "on_error": fields.get("on_error") or []}
        looks_legacy = any(isinstance(m, dict) and "value" not in m and m.get("type")
                           not in MODULE_TYPES for m in fields["modules"])
        if looks_legacy:
            mig = migrate_legacy({**probe, "name": f.get("name")})
            f["value"]["modules"] = mig["value"]["modules"]
            if mig["value"].get("failure_module"):
                f["value"]["failure_module"] = mig["value"]["failure_module"]
            if mig["value"].get("notes"):
                f["value"]["notes"] = mig["value"]["notes"]
        else:
            f["value"]["modules"] = fields["modules"]
    if fields.get("on_error") is not None and fields.get("modules") is None:
        mig = migrate_legacy({"modules": [], "on_error": fields["on_error"]})
        f["value"]["failure_module"] = mig["value"].get("failure_module")
    filestore.put("flows", fid, _normalize(f))
    return True


def delete_flow(fid) -> bool:
    return filestore.delete("flows", fid)


def ensure_webhook_token(fid) -> str | None:
    f = filestore.items("flows").get(fid)
    if not f:
        return None
    if not f.get("webhook_token"):
        f["webhook_token"] = secrets.token_urlsafe(12)
        filestore.put("flows", fid, f)
    return f["webhook_token"]


def find_by_webhook(fid, token) -> dict | None:
    f = get_flow(fid)
    if f and token and f.get("webhook_token") == token:
        return f
    return None


# ───────────────────────── Import / export OpenFlow ─────────────────────────
def export_openflow(fid: str) -> dict | None:
    """Flow → JSON OpenFlow portable (Hub Windmill). Les extensions Elytras (mcptool,
    agent) restent lisibles : aiagent est natif OpenFlow ; mcptool est exporté tel quel
    (champ x_elytras=true) — les importeurs stricts l'ignoreront proprement."""
    f = get_flow(fid)
    if not f:
        return None

    def clean_mod(m):
        m = {k: v for k, v in m.items() if k in
             ("id", "value", "summary", "stop_after_if", "stop_after_all_iters_if", "skip_if",
              "sleep", "cache_ttl", "timeout", "mock", "suspend", "priority",
              "continue_on_error", "retry", "delete_after_secs")}
        v = dict(m.get("value") or {})
        t = v.get("type")
        if t == "mcptool":
            v["x_elytras"] = True
        if t == "aiagent":
            v.setdefault("input_transforms", {})
            v["x_elytras_agent"] = {"agent_id": v.pop("agent_id", None), "memory": v.pop("memory", None)}
        for key in ("modules", "default"):
            if isinstance(v.get(key), list):
                v[key] = [clean_mod(x) for x in v[key]]
        if isinstance(v.get("branches"), list):
            v["branches"] = [{**b, "modules": [clean_mod(x) for x in (b.get("modules") or [])]}
                             for b in v["branches"]]
        m["value"] = v
        return m

    value = dict(f["value"])
    value["modules"] = [clean_mod(m) for m in value.get("modules", [])]
    for k in ("failure_module", "preprocessor_module"):
        if value.get(k):
            value[k] = clean_mod(value[k])
    schema = {k: v for k, v in (f.get("schema") or {}).items() if k != "order"}
    return {"summary": f.get("summary") or f.get("name") or "Flow",
            "description": f.get("description", ""), "value": value, "schema": schema}


def import_openflow(data: dict, owner_id, scope="perso", project_id=None) -> str:
    """JSON OpenFlow (Hub Windmill ou export) → flow Elytras. aiagent x_elytras_agent
    est restauré ; un aiagent « pur Windmill » devient un agent orchestrateur."""
    if not isinstance(data, dict) or not isinstance(data.get("value"), dict):
        raise ValueError("JSON OpenFlow invalide : objet {summary, value:{modules:[…]}} attendu")

    def rest_mod(m):
        v = dict(m.get("value") or {})
        if v.get("type") == "aiagent":
            xa = v.pop("x_elytras_agent", None) or {}
            v["agent_id"] = xa.get("agent_id") or "orchestrateur"
            v["memory"] = xa.get("memory") or "flow"
        v.pop("x_elytras", None)
        for key in ("modules", "default"):
            if isinstance(v.get(key), list):
                v[key] = [rest_mod(x) for x in v[key]]
        if isinstance(v.get("branches"), list):
            v["branches"] = [{**b, "modules": [rest_mod(x) for x in (b.get("modules") or [])]}
                             for b in v["branches"]]
        return {**m, "value": v}

    value = dict(data["value"])
    value["modules"] = [rest_mod(m) for m in (value.get("modules") or [])]
    for k in ("failure_module", "preprocessor_module"):
        if value.get(k):
            value[k] = rest_mod(value[k])
    fid = str(uuid.uuid4())
    filestore.put("flows", fid, _normalize({
        "name": data.get("summary") or "Flow importé", "summary": data.get("summary") or "Flow importé",
        "description": data.get("description", ""), "schema": data.get("schema") or {},
        "scope": scope, "project_id": project_id, "owner_id": owner_id, "value": value}))
    return fid
