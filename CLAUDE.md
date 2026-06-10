# CLAUDE.md — repères pour les IA qui travaillent sur Elytras

> Lu automatiquement par les sessions Claude. Tenir à jour le **journal des interventions** en bas.

## Carte du dépôt

| Dossier | Rôle |
|---|---|
| `phase-0/` | Le moteur (FastAPI, mode fichier) : agents, flows, RBAC, mémoire, MCP, Telegram |
| `gateway/` | Passerelle IA centrale (resell) : metering, plafonds, gammes éco/standard/max → OpenRouter |
| `deploy/` | Déploiement client : Docker + Caddy TLS, onboarding, sauvegardes, smoke e2e |
| `deploy/vm/` | VM Multipass qui simule un VPS client (provision, update, auto-update) |

Tests : `cd phase-0 && python -m pytest` · `cd deploy && python -m pytest` · e2e : `./deploy/smoke/run.sh` (HTTP) et `./deploy/smoke/run-https.sh` (derrière TLS).

## Runbook : mettre à jour la VM cliente (exécutable par une IA)

Contexte : la VM Multipass **`garage-martin`** tourne sur le Mac d'Adam et simule un VPS client.
Elle a un cron d'auto-update (toutes les 10 min) qui fait `git pull` + rebuild **seulement si un
nouveau commit arrive pendant qu'elle tourne** — un simple boot ne rebuild PAS (piège classique :
code à jour, conteneurs anciens).

Étapes (via `osascript` / `do shell script` depuis le Mac — shell **non-interactif**) :

```bash
# 0. PATH d'abord : multipass n'est PAS dans le PATH non-interactif
export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH

# 1. pousser le code (le dépôt est public, la VM tire en lecture seule)
cd ~/Documents/Claude/Projects/Elytras && git push

# 2. pull + rebuild immédiat (sinon, attendre le cron ~10 min)
./deploy/vm/update.sh garage-martin

# 3. vérifier
IP=$(multipass info garage-martin | awk '/IPv4/{print $2; exit}')
curl -s http://$IP/health    # attendu: {"status":"ok", ..., "sandbox":{"active":true,...}}
```

### Pannes et pièges connus

- **« No route to host » sur `multipass exec`** : la VM est marquée Running mais injoignable
  (souvent après une veille du Mac) → `multipass restart garage-martin`, attendre ~15 s, retester.
- **Builds longs** : `do shell script` est synchrone et peut timeout → lancer en
  `nohup … > /tmp/elytras-vm-build.log 2>&1 &` puis suivre le log avec `tail`.
- **`$` dans `deploy/.env`** : docker compose interpole `$VAR` dans les valeurs ! Un nom comme
  `$Vanille Désiré` devient ` Désiré` (corrigé le 9/06). Doubler en `$$` pour un `$` littéral.
- **Commit depuis le bac à sable Cowork** : le montage peut laisser un `.git/index.lock`
  insupprimable → faire le commit **depuis le Mac** (osascript), jamais depuis le bac à sable.
- **Terminal (Ghostty/Terminal.app) via computer-use** : cliquable mais pas de saisie clavier
  (tier « click ») → toujours passer par `osascript` pour exécuter des commandes sur le Mac.

### État de la VM (dernier passage)

- `~/elytras` dans la VM = clone du dépôt public ; `.env` d'onboarding préservé au re-provision.
- `health` : `sandbox.active=true` mais `network_blocked=false` (mode `auto`, detail `open`) →
  avant un vrai client, viser `network_blocked=true` puis `ELYTRAS_CODE_SANDBOX=on` (fail-closed).
- `db: down` = normal (mode fichier, Postgres optionnel).

## Journal des interventions IA

| Date | Intervention |
|---|---|
| 2026-06-10 | **Mémoire équipe + organisation** (point 2 du doc archi) : scopes `team`/`org` dans `memory_engine` (convention : owner=team_id pour team), `recall_many` multi-scopes, agrégation au chat (perso/projet + équipes + org, bornée par policy `memory_scopes`), choix `equipe`/`org` par étape agent de flow, endpoints `/memory/fact` + gardes de suppression, UI (pills scope, ajout de fait, options flow). 10 tests `test_memory_scopes.py`. |
| 2026-06-10 | **Couche Policy unifiée** (point 1 du doc archi) : `policy.py` étendu (policies par rôle, union entre rôles, défaut permissif), enforcement sur le chemin agent (`_agent_setup`, MCP/skills/delegate/chat/Telegram, clamps mémoire + autonomie), endpoints `/admin/policies`, écran admin, 10 tests (`test_policies.py`). Échecs préexistants hors-sujet : `test_code_multilang` (node hors PATH non-interactif) et `test_files_extract` (modules extraction absents du venv) — environnementaux, vérifiés identiques sur la baseline. |
| 2026-06-09 | P0 prod bouclé : `backup.sh`/`restore.sh` chiffrés + testés, banc e2e HTTPS (`run-https.sh`), fix `PUBLIC_BASE_URL` manquant à l'onboarding. Push `08412a9`, VM `garage-martin` mise à jour + rebuild, fix `$` dans `ELYTRAS_COMPANY`. |
