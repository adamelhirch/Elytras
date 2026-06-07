#!/usr/bin/env bash
# Tourne DANS la VM (via cron) : récupère les nouveaux commits du dépôt PUBLIC et rebuild
# l'application UNIQUEMENT s'il y a du nouveau. Aucun identifiant requis (lecture publique).
cd "$HOME/elytras" 2>/dev/null || exit 0
before="$(git rev-parse HEAD 2>/dev/null || echo none)"
git pull --quiet 2>/dev/null || exit 0
after="$(git rev-parse HEAD 2>/dev/null || echo none)"
if [ "$before" != "$after" ] && [ -f "$HOME/elytras/deploy/.env" ]; then
  cd "$HOME/elytras/deploy" && docker compose up -d --build >/dev/null 2>&1 \
    && echo "$(date -u '+%Y-%m-%d %H:%M:%S')  mis à jour $before -> $after"
fi
