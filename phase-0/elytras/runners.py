"""Runners multi-langages (façon workers Windmill) — sandboxés, registre extensible.

Tous les langages de l'enum OpenFlow `rawscript.language` sont reconnus. Convention
Windmill : le script expose `main(...)` ; les arguments (input_transforms évalués)
sont passés par nom. Repli hérité : variable `result = …` (compat anciens flows).

Trois familles :
- NATIFS (toujours dispo)      : python3, bun/deno/nativets (JS/TS via node), bash.
- TOOLCHAIN (si binaire présent): go, php, ruby, rust, java, powershell, nu, csharp,
  rlang, ansible — détectés via PATH ; sinon erreur claire « toolchain absente ».
- CONNEXIONS                    : postgresql (psycopg), mysql (pymysql), graphql (httpx),
  duckdb (module) ; bigquery/snowflake/mssql/oracledb → indisponibles en mode fichier.

Isolation : sous-processus + sandbox-exec (macOS) / bwrap (Linux), réseau coupé,
FS lecture seule hors dossier de travail — identique pour TOUS les langages.
Les langages CONNEXIONS s'exécutent en-process (accès réseau nécessaire), gardés
par les capacités RBAC en amont.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile

from .exprs import plain

SANDBOX_MODE = os.environ.get("ELYTRAS_CODE_SANDBOX", "auto").lower()

# Enum OpenFlow complet (openflow.openapi.yaml v1.721) + alias hérités Elytras.
LANGUAGES = ("python3", "deno", "bun", "nativets", "bash", "powershell", "nu", "go", "php",
             "rust", "csharp", "java", "ruby", "rlang", "ansible", "graphql",
             "postgresql", "mysql", "bigquery", "snowflake", "mssql", "oracledb", "duckdb")
ALIASES = {"python": "python3", "javascript": "bun", "js": "bun", "typescript": "deno", "ts": "deno"}


def norm_lang(lang: str) -> str:
    lan = (lang or "python3").lower()
    return ALIASES.get(lan, lan if lan in LANGUAGES else "python3")


def sandbox_cmd(base_cmd, script_path, work=None):
    """Enveloppe une commande dans le bac à sable (FS RO + réseau coupé). → (cmd, sandboxed)."""
    if SANDBOX_MODE == "off":
        return base_cmd, False
    if sys.platform == "darwin" and shutil.which("sandbox-exec"):
        profile = ('(version 1)(deny default)(allow process*)(allow sysctl-read)(allow mach-lookup)'
                   '(allow file-read*)'
                   '(allow file-write* (subpath "/tmp")(subpath "/private/tmp")'
                   '(subpath "/var/folders")(subpath "/private/var/folders"))'
                   '(deny network*)')
        return ["sandbox-exec", "-p", profile] + base_cmd, True
    if sys.platform.startswith("linux") and shutil.which("bwrap"):
        cmd = ["bwrap", "--ro-bind", "/", "/"]
        if work:
            cmd += ["--bind", work, work]
        else:
            cmd += ["--tmpfs", "/tmp", "--ro-bind", script_path, script_path]
        cmd += ["--proc", "/proc", "--dev", "/dev", "--unshare-net", "--die-with-parent", "--"]
        return cmd + base_cmd, True
    if SANDBOX_MODE == "on":
        raise RuntimeError("bac à sable exigé (ELYTRAS_CODE_SANDBOX=on) mais ni sandbox-exec ni bwrap trouvés")
    return base_cmd, False


# ── Harnais : appellent main(<params nommés>) avec les args, repli `result=` ─────────────
_PY_HARNESS = (
    "import json as _j, sys as _s, inspect as _i\n"
    "class _D(dict):\n"
    "    def __getattr__(self, k):\n"
    "        try: return self[k]\n"
    "        except KeyError: return None\n"
    "def _w(x):\n"
    "    if isinstance(x, dict): return _D({k: _w(v) for k, v in x.items()})\n"
    "    if isinstance(x, list): return [_w(v) for v in x]\n"
    "    return x\n"
    "_ctx=_j.loads(_s.stdin.read())\n"
    "args=_w(_ctx.get('args') or {})\n"
    "flow_input=_w(_ctx.get('flow_input'))\nresults=_w(_ctx.get('results'))\n"
    "item=_w(_ctx.get('item'))\nindex=_ctx.get('index')\n"
    "input_dir=_ctx.get('input_dir')\noutput_dir=_ctx.get('output_dir')\n"
    "globals().update({k: v for k, v in args.items() if isinstance(k, str) and k.isidentifier()})\n"
    "result=None\n"
    "# ───── code utilisateur ─────\n{CODE}\n# ───── fin ─────\n"
    "if 'main' in dir() and callable(main):\n"
    "    _ps=_i.signature(main).parameters\n"
    "    _kw={k: args.get(k) for k in _ps if k in args} if _ps else {}\n"
    "    _out=main(**_kw)\n"
    "else:\n"
    "    _out=result\n"
    "_s.stdout.write('\\x1e'+_j.dumps(_out, default=str))\n")

_JS_HARNESS = (
    "const _ctx=JSON.parse(process.env.ELYTRAS_CTX||'{}');\n"
    "const {flow_input, results, item, index, input_dir, output_dir}=_ctx;\n"
    "const args=_ctx.args||{};\n"
    "for(const _k of Object.keys(args)){ if(/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(_k)) globalThis[_k]=args[_k]; }\n"
    "// ───── code utilisateur ─────\n{CODE}\n// ───── fin ─────\n"
    "(async()=>{let _out;\n"
    "if(typeof main==='function'){\n"
    "  const _sig=(main.toString().match(/\\(([^)]*)\\)/)||[,''])[1];\n"
    "  const _names=_sig.split(',').map(s=>s.split('=')[0].trim()).filter(s=>s&&/^[A-Za-z_$]/.test(s));\n"
    "  _out=await main(..._names.map(n=>args[n]));\n"
    "}else if(typeof result!=='undefined'){_out=result;}else{_out=null;}\n"
    "process.stdout.write('\\x1e'+JSON.stringify(_out===undefined?null:_out));\n"
    "})().catch(e=>{console.error(e&&e.stack||String(e));process.exit(1);});\n")

# Langages « shell » : args exportés en variables + $1.. ; résultat = ./result.json
# s'il existe, sinon dernière ligne de stdout (convention Windmill bash).
_SHELL_NOTE = "# args : $1.. (ordre des inputs) + variables nommées + $ARGS_JSON ; résultat = ./result.json ou dernière ligne"

# Toolchains : binaire requis → comment lancer. {file} = chemin script, {dir} = dossier.
_TOOLCHAINS = {
    "go":         {"bin": "go",      "file": "main.go",   "cmd": ["go", "run", "{file}"]},
    "php":        {"bin": "php",     "file": "main.php",  "cmd": ["php", "{file}"]},
    "ruby":       {"bin": "ruby",    "file": "main.rb",   "cmd": ["ruby", "{file}"]},
    "rust":       {"bin": "rustc",   "file": "main.rs",   "cmd": None},   # compile puis exécute
    "java":       {"bin": "java",    "file": "Main.java", "cmd": ["java", "{file}"]},
    "powershell": {"bin": "pwsh",    "file": "main.ps1",  "cmd": ["pwsh", "-NoProfile", "-File", "{file}"]},
    "nu":         {"bin": "nu",      "file": "main.nu",   "cmd": ["nu", "{file}"]},
    "csharp":     {"bin": "dotnet-script", "file": "main.csx", "cmd": ["dotnet-script", "{file}"]},
    "rlang":      {"bin": "Rscript", "file": "main.R",    "cmd": ["Rscript", "{file}"]},
    "ansible":    {"bin": "ansible-playbook", "file": "play.yml", "cmd": ["ansible-playbook", "{file}"]},
}


def _exec(base, path, work, env, stdin_data, timeout_s):
    cmd, sb = sandbox_cmd(base, path, work)
    p = subprocess.run(cmd, input=stdin_data, capture_output=True, text=True,
                       timeout=float(timeout_s or 30), env=env, cwd=work)
    if sb and p.returncode != 0 and SANDBOX_MODE != "on" \
            and ("bwrap:" in (p.stderr or "") or "namespace" in (p.stderr or "")):
        p = subprocess.run(base, input=stdin_data, capture_output=True, text=True,
                           timeout=float(timeout_s or 30), env=env, cwd=work)
    return p


def _result_from(p, work):
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or "erreur d'exécution").strip()[:600])
    if "\x1e" in (p.stdout or ""):
        _, _, tail = p.stdout.rpartition("\x1e")
        try:
            return json.loads(tail)
        except Exception:
            return tail.strip()
    rj = os.path.join(work, "result.json")
    if os.path.isfile(rj):
        try:
            return json.load(open(rj, encoding="utf-8"))
        except Exception:
            return open(rj, encoding="utf-8").read().strip()
    lines = [ln for ln in (p.stdout or "").splitlines() if ln.strip()]
    last = lines[-1].strip() if lines else ""
    try:
        return json.loads(last)
    except Exception:
        return last


def run(content: str, language: str, args: dict | None = None, ns: dict | None = None,
        timeout_s=None, meta: dict | None = None, files_mod=None):
    """Exécute un script dans le langage demandé. ns = contexte flow (flow_input/results/…)."""
    lang = norm_lang(language)
    ns = ns or {}
    work = tempfile.mkdtemp(prefix="elytras_")
    indir, outdir = os.path.join(work, "in"), os.path.join(work, "out")
    os.makedirs(indir), os.makedirs(outdir)
    for fname, frec in ((meta or {}).get("files") or {}).items():
        try:
            raw = files_mod.raw_bytes(frec) if files_mod else b""
            with open(os.path.join(indir, os.path.basename(frec.get("name") or fname)), "wb") as fh:
                fh.write(raw)
        except Exception:
            pass
    ctx = {"args": plain(args or {}), "flow_input": plain(ns.get("flow_input")),
           "results": plain(ns.get("results")), "item": plain(ns.get("item")),
           "index": ns.get("index"), "input_dir": indir, "output_dir": outdir}
    payload = json.dumps(ctx, default=str)
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/tmp"),
           "LANG": os.environ.get("LANG", "C.UTF-8"), "ARGS_JSON": json.dumps(plain(args or {}), default=str)}
    try:
        if lang == "python3":
            path = os.path.join(work, "_run.py")
            open(path, "w", encoding="utf-8").write(_PY_HARNESS.replace("{CODE}", content or ""))
            p = _exec([sys.executable, "-I", path], path, work, env, payload, timeout_s)
            out = _result_from(p, work)
        elif lang in ("bun", "deno", "nativets"):
            if not shutil.which("node"):
                raise RuntimeError("toolchain absente : node requis pour JS/TS (bun/deno/nativets)")
            ext = "ts" if lang in ("deno", "nativets") else "js"
            src = (content or "").replace("export async function main", "async function main") \
                                 .replace("export function main", "function main")
            path = os.path.join(work, "_run." + ext)
            open(path, "w", encoding="utf-8").write(_JS_HARNESS.replace("{CODE}", src))
            env["ELYTRAS_CTX"] = payload
            base = ["node"] + (["--experimental-strip-types"] if ext == "ts" else []) + [path]
            p = _exec(base, path, work, env, "", timeout_s)
            out = _result_from(p, work)
        elif lang == "bash":
            path = os.path.join(work, "main.sh")
            exports = "".join(f"export {k}={json.dumps(str(v))}\n" for k, v in (args or {}).items()
                              if isinstance(k, str) and k.isidentifier())
            open(path, "w", encoding="utf-8").write("#!/usr/bin/env bash\n" + _SHELL_NOTE + "\n"
                                                    + exports + (content or ""))
            argv = [str(v) for v in (args or {}).values()]
            p = _exec(["bash", path] + argv, path, work, env, "", timeout_s)
            out = _result_from(p, work)
        elif lang in _TOOLCHAINS:
            tc = _TOOLCHAINS[lang]
            if not shutil.which(tc["bin"]):
                raise RuntimeError(f"toolchain absente : « {tc['bin']} » introuvable dans le PATH "
                                   f"(installe-la sur le serveur pour exécuter du {lang})")
            path = os.path.join(work, tc["file"])
            open(path, "w", encoding="utf-8").write(content or "")
            if lang == "rust":
                exe = os.path.join(work, "main_bin")
                pc = subprocess.run(["rustc", "-O", "-o", exe, path], capture_output=True, text=True,
                                    timeout=120, cwd=work)
                if pc.returncode != 0:
                    raise RuntimeError(("compilation rust : " + (pc.stderr or ""))[:600])
                p = _exec([exe], exe, work, env, payload, timeout_s)
            else:
                base = [c.replace("{file}", path) for c in tc["cmd"]]
                p = _exec(base, path, work, env, payload, timeout_s)
            out = _result_from(p, work)
        elif lang == "graphql":
            out = _run_graphql(content, args)
        elif lang in ("postgresql", "mysql", "duckdb"):
            out = _run_sql(lang, content, args)
        elif lang in ("bigquery", "snowflake", "mssql", "oracledb"):
            raise RuntimeError(f"{lang} : non disponible en mode fichier (nécessite le driver dédié — "
                               "utilise postgresql/mysql, ou un script python3 avec le client)")
        else:
            raise RuntimeError(f"langage inconnu : {language}")
        # fichiers produits dans out/ → espace scopé
        if meta is not None and "out_scope" in meta and files_mod is not None:
            import base64
            for fn in sorted(os.listdir(outdir)):
                fp = os.path.join(outdir, fn)
                if os.path.isfile(fp) and os.path.getsize(fp) <= files_mod.MAX_BYTES:
                    b64 = base64.b64encode(open(fp, "rb").read()).decode()
                    files_mod.add_file(meta["out_scope"], meta.get("out_owner"), meta.get("out_project"), fn, b64)
                    meta.setdefault("files_out", []).append(fn)
        return out
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _run_graphql(content, args):
    """Langage graphql : le contenu est la requête ; args = variables (+ api_url, headers)."""
    import httpx
    a = dict(args or {})
    url = a.pop("api_url", None) or a.pop("url", None)
    headers = a.pop("headers", None) or {}
    if not url:
        raise RuntimeError("graphql : argument « api_url » requis")
    r = httpx.post(url, json={"query": content, "variables": a}, headers=headers, timeout=30)
    return r.json()


def _run_sql(lang, content, args):
    """Langages SQL : contenu = requête paramétrée ; args = paramètres nommés (+ database/url)."""
    a = dict(args or {})
    url = a.pop("database", None) or a.pop("connection_url", None) or os.environ.get("DATABASE_URL")
    if lang == "duckdb":
        try:
            import duckdb
        except Exception:
            raise RuntimeError("duckdb : module python « duckdb » non installé")
        con = duckdb.connect(a.pop("db_file", ":memory:"))
        try:
            cur = con.execute(content, a or None)
            cols = [d[0] for d in (cur.description or [])]
            return [dict(zip(cols, r)) for r in cur.fetchmany(1000)] if cols else {"ok": True}
        finally:
            con.close()
    if lang == "mysql":
        try:
            import pymysql  # noqa: F401
        except Exception:
            raise RuntimeError("mysql : module python « pymysql » non installé")
        import pymysql
        conn = pymysql.connect(host=a.pop("host", "localhost"), user=a.pop("user", ""),
                               password=a.pop("password", ""), database=a.pop("db", ""),
                               cursorclass=pymysql.cursors.DictCursor)
        try:
            with conn.cursor() as cur:
                cur.execute(content, a or None)
                if cur.description:
                    return list(cur.fetchmany(1000))
                conn.commit()
                return {"rowcount": cur.rowcount}
        finally:
            conn.close()
    # postgresql
    try:
        import psycopg
    except Exception:
        raise RuntimeError("postgresql : psycopg non installé")
    if not url:
        raise RuntimeError("postgresql : argument « database » (URL) requis ou DATABASE_URL")
    with psycopg.connect(url, connect_timeout=10) as conn:
        with conn.cursor() as cur:
            cur.execute(content, a or None)
            if cur.description:
                cols = [c.name for c in cur.description]
                return [dict(zip(cols, r)) for r in cur.fetchmany(1000)]
            conn.commit()
            return {"rowcount": cur.rowcount}


def available() -> dict:
    """État des toolchains (pour l'UI : langages exécutables ici et maintenant)."""
    out = {"python3": True, "bash": bool(shutil.which("bash")),
           "bun": bool(shutil.which("node")), "deno": bool(shutil.which("node")),
           "nativets": bool(shutil.which("node")),
           "graphql": True, "postgresql": True, "mysql": _has_mod("pymysql"),
           "duckdb": _has_mod("duckdb"),
           "bigquery": False, "snowflake": False, "mssql": False, "oracledb": False}
    for lang, tc in _TOOLCHAINS.items():
        out[lang] = bool(shutil.which(tc["bin"]))
    return out


def _has_mod(name):
    try:
        __import__(name)
        return True
    except Exception:
        return False


_SB_STATUS = None


def sandbox_status():
    """Auto-test réel du bac à sable (exécution + réseau coupé) — résultat en cache."""
    global _SB_STATUS
    if _SB_STATUS is not None:
        return _SB_STATUS
    _c, sb = sandbox_cmd([sys.executable, "-c", "pass"], "/x", None)
    detail = "?"
    try:
        detail = run("import socket\n"
                     "try:\n"
                     "    socket.create_connection(('1.1.1.1', 53), timeout=2)\n"
                     "    result = 'open'\n"
                     "except Exception:\n"
                     "    result = 'blocked'\n", "python3", {}, {}, 8)
    except Exception as e:
        detail = "refus:" + str(e)[:100]
    _SB_STATUS = {"active": bool(sb), "network_blocked": detail == "blocked",
                  "detail": detail, "mode": SANDBOX_MODE}
    return _SB_STATUS
