import { pgTable, text, timestamp, boolean, uuid, pgEnum } from "drizzle-orm/pg-core";

// --- Enums ---

export const userRoleEnum = pgEnum("user_role", ["admin", "user"]);

// --- Users ---

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull().default("user"),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  profileMd: text("profile_md"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Sessions (web auth) ---

export const webSessions = pgTable("web_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Groups ---
// Un groupe = ensemble d'utilisateurs partageant les mêmes accès agents/skills.
// Les admins créent des groupes et y assignent users, agents et skills.

export const groups = pgTable("groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const groupMembers = pgTable("group_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id")
    .notNull()
    .references(() => groups.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Agents ---
// Un agent est global (userId=null, créé par admin) ou appartient à un user.
// L'accès se fait uniquement via les groupes (groupAgentPermissions).

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  // null = agent global créé par admin, accessible via groupe
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  avatarUrl: text("avatar_url"),
  aiProviderId: uuid("ai_provider_id"),
  model: text("model"),
  systemPromptMd: text("system_prompt_md"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Agents assignés à un groupe — tous les membres du groupe y ont accès
export const groupAgentPermissions = pgTable("group_agent_permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id")
    .notNull()
    .references(() => groups.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
});

// Fichiers contexte supplémentaires attachés à un agent
export const agentFiles = pgTable("agent_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  content: text("content").notNull(),
  role: text("role").notNull().default("context"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Gateways ---

export const channelTypeEnum = pgEnum("channel_type", [
  "whatsapp",
  "telegram",
  "slack",
  "discord",
  "signal",
  "imessage",
  "irc",
  "web",
  "other",
]);

export const gatewayStatusEnum = pgEnum("gateway_status", [
  "active",
  "inactive",
  "error",
  "connecting",
]);

export const gateways = pgTable("gateways", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  channelType: channelTypeEnum("channel_type").notNull(),
  configEncrypted: text("config_encrypted"),
  status: gatewayStatusEnum("status").notNull().default("inactive"),
  defaultAgentId: uuid("default_agent_id").references(() => agents.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Skills ---

export const skills = pgTable("skills", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description"),
  skillMdContent: text("skill_md_content").notNull(),
  // enabledGlobal=true → accessible à tous sans passer par un groupe
  enabledGlobal: boolean("enabled_global").notNull().default(false),
  sourcePath: text("source_path"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Skills assignés à un groupe
export const groupSkillPermissions = pgTable("group_skill_permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id")
    .notNull()
    .references(() => groups.id, { onDelete: "cascade" }),
  skillId: uuid("skill_id")
    .notNull()
    .references(() => skills.id, { onDelete: "cascade" }),
});

// Intégrations externes d'un skill
export const skillIntegrations = pgTable("skill_integrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  skillId: uuid("skill_id")
    .notNull()
    .references(() => skills.id, { onDelete: "cascade" }),
  serviceType: text("service_type").notNull(),
  endpoint: text("endpoint"),
  authConfigEncrypted: text("auth_config_encrypted"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- AI Providers ---

export const aiProviderTypeEnum = pgEnum("ai_provider_type", [
  // Pi SDK API-key providers
  "anthropic",
  "google",
  "openai",
  "groq",
  "mistral",
  "xai",
  "cerebras",
  "minimax",
  "openrouter",
  "zai",
  "vercel-ai-gateway",
  // Pi SDK OAuth providers
  "github-copilot",
  "google-gemini-cli",
  "google-antigravity",
  "openai-codex",
  // Legacy / local
  "azure_openai",
  "ollama",
  "github_copilot",
  "custom",
]);

export const aiProviders = pgTable("ai_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  providerType: aiProviderTypeEnum("provider_type").notNull(),
  baseUrl: text("base_url"),
  credentialEncrypted: text("credential_encrypted"),
  modelAllowlist: text("model_allowlist").array(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Secrets ---

export const secretOwnerTypeEnum = pgEnum("secret_owner_type", [
  "user",
  "agent",
  "gateway",
  "skill",
]);

export const secrets = pgTable("secrets", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull(),
  ownerType: secretOwnerTypeEnum("owner_type").notNull(),
  name: text("name").notNull(),
  encryptedValue: text("encrypted_value").notNull(),
  providerHint: text("provider_hint"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
