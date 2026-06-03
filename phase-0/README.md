# Elytras — Phase 0 (cœur modulaire + OAuth)

Cœur **sans aucune intégration codée** : les connecteurs arrivent via **serveurs MCP**
(OAuth 2.1 géré), le savoir-faire via **skills**, et une **interface web** te montre
l'état, lance les tests, branche tes serveurs MCP et tes providers (Codex/Claude/Gemini).

## 1. Prérequis (Mac) — Ollama natif (hors Docker, pour le GPU Metal)

```bash
brew install ollama && ollama serve &
ollama pull nomic-embed-text     # embeddings mémoire
ollama pull qwen2.5:3b           # petit modèle local (optionnel)
```

## 2. Connecter tes providers (Codex / Claude / Gemini)

Depuis l'interface (carte **Providers → Se connecter**). Elytras gère l'OAuth
**nativement** — login + PKCE + refresh — via une technique **réimplémentée** du
projet open-source CLIProxyAPI (on n'en dépend pas). Le navigateur s'ouvre, tu
autorises, le token (chiffré) est stocké ; le callback revient sur un port loopback
local (1455 Codex / 54545 Claude / 8085 Gemini, exposés par docker-compose).
⚠️ Usage perso/self-host (voir Phase-0.md, ToS). Alternative clé API :
`ELYTRAS_PROVIDER=openai` + `OPENAI_API_KEY` dans `.env`.

## 3. Lancer

**Double-clic** sur `start.command` (macOS) — ou :

```bash
cp .env.example .env
docker compose up --build        # db + core + example-mcp + adminer
```

Ouvre **http://localhost:8000**. (Base : http://localhost:8080 · MCP démo : http://localhost:9001)

## 4. Brancher un vrai serveur MCP (Shopify, Odoo, Gmail…)

Dans l'UI, carte **Serveurs MCP → Ajouter un serveur MCP** : nom + URL + mode d'auth
(`sans auth` / `OAuth 2.1` / `jeton`). Pour OAuth, clique **« Se connecter (OAuth) »** :
le cœur fait la découverte des métadonnées, l'enregistrement dynamique, le flow
PKCE, stocke le token (chiffré) et le rafraîchit tout seul. **Rien à coder dans le cœur.**

## 5. Structure

```
elytras/
  main.py        API + UI + /selftest + endpoints OAuth
  mcp_client.py  client MCP générique (injecte le Bearer)
  mcp_oauth.py   OAuth 2.1 + PKCE (découverte, registration, refresh)
  crypto.py      chiffrement des tokens/clés (Fernet)
  registry.py    serveurs MCP enregistrés (BYO)
  skills.py      chargeur de SKILL.md
  provider_auth.py  auth NATIVE des providers d'abonnement (Codex/Claude/Gemini)
  providers.py   passerelle LLM (providers natifs + OpenAI/Ollama) + coûts
  memory.py      mémoire scopée (pgvector + RLS) + provenance
  policy.py      autonomie ASK/AUTO
  web/index.html interface
skills/clients-inactifs/SKILL.md   skill d'exemple
example-mcp/   serveur MCP de démo (SUPPRIMABLE)
db/schema.sql  tables + pgvector + RLS + mcp_oauth (tokens chiffrés)
```

## 6. Tests (vérifiés hors Docker)

- Flux MCP modulaire + skills + UI : **OK**.
- OAuth serveurs MCP (chiffrement → découverte → registration → PKCE → token →
  appel authentifié → refus sans token → refresh) : **OK** (serveur factice).
- Auth NATIVE providers (login PKCE → capture loopback → échange → refresh → statut) : **OK** (provider factice).
- Mémoire (write/recall, RLS) : passe au vert avec Postgres + Ollama (sous Docker).
