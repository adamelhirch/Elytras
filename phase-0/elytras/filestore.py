"""Petit stockage fichier (JSON) pour fonctionner SANS base de données.

Utilisé en repli quand Postgres n'est pas là (mode local sans Docker) : persiste
les tokens providers, les serveurs MCP enregistrés et les tokens OAuth MCP, pour
qu'ils survivent à un redémarrage. Les secrets y sont déjà chiffrés (base64 de Fernet).
"""
from __future__ import annotations

import json
import os
import pathlib
import threading

_PATH = pathlib.Path(os.environ.get("ELYTRAS_STATE_FILE", ".elytras-state.json"))
# Verrou réentrant : les écritures sont des lecture-modification-écriture, donc
# non sûres entre threads (exécution parallèle des flows). On sérialise les accès.
_LOCK = threading.RLock()


def _load() -> dict:
    try:
        return json.loads(_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save(d: dict):
    try:
        _PATH.write_text(json.dumps(d, ensure_ascii=False, indent=0), encoding="utf-8")
    except Exception:
        pass


def get(section: str, key: str, default=None):
    with _LOCK:
        return _load().get(section, {}).get(key, default)


def put(section: str, key: str, value):
    with _LOCK:
        d = _load()
        d.setdefault(section, {})[key] = value
        _save(d)


def items(section: str) -> dict:
    with _LOCK:
        return _load().get(section, {})


def delete(section: str, key: str) -> bool:
    with _LOCK:
        d = _load()
        if section in d and key in d[section]:
            del d[section][key]
            _save(d)
            return True
        return False


def clear(section: str):
    with _LOCK:
        d = _load()
        d[section] = {}
        _save(d)
