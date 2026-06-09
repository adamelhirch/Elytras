#!/usr/bin/env bash
# Elytras — sauvegarde CHIFFRÉE de l'instance (état + clé + fichiers + config).
#
#   ./backup.sh                     → crée backups/elytras-backup-AAAAMMJJ-HHMMSS.tar.gz.enc
#   ./backup.sh --verify <fichier>  → vérifie qu'une archive est lisible (déchiffrable + intègre)
#   ./backup.sh --install-cron      → installe la sauvegarde quotidienne (3h07) dans la crontab
#
# Configuration (deploy/.env ou variables d'environnement) :
#   BACKUP_PASSPHRASE   (REQUIS)  phrase de chiffrement — à garder HORS du serveur aussi !
#                                 Sans elle, une sauvegarde est IRRÉCUPÉRABLE (c'est voulu).
#   BACKUP_DIR          (défaut: ./backups)   dossier local des archives
#   BACKUP_KEEP         (défaut: 14)          nombre d'archives locales conservées (rotation)
#   BACKUP_REMOTE       (optionnel)           destination HORS-SITE :
#                         - remote rclone  « monremote:bucket/elytras »  (si rclone installé)
#                         - cible scp      « user@hote:/chemin »         (sinon)
#
# Ce qui est sauvegardé :
#   - volume elytras_data  : .elytras-state.json + .elytras-key + files_data/ (TOUT l'état)
#   - volume gateway_data  : état de la passerelle (clients, metering) — si présent
#   - config deploy        : .env, selection.json, company-context.md
# (Les certificats Caddy ne sont pas inclus : ils se réémettent automatiquement.)
#
# Mode sans Docker (tests / install nue) : si ELYTRAS_DATA_DIR est défini, on archive ce
# dossier directement au lieu du volume Docker (idem GATEWAY_DATA_DIR).
set -euo pipefail
cd "$(dirname "$0")"

# --- charge BACKUP_* et *_DATA_DIR depuis .env sans écraser l'environnement ---
if [ -f .env ]; then
  while IFS='=' read -r k v; do
    case "$k" in BACKUP_*|ELYTRAS_DATA_DIR|GATEWAY_DATA_DIR)
      if [ -z "${!k:-}" ]; then export "$k=$v"; fi ;; esac
  done < <(grep -E '^[A-Z_]+=' .env || true)
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-elytras}"
OPENSSL_OPTS=(-aes-256-cbc -pbkdf2 -iter 600000 -salt)

die() { echo "❌ $*" >&2; exit 1; }
need_pass() { [ -n "${BACKUP_PASSPHRASE:-}" ] || die "BACKUP_PASSPHRASE manquante (deploy/.env). Choisis une phrase forte et garde-la AILLEURS que sur ce serveur."; }

# --- vérification d'une archive existante -------------------------------------------------
if [ "${1:-}" = "--verify" ]; then
  need_pass
  [ -f "${2:-}" ] || die "archive introuvable : ${2:-}"
  if openssl enc -d "${OPENSSL_OPTS[@]}" -pass env:BACKUP_PASSPHRASE -in "$2" | tar -tzf - >/dev/null; then
    echo "✅ Archive lisible et intègre : $2"; exit 0
  else
    die "archive illisible (mauvaise phrase ? fichier corrompu ?) : $2"
  fi
fi

# --- installation cron ---------------------------------------------------------------------
if [ "${1:-}" = "--install-cron" ]; then
  need_pass
  LINE="7 3 * * * cd $(pwd) && ./backup.sh >> backups/backup.log 2>&1"
  ( crontab -l 2>/dev/null | grep -vF "backup.sh" ; echo "$LINE" ) | crontab -
  echo "✅ Cron installé : sauvegarde quotidienne à 3h07 (logs: backups/backup.log)"; exit 0
fi

need_pass
command -v openssl >/dev/null || die "openssl requis"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/volumes" "$STAGE/config"

# --- 1. dump des données (volume Docker, ou dossier direct en mode sans Docker) ------------
dump_volume() {  # $1 = nom logique, $2 = volume docker, $3 = dossier direct (optionnel)
  local name="$1" vol="${COMPOSE_PROJECT}_$2" dir="${3:-}"
  if [ -n "$dir" ] && [ -d "$dir" ]; then
    tar -C "$dir" -czf "$STAGE/volumes/$name.tar.gz" .
    echo "   • $name ← $dir"
  elif command -v docker >/dev/null && docker volume inspect "$vol" >/dev/null 2>&1; then
    docker run --rm -v "$vol":/src:ro alpine tar -C /src -czf - . > "$STAGE/volumes/$name.tar.gz"
    echo "   • $name ← volume $vol"
  else
    return 1
  fi
}

echo "→ Sauvegarde des données…"
dump_volume elytras_data elytras_data "${ELYTRAS_DATA_DIR:-}" \
  || die "aucune donnée trouvée (ni volume Docker '${COMPOSE_PROJECT}_elytras_data', ni ELYTRAS_DATA_DIR)"
dump_volume gateway_data gateway_data "${GATEWAY_DATA_DIR:-}" || echo "   • gateway_data : absent (mode test ?) — ignoré"

# --- 2. config de déploiement ---------------------------------------------------------------
for f in .env selection.json company-context.md; do
  [ -f "$f" ] && cp "$f" "$STAGE/config/" && echo "   • config/$f"
done

# --- 3. manifeste ----------------------------------------------------------------------------
GIT_REV="$(git -C .. rev-parse --short HEAD 2>/dev/null || echo 'n/a')"
cat > "$STAGE/manifest.json" <<EOF
{"created_at": "$(date -u +%FT%TZ)", "host": "$(hostname)", "git": "$GIT_REV",
 "contents": [$(cd "$STAGE" && find volumes config -type f | sed 's/.*/"&"/' | paste -sd, -)]}
EOF

# --- 4. archive chiffrée + empreinte ---------------------------------------------------------
OUT="$BACKUP_DIR/elytras-backup-$STAMP.tar.gz.enc"
tar -C "$STAGE" -czf - . | openssl enc "${OPENSSL_OPTS[@]}" -pass env:BACKUP_PASSPHRASE -out "$OUT"
( cd "$BACKUP_DIR" && { sha256sum "$(basename "$OUT")" 2>/dev/null || shasum -a 256 "$(basename "$OUT")"; } > "$(basename "$OUT").sha256" )

# --- 5. auto-vérification : une sauvegarde non testée n'existe pas ---------------------------
openssl enc -d "${OPENSSL_OPTS[@]}" -pass env:BACKUP_PASSPHRASE -in "$OUT" | tar -tzf - >/dev/null \
  || die "l'archive produite ne se relit pas — sauvegarde INVALIDE"
echo "✅ Archive chiffrée + vérifiée : $OUT ($(du -h "$OUT" | cut -f1))"

# --- 6. rotation locale ----------------------------------------------------------------------
ls -1t "$BACKUP_DIR"/elytras-backup-*.tar.gz.enc 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | while read -r old; do
  rm -f "$old" "$old.sha256"; echo "   (rotation) supprimé : $old"
done

# --- 7. copie hors-site (fortement recommandée) ----------------------------------------------
if [ -n "${BACKUP_REMOTE:-}" ]; then
  echo "→ Copie hors-site vers $BACKUP_REMOTE…"
  if command -v rclone >/dev/null && [[ "$BACKUP_REMOTE" != *"@"* ]]; then
    rclone copy "$OUT" "$BACKUP_REMOTE" && rclone copy "$OUT.sha256" "$BACKUP_REMOTE"
  else
    scp -q "$OUT" "$OUT.sha256" "$BACKUP_REMOTE"
  fi
  echo "✅ Copie hors-site effectuée."
else
  echo "⚠️  BACKUP_REMOTE non défini : la sauvegarde reste sur CE serveur (incendie/panne = tout perdu)."
fi
