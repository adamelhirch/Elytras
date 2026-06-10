"""Importe le catalogue du Hub Windmill (actions + triggers) dans elytras/data/windmill_hub/.

Usage : python3 tools/import_hub_catalog.py actions <fichier(s) réponse hub …>
        python3 tools/import_hub_catalog.py triggers <fichier(s) réponse hub …>
Les fichiers sources sont des réponses brutes de https://hub.windmill.dev/scripts/top
(éventuellement tronquées ou enveloppées en « tool result » JSON) ; fusion + dédup par ask_id.
"""
import collections
import json
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(HERE, "elytras", "data", "windmill_hub")


def load(path):
    """Réponse hub (tronquée ou enveloppée) → liste d'asks."""
    raw = open(path, encoding="utf-8").read()
    if raw.lstrip().startswith("["):                # enveloppe « tool result » JSON
        try:
            raw = json.loads(raw)[0]["text"]
        except Exception:
            pass
    start = raw.find('{"asks"')
    if start < 0:
        raise SystemExit(f"pas de JSON 'asks' dans {path}")
    raw = raw[start:]
    try:
        return json.loads(raw)["asks"]
    except json.JSONDecodeError:                    # tronqué : coupe au dernier objet complet
        end = raw.rfind('},{')
        return json.loads(raw[:end + 1] + "]}")["asks"]


def merge(paths):
    by_id = {}
    for p in paths:
        for a in load(p):
            by_id[a["ask_id"]] = a
    return list(by_id.values())


def write(name, asks):
    os.makedirs(DEST, exist_ok=True)
    slim = sorted(
        [{"ask_id": a["ask_id"], "app": a["app"], "summary": a["summary"],
          "description": (a.get("description") or "")[:280], "kind": a["kind"]} for a in asks],
        key=lambda x: (x["app"], x["summary"] or ""))
    with open(os.path.join(DEST, name), "w", encoding="utf-8") as f:
        json.dump({"source": "https://hub.windmill.dev/scripts/top", "count": len(slim),
                   "scripts": slim}, f, ensure_ascii=False, indent=1)
    apps = collections.Counter(a["app"] for a in asks)
    print(f"{name}: {len(slim)} scripts, {len(apps)} apps")
    print("apps:", ",".join(sorted(apps)))


if __name__ == "__main__":
    write(sys.argv[1] + ".json", merge(sys.argv[2:]))
