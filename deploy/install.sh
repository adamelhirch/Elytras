#!/usr/bin/env bash
# Elytras — déploiement en UNE commande.
#   ./install.sh            (onboarding au 1er lancement, puis build + démarrage)
#   ./install.sh --reset    (relance l'onboarding même si .env existe)
set -euo pipefail
cd "$(dirname "$0")"

echo "=== Déploiement Elytras ==="

command -v docker >/dev/null 2>&1 || { echo "❌ Docker requis. Installe Docker puis relance."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "❌ Le plugin 'docker compose' est requis."; exit 1; }

if [ "${1:-}" = "--reset" ] || [ ! -f .env ]; then
  echo "→ Onboarding (configuration minimale)…"
  python3 onboard.py
fi

echo "→ Construction des images et démarrage des conteneurs…"
docker compose up -d --build

# Mode PROD : créer le client sur la passerelle et injecter sa clé, puis recharger l'app.
if grep -q '^ELYTRAS_PROVIDER=elytras-gateway$' .env && grep -q '^ELYTRAS_GATEWAY_KEY=$' .env; then
  echo "→ Création du client sur la passerelle…"
  if python3 provision.py; then
    docker compose up -d elytras
  else
    echo "⚠️  Provisioning passerelle à finaliser (voir README) — l'app tourne, l'IA prod sera active une fois la clé renseignée."
  fi
fi

ADDR="$(grep '^ELYTRAS_SITE_ADDRESS=' .env | cut -d= -f2-)"
echo ""
echo "✅ Elytras est lancé."
case "$ADDR" in
  ":80"|"") echo "   → Ouvre http://localhost (ou l'IP du serveur) et crée ton compte admin." ;;
  *)        echo "   → Ouvre https://$ADDR et crée ton compte admin." ;;
esac
if grep -q '^ELYTRAS_PROVIDER=codex$' .env; then
  echo "   → Mode TEST : connecte ton compte Codex depuis la carte « Providers »."
  echo "     (Le login Codex doit se faire là où ton navigateur atteint le serveur — en local ou via tunnel SSH.)"
fi
echo ""
echo "   Logs : docker compose logs -f    |    Arrêt : docker compose down    |    Sauvegarde : volume 'elytras_data'"
