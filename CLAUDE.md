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
- `health` : `sandbox.active=true` et `network_blocked=true` (mode `auto`, detail `blocked`) depuis
  la refonte OpenFlow du 10/06 → reste à passer `ELYTRAS_CODE_SANDBOX=on` (fail-closed) avant un vrai client.
- `db: down` = normal (mode fichier, Postgres optionnel).

## Journal des interventions IA

| Date | Intervention |
|---|---|
| 2026-06-10 | **Triggers v2 + UI flows SaaS** : (1) email entrant façon Windmill — boîte IMAP partagée (réglages chiffrés `trigger_settings/email_inbox`, endpoints GET/PUT `/triggers/email-settings`), **une adresse par flow** via plus-addressing (`flows.ensure_email_token`, `POST /flows/{fid}/email-token`, routage par destinataire dans `_email_trigger_loop`), 7 tests `test_email_triggers.py`. (2) UI flows refaite : onglet Déclencheurs en cartes (webhook + mode d'emploi Shopify/Stripe/GitHub, email entrant + config boîte admin, routes HTTP avec switch on/off, planif, gestionnaire d'erreurs), design system `.field/.tcard/.copybox/.switch`, deep-linking `#section/onglet/flow_id`, helper `jput`. (3) **Palette d'insertion unifiée** (modal recherche + catégories façon Windmill : pré-construits HTTP/email/SQL, scripts du workspace, nouveau script limité aux **toolchains installées**, outils MCP via `/mcp/tools`) — boutons éparpillés et `identity` retirés de l'UI. (4) Étape Agent IA enrichie : `system_prompt`, `output_schema` (réponse JSON parsée → objet exploitable en aval), `max_iterations` (borne `_agent_loop`), 3 tests `test_agent_step_options.py`. (5) **Webhooks nommés** par flow (un par service externe : label + jeton, URL `POST /hooks/<token>`, query+corps fusionnés en `flow_input`), liste UI avec copier/switch/suppression, 3 tests `test_named_webhooks.py`. |
| 2026-06-10 | **Refonte flows façon Windmill (OpenFlow)** : `flows.py` réécrit en modèle OpenFlow natif (migration auto de l'ancien format, import/export YAML), nouveaux modules `exprs.py` / `flow_engine.py` (moteur d'exécution) / `runners.py` (langages + bac à sable : `sandbox_cmd`/`SANDBOX_MODE` **déplacés de `main.py` vers `runners.py`**) / `scripts.py` / `triggers.py` ; chirurgie de `main.py` (~1090 lignes), UI flows + vue Scripts. `conftest.py` : `ELYTRAS_EMAIL_TRIGGERS=0` (poller IMAP coupé en test). 19 tests `test_openflow.py` ; `test_crypto_access.py` mis à jour (sandbox → `elytras.runners`). Non-régression : seuls les 8 échecs environnementaux connus (`test_code_multilang` ×2, `test_files_extract` ×6). |
| 2026-06-10 | **Mémoire équipe + organisation** (point 2 du doc archi) : scopes `team`/`org` dans `memory_engine` (convention : owner=team_id pour team), `recall_many` multi-scopes, agrégation au chat (perso/projet + équipes + org, bornée par policy `memory_scopes`), choix `equipe`/`org` par étape agent de flow, endpoints `/memory/fact` + gardes de suppression, UI (pills scope, ajout de fait, options flow). 10 tests `test_memory_scopes.py`. |
| 2026-06-10 | **Couche Policy unifiée** (point 1 du doc archi) : `policy.py` étendu (policies par rôle, union entre rôles, défaut permissif), enforcement sur le chemin agent (`_agent_setup`, MCP/skills/delegate/chat/Telegram, clamps mémoire + autonomie), endpoints `/admin/policies`, écran admin, 10 tests (`test_policies.py`). Échecs préexistants hors-sujet : `test_code_multilang` (node hors PATH non-interactif) et `test_files_extract` (modules extraction absents du venv) — environnementaux, vérifiés identiques sur la baseline. |
| 2026-06-09 | P0 prod bouclé : `backup.sh`/`restore.sh` chiffrés + testés, banc e2e HTTPS (`run-https.sh`), fix `PUBLIC_BASE_URL` manquant à l'onboarding. Push `08412a9`, VM `garage-martin` mise à jour + rebuild, fix `$` dans `ELYTRAS_COMPANY`. |
