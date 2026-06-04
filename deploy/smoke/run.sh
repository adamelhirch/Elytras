#!/usr/bin/env bash
# Banc de test e2e SANS Docker : démarre faux modèle + passerelle + app, déroule le parcours,
# puis arrête tout. Prouve que le déploiement fonctionne de bout en bout, sans clé ni frais.
#   ./deploy/smoke/run.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ST="$(mktemp -d)"
echo "=== Banc e2e Elytras (sans Docker) ==="

cd "$HERE" && nohup python3 -m uvicorn fakemodel:app --host 127.0.0.1 --port 9099 >"$ST/fake.log" 2>&1 & FAKE=$!
cd "$ROOT/gateway" && OPENROUTER_URL=http://127.0.0.1:9099/v1/chat/completions OPENROUTER_API_KEY=x \
  GATEWAY_ADMIN_TOKEN=adm-tok GATEWAY_STATE_FILE="$ST/gw.json" GW_ECO_MODEL=fake/eco \
  PYTHONPATH=. nohup python3 -m uvicorn elytras_gateway.main:app --host 127.0.0.1 --port 8088 >"$ST/gw.log" 2>&1 & GW=$!

for _ in $(seq 1 24); do curl -sf http://127.0.0.1:8088/health >/dev/null 2>&1 \
  && curl -sf http://127.0.0.1:9099/health >/dev/null 2>&1 && break; sleep 0.5; done

KEY=$(curl -s -X POST http://127.0.0.1:8088/admin/tenants -H "Authorization: Bearer adm-tok" \
  -H "Content-Type: application/json" -d '{"name":"Client Test","monthly_cap_usd":50}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('service_key',''))")
TID=$(curl -s http://127.0.0.1:8088/admin/tenants -H "Authorization: Bearer adm-tok" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['tenants'][0]['id'] if d.get('tenants') else '')")

cd "$ROOT/phase-0" && APP_ENCRYPTION_KEY=cle-forte-de-test-2026 ELYTRAS_STATE_FILE="$ST/ely.json" \
  SKILLS_DIR="$PWD/skills" ELYTRAS_TELEGRAM=0 ELYTRAS_CODE_SANDBOX=off ELYTRAS_PROVIDER=elytras-gateway \
  ELYTRAS_GATEWAY_URL=http://127.0.0.1:8088 ELYTRAS_GATEWAY_KEY="$KEY" ELYTRAS_GATEWAY_TIER=eco \
  PYTHONPATH=. nohup python3 -m uvicorn elytras.main:app --host 127.0.0.1 --port 8000 >"$ST/ely.log" 2>&1 & ELY=$!

for _ in $(seq 1 40); do curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1 && break; sleep 0.5; done

GW_TID="$TID" python3 "$HERE/driver.py"
RC=$?
kill "$FAKE" "$GW" "$ELY" 2>/dev/null
echo "(arrêté ; logs dans $ST)"
exit $RC
