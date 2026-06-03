#!/usr/bin/env python3
"""Mode PROD : crée le client sur la passerelle et injecte sa clé de service dans .env.

Appelé par install.sh quand ELYTRAS_PROVIDER=elytras-gateway et ELYTRAS_GATEWAY_KEY vide.
La passerelle est jointe en local (127.0.0.1:8088, publié seulement sur la loopback).
"""
import json
import os
import pathlib
import time
import urllib.error
import urllib.request

DEPLOY = pathlib.Path(__file__).resolve().parent
ENV = DEPLOY / ".env"
BASE = os.environ.get("GATEWAY_LOCAL_URL", "http://127.0.0.1:8088")


def read_env() -> dict:
    d = {}
    for line in ENV.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            d[k] = v
    return d


def set_env(key: str, value: str) -> None:
    lines = ENV.read_text(encoding="utf-8").splitlines()
    out, seen = [], False
    for line in lines:
        if line.startswith(key + "="):
            out.append(f"{key}={value}")
            seen = True
        else:
            out.append(line)
    if not seen:
        out.append(f"{key}={value}")
    ENV.write_text("\n".join(out) + "\n", encoding="utf-8")


def _post(path: str, token: str, payload: dict) -> dict:
    req = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


def _wait_health(timeout: float = 60.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(BASE + "/health", timeout=5) as r:
                if r.status == 200:
                    return True
        except (urllib.error.URLError, OSError):
            time.sleep(2)
    return False


def main() -> int:
    e = read_env()
    if e.get("ELYTRAS_GATEWAY_KEY"):
        return 0                                   # déjà provisionné
    token = e.get("GATEWAY_ADMIN_TOKEN", "")
    if not token:
        print("GATEWAY_ADMIN_TOKEN manquant.")
        return 1
    if not _wait_health():
        print("Passerelle injoignable sur " + BASE)
        return 1
    body = {"name": e.get("GATEWAY_COMPANY") or e.get("ELYTRAS_COMPANY") or "Client"}
    cap = e.get("GATEWAY_CAP_USD")
    if cap:
        body["monthly_cap_usd"] = float(cap)
    res = _post("/admin/tenants", token, body)
    key = res.get("service_key")
    if not key:
        print("Réponse passerelle inattendue : " + json.dumps(res))
        return 1
    set_env("ELYTRAS_GATEWAY_KEY", key)
    print("Client créé et clé de service injectée dans .env.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
