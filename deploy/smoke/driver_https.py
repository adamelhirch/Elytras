"""Parcours e2e DERRIÈRE un proxy TLS — prouve qu'Elytras marche en HTTPS (P0 prod).

Vérifie ce qui casse classiquement derrière un reverse proxy :
  - auth par jeton (header X-Elytras-Token) à travers le proxy ;
  - exécution de flow + chat via la passerelle ;
  - PUBLIC_BASE_URL respecté : les URLs générées (webhooks, approbations) sont en https.
"""
import json
import os

import httpx

E = os.environ.get("ELY_URL", "https://127.0.0.1:8443")
res = []


def chk(name, cond):
    res.append(bool(cond))
    print(("PASS" if cond else "FAIL"), "-", name)


try:
    c = httpx.Client(verify=False, timeout=60)   # cert auto-signé : normal pour le banc
    tok = c.post(E + "/auth/setup", json={"name": "Leo", "email": "leo@vd.com",
                                          "password": "pw"}).json().get("token")
    H = {"X-Elytras-Token": tok}
    chk("HTTPS : setup admin + jeton de session a travers le proxy", bool(tok))

    me = c.get(E + "/auth/me", headers=H).json()
    chk("HTTPS : session reconnue (auth par header, insensible au proxy)", me.get("name") == "Leo")

    fid = c.post(E + "/flows", json={"name": "Demo"}, headers=H).json()["id"]
    c.patch(E + "/flows/" + fid,
            json={"modules": [{"id": "a", "summary": "calc", "type": "code", "content": "result=6*7"}]},
            headers=H)
    rr = c.post(E + "/flows/" + fid + "/run", json={}, headers=H, timeout=30).json()
    chk("HTTPS : flow (code Python) execute = 42", rr.get("results", {}).get("a") == 42)

    wh = c.post(E + "/flows/" + fid + "/webhook-token", json={}, headers=H).json()
    chk("PUBLIC_BASE_URL : URL de webhook generee en https", str(wh.get("url", "")).startswith("https://"))
    hook = c.post(wh["url"], json={}, headers=H)   # le webhook fonctionne via le proxy TLS
    chk("HTTPS : webhook declenchable a travers le proxy", hook.status_code == 200)

    ch = c.post(E + "/chat", json={"messages": [{"role": "user", "content": "bonjour"}]},
                headers=H, timeout=60).json()
    chk("HTTPS : chat via passerelle -> modele", "agent Elytras de test" in json.dumps(ch, ensure_ascii=False))
except Exception as e:  # noqa: BLE001
    print("FAIL - exception:", repr(e))

print("RESULTAT:", "TOUT PASSE" if (res and all(res)) else "ECHEC PARTIEL")
raise SystemExit(0 if (res and all(res)) else 1)
