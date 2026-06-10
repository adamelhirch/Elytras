"""Primitives d'évaluation partagées (flows, scripts, triggers).

- `_Dot`/`wrap`/`plain` : namespaces accessibles par points (results.etape.champ).
- `eval_expr` : évaluation d'expressions restreintes (les `input_transforms` javascript
  d'OpenFlow sont évaluées ici — syntaxe Python-compatible ; les idiomes JS courants
  sont traduits : `&&`/`||`/`!`, `===`, `true/false/null`, template `${}`).
- `render` : interpolation `{{ expr }}` (compat héritée + transforms static).
- `with_retry` : politique de retry OpenFlow complète (constant / exponential
  + random_factor + retry_if).
- Signaux de contrôle : StopFlow (early stop), Suspend (approbation).
"""
from __future__ import annotations

import json
import random
import re
import threading
import time

SAFE_BUILTINS = {"len": len, "range": range, "str": str, "int": int, "float": float, "bool": bool,
                 "min": min, "max": max, "sum": sum, "sorted": sorted, "abs": abs, "round": round,
                 "any": any, "all": all, "list": list, "dict": dict, "set": set, "tuple": tuple,
                 "enumerate": enumerate, "zip": zip, "map": map, "filter": filter, "reversed": reversed,
                 "True": True, "False": False, "None": None,
                 "true": True, "false": False, "null": None, "undefined": None}


class Dot(dict):
    """Dict accessible aussi par attribut (results.maStep, item.nom…) ; clé absente → ''."""
    def __getattr__(self, k):
        try:
            return self[k]
        except KeyError:
            return ""

    def __setattr__(self, k, v):
        self[k] = v


def wrap(x):
    if isinstance(x, dict):
        return Dot({k: wrap(v) for k, v in x.items()})
    if isinstance(x, list):
        return [wrap(v) for v in x]
    return x


def plain(x):
    try:
        return json.loads(json.dumps(x, default=str)) if x is not None else None
    except Exception:
        return str(x)


def short(v, n: int = 2000):
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str)
    return s[:n]


_JS_SUBS = ((re.compile(r"&&"), " and "), (re.compile(r"\|\|"), " or "),
            (re.compile(r"!=="), "!="), (re.compile(r"==="), "=="),
            (re.compile(r"!(?![=])"), " not "))


def _js_to_py(expr: str) -> str:
    """Traduit les idiomes JavaScript courants des transforms OpenFlow vers Python."""
    out, i, in_str, q = [], 0, False, ""
    # protège les chaînes pendant la traduction
    parts, buf = [], []
    for ch in expr:
        if in_str:
            buf.append(ch)
            if ch == q:
                in_str = False
                parts.append(("s", "".join(buf)))
                buf = []
        else:
            if ch in "\"'`":
                if buf:
                    parts.append(("c", "".join(buf)))
                buf = [ch]
                in_str, q = True, ch
            else:
                buf.append(ch)
    if buf:
        parts.append(("s" if in_str else "c", "".join(buf)))
    res = []
    for kind, seg in parts:
        if kind == "c":
            for rx, rep in _JS_SUBS:
                seg = rx.sub(rep, seg)
        else:
            if seg.startswith("`"):                      # template literal → f-string-ish
                inner = seg[1:-1] if seg.endswith("`") else seg[1:]
                seg = json.dumps(inner)                  # littéral sûr ; ${} géré par render()
        res.append(seg)
    return "".join(res)


def eval_expr(expr, ns):
    """Évalue une expression restreinte sur un namespace (sans builtins dangereux)."""
    if expr is None or str(expr).strip() == "":
        return None
    expr = str(expr)
    try:
        return eval(expr, {"__builtins__": {}}, {**SAFE_BUILTINS, **ns})  # noqa: S307
    except Exception:
        try:
            return eval(_js_to_py(expr), {"__builtins__": {}}, {**SAFE_BUILTINS, **ns})  # noqa: S307
        except Exception as e:
            raise ValueError(f"expression invalide « {expr} » : {e}")


def render(tpl, ns):
    """Interpole {{ expr }} et ${ expr } dans une chaîne."""
    if not isinstance(tpl, str):
        return tpl

    def sub(mm):
        expr = (mm.group(1) or mm.group(2) or "").strip()
        try:
            v = eval_expr(expr, ns)
        except Exception:
            cur = ns
            for p in expr.split("."):
                cur = cur.get(p, "") if isinstance(cur, dict) else getattr(cur, p, "")
            v = cur
        if v is None:
            return ""
        return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str) \
            if isinstance(v, (dict, list)) else str(v)
    return re.sub(r"\{\{\s*([^}]+?)\s*\}\}|\$\{\s*([^}]+?)\s*\}", sub, tpl)


def eval_transform(t, ns):
    """Évalue un InputTransform OpenFlow : {type:'static',value} | {type:'javascript',expr}.
    Compat : une valeur nue (str/num/dict) est traitée comme static ; les chaînes static
    contenant {{ }} ou ${ } sont interpolées (templating)."""
    if isinstance(t, dict) and t.get("type") == "javascript":
        return eval_expr(t.get("expr", ""), ns)
    if isinstance(t, dict) and t.get("type") == "ai":
        return None                                     # résolu par l'agent appelant (AiTransform)
    v = t.get("value") if isinstance(t, dict) and "value" in t and t.get("type") == "static" else t
    if isinstance(v, str):
        return render(v, ns)
    if isinstance(v, dict):
        return {k: (render(x, ns) if isinstance(x, str) else x) for k, x in v.items()}
    return v


def eval_transforms(transforms: dict, ns) -> dict:
    return {k: eval_transform(t, ns) for k, t in (transforms or {}).items()}


class StopFlow(Exception):
    def __init__(self, value, error: str | None = None, skipped: bool = False):
        self.value, self.error, self.skipped = value, error, skipped


class Suspend(Exception):
    def __init__(self, payload):
        self.payload = payload


def with_timeout(fn, timeout_s):
    t = float(timeout_s or 0)
    if t <= 0:
        return fn()
    box = {}

    def run():
        try:
            box["r"] = fn()
        except Exception as e:  # noqa: BLE001
            box["e"] = e
    th = threading.Thread(target=run, daemon=True)
    th.start()
    th.join(t)
    if th.is_alive():
        raise TimeoutError(f"délai dépassé ({t:g}s)")
    if "e" in box:
        raise box["e"]
    return box.get("r")


def with_retry(fn, retry, ns=None):
    """Retry OpenFlow : constant{attempts,seconds} | exponential{attempts,multiplier,seconds,
    random_factor%} (+ retry_if{expr} : ne retente que si l'expr est vraie, avec `error` en scope)."""
    retry = retry or {}
    const, expo = retry.get("constant") or {}, retry.get("exponential") or {}
    if const.get("attempts"):
        attempts, base, mult, rnd = int(const["attempts"]), float(const.get("seconds") or 0), 1.0, 0
    elif expo.get("attempts"):
        attempts = int(expo["attempts"])
        base, mult = float(expo.get("seconds") or 1), float(expo.get("multiplier") or 2)
        rnd = int(expo.get("random_factor") or 0)
    else:   # compat héritée {attempts, delay_s, mode}
        attempts = int(retry.get("attempts") or 0)
        base = float(retry.get("delay_s") or 0)
        mult = 2.0 if retry.get("mode") == "exponential" else 1.0
        rnd = 0
    retry_if = (retry.get("retry_if") or {}).get("expr")
    last = None
    for i in range(attempts + 1):
        try:
            return fn()
        except (StopFlow, Suspend):
            raise
        except Exception as e:  # noqa: BLE001
            last = e
            if i >= attempts:
                break
            if retry_if:
                try:
                    ok = bool(eval_expr(retry_if, {**(ns or {}), "error": wrap({"message": str(e)})}))
                except Exception:
                    ok = True
                if not ok:
                    break
            delay = base * (mult ** i)
            if rnd:
                delay *= 1 + random.uniform(-rnd / 100.0, rnd / 100.0)
            if delay > 0:
                time.sleep(min(delay, 60))
    raise last
