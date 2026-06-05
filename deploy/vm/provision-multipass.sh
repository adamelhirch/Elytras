#!/usr/bin/env bash
# Crée une VM Ubuntu (Multipass) qui SIMULE un VPS, y installe Docker et y copie Elytras.
# Tu lances ensuite l'onboarding + le déploiement DANS la VM. Plusieurs VMs = plusieurs « clients ».
#
#   ./provision-multipass.sh [nom_vm]      (def. elytras-client1)
#
# Prérequis (sur ton Mac) : brew install --cask multipass
set -euo pipefail
NAME="${1:-elytras-client1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

command -v multipass >/dev/null 2>&1 || { echo "❌ Multipass requis : brew install --cask multipass"; exit 1; }

echo "→ Création de la VM '$NAME' (2 vCPU, 4 Go RAM, 20 Go)…"
multipass launch 24.04 --name "$NAME" --cpus 2 --memory 4G --disk 20G 2>/dev/null \
  || echo "   (VM déjà existante — on continue)"

echo "→ Installation de Docker dans la VM…"
multipass exec "$NAME" -- bash -lc '
  set -e
  sudo apt-get update -y -qq
  curl -fsSL https://get.docker.com | sudo sh >/dev/null
  sudo usermod -aG docker ubuntu
'

echo "→ Copie de la solution (sans secrets ni venv) dans la VM…"
TGZ="$(mktemp -t elytras-src.XXXX.tgz)"
tar czf "$TGZ" -C "$ROOT" \
  --exclude='.git' --exclude='*/.venv' --exclude='__pycache__' --exclude='.pytest_cache' \
  --exclude='*.elytras-state.json' --exclude='*.elytras-key' --exclude='*/.gateway-state.json' \
  --exclude='*/.env' --exclude='deploy/selection.json' --exclude='deploy/company-context.md' \
  phase-0 gateway deploy
multipass transfer "$TGZ" "$NAME":/home/ubuntu/elytras-src.tgz
rm -f "$TGZ"
multipass exec "$NAME" -- bash -lc 'rm -rf ~/elytras && mkdir -p ~/elytras && tar xzf ~/elytras-src.tgz -C ~/elytras && rm ~/elytras-src.tgz'

IP="$(multipass info "$NAME" | awk '/IPv4/{print $2; exit}')"
echo ""
echo "✅ VM '$NAME' prête (IP ${IP:-?})."
echo ""
echo "   Étape suivante — onboarding + déploiement DANS la VM :"
echo "     multipass shell $NAME"
echo "     cd ~/elytras/deploy && ./install.sh"
echo "   Puis, depuis ton Mac, ouvre :  http://${IP:-<ip>}"
echo ""
echo "   Gérer : multipass list | multipass stop $NAME | multipass start $NAME | multipass delete $NAME --purge"
