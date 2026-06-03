"""Persistance fichier thread-safe (JSON unique), même approche que le filestore d'Elytras.

Sections « dict » (clé -> objet) pour les clients, sections « list » (append) pour l'usage.
Le chemin est relu dynamiquement depuis config.STATE_FILE → les tests l'isolent facilement.
"""
import json
import pathlib
import threading

from . import config

_LOCK = threading.RLock()


def _path() -> pathlib.Path:
    return pathlib.Path(config.STATE_FILE)


def _load() -> dict:
    p = _path()
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _save(d: dict) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)


def get_dict(name: str) -> dict:
    with _LOCK:
        return _load().get(name, {}) or {}


def put_dict(name: str, key: str, value) -> None:
    with _LOCK:
        d = _load()
        d.setdefault(name, {})[key] = value
        _save(d)


def del_dict(name: str, key: str) -> bool:
    with _LOCK:
        d = _load()
        if name in d and key in d[name]:
            del d[name][key]
            _save(d)
            return True
        return False


def get_list(name: str) -> list:
    with _LOCK:
        return _load().get(name, []) or []


def append_list(name: str, value) -> None:
    with _LOCK:
        d = _load()
        d.setdefault(name, []).append(value)
        _save(d)
