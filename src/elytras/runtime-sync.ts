/**
 * Elytras Runtime Sync
 *
 * Construit une OpenClawConfig complète depuis la DB Elytras et l'injecte
 * dans le runtime OpenClaw via setRuntimeConfigSnapshot().
 *
 * Flux :
 *   startElytrasSyncLoop() → buildConfigFromDb() → setRuntimeConfigSnapshot()
 *                                                 → replaceRuntimeAuthProfileStoreSnapshots()
 *   → poll toutes les N secondes pour détecter les changements DB
 *
 * La config injectée contient :
 *   - agents.list[] : agents DB → agentDir sur filesystem
 *   - bindings[]    : gateways actifs → agent par défaut par canal
 *   - channels.*    : configs déchiffrées des gateways (telegram.botToken, etc.)
 *   - AuthProfileStore : ApiKeyCredential par ai_provider (clé déchiffrée)
 *   - models.providers : baseUrl pour les providers sans clé (Ollama)
 */

import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getModels } from "@mariozechner/pi-ai";
import postgres from "postgres";
import {
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store.js";
import type {
  AuthProfileStore,
  ApiKeyCredential,
  AuthProfileCredential,
  TokenCredential,
} from "../agents/auth-profiles/types.js";
import { setRuntimeConfigSnapshot, loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.js";

// ---------------------------------------------------------------------------
// Déchiffrement AES-256-GCM (même format que apps/web/src/lib/crypto.ts)
// Format : "<iv_hex>:<ciphertext_hex>"
// ---------------------------------------------------------------------------

const ENV_FILE_CANDIDATES = [
  join(process.cwd(), ".env.local"),
  join(process.cwd(), ".env"),
  join(process.cwd(), "apps", "web", ".env.local"),
  join(process.cwd(), "apps", "web", ".env"),
  join(homedir(), ".openclaw", ".env"),
];

const localEnvCache = new Map<string, string | null>();

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readEnvValueFromCandidates(key: string): string | null {
  if (localEnvCache.has(key)) {
    return localEnvCache.get(key) ?? null;
  }

  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, "m");
  for (const filePath of ENV_FILE_CANDIDATES) {
    if (!existsSync(filePath)) {
      continue;
    }
    try {
      const raw = readFileSync(filePath, "utf8");
      const match = raw.match(pattern);
      if (!match) {
        continue;
      }
      const value = stripWrappingQuotes(match[1].trim());
      if (value.length > 0) {
        localEnvCache.set(key, value);
        return value;
      }
    } catch {
      // ignore malformed/unreadable fallback env files
    }
  }

  localEnvCache.set(key, null);
  return null;
}

function getEncryptionKey(): Buffer {
  const raw =
    process.env.ELYTRAS_ENCRYPTION_KEY ?? readEnvValueFromCandidates("ELYTRAS_ENCRYPTION_KEY");
  if (!raw) {
    throw new Error("ELYTRAS_ENCRYPTION_KEY non défini");
  }
  if (raw.length === 64) {
    return Buffer.from(raw, "hex");
  }
  return Buffer.from(raw, "base64");
}

function decryptValue(stored: string): string {
  const [ivHex, ctHex] = stored.split(":");
  if (!ivHex || !ctHex) {
    throw new Error("Format de secret invalide");
  }
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, "hex");
  const ct = Buffer.from(ctHex, "hex");
  // AES-256-GCM : les 16 derniers bytes du ciphertext sont le tag
  const tagLength = 16;
  const ciphertext = ct.subarray(0, ct.length - tagLength);
  const tag = ct.subarray(ct.length - tagLength);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function tryDecrypt(stored: string | null | undefined): string | null {
  if (!stored) {
    return null;
  }
  try {
    return decryptValue(stored);
  } catch {
    return null;
  }
}

function tryParseJson(s: string | null): Record<string, unknown> | null {
  if (!s) {
    return null;
  }
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseOptionalBool(raw: string | undefined): boolean | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseOptionalCsv(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const values = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return values.length > 0 ? values : undefined;
}

function normalizeAgentName(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase();
}

type PersonaPreset = {
  name: string;
  role: string;
  personality: string;
  dedicatedMemory: string[];
  redirectHint: string;
};

const PERSONA_PRESETS: Record<string, PersonaPreset> = {
  alex: {
    name: "Alex",
    role: "Research Specialist",
    personality: "Curious, methodical, source-first.",
    dedicatedMemory: ["Research topics", "Sources", "Past findings", "Preferred news outlets"],
    redirectHint:
      "redirect writing to Maya, marketing to Jordan, coding to Dev, and social tasks to Sam.",
  },
  maya: {
    name: "Maya",
    role: "Writing Specialist",
    personality: "Clear, editorial, concise.",
    dedicatedMemory: [
      "Writing style preferences",
      "Past blog topics",
      "Tone guidelines",
      "Target keywords",
    ],
    redirectHint:
      "redirect coding to Dev, research to Alex, marketing strategy to Jordan, and social operations to Sam.",
  },
  jordan: {
    name: "Jordan",
    role: "Marketing Strategist",
    personality: "Outcome-driven, pragmatic, growth-oriented.",
    dedicatedMemory: [
      "Marketing goals",
      "Past strategies",
      "Monetization ideas",
      "Campaign history",
    ],
    redirectHint:
      "redirect deep research to Alex, writing execution to Maya, coding to Dev, and posting operations to Sam.",
  },
  dev: {
    name: "Dev",
    role: "Software Engineer",
    personality: "Precise, implementation-focused, test-minded.",
    dedicatedMemory: [
      "Tech stack details",
      "Past code decisions",
      "Preferred libraries",
      "Project structure",
    ],
    redirectHint:
      "redirect writing to Maya, broad research to Alex, marketing strategy to Jordan, and social execution to Sam.",
  },
  sam: {
    name: "Sam",
    role: "Social Media Operator",
    personality: "Brand-aware, cadence-focused, execution-first.",
    dedicatedMemory: ["Brand voice", "Past posts", "Hashtag performance", "Posting schedules"],
    redirectHint:
      "redirect coding to Dev, deep research to Alex, long-form writing to Maya, and growth strategy to Jordan.",
  },
};

function resolvePersonaPreset(name: string | null | undefined): PersonaPreset | undefined {
  const normalized = normalizeAgentName(name);
  if (!normalized) {
    return undefined;
  }
  return PERSONA_PRESETS[normalized];
}

function buildPersonaAgentsMd(
  agent: AgentRow,
  preset: PersonaPreset,
  extraPrompt: string | null | undefined,
): string {
  const identityName = agent.name?.trim() || preset.name;
  const roleBoundary =
    `If a request is outside your scope, politely refuse and ${preset.redirectHint} ` +
    "Do not perform out-of-scope tasks yourself.";
  const extra = extraPrompt?.trim();
  return [
    `# ${identityName}`,
    "",
    `You are ${identityName}, the ${preset.role}.`,
    "",
    "## Persona",
    `- Keep this identity stable in every session.`,
    `- Personality: ${preset.personality}`,
    "",
    "## Role Boundaries",
    `- ${roleBoundary}`,
    "- When declining, use one short sentence and stop after the redirection.",
    "",
    "## Memory Scope",
    "- Store and retrieve only role-relevant context listed in MEMORY.md.",
    "- Never mix memory from other agents.",
    "",
    "## Execution",
    "- Prioritize the assigned role and produce actionable outputs.",
    "- Keep responses concise unless more detail is requested.",
    ...(extra ? ["", "## Project Instructions", extra] : []),
    "",
  ].join("\n");
}

function buildIdentityMd(agent: AgentRow, preset?: PersonaPreset): string {
  if (preset) {
    return [
      `name: ${agent.name?.trim() || preset.name}`,
      `role: ${preset.role}`,
      `personality: ${preset.personality}`,
      "stability: strict",
      "",
    ].join("\n");
  }
  return [
    `name: ${agent.name?.trim() || "Agent"}`,
    "role: General Assistant",
    "personality: Helpful, precise",
    "stability: strict",
    "",
  ].join("\n");
}

function buildUserMd(): string {
  return [
    "# User Profile",
    "",
    "- Keep user-specific preferences and facts here.",
    "- Do not copy context from other agents.",
    "",
  ].join("\n");
}

function buildMemoryMd(agent: AgentRow, preset?: PersonaPreset): string {
  if (preset) {
    const sections = preset.dedicatedMemory.map((item) => `## ${item}\n- `).join("\n\n");
    return [
      `# MEMORY — ${agent.name?.trim() || preset.name}`,
      "",
      "This file is dedicated to this agent only.",
      "Never store context that belongs to another agent.",
      "",
      sections,
      "",
    ].join("\n");
  }
  return [
    `# MEMORY — ${agent.name?.trim() || "Agent"}`,
    "",
    "This memory is agent-scoped.",
    "Do not mix data from other agents.",
    "",
    "## Notes",
    "- ",
    "",
  ].join("\n");
}

function workspaceDirPath(agentId: string): string {
  return join(homedir(), ".openclaw", `workspace-${agentId}`);
}

async function writeFileIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code !== "EEXIST") {
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Table de mapping providerType → baseUrl + api protocol (Pi SDK built-ins)
// Sources : models.generated.js dans @mariozechner/pi-ai
// ---------------------------------------------------------------------------

type ProviderMeta = {
  baseUrl: string;
  api: string;
};

const PROVIDER_META: Record<string, ProviderMeta> = {
  anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
  "github-copilot": {
    baseUrl: "https://api.individual.githubcopilot.com",
    api: "anthropic-messages",
  },
  "google-gemini-cli": { baseUrl: "https://cloudcode-pa.googleapis.com", api: "google-gemini-cli" },
  "google-antigravity": {
    baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
    api: "google-gemini-cli",
  },
  "openai-codex": { baseUrl: "https://chatgpt.com/backend-api", api: "openai-codex-responses" },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    api: "google-generative-ai",
  },
  openai: { baseUrl: "https://api.openai.com/v1", api: "openai-responses" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", api: "openai-completions" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", api: "openai-completions" },
  xai: { baseUrl: "https://api.x.ai/v1", api: "openai-completions" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", api: "openai-completions" },
  minimax: { baseUrl: "https://api.minimax.io/anthropic", api: "anthropic-messages" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" },
  zai: { baseUrl: "https://api.z.ai/api/coding/paas/v4", api: "openai-completions" },
  "vercel-ai-gateway": { baseUrl: "https://ai-gateway.vercel.sh", api: "anthropic-messages" },
};

// ---------------------------------------------------------------------------
// Types locaux pour les lignes DB
// ---------------------------------------------------------------------------

type AgentRow = {
  id: string;
  name: string;
  userId: string | null;
  aiProviderId: string | null;
  model: string | null;
  systemPromptMd: string | null;
};

type AgentFileRow = {
  filename: string;
  content: string;
};

type GatewayRow = {
  id: string;
  channelType: string;
  defaultAgentId: string | null;
  configEncrypted: string | null;
};

type AiProviderRow = {
  id: string;
  providerType: string;
  credentialEncrypted: string | null;
  baseUrl: string | null;
  modelAllowlist: string[] | null;
};

// ---------------------------------------------------------------------------
// Requêtes DB
// ---------------------------------------------------------------------------

type Sql = ReturnType<typeof postgres>;

async function fetchAgents(sql: Sql): Promise<AgentRow[]> {
  type Raw = {
    id: string;
    name: string;
    user_id: string | null;
    ai_provider_id: string | null;
    model: string | null;
    system_prompt_md: string | null;
  };
  const rows = await sql<Raw[]>`
    SELECT id, name, user_id, ai_provider_id, model, system_prompt_md FROM agents
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    userId: r.user_id,
    aiProviderId: r.ai_provider_id,
    model: r.model,
    systemPromptMd: r.system_prompt_md,
  }));
}

async function fetchAgentFiles(sql: Sql, agentId: string): Promise<AgentFileRow[]> {
  type Raw = { filename: string; content: string };
  return sql<Raw[]>`SELECT filename, content FROM agent_files WHERE agent_id = ${agentId}`;
}

async function fetchActiveGateways(sql: Sql): Promise<GatewayRow[]> {
  type Raw = {
    id: string;
    channel_type: string;
    default_agent_id: string | null;
    config_encrypted: string | null;
  };
  const rows = await sql<Raw[]>`
    SELECT id, channel_type, default_agent_id, config_encrypted
    FROM gateways WHERE status = 'active'
  `;
  return rows.map((r) => ({
    id: r.id,
    channelType: r.channel_type,
    defaultAgentId: r.default_agent_id,
    configEncrypted: r.config_encrypted,
  }));
}

async function fetchActiveProviders(sql: Sql): Promise<AiProviderRow[]> {
  type Raw = {
    id: string;
    provider_type: string;
    credential_encrypted: string | null;
    base_url: string | null;
    model_allowlist: string[] | null;
  };
  const rows = await sql<Raw[]>`
    SELECT id, provider_type, credential_encrypted, base_url, model_allowlist
    FROM ai_providers WHERE is_active = true
  `;
  return rows.map((r) => ({
    id: r.id,
    providerType: r.provider_type,
    credentialEncrypted: r.credential_encrypted,
    baseUrl: r.base_url,
    modelAllowlist: r.model_allowlist,
  }));
}

// ---------------------------------------------------------------------------
// Sync agents → filesystem agentDir
// ---------------------------------------------------------------------------

function agentDirPath(agentId: string): string {
  return join(homedir(), ".openclaw", "agents", agentId, "agent");
}

async function syncAgentWorkspace(agent: AgentRow): Promise<string> {
  const dir = workspaceDirPath(agent.id);
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, "memory"), { recursive: true });

  const preset = resolvePersonaPreset(agent.name);
  const agentsMd = preset
    ? buildPersonaAgentsMd(agent, preset, agent.systemPromptMd)
    : agent.systemPromptMd;

  if (agentsMd?.trim()) {
    await writeFile(join(dir, "AGENTS.md"), agentsMd, "utf8");
  }

  await writeFileIfMissing(join(dir, "IDENTITY.md"), buildIdentityMd(agent, preset));
  await writeFileIfMissing(join(dir, "USER.md"), buildUserMd());
  await writeFileIfMissing(join(dir, "MEMORY.md"), buildMemoryMd(agent, preset));
  return dir;
}

async function syncAgentToFs(sql: Sql, agent: AgentRow): Promise<string> {
  const dir = agentDirPath(agent.id);
  await mkdir(dir, { recursive: true });
  if (agent.systemPromptMd) {
    await writeFile(join(dir, "AGENTS.md"), agent.systemPromptMd, "utf8");
  }
  const files = await fetchAgentFiles(sql, agent.id);
  for (const file of files) {
    const safeName = file.filename.replace(/[^a-z0-9_.-]/gi, "_");
    await writeFile(join(dir, safeName), file.content, "utf8");
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Construction de la config OpenClaw depuis la DB
// ---------------------------------------------------------------------------

type BuildResult = {
  config: OpenClawConfig;
  authStore: AuthProfileStore;
  agentDirs: string[];
};

async function buildConfigFromDb(): Promise<BuildResult> {
  const baseConfig = loadConfig();
  const connectionString =
    process.env.DATABASE_URL ??
    readEnvValueFromCandidates("DATABASE_URL") ??
    "postgres://elytras:elytras@localhost:5432/elytras";
  const sql = postgres(connectionString, { max: 2 });

  try {
    const [allAgents, activeGateways, activeProviders] = await Promise.all([
      fetchAgents(sql),
      fetchActiveGateways(sql),
      fetchActiveProviders(sql),
    ]);

    // Indexer les providers par id pour résolution rapide
    const providerById = new Map<string, AiProviderRow>(activeProviders.map((p) => [p.id, p]));

    // --- AI Providers → AuthProfileStore + models.providers ---
    const authProfiles: AuthProfileStore["profiles"] = {};
    // Custom providers injectés dans models.providers (clé = "elytras-<uuid>")
    const modelsProviders: Record<string, unknown> = {};

    for (const p of activeProviders) {
      const credential = tryDecrypt(p.credentialEncrypted);
      const profileId = `elytras-${p.id}`;
      const meta = PROVIDER_META[p.providerType];

      if (credential) {
        const parsed = tryParseJson(credential);
        if (parsed && parsed.type === "oauth" && typeof parsed.access === "string") {
          const providerName =
            typeof parsed.provider === "string" ? parsed.provider : p.providerType;
          const expires = Number(parsed.expires);
          if (typeof parsed.refresh === "string" && parsed.refresh.length > 0) {
            authProfiles[profileId] = {
              type: "oauth",
              provider: providerName,
              access: parsed.access,
              refresh: parsed.refresh,
              expires: Number.isFinite(expires) ? expires : Date.now() + 60_000,
              ...(typeof parsed.email === "string" ? { email: parsed.email } : {}),
              ...(typeof parsed.projectId === "string" ? { projectId: parsed.projectId } : {}),
            } as AuthProfileCredential;
          } else {
            const tokenCred: TokenCredential = {
              type: "token",
              provider: providerName,
              token: parsed.access,
              ...(Number.isFinite(expires) ? { expires } : {}),
              ...(typeof parsed.email === "string" ? { email: parsed.email } : {}),
            };
            authProfiles[profileId] = tokenCred;
          }
        } else {
          const cred: ApiKeyCredential = {
            type: "api_key",
            provider: p.providerType,
            key: credential,
          };
          authProfiles[profileId] = cred;
        }

        // Injecter comme custom provider dans models.json sous "elytras-<uuid>"
        // pour que les modèles apparaissent avec provider="elytras-<uuid>" dans le catalog.
        if (meta) {
          // Résoudre l'apiKey depuis le credential (oauth → getApiKey, api_key → key directe)
          let apiKey: string;
          const parsedCred = tryParseJson(credential);
          if (parsedCred && parsedCred.type === "oauth" && typeof parsedCred.access === "string") {
            // Pour OAuth, Pi SDK résout le token via AuthStorage — on passe l'access token brut.
            // Le vrai refresh sera géré par Pi à l'exécution via auth-profiles.
            apiKey = profileId; // placeholder : Pi résoudra via AuthStorage au runtime
          } else {
            apiKey = credential;
          }

          // Modèles : model_allowlist si défini, sinon tous les modèles Pi SDK du provider
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const piModels = getModels(p.providerType as any);
          const allowlist =
            p.modelAllowlist && p.modelAllowlist.length > 0 ? new Set(p.modelAllowlist) : null;
          const selectedModels = piModels
            .filter((m) => !allowlist || allowlist.has(m.id))
            .map((m) => ({
              id: m.id,
              name: m.name ?? m.id,
              api: m.api ?? meta.api,
              contextWindow: m.contextWindow,
              maxTokens: m.maxTokens,
              ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
              ...(m.input ? { input: m.input } : {}),
              cost: m.cost,
            }));

          if (selectedModels.length > 0) {
            modelsProviders[profileId] = {
              baseUrl: p.baseUrl ?? meta.baseUrl,
              api: meta.api,
              apiKey,
              models: selectedModels,
            };
          }
        }
      } else if (p.baseUrl) {
        // Provider sans clé mais avec baseUrl (ex: Ollama local)
        modelsProviders[profileId] = {
          baseUrl: p.baseUrl,
          models: [],
        };
      }
    }

    const authStore: AuthProfileStore = {
      version: 1,
      profiles: authProfiles,
    };

    // --- Agents ---
    type AgentEntry = {
      id: string;
      name?: string;
      agentDir: string;
      workspace?: string;
      default?: boolean;
      model?: { primary: string; fallbacks?: string[] };
    };

    const agentList: AgentEntry[] = [];
    for (const agent of allAgents) {
      let dir: string;
      let workspace: string;
      try {
        dir = await syncAgentToFs(sql, agent);
      } catch {
        dir = agentDirPath(agent.id);
      }
      try {
        workspace = await syncAgentWorkspace(agent);
      } catch {
        workspace = workspaceDirPath(agent.id);
      }

      // Résoudre le modèle : si l'agent a un aiProviderId, suffixer avec @profileId
      let modelConfig: { primary: string; fallbacks?: string[] } | undefined;
      if (agent.model) {
        let modelStr = agent.model;
        if (agent.aiProviderId) {
          const provider = providerById.get(agent.aiProviderId);
          if (provider) {
            // Les IDs modèle du runtime doivent inclure le provider (provider/model)
            // puis le profil custom (@elytras-<providerId>) pour résoudre l'auth.
            const modelWithProvider = agent.model.includes("/")
              ? agent.model
              : `${provider.providerType}/${agent.model}`;
            modelStr = modelWithProvider.includes("@")
              ? modelWithProvider
              : `${modelWithProvider}@elytras-${agent.aiProviderId}`;
          }
        }
        // Elytras agents are pinned to their DB model by default.
        // Keep fallback list explicit (empty) to avoid implicit fallback to
        // OpenClaw global defaults (e.g. anthropic/claude-opus-4-6).
        modelConfig = { primary: modelStr, fallbacks: [] };
      }

      agentList.push({
        id: agent.id,
        name: agent.name,
        agentDir: dir,
        workspace,
        default: false,
        ...(modelConfig ? { model: modelConfig } : {}),
      });
    }

    // Premier agent global comme défaut
    const firstGlobal = allAgents.find((a) => a.userId === null);
    const defaultEntry = firstGlobal
      ? agentList.find((a) => a.id === firstGlobal.id)
      : agentList[0];
    if (defaultEntry) {
      defaultEntry.default = true;
    }

    // --- Gateways actifs → bindings + configs canaux ---
    const bindings: NonNullable<OpenClawConfig["bindings"]> = [];
    const channelsConfig: Record<string, unknown> = {};

    for (const gw of activeGateways) {
      if (gw.defaultAgentId) {
        bindings.push({
          agentId: gw.defaultAgentId,
          match: { channel: gw.channelType, accountId: "*" },
        });
      }

      const rawConfig = tryDecrypt(gw.configEncrypted);
      const config = tryParseJson(rawConfig);
      if (!config) {
        continue;
      }

      switch (gw.channelType) {
        case "telegram":
          if (config.botToken) {
            channelsConfig.telegram = {
              ...(typeof channelsConfig.telegram === "object" ? channelsConfig.telegram : {}),
              accounts: [
                ...((channelsConfig.telegram as { accounts?: unknown[] })?.accounts ?? []),
                { botToken: config.botToken },
              ],
            };
          }
          break;

        case "discord":
          if (config.token) {
            channelsConfig.discord = {
              ...(typeof channelsConfig.discord === "object" ? channelsConfig.discord : {}),
              accounts: [
                ...((channelsConfig.discord as { accounts?: unknown[] })?.accounts ?? []),
                { token: config.token },
              ],
            };
          }
          break;

        case "slack":
          if (config.botToken) {
            channelsConfig.slack = {
              ...(typeof channelsConfig.slack === "object" ? channelsConfig.slack : {}),
              accounts: [
                ...((channelsConfig.slack as { accounts?: unknown[] })?.accounts ?? []),
                {
                  botToken: config.botToken,
                  ...(config.appToken ? { appToken: config.appToken } : {}),
                  ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
                  mode: config.appToken ? "socket" : "http",
                },
              ],
            };
          }
          break;

        case "signal":
          if (config.account) {
            channelsConfig.signal = {
              ...(typeof channelsConfig.signal === "object" ? channelsConfig.signal : {}),
              accounts: [
                ...((channelsConfig.signal as { accounts?: unknown[] })?.accounts ?? []),
                {
                  account: config.account,
                  ...(config.httpUrl ? { httpUrl: config.httpUrl } : {}),
                },
              ],
            };
          }
          break;

        case "irc":
          if (config.host && config.nick) {
            channelsConfig.irc = {
              ...(typeof channelsConfig.irc === "object" ? channelsConfig.irc : {}),
              accounts: [
                ...((channelsConfig.irc as { accounts?: unknown[] })?.accounts ?? []),
                {
                  host: config.host,
                  port: config.port ? Number(config.port) : 6697,
                  nick: config.nick,
                  ...(config.password ? { password: config.password } : {}),
                },
              ],
            };
          }
          break;

        default:
          break;
      }
    }

    // --- Overrides Control UI depuis env Docker (utile sur volume gateway vierge) ---
    const controlUiAllowedOrigins = parseOptionalCsv(
      process.env.ELYTRAS_GATEWAY_CONTROLUI_ALLOWED_ORIGINS,
    );
    const controlUiAllowHostFallback = parseOptionalBool(
      process.env.ELYTRAS_GATEWAY_CONTROLUI_ALLOW_HOST_FALLBACK,
    );
    const hasControlUiOverrides =
      controlUiAllowedOrigins !== undefined || controlUiAllowHostFallback !== undefined;

    // --- Assembler la config finale ---
    const config: OpenClawConfig = {
      ...baseConfig,
      ...(hasControlUiOverrides
        ? {
            gateway: {
              ...baseConfig.gateway,
              controlUi: {
                ...baseConfig.gateway?.controlUi,
                ...(controlUiAllowedOrigins ? { allowedOrigins: controlUiAllowedOrigins } : {}),
                ...(controlUiAllowHostFallback !== undefined
                  ? {
                      dangerouslyAllowHostHeaderOriginFallback: controlUiAllowHostFallback,
                    }
                  : {}),
              },
            },
          }
        : {}),
      agents: {
        ...baseConfig.agents,
        list: agentList as OpenClawConfig["agents"] extends { list?: infer L } ? L : never,
      },
      bindings: [
        ...(Array.isArray(baseConfig.bindings) ? baseConfig.bindings : []),
        ...bindings,
      ] as OpenClawConfig["bindings"],
      channels: {
        ...baseConfig.channels,
        ...channelsConfig,
      } as OpenClawConfig["channels"],
      ...(Object.keys(modelsProviders).length > 0
        ? {
            models: {
              ...baseConfig.models,
              providers: {
                ...(baseConfig.models as { providers?: Record<string, unknown> })?.providers,
                ...modelsProviders,
              },
            } as OpenClawConfig["models"],
          }
        : {}),
    };

    return {
      config,
      authStore,
      agentDirs: agentList.map((entry) => entry.agentDir),
    };
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// Boucle de synchronisation
// ---------------------------------------------------------------------------

let syncLoopHandle: ReturnType<typeof setInterval> | null = null;
let lastConfigHash: string | null = null;

function hashBuildResult(result: BuildResult): string {
  return createHash("sha256")
    .update(JSON.stringify({ config: result.config, authStore: result.authStore }))
    .digest("hex");
}

async function syncOnce(): Promise<void> {
  try {
    const result = await buildConfigFromDb();
    const hash = hashBuildResult(result);
    if (hash !== lastConfigHash) {
      lastConfigHash = hash;
      try {
        // Persist auth store for main + per-agent dirs so isolated agent runs
        // can resolve provider credentials even outside this process context.
        saveAuthProfileStore(result.authStore);
        for (const agentDir of result.agentDirs) {
          saveAuthProfileStore(result.authStore, agentDir);
        }
      } catch (error) {
        console.error("[elytras] Erreur de persistance auth-profiles:", error);
      }
      setRuntimeConfigSnapshot(result.config);
      replaceRuntimeAuthProfileStoreSnapshots([
        { store: result.authStore },
        ...result.agentDirs.map((agentDir) => ({ agentDir, store: result.authStore })),
      ]);
      console.log("[elytras] Config runtime mise à jour depuis la DB");
    }
  } catch (err) {
    console.error("[elytras] Erreur lors de la sync config:", err);
  }
}

/**
 * Démarre la boucle de synchronisation DB → OpenClaw runtime config.
 * @param intervalMs Intervalle entre deux syncs (défaut: 5000ms)
 */
export async function startElytrasSyncLoop(intervalMs = 5000): Promise<void> {
  if (syncLoopHandle) {
    return;
  } // déjà démarré

  // Sync initiale (bloquante pour garantir que la config est prête avant le démarrage)
  await syncOnce();

  syncLoopHandle = setInterval(() => {
    void syncOnce();
  }, intervalMs);
}

export function stopElytrasSyncLoop(): void {
  if (syncLoopHandle) {
    clearInterval(syncLoopHandle);
    syncLoopHandle = null;
  }
}

/**
 * Force une resync immédiate (appeler après une modification en DB).
 */
export async function triggerElytrasSync(): Promise<void> {
  await syncOnce();
}
