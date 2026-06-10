"""Bibliothèque de SCRIPTS — première classe, façon Windmill.

Un script = {path, summary, description, language, content, schema, kind, versions}.
- le **schéma d'entrées est déduit automatiquement** de la signature de `main(...)`
  (Python : AST ; JS/TS : signature ; SQL : paramètres nommés ; bash : $1..) — comme
  l'auto-generated UI de Windmill ;
- un script devient une **action** réutilisable : étape `script` (PathScript) dans
  n'importe quel flow, exécutable seul, exposable en webhook/route HTTP/email/cron ;
- **kinds** Windmill : action | trigger (poll + dédup d'état) | approval | error_handler
  | preprocessor ;
- **versions** : chaque déploiement archive un hash (history) ; brouillon (draft)
  séparé du déployé — Draft & deploy de Windmill ;
- **builtins** `hub/elytras/...` : actions toutes faites (http_request, send_email,
  sql_query, poll_dedup) exécutées en-process (anti-SSRF, caps RBAC), miroir des
  scripts du Hub Windmill.
"""
from __future__ import annotations

import ast
import hashlib
import re
import time
import uuid

from . import filestore
from .runners import norm_lang

SECTION = "scripts"
KINDS = ("action", "trigger", "approval", "error_handler", "preprocessor")

# ───────────────────────── Parsing du schéma (auto-generated UI) ─────────────────────────
_PY_TYPES = {"str": "string", "int": "integer", "float": "number", "bool": "boolean",
             "list": "array", "dict": "object"}


def _schema_python(content: str) -> dict:
    try:
        tree = ast.parse(content or "")
    except SyntaxError:
        return {}
    fn = next((n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
               and n.name == "main"), None)
    if not fn:
        return {}
    props, req = {}, []
    args = fn.args.args
    defaults = [None] * (len(args) - len(fn.args.defaults)) + list(fn.args.defaults)
    for a, d in zip(args, defaults):
        t = "string"
        if a.annotation is not None:
            ann = getattr(a.annotation, "id", None) or getattr(getattr(a.annotation, "value", None), "id", None)
            t = _PY_TYPES.get(ann or "", "string")
        p = {"type": t}
        if d is not None:
            try:
                p["default"] = ast.literal_eval(d)
            except Exception:
                pass
        else:
            req.append(a.arg)
        props[a.arg] = p
    return {"type": "object", "properties": props, "required": req}


def _schema_js(content: str) -> dict:
    m = re.search(r"function\s+main\s*\(([^)]*)\)", content or "")
    if not m:
        return {}
    props, req = {}, []
    for part in [p.strip() for p in m.group(1).split(",") if p.strip()]:
        part = part.split(":")[0].strip()                  # retire l'annotation TS
        name, _, dflt = part.partition("=")
        name = name.strip().lstrip(".")
        if not re.match(r"^[A-Za-z_$][\w$]*$", name):
            continue
        p = {"type": "string"}
        if dflt.strip():
            try:
                import json as _json
                p["default"] = _json.loads(dflt.strip().replace("'", '"'))
            except Exception:
                p["default"] = dflt.strip().strip("'\"")
        else:
            req.append(name)
        props[name] = p
    return {"type": "object", "properties": props, "required": req}


def _schema_sql(content: str) -> dict:
    names = sorted(set(re.findall(r"%\((\w+)\)s|:(\w+)\b", content or "")))
    flat = sorted({a or b for a, b in names if (a or b)})
    props = {n: {"type": "string"} for n in flat}
    props.setdefault("database", {"type": "string", "description": "URL de connexion"})
    return {"type": "object", "properties": props, "required": []}


def _schema_bash(content: str) -> dict:
    n = max([int(x) for x in re.findall(r"\$(\d+)", content or "")] or [0])
    props = {f"arg{i}": {"type": "string"} for i in range(1, n + 1)}
    return {"type": "object", "properties": props, "required": []}


def parse_schema(language: str, content: str) -> dict:
    lang = norm_lang(language)
    if lang == "python3":
        return _schema_python(content)
    if lang in ("bun", "deno", "nativets"):
        return _schema_js(content)
    if lang in ("postgresql", "mysql", "bigquery", "snowflake", "mssql", "oracledb", "duckdb", "graphql"):
        return _schema_sql(content)
    if lang in ("bash", "powershell", "nu"):
        return _schema_bash(content)
    return {}


# ───────────────────────── CRUD + versions (draft & deploy) ─────────────────────────
def _hash(content: str) -> str:
    return hashlib.sha1((content or "").encode()).hexdigest()[:12]


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (s or "script").lower()).strip("_") or "script"


def create(owner_id: str, path: str | None, summary: str, language: str, content: str = "",
           description: str = "", kind: str = "action", scope: str = "perso",
           project_id: str | None = None) -> str:
    sid = str(uuid.uuid4())
    path = path or f"u/{(owner_id or 'user')[:8]}/{slugify(summary)}"
    filestore.put(SECTION, sid, {
        "path": path, "summary": summary or path, "description": description,
        "language": norm_lang(language), "content": content,
        "schema": parse_schema(language, content),
        "kind": kind if kind in KINDS else "action",
        "owner_id": owner_id, "scope": scope, "project_id": project_id,
        "draft": None, "archived": False, "created_at": time.time(),
        "versions": [{"hash": _hash(content), "content": content, "at": time.time()}]})
    return sid


def update(sid: str, deploy: bool = True, **fields) -> bool:
    s = filestore.items(SECTION).get(sid)
    if not s:
        return False
    if not deploy:                                       # brouillon : ne touche pas au déployé
        s["draft"] = {k: v for k, v in fields.items() if k in ("content", "summary", "language")}
        filestore.put(SECTION, sid, s)
        return True
    for k in ("path", "summary", "description", "language", "content", "kind", "scope", "project_id", "archived"):
        if k in fields and fields[k] is not None:
            s[k] = norm_lang(fields[k]) if k == "language" else fields[k]
    if "content" in fields and fields["content"] is not None:
        s["schema"] = parse_schema(s.get("language"), s["content"])
        h = _hash(s["content"])
        if not s["versions"] or s["versions"][-1]["hash"] != h:
            s["versions"] = (s["versions"] + [{"hash": h, "content": s["content"], "at": time.time()}])[-20:]
    s["draft"] = None
    filestore.put(SECTION, sid, s)
    return True


def delete(sid: str) -> bool:
    return filestore.delete(SECTION, sid)


def get(sid_or_path: str) -> dict | None:
    items = filestore.items(SECTION)
    if sid_or_path in items:
        return {"id": sid_or_path, **items[sid_or_path]}
    for sid, s in items.items():
        if s.get("path") == sid_or_path:
            return {"id": sid, **s}
    return BUILTINS.get(sid_or_path)


def list_scripts(user_id=None, project_ids=None, include_builtins: bool = True) -> list[dict]:
    out = []
    for sid, s in filestore.items(SECTION).items():
        if s.get("archived"):
            continue
        if user_id is None or s.get("owner_id") == user_id or s.get("project_id") in (project_ids or []) \
                or s.get("scope") == "partage":
            out.append({"id": sid, **{k: s.get(k) for k in
                        ("path", "summary", "description", "language", "kind", "schema", "scope", "project_id")},
                        "hash": (s.get("versions") or [{}])[-1].get("hash"), "draft": bool(s.get("draft"))})
    if include_builtins:
        out += [{"id": p, **{k: b.get(k) for k in ("path", "summary", "description", "language", "kind", "schema")},
                 "builtin": True} for p, b in BUILTINS.items()]
    return out


# ───────────────────────── Builtins hub/elytras (actions toutes faites) ─────────────────────────
# Exécutées EN-PROCESS par le moteur (réseau nécessaire) — gardées par caps + anti-SSRF.
BUILTINS = {
    "hub/elytras/http_request": {
        "path": "hub/elytras/http_request", "summary": "Requête HTTP",
        "description": "Appelle une URL (GET/POST/PUT/PATCH/DELETE) et renvoie status/json/texte. Anti-SSRF.",
        "language": "python3", "kind": "action", "builtin": "http",
        "schema": {"type": "object", "properties": {
            "url": {"type": "string"}, "method": {"type": "string", "default": "GET",
                                                  "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"]},
            "headers": {"type": "object", "default": {}}, "body": {"type": "string", "default": ""},
            "timeout_s": {"type": "number", "default": 15}}, "required": ["url"]}},
    "hub/elytras/send_email": {
        "path": "hub/elytras/send_email", "summary": "Envoyer un email",
        "description": "Envoie un email via le SMTP configuré (SMTP_HOST/USER/PASS/FROM).",
        "language": "python3", "kind": "action", "builtin": "email",
        "schema": {"type": "object", "properties": {
            "to": {"type": "string"}, "cc": {"type": "string", "default": ""},
            "subject": {"type": "string"}, "body": {"type": "string"},
            "html": {"type": "boolean", "default": False}}, "required": ["to", "subject"]}},
    "hub/elytras/sql_query": {
        "path": "hub/elytras/sql_query", "summary": "Requête SQL (Postgres)",
        "description": "Requête paramétrée sur Postgres ; SELECT → lignes (max 1000).",
        "language": "postgresql", "kind": "action", "builtin": "sql",
        "schema": {"type": "object", "properties": {
            "query": {"type": "string"}, "params": {"type": "object", "default": {}},
            "connection_url": {"type": "string", "default": ""}}, "required": ["query"]}},
    "hub/elytras/poll_dedup": {
        "path": "hub/elytras/poll_dedup", "summary": "Trigger : poll + dédup",
        "description": "Exécute du code qui renvoie une liste ; ne laisse passer que les items jamais vus "
                       "(état persistant par flow+étape). Liste vide → arrêt propre du flow (skip).",
        "language": "python3", "kind": "trigger", "builtin": "poll_dedup",
        "schema": {"type": "object", "properties": {
            "code": {"type": "string"}, "language": {"type": "string", "default": "python3"},
            "key": {"type": "string", "default": ""}}, "required": ["code"]}},
}
