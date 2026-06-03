-- Elytras — Phase 0 — schéma initial (cœur modulaire, aucune intégration codée)
-- Postgres 16 + pgvector. Chargé automatiquement au 1er démarrage du conteneur db.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ───────────────────────── Identité / tenants / projets ─────────────────────────
CREATE TABLE tenant (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name  text NOT NULL
);

CREATE TABLE app_user (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  email      text UNIQUE NOT NULL,
  role       text NOT NULL DEFAULT 'member',   -- admin | member
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name      text NOT NULL
);

-- Appartenance projet → sert à résoudre la mémoire PARTAGÉE entre users
CREATE TABLE project_member (
  project_id uuid NOT NULL REFERENCES project(id),
  user_id    uuid NOT NULL REFERENCES app_user(id),
  PRIMARY KEY (project_id, user_id)
);

-- ───────────────────────── Agents ─────────────────────────
CREATE TABLE agent (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  name           text NOT NULL,
  role           text NOT NULL DEFAULT 'assistant',
  autonomy_level text NOT NULL DEFAULT 'ask'    -- ask | auto
);

-- ───────────────────────── Connecteurs = serveurs MCP (BYO, par utilisateur) ─────────────────────────
-- AUCUNE intégration n'est codée dans le cœur : on enregistre des serveurs MCP.
CREATE TABLE mcp_server (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid REFERENCES tenant(id),
  owner_id   uuid REFERENCES app_user(id),
  name       text NOT NULL,
  transport  text NOT NULL DEFAULT 'http',      -- http | stdio (plus tard)
  url        text,
  auth_type  text NOT NULL DEFAULT 'none',      -- none | bearer | header
  secret_enc bytea,                             -- credential BYO chiffré (clé/oauth)
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Skills enregistrées (le SKILL.md vit sur disque ; la table sert au statut/activation)
CREATE TABLE skill (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenant(id),
  owner_id    uuid REFERENCES app_user(id),
  name        text NOT NULL,
  description text,
  path        text,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Mémoire scopée (cœur de l'isolation) ─────────────────────────
CREATE TABLE memory (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  scope_type  text NOT NULL,                    -- global | org | project | user | agent | session
  owner_id    uuid REFERENCES app_user(id),     -- requis si scope_type = user
  project_id  uuid REFERENCES project(id),      -- requis si scope_type = project
  agent_id    uuid REFERENCES agent(id),        -- requis si scope_type = agent
  session_id  uuid,                             -- requis si scope_type = session
  visibility  text NOT NULL DEFAULT 'private',  -- private | shared
  mtype       text NOT NULL DEFAULT 'fact',     -- fact | preference | decision | summary
  content     text NOT NULL,
  embedding   vector(768),                      -- nomic-embed-text
  source_ref  text,                             -- PROVENANCE (anti-hallucination)
  provenance  jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz
);
CREATE INDEX memory_embedding_idx ON memory USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX memory_scope_idx ON memory (tenant_id, scope_type, owner_id, project_id);

-- Résumés hiérarchiques "sans perte" (idée Lossless Claw) : un nœud résume des nœuds,
-- mais garde le lien vers ses sources (on peut toujours déplier jusqu'au brut).
CREATE TABLE memory_summary (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  session_id  uuid,
  level       int  NOT NULL DEFAULT 0,
  content     text NOT NULL,
  child_ids   uuid[] NOT NULL DEFAULT '{}',
  source_refs text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Tâches, validations, audit, coûts ─────────────────────────
CREATE TABLE task (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  initiator_type text NOT NULL,
  initiator_id   uuid,
  agent_id       uuid REFERENCES agent(id),
  command        text,
  status         text NOT NULL DEFAULT 'created',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approval_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      uuid REFERENCES task(id),
  action       text NOT NULL,
  sensitivity  text NOT NULL,                   -- read | sensitive
  status       text NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  requested_by uuid REFERENCES agent(id),
  decided_by   uuid REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  initiator       text,
  mandator        text,
  agent_id        uuid REFERENCES agent(id),
  action          text NOT NULL,
  scopes          text[],
  tools           text[],
  memory_accessed uuid[],
  result          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE llm_usage (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid REFERENCES tenant(id),
  user_id           uuid REFERENCES app_user(id),
  provider          text NOT NULL,
  model             text NOT NULL,
  prompt_tokens     int  NOT NULL DEFAULT 0,
  completion_tokens int  NOT NULL DEFAULT 0,
  cost_estimate     numeric(10,5) NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── OAuth (tokens chiffrés) ─────────────────────────
-- Tokens OAuth des serveurs MCP (par serveur + utilisateur), chiffrés (APP_ENCRYPTION_KEY).
CREATE TABLE mcp_oauth (
  server_id  text NOT NULL,
  user_id    uuid NOT NULL REFERENCES app_user(id),
  token_enc  bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, user_id)
);

-- Comptes provider par utilisateur (clé API chiffrée ou OAuth). Codex se lit aussi
-- depuis ~/.codex/auth.json ; cette table sert aux clés API et aux autres providers.
CREATE TABLE provider_account (
  user_id    uuid NOT NULL REFERENCES app_user(id),
  provider   text NOT NULL,
  auth_type  text NOT NULL DEFAULT 'oauth',   -- api_key | oauth
  secret_enc bytea,
  meta       jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

-- ───────────────────────── RLS : isolation de la mémoire ─────────────────────────
-- L'application pose, par requête :
--   SET app.current_user_id   = '<uuid>'; SET app.current_tenant_id = '<uuid>';
--   SET app.current_role = 'admin|member'; (+ agent_id / session_id si pertinent)
ALTER TABLE memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory FORCE  ROW LEVEL SECURITY;

CREATE POLICY memory_read ON memory FOR SELECT USING (
      scope_type = 'global'
   OR (scope_type = 'org'     AND tenant_id  = current_setting('app.current_tenant_id',  true)::uuid)
   OR (scope_type = 'user'    AND owner_id   = current_setting('app.current_user_id',    true)::uuid)
   OR (scope_type = 'agent'   AND agent_id   = current_setting('app.current_agent_id',   true)::uuid)
   OR (scope_type = 'session' AND session_id = current_setting('app.current_session_id', true)::uuid)
   OR (scope_type = 'project' AND project_id IN (
          SELECT pm.project_id FROM project_member pm
          WHERE pm.user_id = current_setting('app.current_user_id', true)::uuid))
);

CREATE POLICY memory_write ON memory FOR INSERT WITH CHECK (
      (scope_type = 'user'    AND owner_id   = current_setting('app.current_user_id',    true)::uuid)
   OR (scope_type = 'agent'   AND agent_id   = current_setting('app.current_agent_id',   true)::uuid)
   OR (scope_type = 'session' AND session_id = current_setting('app.current_session_id', true)::uuid)
   OR (scope_type = 'project' AND project_id IN (
          SELECT pm.project_id FROM project_member pm
          WHERE pm.user_id = current_setting('app.current_user_id', true)::uuid))
   OR (scope_type IN ('org','global')
          AND current_setting('app.current_role', true) = 'admin')
);

-- ───────────────────────── Données de démo (mono-tenant) ─────────────────────────
INSERT INTO tenant (id, name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Demo');
INSERT INTO app_user (id, tenant_id, email, role) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'leo@vanilledesire.com', 'admin');
INSERT INTO agent (id, tenant_id, name, role, autonomy_level) VALUES
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000001', 'Assistant', 'assistant', 'ask');
