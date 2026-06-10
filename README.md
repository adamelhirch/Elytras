# ⬡ Elytras

**Système d'exploitation d'entreprise opéré par un orchestre d'agents IA** — auto-hébergé, *local-first*, multi-utilisateur avec droits fins, multi-canal. Interne d'abord (Vanille Désire), puis produit SaaS multi-tenant.

> Phase 0 — preuve de concept fonctionnelle, mode fichier (sans base de données requise). Tourne sur un PC normal.

---

## Ce que ça fait

Elytras assemble, dans un cœur mince, les briques d'un « OS d'entreprise » piloté par des agents :

- **Chat agentique** multi-agents (orchestre + délégation), branché sur un provider LLM via OAuth d'abonnement (Codex) ou API.
- **Connecteurs MCP** (aucune intégration codée en dur) : on branche des serveurs MCP ; OAuth 2.1 + PKCE géré automatiquement.
- **Skills** : savoir-faire packagé (SKILL.md), chargé à la demande.
- **Flows (workflows)** façon Windmill : éditeur canvas glisser-déposer, étapes *agent / outil MCP / code Python / note / boucles for-while / branches / approbation*, config avancée par étape (retry, timeout, cache, mock, early-stop), exécution parallèle, déclencheurs (manuel, webhook, cron), génération **et** modification de flows par IA.
- **Mémoire long terme** scopée (perso / projet) avec extraction de faits, déduplication, rappel hybride et consolidation hiérarchique ; + un **contexte d'entreprise** (markdown d'onboarding) injecté en lecture seule à tous les agents.
- **RBAC complet** : authentification réelle (mot de passe + SSO OpenID Connect), **équipes + rôles configurables capacité par capacité**, accès par équipe sur chaque MCP et chaque skill, connexions MCP **partagées (admin)** ou **personnelles**.
- **Policies par rôle** (la « sandbox » des agents) : un écran admin unique compose, pour chaque rôle, ce que ses agents peuvent faire — agents pilotables, connecteurs MCP, skills, familles d'outils (code/web/flows/fichiers/dispatch/délégation), scopes mémoire, autonomie (forcer la validation ou imposer l'auto). Sans policy : aucun changement ; la policy ne fait que restreindre, jamais outrepasser le RBAC.
- **Autonomie** : par agent, mode *validation* (l'agent demande confirmation avant une action sensible) ou *auto* ; validation depuis le web ou par **boutons inline Telegram**.
- **Fichiers** : espace scopé (perso/projet), montés en lecture seule dans le bac à sable du code, sortie de fichiers depuis les flows, livraison de fichiers par l'agent (web + Telegram).
- **Multi-canal** : un **bot Telegram par agent** ; une conversation Telegram = une session Elytras (persistée, visible côté web) ; commandes `/new`, `/sessions` ; **dispatch** (notifier un utilisateur ouvre une session questionnable).
- **Observabilité & coûts** : tableau de bord usage LLM (appels/tokens/coût estimé), activité par type, exécutions de flows.
- **Bac à sable** : les étapes code Python tournent en sous-processus isolé (sandbox-exec sur macOS / bwrap sur Linux) — réseau coupé, FS en lecture seule hors dossier de travail.

Tout est **cloisonné par les droits** : un utilisateur ne voit et ne fait que ce que son rôle autorise — y compris via le chat (l'agent ne se voit offrir que les outils permis et refuse honnêtement le reste).

---

## Démarrer (local, sans Docker)

```bash
cd phase-0
./start-local.command        # crée le venv, installe, lance uvicorn, ouvre http://localhost:8000
```

Au premier lancement : créer le **compte administrateur**, puis se connecter. Ensuite (carte **Administration**) : créer les **équipes** et **rôles**, les **comptes**, remplir le **contexte d'entreprise**, configurer le **SSO** et les **bots Telegram**.

Variables d'environnement utiles (voir `phase-0/.env.example`) :
`APP_ENCRYPTION_KEY` (chiffrement des secrets), `CODEX_MODEL` (défaut `gpt-5.4-mini`), `ELYTRAS_CODE_SANDBOX` (`auto`/`on`/`off`), `ELYTRAS_TELEGRAM` (`0` pour couper les bots), `PUBLIC_BASE_URL`.

---

## Architecture (Phase 0)

Cœur **Python / FastAPI**, persistance **fichier** (`filestore.py`, `.elytras-state.json`) — Postgres optionnel.

| Module | Rôle |
|---|---|
| `elytras/main.py` | API + cœur : chat agentique, moteur de flows, RBAC/auth, Telegram, fichiers, observabilité |
| `elytras/rbac.py` | Capacités, rôles configurables, équipes, comptes (mdp pbkdf2), jetons, SSO |
| `elytras/flows.py` | Modèle de flow (modules typés, schéma d'entrées) |
| `elytras/agents.py` | Registre d'agents (orchestre), autonomie, token bot |
| `elytras/memory_engine.py` | Mémoire long terme scopée (extraction, dédup, rappel, consolidation) |
| `elytras/files.py` | Espace de fichiers scopé |
| `elytras/scheduler.py` | Planificateur (daily / interval / cron) |
| `elytras/mcp_client.py`, `mcp_oauth.py`, `registry.py` | Client MCP + OAuth 2.1/PKCE + registre des serveurs |
| `elytras/providers.py`, `provider_auth.py` | Passerelle providers (Codex/Claude/Gemini/Ollama) + auth native |
| `elytras/web/index.html` | Interface web (mono-fichier, vanilla JS) |

L'interface est servie sur `localhost:8000`. Sécurité : identité par jeton (header `X-Elytras-Token`), enforcement des capacités sur tous les endpoints sensibles **et** au dispatch des outils de l'agent.

---

## Limites connues (Phase 0)

- Persistance **fichier** (petits volumes) — secrets chiffrés (Fernet) ; à migrer vers Postgres/objet pour le scale.
- Coûts/tokens LLM = **estimations** (le flux Codex ne renvoie pas les comptes réels).
- SSO et bots Telegram non testés contre les vrais services depuis l'environnement de dev (mécanique conforme aux specs).
- Réutilisation des `client_id` CLI officiels (Codex) = zone grise ToS → usage perso/self-host ; bascule API prévue avant le SaaS.

---

## Licence

À définir (voir le cahier des charges). Données chez le client par conception.
