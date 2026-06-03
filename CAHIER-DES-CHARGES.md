# Elytras — Cahier des charges

> Plateforme d'agents IA pour la gestion et l'automatisation d'entreprise.
> Auto-hébergée, locale d'abord, multi-utilisateurs, sécurisée par conception.
> Version du document : Phase 0 (déployable en local). Dernière mise à jour : 3 juin 2026.

---

## 1. Objectif

Elytras permet à une entreprise de **gérer et automatiser son activité par des agents IA**, sans
exposer ses données. Tout tourne **sur la machine du client** : aucun composant obligatoire dans le
cloud, aucun secret en clair, et chaque action sensible est soumise à des droits et, au besoin, à une
validation humaine. La cible : un outil installable en local chez chaque client (e‑commerce d'abord,
puis SaaS), qui leur ouvre l'usage d'IA pour piloter leur entreprise et automatiser un maximum de
tâches — un « OpenClaw pour entreprises ».

Principes directeurs : **local‑first**, **sécurité par défaut**, **multi‑canal** (web + Telegram),
**multi‑utilisateurs avec droits fins**, **extensible** (connecteurs MCP + skills), **auditable**.

---

## 2. Périmètre fonctionnel

### 2.1 Agents & chat
- Orchestre multi‑agents (par défaut : Orchestrateur, Support, Ventes/CRM ; créables/modifiables).
- Chat web agentique : l'agent raisonne, appelle des outils, rend une réponse, demande validation si besoin.
- L'agent dispose d'outils : lancer un flow, créer/modifier un flow, appeler un connecteur MCP,
  lire/écrire des fichiers, naviguer/scraper le web, livrer un fichier dans la conversation.
- **Honnêteté sur les droits** : l'agent connaît les capacités de l'utilisateur courant et ne prétend
  pas pouvoir faire ce que le rôle interdit.
- Sessions de conversation persistées, consultables et reprenables (web et Telegram partagent les sessions).

### 2.2 Flows (moteur d'automatisation, inspiré de Windmill)
- Éditeur **canvas** glisser‑déposer avec inspecteur de module.
- Types de modules : étape **code Python** (sandboxée), **note/template**, boucle **forloop**,
  branchements **branchone / branchall**, **whileloop**, **approbation humaine** (suspend/reprise).
- Options par module : **mock** (valeur simulée), **stop_after_if** (arrêt conditionnel), itérateur, expressions `{{ results.x }}`.
- Chaînage des résultats entre étapes (résolution par id et par intitulé).
- **Exécution parallèle** des itérations/branches.
- Déclencheurs : manuel, **webhook** (jeton dédié), **cron** (planificateur).
- **Entrées/sorties fichiers** : un flow reçoit des fichiers (montés en lecture dans `input_dir`)
  et en produit (`output_dir`), récupérés dans l'espace de fichiers scopé.
- **Génération et modification de flows par IA**, depuis l'admin **et depuis le chat**.

### 2.3 Mémoire
- Mémoire **par utilisateur** et **par projet**, **cloisonnée** (un utilisateur ne voit pas la mémoire d'un autre).
- Extraction/consolidation de faits, rappel par pertinence (mots‑clés + embeddings si disponibles).
- **Mémoire système d'entreprise** : un document Markdown rempli à l'onboarding, injecté en contexte,
  **en lecture seule depuis les chats** (modifiable uniquement par un admin).

### 2.4 Fichiers
- Espace de fichiers **scopé** (personnel / projet), avec contrôle d'accès.
- Dépôt depuis l'interface, lecture/écriture par les agents et les flows.
- Livraison de fichiers **dans la conversation** (web et Telegram).

### 2.5 Connecteurs (MCP) & providers LLM
- Enregistrement de **serveurs MCP** (connecteurs métier) avec **OAuth 2.1 + PKCE** géré nativement.
- **Contrôle d'accès par connecteur et par skill** (ouvert à tous, ou réservé à des équipes).
- **Connexions partagées vs personnelles** : certains connecteurs utilisent un compte commun,
  d'autres une connexion propre à chaque utilisateur.
- Providers LLM connectés depuis l'interface (Codex/Claude/Gemini par OAuth, ou clé API ; Ollama local).
  ⚠️ L'usage des providers d'abonnement par OAuth relève d'un cadre perso/self‑host (voir `Phase-0.md`).

### 2.6 Skills
- Catalogue de **skills** (capacités spécialisées) listées et **soumises au contrôle d'accès par équipe**.

### 2.7 Navigateur / scraping
- Outil `browse` permettant à l'agent d'**ouvrir une page et d'en extraire le texte**,
  protégé contre le SSRF (voir §3.5).

### 2.8 Planificateur
- Tâches **cron** complètes (5 champs), planning quotidien et par intervalle ; exécution de flows planifiés.

### 2.9 Dispatch / Telegram
- **Un bot Telegram par agent**. Chaque utilisateur renseigne son identifiant Telegram sur son profil.
- Une **conversation Telegram = une session** Elytras (persistée, visible côté web) ; commandes
  `/new` (nouvelle session) et `/sessions` (sélecteur).
- **Dispatch** : un agent crée une nouvelle session dont le premier message est la notification,
  l'envoie à l'utilisateur ciblé, qui peut poursuivre la discussion dessus.
- **Boutons inline** Telegram pour **approuver/refuser** une action sensible.
- Les droits (scopes) de l'utilisateur restent appliqués **à l'identique** quel que soit le canal.

### 2.10 Observabilité & coûts
- Tableau de bord : exécutions, statuts, **estimation des coûts/tokens**, journal d'audit des actions.

---

## 3. Sécurité & contrôle d'accès

### 3.1 Authentification
- **Vrai login** : mot de passe (hash **PBKDF2‑HMAC‑SHA256**, 200 000 itérations, sel par compte).
- **Jetons de session opaques** (en‑tête `X-Elytras-Token`), révocables.
- **SSO OIDC** générique (rattachement par e‑mail ; provisioning optionnel configurable).
- Premier lancement : assistant de création de l'**admin initial** (`setup`).

### 3.2 Autorisation (RBAC)
- Modèle **équipes + rôles**, rôles **entièrement configurables capacité par capacité**.
- Rôles fournis : **Admin** (toutes capacités, protégé), **Opérateur**, **Lecteur** — éditables.
- **18 capacités** verrouillent chaque zone sensible :
  `mcp.manage`, `provider.manage`, `flow.view/create/edit/run/delete`, `code.execute`,
  `agent.use`, `agent.manage`, `memory.view`, `memory.reset`, `file.read`, `file.write`,
  `web.browse`, `dispatch`, `schedule.manage`, `admin`.
- **Enforcement à deux niveaux** : sur les endpoints **ET au dispatch des outils de l'agent**
  (un utilisateur ne peut pas contourner ses droits en passant par le chat) — faille identifiée et corrigée.
- Contrôle d'accès **par connecteur MCP** et **par skill** (ouvert / réservé à des équipes).

### 3.3 Autonomie (validation des actions sensibles)
- Mode **ASK** (validation humaine requise) / **AUTO** (autonome) réglable par agent.
- Une action sensible permise par le rôle déclenche une **demande de confirmation** (web : carte de
  confirmation ; Telegram : boutons inline). Une action **non permise** est refusée, pas mise en attente.

### 3.4 Exécution de code en bac à sable
- Étapes code exécutées dans un **sandbox** : **réseau coupé**, **système de fichiers en lecture seule**,
  seul le dossier de travail (in/out) est accessible en écriture.
- macOS : `sandbox-exec` ; Linux : `bwrap` (`--unshare-net`, `--ro-bind /`, `--die-with-parent`).
- Mode `ELYTRAS_CODE_SANDBOX = auto | on | off` ; en mode `on`, l'exécution **échoue** si aucun
  bac à sable n'est disponible (pas de repli silencieux).
- La capacité `code.execute` est requise pour lancer un flow contenant du code.

### 3.5 Navigateur protégé (anti‑SSRF)
- Avant toute requête, résolution DNS puis **blocage des plages internes** (loopback, privées,
  link‑local, métadonnées cloud `169.254.169.254`) ; **re‑validation à chaque redirection** ;
  seuls `http/https` sont autorisés ; taille de réponse plafonnée.

### 3.6 Chiffrement des secrets
- Tous les secrets (tokens OAuth providers et connecteurs MCP, clés API) sont **chiffrés** (Fernet).
- Clé = `APP_ENCRYPTION_KEY` si fournie et forte ; sinon **génération d'une clé forte au 1er lancement**,
  **persistée** dans `.elytras-key` (chmod 600), à côté de l'état. Aucun secret en clair.

### 3.7 Surface réseau & confidentialité
- Le serveur **n'écoute qu'en local** (`127.0.0.1`) ; serveurs OAuth loopback en `127.0.0.1` (RFC 8252) ;
  ports Docker publiés **bind 127.0.0.1** uniquement.
- Secrets et état runtime **jamais committés** (`.gitignore` couvrant `.elytras-state.json`,
  `.elytras-key`, `.env`, `.venv`, `*.key`, `*.pem`).
- **Journal d'audit** des actions sensibles.

---

## 4. Architecture & stack

- **Backend** : Python 3.10+/3.12, **FastAPI** + **uvicorn**.
- **Persistance** : **mode fichier** par défaut (`.elytras-state.json`) — aucune base requise ;
  **Postgres + pgvector optionnel** (mémoire vectorielle à grande échelle).
- **Interface** : application web mono‑fichier (thème clair, SaaS B2B).
- **Extensibilité** : client **MCP** + registre de connecteurs + catalogue de **skills**.
- **Crypto** : `cryptography` (Fernet) ; **PBKDF2** pour les mots de passe.
- **Code** : ~5 500 lignes, modules `main, rbac, flows, files, agents, sessions, memory_engine,
  scheduler, crypto, registry, mcp_client, providers, provider_auth, skills`.
- **API** : ~84 endpoints REST (auth, admin, flows, chat, fichiers, mémoire, MCP, providers,
  planificateur, observabilité, Telegram, santé/selftest).

---

## 5. Déploiement

- **Local sans Docker (recommandé)** : `start-local.command` — crée l'environnement, installe les
  dépendances cœur, génère la clé de chiffrement, démarre l'interface sur `http://localhost:8000`.
- **Docker** : `docker-compose.yml` (cœur + Postgres + adminer + MCP d'exemple), ports en `127.0.0.1`.
- **Prérequis** : Python 3.10+ (mode fichier) ; aucun service externe obligatoire.
- **Dépendances** : `requirements.txt` (cœur), `requirements-postgres.txt` (optionnel), `requirements-dev.txt` (tests).
- Voir **`GUIDE-INSTALLATION.md`** pour la procédure pas à pas et la check‑list de sécurité.

---

## 6. Qualité & tests

- **Suite pytest : 35 tests, 100 % au vert.** Domaines couverts :
  - RBAC (rôles configurables, capacités, équipes, mots de passe, SSO) ;
  - Authentification + **verrous endpoints ET dispatch** (anti‑contournement par le chat) ;
  - Moteur de flows (code, chaînage, forloop, branche, mock, stop, **E/S fichiers**, approbation, capacité `code.execute`) ;
  - Mémoire (**isolement** inter‑utilisateurs, contexte entreprise injecté + lecture seule) ;
  - Fichiers (scope + RBAC) ;
  - Navigateur (**anti‑SSRF**, extraction de texte) ;
  - Telegram (expéditeur inconnu, conversation = session, dispatch) et **cron** ;
  - Chiffrement (round‑trip, **persistance de clé**, priorité clé d'environnement) ;
  - Bac à sable (commande d'isolement, refus en mode `on` sans outil) ;
  - Contrôle d'accès **MCP/skill** par équipe.
- Lancement : `cd phase-0 && pip install -r requirements-dev.txt && PYTHONPATH=. python -m pytest`.

---

## 7. Exigences non‑fonctionnelles

- **Sécurité** : moindre privilège, secrets chiffrés, réseau local, audit, validation humaine.
- **Confidentialité** : données et traitements sur la machine du client.
- **Portabilité** : macOS et Linux ; démarrage en une commande, sans base.
- **Robustesse** : reprise des flows suspendus, repli gracieux quand un composant optionnel manque.
- **Maintenabilité** : modules découplés, suite de tests, configuration par variables d'environnement.
- **Extensibilité** : ajout de connecteurs MCP et de skills sans modifier le cœur.

---

## 8. Limites de la Phase 0 & feuille de route

- **Multi‑tenant** : un déploiement = une entreprise (isolation par instance). Multi‑tenant logique = phase ultérieure.
- **Mémoire vectorielle** : embeddings locaux optionnels ; Postgres/pgvector recommandé au‑delà d'un certain volume.
- **Canaux de dispatch** : Telegram d'abord ; e‑mail/Slack/WhatsApp envisagés ensuite.
- **Stockage fichiers** : contenu encodé dans l'état fichier (plafond 1 Mo/fichier) ; backend objet à prévoir pour de gros volumes.
- **Providers d'abonnement par OAuth** : cadre perso/self‑host à clarifier pour un usage commercial (ToS).
- Pistes : packaging installeur signé, sauvegardes/rotation de clé, rôles hiérarchiques, marketplace de connecteurs.

---

## 9. Annexe — capacités (verrous RBAC)

| Capacité | Intitulé |
|---|---|
| `mcp.manage` | Gérer les connecteurs MCP |
| `provider.manage` | Connecter les providers LLM |
| `flow.view` / `flow.create` / `flow.edit` / `flow.run` / `flow.delete` | Voir / Créer / Modifier / Exécuter / Supprimer des flows |
| `code.execute` | Exécuter du code Python (sensible) |
| `agent.use` | Discuter avec les agents (chat) |
| `agent.manage` | Gérer les agents |
| `memory.view` / `memory.reset` | Consulter / Réinitialiser la mémoire |
| `file.read` / `file.write` | Lire / Écrire‑déposer des fichiers |
| `web.browse` | Naviguer / scraper le web |
| `dispatch` | Notifier / dispatcher des utilisateurs |
| `schedule.manage` | Planificateur |
| `admin` | Administration (tout) |
