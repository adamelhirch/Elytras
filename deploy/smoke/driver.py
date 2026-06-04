"""Parcours e2e : bootstrap admin, flow code, chat via passerelle, vérif metering."""
import json
import os

import httpx

E = os.environ.get("ELY_URL", "http://127.0.0.1:8000")
G = os.environ.get("GW_URL", "http://127.0.0.1:8088")
GAD = {"Authorization": "Bearer " + os.environ.get("GW_ADMIN", "adm-tok")}
TID = os.environ.get("GW_TID", "")
res = []


def chk(name, cond):
    res.append(bool(cond))
    print(("PASS" if cond else "FAIL"), "-", name)


try:
    tok = httpx.post(E + "/auth/setup", json={"name": "Leo", "email": "leo@vd.com", "password": "pw"},
                     timeout=20).json().get("token")
    H = {"X-Elytras-Token": tok}
    chk("setup admin + jeton de session", bool(tok))

    fid = httpx.post(E + "/flows", json={"name": "Demo"}, headers=H, timeout=20).json()["id"]
    httpx.patch(E + "/flows/" + fid,
                json={"modules": [{"id": "a", "summary": "calc", "type": "code", "content": "result=6*7"}]},
                headers=H, timeout=20)
    rr = httpx.post(E + "/flows/" + fid + "/run", json={}, headers=H, timeout=30).json()
    chk("flow (code Python) execute = 42", rr.get("results", {}).get("a") == 42)

    c = httpx.post(E + "/chat", json={"messages": [{"role": "user", "content": "bonjour"}]},
                   headers=H, timeout=60).json()
    chk("chat repond via la passerelle -> modele", "agent Elytras de test" in json.dumps(c, ensure_ascii=False))

    if TID:
        u = httpx.get(G + "/admin/usage", params={"tenant": TID}, headers=GAD, timeout=20).json()
        chk("metering passerelle (appels>=1, tokens>0)", u.get("calls", 0) >= 1 and u.get("ptok", 0) > 0)
        print("USAGE passerelle:", json.dumps(u, ensure_ascii=False))
except Exception as e:  # noqa: BLE001
    print("FAIL - exception:", repr(e))

print("RESULTAT:", "TOUT PASSE" if (res and all(res)) else "ECHEC PARTIEL")
