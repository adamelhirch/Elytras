#!/bin/bash
# Elytras — Phase 0 — démarrage LOCAL (sans Docker). Double-clique ce fichier.
cd "$(dirname "$0")" || exit 1
echo "=== Elytras — Phase 0 — démarrage local (sans Docker) ==="
PY="$(command -v python3 || command -v python)"
if [ -z "$PY" ]; then echo "Python 3 introuvable. Installe Python puis relance."; read -r -p "Entrée pour fermer…" _; exit 1; fi

[ -d .venv ] || { echo "→ création de l'environnement Python…"; "$PY" -m venv .venv; }
source .venv/bin/activate
echo "→ installation des dépendances (1re fois : ~1 min)…"
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r requirements.txt

[ -f .env ] || cp .env.example .env
export EXAMPLE_MCP_URL="${EXAMPLE_MCP_URL:-http://127.0.0.1:9001}"
export SKILLS_DIR="$PWD/skills"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://localhost:8000}"
# Clé de chiffrement : si non fournie, le cœur en génère une forte et la persiste (.elytras-key).
export WATCHFILES_FORCE_POLLING=true
# (sans Postgres : mémoire en mode fichier ; tout le reste fonctionne)

# libère les ports si une ancienne instance tourne (redémarrage propre)
lsof -ti tcp:8000 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null
lsof -ti tcp:9001 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null
sleep 1

echo "→ serveur MCP d'exemple (port 9001)…"
( cd example-mcp && python -m uvicorn server:app --host 127.0.0.1 --port 9001 >/tmp/elytras-mcp.log 2>&1 ) &
MCP_PID=$!
trap 'kill $MCP_PID 2>/dev/null' EXIT

( sleep 5; open "http://localhost:8000" ) &
echo "→ interface : http://localhost:8000   (Ctrl+C ou ferme la fenêtre pour arrêter)"
# Sécurité : on N'ÉCOUTE QUE en local (127.0.0.1). ELYTRAS_DEV=1 active le rechargement à chaud.
if [ "$ELYTRAS_DEV" = "1" ]; then
  python -m uvicorn elytras.main:app --host 127.0.0.1 --port 8000 --reload --reload-dir elytras
else
  python -m uvicorn elytras.main:app --host 127.0.0.1 --port 8000
fi
