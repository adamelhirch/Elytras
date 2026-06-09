#!/usr/bin/env bash
# Elytras — RESTAURATION complète depuis une sauvegarde chiffrée (backup.sh).
#
#   ./restore.sh <archive.tar.gz.enc> [--yes]
#
# Requiert BACKUP_PASSPHRASE (deploy/.env ou environnement).
# Restaure : volumes Docker (elytras_data, gateway_data) + config deploy (.env, selection.json,
# company-context.md), puis relance les conteneurs. L'existant est écrasé (confirmation demandée).
#
# Mode sans Docker (tests / install nue) : si ELYTRAS_DATA_DIR est défini, on restaure dans ce
# dossier au lieu du volume Docker (idem GATEWAY_DATA_DIR).
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then
  while IFS='=' read -r k v; do
    case "$k" in BACKUP_*|ELYTRAS_DATA_DIR|GATEWAY_DATA_DIR)
      if [ -z "${!k:-}" ]; then export "$k=$v"; fi ;; esac
  done < <(grep -E '^[A-Z_]+=' .env || true)
fi

COMPOSE_PROJECT="${COMPOSE_PROJECT:-elytras}"
OPENSSL_OPTS=(-aes-256-cbc -pbkdf2 -iter 600000 -salt)
die() { echo "❌ $*" >&2; exit 1; }

ARCHIVE="${1:-}"
[ -f "$ARCHIVE" ] || die "usage : ./restore.sh <archive.tar.gz.enc> [--yes]"
[ -n "${BACKUP_PASSPHRASE:-}" ] || die "BACKUP_PASSPHRASE manquante (c'est la phrase choisie à la sauvegarde)."

# --- 1. déchiffrer + extraire dans un dossier de travail -------------------------------------
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
openssl enc -d "${OPENSSL_OPTS[@]}" -pass env:BACKUP_PASSPHRASE -in "$ARCHIVE" | tar -C "$STAGE" -xzf - \
  || die "déchiffrement impossible (mauvaise phrase ? archive corrompue ?)"

echo "→ Contenu de la sauvegarde :"
[ -f "$STAGE/manifest.json" ] && python3 -m json.tool "$STAGE/manifest.json" || ls -R "$STAGE"

if [ "${2:-}" != "--yes" ]; then
  printf "⚠️  La restauration ÉCRASE l'état actuel. Continuer ? [o/N] "
  read -r ok; [ "$ok" = "o" ] || [ "$ok" = "O" ] || die "abandonné."
fi

HAS_DOCKER=0
if command -v docker >/dev/null && [ -z "${ELYTRAS_DATA_DIR:-}" ]; then HAS_DOCKER=1; fi

# --- 2. arrêter l'app pendant la restauration ------------------------------------------------
if [ "$HAS_DOCKER" = 1 ]; then docker compose down 2>/dev/null || true; fi

# --- 3. restaurer les données ----------------------------------------------------------------
restore_volume() {  # $1 = nom logique, $2 = volume docker, $3 = dossier direct (optionnel)
  local name="$1" vol="${COMPOSE_PROJECT}_$2" dir="${3:-}" tarball="$STAGE/volumes/$1.tar.gz"
  [ -f "$tarball" ] || return 0
  if [ -n "$dir" ]; then
    mkdir -p "$dir"; find "$dir" -mindepth 1 -delete
    tar -C "$dir" -xzf "$tarball"
    echo "   • $name → $dir"
  elif [ "$HAS_DOCKER" = 1 ]; then
    docker volume create "$vol" >/dev/null
    docker run --rm -v "$vol":/dst -v "$tarball":/backup.tar.gz:ro alpine \
      sh -c 'find /dst -mindepth 1 -delete && tar -C /dst -xzf /backup.tar.gz'
    echo "   • $name → volume $vol"
  else
    die "ni Docker ni ${name^^}_DIR : impossible de restaurer $name"
  fi
}

echo "→ Restauration des données…"
restore_volume elytras_data elytras_data "${ELYTRAS_DATA_DIR:-}"
restore_volume gateway_data gateway_data "${GATEWAY_DATA_DIR:-}"

# --- 4. restaurer la config deploy (l'existant est gardé en .avant-restauration) -------------
for f in .env selection.json company-context.md; do
  if [ -f "$STAGE/config/$f" ]; then
    [ -f "$f" ] && cp "$f" "$f.avant-restauration"
    cp "$STAGE/config/$f" "$f"
    echo "   • config/$f restauré (ancien : $f.avant-restauration)"
  fi
done

# --- 5. relancer -------------------------------------------------------------------------------
if [ "$HAS_DOCKER" = 1 ]; then
  echo "→ Redémarrage des conteneurs…"
  docker compose up -d
fi
echo "✅ Restauration terminée."
