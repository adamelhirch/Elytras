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

**Sauvegarde** (essentiel) : le volume **`elytras_data`** contient l'état **et la clé de
chiffrement** `.elytras-key`. Sans cette clé, les secrets sont irrécupérables. Sauvegarde le
volume régulièrement :

```bash
docker run --rm -v elytras_elytras_data:/d -v "$PWD":/b alpine tar czf /b/elytras-backup.tgz -C /d .
```

## Sécurité

- Secrets jamais committés (`.env`, clés) — voir `.gitignore`.
- HTTPS via Caddy si domaine ; sinon réserve l'accès au réseau local.
- Définis `ELYTRAS_CODE_SANDBOX=on` pour **exiger** le bac à sable en production.
