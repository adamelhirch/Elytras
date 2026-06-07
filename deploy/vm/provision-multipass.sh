#!/usr/bin/env bash
# Crée une VM Ubuntu (Multipass) qui SIMULE un VPS, y installe Docker, CLONE le dépôt public
# Elytras et active la MISE À JOUR AUTOMATIQUE (la VM se met à jour seule après chaque push).
#
#   ./provision-multipass.sh [nom_vm] [--no-auto]
#     --no-auto : ne pas installer l'auto-update (mises à jour manuelles via update.sh)
#
# Prérequis (sur ton Mac) : brew install --cask multipass
set -euo pipefail

REPO_URL="${ELYTRAS_REPO:-https://github.com/adamelhirch/Elytras.git}"
AUTO=1
ARGS=()
for a in "$@"; do
  case "$a" in
    --no-auto) AUTO=0 ;;
    *) ARGS+=("$a") ;;
  esac
done
NAME="${ARGS[0]:-elytras-client1}"

command -v multipass >/dev/null 2>&1 || { echo "❌ Multipass requis : brew install --cask multipass"; exit 1; }

echo "→ Création de la VM '$NAME' (2 vCPU, 4 Go RAM, 20 Go)…"
multipass launch 24.04 --name "$NAME" --cpus 2 --memory 4G --disk 20G 2>/dev/null \
  || echo "   (VM déjà existante — on continue)"

echo "→ Installation de Docker, git et cron dans la VM…"
multipass exec "$NAME" -- bash -lc '
  set -e
  sudo apt-get update -y -qq
  sudo apt-get install -y -qq git cron >/dev/null 2>&1 || true
  command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sudo sh >/dev/null
  sudo usermod -aG docker ubuntu
  sudo systemctl enable --now cron >/dev/null 2>&1 || true
'

echo "→ Récupération du code (clone/màj du dépôt public, .env préservé)…"
multipass exec "$NAME" -- bash -lc "
  set -e
  if [ -d ~/elytras/.git ]; then
    cd ~/elytras && git pull --quiet || true
  else
    [ -f ~/elytras/deploy/.env ] && cp ~/elytras/deploy/.env /tmp/elytras.env.bak || true
    rm -rf ~/elytras
    git clone --quiet '$REPO_URL' ~/elytras
    if [ -f /tmp/elytras.env.bak ]; then mkdir -p ~/elytras/deploy && cp /tmp/elytras.env.bak ~/elytras/deploy/.env && rm /tmp/elytras.env.bak; fi
  fi
"

if [ "$AUTO" = "1" ]; then
  echo "→ Activation de la mise à jour automatique (toutes les 10 min, rebuild si nouveaux commits)…"
  multipass exec "$NAME" -- bash -lc '
    chmod +x ~/elytras/deploy/vm/autoupdate.sh
    ( crontab -l 2>/dev/null | grep -v "elytras/deploy/vm/autoupdate"; \
      echo "*/10 * * * * /home/ubuntu/elytras/deploy/vm/autoupdate.sh >> /home/ubuntu/elytras-update.log 2>&1" ) | crontab -
  '
fi

HAS_ENV="$(multipass exec "$NAME" -- bash -lc 'test -f ~/elytras/deploy/.env && echo yes || echo no')"
IP="$(multipass info "$NAME" | awk '/IPv4/{print $2; exit}')"
echo ""
echo "✅ VM '$NAME' prête (IP ${IP:-?})."
[ "$AUTO" = "1" ] && echo "   🔄 Auto-update activée : après un 'git push', la VM se met à jour seule sous ~10 min."
echo ""
if [ "$HAS_ENV" = "yes" ]; then
  echo "   Déjà onboardée → applique tout de suite la dernière version :"
  echo "     multipass shell $NAME"
  echo "     cd ~/elytras/deploy && docker compose up -d --build"
else
  echo "   Premier déploiement — onboarding DANS la VM :"
  echo "     multipass shell $NAME"
  echo "     cd ~/elytras/deploy && ./install.sh"
fi
echo "   Puis, depuis ton Mac, ouvre :  http://${IP:-<ip>}"
echo ""
echo "   Màj manuelle : ./update.sh $NAME    |    Journal auto-update (dans la VM) : ~/elytras-update.log"
echo "   Gérer : multipass list | multipass stop $NAME | multipass start $NAME | multipass delete $NAME --purge"
