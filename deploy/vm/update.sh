#!/usr/bin/env bash
# Mise à jour MANUELLE d'une VM (depuis ton Mac) : pull du dépôt public + rebuild.
#   ./update.sh [nom_vm]
set -euo pipefail
NAME="${1:-elytras-client1}"
command -v multipass >/dev/null 2>&1 || { echo "❌ Multipass requis."; exit 1; }
echo "→ Mise à jour de '$NAME' (git pull + rebuild)…"
multipass exec "$NAME" -- bash -lc '
  cd ~/elytras && git pull
  if [ -f deploy/.env ]; then cd deploy && docker compose up -d --build; else echo "(pas encore onboardée : lance ./install.sh dans la VM)"; fi
'
echo "✅ '$NAME' à jour."
