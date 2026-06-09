#!/usr/bin/env bash
# Banc e2e HTTPS (sans Docker) : même parcours que run.sh mais DERRIÈRE un proxy TLS
# (certificat auto-signé) — prouve le P0 « fonctionne derrière proxy HTTPS ».
#   ./deploy/smoke/run-https.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ST="$(mktemp -d)"
echo "=== Banc e2e Elytras DERRIÈRE TLS (sans Docker) ==="

# Certificat auto-signé éphémère (rôle de Let's Encrypt dans le banc).
openssl req -x509 -newkey rsa:2048 -keyout "$ST/key.pem" -out "$ST/cert.pem" \
  -days 2 -nodes -subj "/CN=127.0.0.1" >/dev/null 2>&1

cd "$HERE" && nohup python3 -m uvicorn fakemodel:app --host 127.0.0.1 --port 9099 >"$ST/fake.log" 2>&1 & FAKE=$!
cd "$ROOT/gateway" && OPENROUTER_URL=http://127.0.0.1:9099/v1/chat/completions OPENROUTER_API_KEY=x \
  GATEWAY_ADMIN_TOKEN=adm-tok GATEWAY_STATE_FILE="$ST/gw.json" GW_ECO_MODEL=fake/eco \
  PYTHONPATH=. nohup python3 -m uvicorn elytras_gateway.main:app --host 127.0.0.1 --port 8088 >"$ST/gw.log" 2>&1 & GW=$!

for _ in $(seq 1 24); do curl -sf http://127.0.0.1:8088/health >/dev/null 2>&1 \
  && curl -sf http://127.0.0.1:9099/health >/dev/null 2>&1 && break; sleep 0.5; done

KEY=$(curl -s -X POST http://127.0.0.1:8088/admin/tenants -H "Authorization: Bearer adm-tok" \
  -H "Content-Type: application/json" -d '{"name":"Client TLS","monthly_cap_usd":50}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('service_key',''))")

# L'app, configurée comme en PROD derrière un domaine : PUBLIC_BASE_URL = l'URL https publique.
cd "$ROOT/phase-0" && APP_ENCRYPTION_KEY=cle-forte-de-test-2026 ELYTRAS_STATE_FILE="$ST/ely.json" \
  SKILLS_DIR="$PWD/skills" ELYTRAS_TELEGRAM=0 ELYTRAS_CODE_SANDBOX=off ELYTRAS_PROVIDER=elytras-gateway \
  ELYTRAS_GATEWAY_URL=http://127.0.0.1:8088 ELYTRAS_GATEWAY_KEY="$KEY" ELYTRAS_GATEWAY_TIER=eco \
  PUBLIC_BASE_URL=https://127.0.0.1:8443 \
  PYTHONPATH=. nohup python3 -m uvicorn elytras.main:app --host 127.0.0.1 --port 8000 >"$ST/ely.log" 2>&1 & ELY=$!

for _ in $(seq 1 40); do curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1 && break; sleep 0.5; done

# Le proxy TLS (rôle de Caddy) : https://8443 -> http://8000, X-Forwarded-* posés.
cd "$HERE" && nohup python3 tlsproxy.py --listen 8443 --upstream 127.0.0.1:8000 \
  --cert "$ST/cert.pem" --key "$ST/key.pem" >"$ST/tls.log" 2>&1 & TLS=$!
for _ in $(seq 1 20); do curl -skf https://127.0.0.1:8443/health >/dev/null 2>&1 && break; sleep 0.5; done

python3 "$HERE/driver_https.py"
RC=$?
kill "$FAKE" "$GW" "$ELY" "$TLS" 2>/dev/null
echo "(arrêté ; logs dans $ST)"
exit $RC
