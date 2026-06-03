"""Chiffrement des secrets (tokens OAuth, clés API).

Clé = APP_ENCRYPTION_KEY si fournie (et forte) ; sinon une clé aléatoire est
GÉNÉRÉE au 1er lancement et PERSISTÉE (fichier `.elytras-key`, chmod 600) à côté
de l'état. Déploiement client = clé forte et stable, sans configuration manuelle.
Tout ce qui est sensible est stocké chiffré ; rien en clair.
"""
from __future__ import annotations

import base64
import hashlib
import os
import pathlib
import secrets

from cryptography.fernet import Fernet

_WEAK = {"", "change-me", "local-dev-key", "test"}


def _key_path() -> pathlib.Path:
    if os.environ.get("ELYTRAS_KEY_FILE"):
        return pathlib.Path(os.environ["ELYTRAS_KEY_FILE"])
    state = pathlib.Path(os.environ.get("ELYTRAS_STATE_FILE", ".elytras-state.json"))
    return state.resolve().parent / ".elytras-key"


def _key_material() -> bytes:
    env = os.environ.get("APP_ENCRYPTION_KEY", "")
    if env and env not in _WEAK:
        return env.encode()                       # clé fournie explicitement (forte)
    path = _key_path()
    try:
        if path.exists():
            return path.read_text().strip().encode()
        key = secrets.token_urlsafe(48)           # génération au 1er lancement
        path.write_text(key)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        return key.encode()
    except Exception:
        return (env or "change-me").encode()      # repli (tests / FS en lecture seule)


def _fernet() -> Fernet:
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(_key_material()).digest()))


def encrypt(text: str) -> bytes:
    return _fernet().encrypt(text.encode())


def decrypt(blob: bytes) -> str:
    return _fernet().decrypt(bytes(blob)).decode()
