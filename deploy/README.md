# Elytras — Déploiement (1 entreprise / 1 serveur)

Déploie une instance Elytras **conteneurisée et isolée** pour une entreprise, en **une commande**.
Tout tourne dans des conteneurs Docker (app + reverse proxy TLS + IA), avec un état persistant
et chiffré. Le multi-entreprises par serveur viendra plus tard ; ici, **un serveur = une entreprise**.

## Prérequis

- Un serveur Linux (ou un Mac) avec **Docker** + **docker compose**.
- (Optionnel) un nom de domaine pointant sur le serveur → HTTPS automatique.

## Installer

```bash
cd deploy
./install.sh
```

`install.sh` :
1. lance l'**onboarding terminal** (au 1er lancement) pour configurer le minimum ;
2. construit les images et **démarre tout** (`docker compose up -d --build`) ;
3. en mode prod, **provisionne automatiquement** le client sur la passerelle ;
4. affiche l'URL où créer ton compte admin.

Relancer l'onboarding : `./install.sh --reset`.

## Onboarding — ce qu'il demande

- **Nom de l'entreprise**.
- **Cerveau IA** :
  - **Test — Codex** : gratuit via ton abonnement ChatGPT (aucun frais OpenRouter). *Recommandé pour démarrer.*
  - **Production — passerelle + OpenRouter** : resell facturé (clé OpenRouter + marge + plafond).
- **Domaine** (vide = accès local en HTTP).
- **Options / modules** : MCP d'exemple (démo) ; Odoo et WhatsApp vocal arrivent.

Il génère `deploy/.env` (jamais committé) et `deploy/selection.json`.

## Mode TEST (Codex) — gratuit

Idéal pour essayer sans frais. Après `./install.sh`, ouvre l'interface et **connecte Codex**
depuis la carte « Providers ». Note : le login OAuth de Codex utilise une redirection loopback —
fais-le **là où ton navigateur atteint le serveur** (en local, ou via un tunnel SSH
`ssh -L 1455:127.0.0.1:1455 …` vers le serveur).

## Mode PRODUCTION (OpenRouter)

L'onboarding crée un jeton admin de passerelle ; `install.sh` lance la passerelle, **crée le client**
et injecte sa clé de service dans `.env`, puis recharge l'app. Renseigne ta clé OpenRouter à
l'onboarding (ou plus tard dans `.env`, puis `docker compose up -d`).

## Bac à sable du code (Python / JS / TS)

Les blocs de code des flows tournent isolés (réseau coupé, FS lecture seule) via **bubblewrap**.
Le `docker-compose` relâche déjà seccomp/apparmor du conteneur Elytras pour que bubblewrap puisse
créer ses namespaces. **Vérifie que l'isolation est active** : `curl http://<ip>/health` → champ
`sandbox` → `{"active":true,"network_blocked":true}`. Si c'est bon, passe en **fail-closed**
(refuse d'exécuter du code non isolé) en mettant dans `deploy/.env` :
```
ELYTRAS_CODE_SANDBOX=on
```
puis `docker compose up -d`. Si `active` reste `false` (noyau/hôte sans user-namespaces non
privilégiés), garde `auto` en attendant — ou isole via gVisor/microVM pour de l'exécution de code
client non confiance.

## Architecture des conteneurs

```
  Internet ──▶ caddy (TLS) ──▶ elytras (app, non exposée)
                                  │
                                  └──▶ gateway (IA, mode prod) ──▶ OpenRouter
  Volumes persistants : elytras_data (état + clé), gateway_data, caddy_data
```

- L'app n'est **jamais exposée directement** — uniquement via Caddy.
- Les ports de callback OAuth (1455/54545/8085) sont publiés **seulement sur 127.0.0.1**.
- Le code des flows tourne en **bac à sable** (`ELYTRAS_CODE_SANDBOX=auto`).

## Exploitation

```bash
docker compose logs -f            # logs
docker compose down               # arrêt
docker compose up -d --build      # mise à jour après un changement de code
```

## Sauvegardes (chiffrées, testées)

Le volume **`elytras_data`** contient l'état **et la clé de chiffrement** `.elytras-key` :
sans sauvegarde, une panne disque = tout perdu. `backup.sh` archive **tout** (volumes
`elytras_data` + `gateway_data`, `.env`, `selection.json`, `company-context.md`), chiffre
(AES-256, PBKDF2), **auto-vérifie** l'archive, fait la rotation et pousse hors-site.

```bash
# deploy/.env :
#   BACKUP_PASSPHRASE=une-phrase-forte     # à garder AUSSI hors du serveur !
#   BACKUP_REMOTE=monremote:bucket/elytras # rclone, ou user@hote:/chemin (scp) — recommandé
./backup.sh                   # sauvegarde maintenant
./backup.sh --install-cron    # sauvegarde quotidienne (3h07)
./backup.sh --verify backups/elytras-backup-….tar.gz.enc   # contrôle d'une archive
```

**Restauration** (testée automatiquement : `tests/test_backup_restore.py`) :

```bash
./restore.sh backups/elytras-backup-….tar.gz.enc   # restaure volumes + config, relance tout
```

⚠️ La phrase `BACKUP_PASSPHRASE` est indispensable à la restauration : note-la dans un
gestionnaire de mots de passe, pas seulement sur le serveur.

## Vérification HTTPS (banc e2e derrière TLS)

`smoke/run-https.sh` rejoue le parcours complet **derrière un proxy TLS** (rôle de Caddy,
certificat auto-signé) : auth par jeton à travers le proxy, flows, chat via la passerelle,
et URLs générées (webhooks/approbations) bien en `https://…` grâce à `PUBLIC_BASE_URL`
(défini automatiquement par l'onboarding quand un domaine est fourni).

```bash
./smoke/run-https.sh    # → RESULTAT: TOUT PASSE
```

### Checklist avant le 1er client (à faire sur le vrai serveur)

1. `./install.sh` avec un **domaine** → vérifier le certificat Let's Encrypt (cadenas).
2. Connecter un **MCP OAuth réel** depuis l'interface → le callback doit revenir sur `https://<domaine>/oauth/callback`.
3. `BACKUP_PASSPHRASE` + `BACKUP_REMOTE` dans `.env` → `./backup.sh --install-cron`.
4. **Exercice de restauration** : `./restore.sh` de la veille sur une VM vierge → se connecter, tout est là.
5. `curl https://<domaine>/health` → `sandbox.active=true`, puis `ELYTRAS_CODE_SANDBOX=on`.

## Sécurité

- Secrets jamais committés (`.env`, clés) — voir `.gitignore`.
- HTTPS via Caddy si domaine ; sinon réserve l'accès au réseau local.
- Définis `ELYTRAS_CODE_SANDBOX=on` pour **exiger** le bac à sable en production.
