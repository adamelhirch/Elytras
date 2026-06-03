#!/bin/bash
# Elytras — Phase 0. Double-clique ce fichier (macOS) pour tout lancer.
cd "$(dirname "$0")" || exit 1

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker n'est pas installé / lancé. Ouvre Docker Desktop puis relance."
  read -r -p "Entrée pour fermer…" _ ; exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  # génère une clé de chiffrement aléatoire
  KEY=$(python3 -c "import secrets;print(secrets.token_urlsafe(32))" 2>/dev/null)
  [ -n "$KEY" ] && sed -i '' "s/^APP_ENCRYPTION_KEY=.*/APP_ENCRYPTION_KEY=$KEY/" .env 2>/dev/null
  echo "→ .env créé."
fi

echo "→ Démarrage d'Elytras…  (interface : http://localhost:8000)"
exec docker compose up --build
