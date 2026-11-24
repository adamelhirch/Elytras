import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import JSON5 from "json5";
import type { Connect, NextHandleFunction } from "vite";
import { GatewayClient } from "../src/gateway/client.js";
import { normalizeRpcAttachmentsToChatAttachments } from "../src/gateway/server-methods/attachment-normalize.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { isPathInside } from "../src/infra/path-guards.js";
import { getDefaultMediaLocalRoots } from "../src/media/local-roots.js";
import { detectMime } from "../src/media/mime.js";
import { splitMediaFromOutput } from "../src/media/parse.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import {
  CHANNEL_SETUP_TEMPLATES,
  getChannelSetupTemplate,
  type ChannelSetupTemplateDefinition,
} from "./channel-catalog";

type JsonRecord = Record<string, unknown>;

type GatewayCall = {
  method: string;
  params?: JsonRecord;
};

type GatewayBatchResult = {
  snapshot: JsonRecord | null;
  results: Record<string, unknown>;
};

type ControlTowerStore = {
  version: number;
  users: DashboardUser[];
  teams: DashboardTeam[];
  projects: DashboardProject[];
  channels: DashboardChannel[];
  pipelines: PipelineRecord[];
  pipelineRuns: PipelineRunRecord[];
  cronJobs: CustomCronJob[];
  grants: AccessGrant[];
  agentBindings: AgentBinding[];
  providerBridges: ProviderBridge[];
};

type DashboardUser = {
  id: string;
  name: string;
  email: string;
  title: string;
  phone: string;
  location: string;
  notes: string;
  role: "admin" | "operator" | "member" | "viewer";
  status: "active" | "invited" | "disabled";
  teamIds: string[];
  channelIds: string[];
  agentIds: string[];
  externalIdentities: string[];
  createdAt: string;
  updatedAt: string;
};

type DashboardTeam = {
  id: string;
  name: string;
  color: string;
  description: string;
  contactEmail: string;
  website: string;
  notes: string;
  memberIds: string[];
  agentIds: string[];
  channelIds: string[];
  createdAt: string;
  updatedAt: string;
};

type DashboardProject = {
  id: string;
  name: string;
  description: string;
  teamId: string;
  memberIds: string[];
  agentIds: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
};

type DashboardChannel = {
  id: string;
  name: string;
  kind: string;
  target: string;
  accountId?: string;
  deliveryTarget?: string;
  destinationType?: string;
  surfaceType?: "transport" | "destination" | "system";
  ownerId?: string;
  inboundAgentId?: string;
  enabled: boolean;
  source: "detected" | "custom";
  createdAt: string;
  updatedAt: string;
};

type DashboardActorContext = {
  user: DashboardUser | null;
  requestedUserId: string;
  requestedTeamScopeId: string;
  currentUserCanManageAdminViews: boolean;
  currentUserCanOperate: boolean;
  selectedTeamIds: string[];
  selectedTeamIdSet: Set<string>;
  selectedAgentIds: string[];
  selectedAgentIdSet: Set<string>;
  selectedChannelIds: string[];
  selectedChannelIdSet: Set<string>;
  hasGrant: (
    resourceType: AccessGrant["resourceType"],
    resourceId: string,
    minimumPermission: AccessGrant["permission"],
  ) => boolean;
  canViewAgentRecord: (agentId: string) => boolean;
  canOperateAgentRecord: (agentId: string) => boolean;
  canViewPipelineRecord: (pipeline: PipelineRecord) => boolean;
  canOperatePipelineRecord: (pipeline: PipelineRecord) => boolean;
  canViewCronJobRecord: (job: { id?: string; pipelineId?: string; agentId?: string }) => boolean;
  canOperateCronJobRecord: (job: { id?: string; pipelineId?: string; agentId?: string }) => boolean;
  canViewChannelRoute: (channelId: string) => boolean;
  canOperateChannelRoute: (channelId?: string) => boolean;
  canViewSessionRecord: (session: {
    key?: string;
    agentId?: string;
    pipelineId?: string;
  }) => boolean;
  canOperateSessionRecord: (
    session: { key?: string; agentId?: string; pipelineId?: string } | null | undefined,
  ) => boolean;
};

const SYSTEM_CHANNEL_KINDS = new Set(["heartbeat", "internal", "webchat"]);
const DASHBOARD_LOCAL_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

type ChannelRuntimeAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  linked: boolean;
  connected: boolean;
  running: boolean;
  dmPolicy?: string;
  allowFrom: string[];
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  lastError?: string | null;
  statusLabel: string;
  detailLines: string[];
};

type ChannelCatalogEntry = {
  id: string;
  installed: boolean;
  configured: boolean;
  defaultAccountId?: string;
  template: ChannelSetupTemplateDefinition;
  accounts: ChannelRuntimeAccount[];
};

type ChannelSetupOperation = {
  id: string;
  kind: "configure" | "install" | "login" | "logout" | "remove";
  channelId: string;
  accountId?: string;
  status: "running" | "done" | "failed";
  command: string;
  logs: string[];
  startedAt: string;
  completedAt?: string;
};

type OpenClawInboundRouteBinding = {
  agentId: string;
  channelId: string;
  accountId?: string;
};

type PipelineStep = {
  id: string;
  name: string;
  agentId: string;
  prompt?: string;
  status: "draft" | "queued" | "running" | "paused" | "failed" | "done";
  skills: string[];
  output: string;
  nextStepIds?: string[];
  routingMode?: "linear" | "fan-out" | "conditional" | "terminal";
  condition?: string;
  modelRef?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  reasoningLevel?: string;
};

type PipelineRecord = {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  teamId?: string;
  agentIds: string[];
  outputTargets: string[];
  outputDeliveryMode?: "final-only" | "step-only" | "step-and-final";
  status: "draft" | "queued" | "running" | "paused" | "failed" | "done";
  steps: PipelineStep[];
  nodePositions?: Record<string, { x: number; y: number }>;
  viewport?: {
    x: number;
    y: number;
    zoom: number;
  } | null;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
};

type PipelineRunStepResult = {
  stepId: string;
  stepName: string;
  agentId?: string;
  sessionKey: string;
  runId: string;
  status: string;
  output: string;
};

type PipelineRunDeliveryResult = {
  channelId: string;
  channel: string;
  accountId?: string;
  to: string;
  messageId?: string;
  chatId?: string;
  scope: "step" | "final";
  stepId?: string;
  stepName?: string;
  status: "sent" | "skipped";
  reason?: string;
};

type PipelineRunLogEntry = {
  timestamp: string;
  level: "info" | "error" | "success";
  stepId?: string;
  stepName?: string;
  message: string;
};

type PipelineRunRecord = {
  id: string;
  pipelineId: string;
  pipelineName: string;
  outputDeliveryMode: "final-only" | "step-only" | "step-and-final";
  startedAt: string;
  completedAt?: string;
  input?: string;
  status: "running" | "done" | "failed";
  finalOutput: string;
  finalSessionKey?: string;
  error?: string;
  steps: PipelineRunStepResult[];
  deliveries: PipelineRunDeliveryResult[];
  logs: PipelineRunLogEntry[];
};

type CustomCronJob = {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  agentId?: string;
  pipelineId?: string;
  targetType?: "pipeline" | "request";
  schedule?: string;
  input?: string;
  status: "queued" | "running" | "paused" | "failed" | "done";
  outputTargets: string[];
  createdAt: string;
  updatedAt: string;
};

type AccessGrant = {
  id: string;
  subjectType: "user" | "team";
  subjectId: string;
  resourceType:
    | "agent"
    | "skill"
    | "channel"
    | "pipeline"
    | "workspace"
    | "provider"
    | "cron"
    | "*";
  resourceId: string;
  permission: "view" | "operate" | "admin";
  createdAt: string;
  updatedAt: string;
};

type SessionInboundPrincipal = {
  status: "n/a" | "resolved" | "unresolved" | "ambiguous";
  candidateExternalIds: string[];
  senderExternalIds: string[];
  destinationExternalIds: string[];
  senderLabel?: string;
  resolutionSurface?: "sender" | "destination";
  matchedExternalId?: string;
  matchedBy?: "exact" | "pattern";
  userId?: string;
  userName?: string;
  userRole?: DashboardUser["role"];
  userStatus?: DashboardUser["status"];
  teamIds: string[];
  teamNames: string[];
  authorizingTeamIds?: string[];
  authorizingTeamNames?: string[];
  targetAgentId?: string;
  accessibleAgentIds: string[];
  accessibleChannelIds: string[];
  matchedChannelIds: string[];
  canUseChannel: boolean;
  canUseAgent: boolean;
  allowedSkillIds: string[];
  accessSource?: string;
  restrictionSource?: string;
  reason?: string;
  ambiguousUserIds?: string[];
};

type PersistedSessionInboundSender = {
  label?: string;
  id?: string;
  name?: string;
  username?: string;
  tag?: string;
  e164?: string;
  externalIds: string[];
};

type AgentBinding = {
  id: string;
  agentId: string;
  ownerId?: string;
  teamId?: string;
  purpose: string;
  channelIds: string[];
  defaultOutputChannelIds: string[];
  providerIds: string[];
  providerAccountIds?: Record<string, string[]>;
  providerSkillPolicies?: Record<
    string,
    {
      mode: "inherit" | "allow-all" | "deny-all" | "selected";
      skillIds: string[];
    }
  >;
  skillPolicy?: "all" | "selected" | "none";
  skillIds: string[];
  tags: string[];
  preferredModelRef?: string;
  resumePolicy?: "manual" | "prefer-recent" | "sticky";
  dispatchPolicy?: "manual" | "default-channels" | "broadcast";
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  reasoningLevel?: string;
  createdAt: string;
  updatedAt: string;
};

type ManagedMemoryEngineConfig = {
  dbPath?: string;
  storePath?: string;
  dataRoot?: string;
  injectUserContext?: boolean;
  injectTeamContext?: boolean;
  injectProjectContext?: boolean;
  auditLogPath?: string;
  maxInjectedChars?: number;
  summaryModel?: string;
  expansionModel?: string;
  freshTailCount?: number;
  contextThreshold?: number;
  incrementalMaxDepth?: number;
  ignoreSessionPatterns: string[];
  statelessSessionPatterns: string[];
  skipStatelessSessions: boolean;
};

type MemoryEngineStatus = {
  ok: boolean;
  activeEngineId: string;
  configPath: string;
  defaultDbPath: string;
  resolvedPaths: {
    dbPath: string;
    storePath?: string;
    dataRoot?: string;
    auditLogPath?: string;
  };
  dbStats: {
    available: boolean;
    sizeBytes?: number;
    updatedAtMs?: number;
    conversations?: number;
    messages?: number;
    summaries?: number;
  };
  auditLog: {
    path?: string;
    exists: boolean;
    sizeBytes?: number;
    updatedAtMs?: number;
    lineCount?: number;
    lastEventAt?: string;
    lastEventType?: string;
    lastSessionKey?: string;
  };
  managedPluginId: string;
  managedPluginLabel: string;
  managedPlugin: {
    installed: boolean;
    enabled: boolean;
    selected: boolean;
    status?: string;
    version?: string;
    source?: string;
    description?: string;
    toolNames: string[];
    config: ManagedMemoryEngineConfig;
    subagent: {
      allowModelOverride: boolean;
      allowedModels: string[];
    };
  };
};

type AgentMemoryConversation = {
  conversationId: string;
  sessionId?: string;
  sessionKey: string;
  sessionLabel?: string;
  title?: string;
  updatedAt?: string;
  messageCount: number;
  summaryCount: number;
  lastSummaryAt?: string;
};

type AgentMemorySummary = {
  summaryId: string;
  conversationId: string;
  sessionKey: string;
  sessionLabel?: string;
  kind: string;
  depth: number;
  tokenCount?: number;
  model?: string;
  createdAt?: string;
  preview: string;
};

type AgentMemoryMatch = {
  type: "summary" | "message";
  id: string;
  conversationId: string;
  sessionKey: string;
  sessionLabel?: string;
  role?: string;
  createdAt?: string;
  model?: string;
  preview: string;
};

type AgentMemoryInsight = {
  agentId: string;
  searchTerm: string;
  engine: {
    active: boolean;
    installed: boolean;
    selected: boolean;
    dbPath: string;
    available: boolean;
    reason?: string;
  };
  stats: {
    dashboardSessionCount: number;
    indexedSessionCount: number;
    conversationCount: number;
    summaryCount: number;
    messageCount: number;
    lastConversationAt?: string;
    lastSummaryAt?: string;
  };
  trackedSessionKeys: string[];
  conversations: AgentMemoryConversation[];
  summaries: AgentMemorySummary[];
  matches: AgentMemoryMatch[];
};

type OpenClawPluginListJson = {
  workspaceDir?: string;
  plugins?: JsonRecord[];
  diagnostics?: unknown[];
};

type ProviderBridgeModel = {
  id: string;
  name: string;
  api?: "openai-responses" | "openai-chat" | "openai-codex-responses";
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
};

type ProviderBridge = {
  id: string;
  name: string;
  kind: "openai-compatible";
  runtimeBaseUrl: string;
  consoleUrl?: string;
  apiKey?: string;
  managementKey?: string;
  apiMode: "openai-responses" | "openai-chat" | "openai-codex-responses";
  authMode?: "api-key" | "token" | "oauth";
  authHeader: boolean;
  headers: Record<string, string>;
  discoveredModels: ProviderBridgeModel[];
  activeModelIds: string[];
  primaryModelId?: string;
  applyAsDefaultModel: boolean;
  importedProviderId?: string;
  status: "draft" | "ready" | "imported" | "error";
  lastSyncAt?: string;
  lastImportAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

type ProviderAuthProfileLabels = {
  count: number;
  oauth: number;
  token: number;
  apiKey: number;
  labels: string[];
};

type ProviderAuthSource = {
  kind: string;
  detail?: string;
};

type ProviderAuthInventory = {
  provider: string;
  effective?: ProviderAuthSource;
  profiles?: ProviderAuthProfileLabels;
};

type ProviderAuthProfileStatus = {
  profileId: string;
  provider?: string;
  type?: string;
  status: string;
  reasonCode?: string;
  source?: string;
  label?: string;
  expiresAt?: number;
  remainingMs?: number;
};

type ProviderOAuthStatus = {
  provider: string;
  status: string;
  profiles: ProviderAuthProfileStatus[];
  expiresAt?: number;
  remainingMs?: number;
};

type ProviderUsageWindow = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

type ProviderUsageStatus = {
  provider: string;
  displayName: string;
  windows: ProviderUsageWindow[];
  plan?: string;
  error?: string;
};

type CliproxyAuthFile = {
  id: string;
  name: string;
  provider: string;
  label?: string;
  status?: string;
  statusMessage?: string;
  disabled?: boolean;
  unavailable?: boolean;
  runtimeOnly?: boolean;
  source?: string;
  path?: string;
  size?: number;
  modtime?: string;
  email?: string;
  accountType?: string;
  account?: string;
  createdAt?: string;
  updatedAt?: string;
  lastRefresh?: string;
  usage?: ProviderUsageStatus;
};

type CliproxyStatusResponse = {
  ok: true;
  available: boolean;
  runtimeBaseUrl?: string;
  managementBaseUrl?: string;
  importedProviderId?: string;
  runtimeMode?: "local-binary";
  projectDir?: string;
  projectConfigPath?: string;
  projectComposePath?: string;
  projectSourcePath?: string;
  projectBinaryPath?: string;
  projectPidPath?: string;
  projectAuthDir?: string;
  managementConfigured: boolean;
  remoteManagementDisabled: boolean;
  authFilesSource: "management" | "project-auth-dir";
  modelsSource: "runtime" | "bridge";
  warnings: string[];
  authFiles: CliproxyAuthFile[];
  geminiApiKeys: Array<Record<string, unknown>>;
  codexApiKeys: Array<Record<string, unknown>>;
  claudeApiKeys: Array<Record<string, unknown>>;
  openAiCompatibility: Array<Record<string, unknown>>;
  oauthExcludedModels: Record<string, string[]>;
  usageStatisticsEnabled?: boolean;
  switchProjectOnQuotaExceeded?: boolean;
  switchPreviewModelOnQuotaExceeded?: boolean;
  models: ProviderBridgeModel[];
};

type CliproxyImportOpenClawAuthResponse = {
  ok: true;
  imported: number;
  providers: string[];
  restarted: boolean;
};

type OpenClawModelsStatusJson = {
  configPath?: string;
  agentDir?: string;
  defaultModel?: string;
  resolvedDefault?: string;
  fallbacks?: string[];
  auth?: {
    storePath?: string;
    providersWithOAuth?: string[];
    missingProvidersInUse?: string[];
    providers?: ProviderAuthInventory[];
    unusableProfiles?: Array<Record<string, unknown>>;
    oauth?: {
      profiles?: ProviderAuthProfileStatus[];
      providers?: ProviderOAuthStatus[];
    };
  };
};

type CachedValue<T> = {
  value?: T;
  updatedAt?: number;
  inFlight?: Promise<T>;
};

type ProjectCliproxyBootstrap = {
  apiKey: string;
  managementKey: string;
  runtimeBaseUrl: string;
  consoleUrl: string;
  runtimeMode: "local-binary";
  projectDir: string;
  configPath: string;
  composePath: string;
  sourcePath: string;
  binaryPath: string;
  pidPath: string;
  authDir: string;
  logDir: string;
  configChanged?: boolean;
};

type CliproxyModelProbeResult = {
  checkedAt: string;
  supportedModelIds: string[];
  unsupportedModelIds: string[];
};

type RuntimeEnvField = {
  key: string;
  value: string;
  secret?: boolean;
  redacted?: boolean;
};

type RuntimeEnvStatus = {
  ok: boolean;
  backendHealthy: boolean;
  backendLogPath: string;
  startScriptPath: string;
  gatewayUrl: string;
  gatewayToken: string;
  docsUrl: string;
  openClawEnv: {
    configPath: string;
    sourceOrder: string[];
    inlineFields: RuntimeEnvField[];
    varsFields: RuntimeEnvField[];
    shellEnvEnabled: boolean;
    shellEnvTimeoutMs: string;
  };
  effective: {
    backendRoot: string;
    cliBin: string;
    runtimeDir: string;
    stateDir: string;
    workspaceDir: string;
    configPath: string;
    gatewayPort: string;
    gatewayToken: string;
    gatewayUrl: string;
  };
};

type RuntimeLinkValues = {
  backendRoot: string;
  cliBin: string;
  runtimeDir: string;
  stateDir: string;
  workspaceDir: string;
  configPath: string;
  gatewayPort: string;
  gatewayToken: string;
  gatewayUrl: string;
  dashboardGatewayToken: string;
};

type RuntimeLinkChecks = {
  backendEntrypointExists: boolean;
  cliResolvable: boolean;
  envFileExists: boolean;
  configExists: boolean;
  stateDirExists: boolean;
  workspaceDirExists: boolean;
  usingIsolatedRuntime: boolean;
  linkedOpenClawConfigExists: boolean;
};

type RuntimeLinkStatus = {
  ok: boolean;
  envFilePath: string;
  envFileExists: boolean;
  values: RuntimeLinkValues;
  presets: {
    linkedOpenClaw: RuntimeLinkValues;
    isolatedControlTower: RuntimeLinkValues;
  };
  checks: RuntimeLinkChecks;
  detected: {
    backendRoot: string;
    openClawHomeStateDir: string;
    openClawHomeConfigPath: string;
    openClawHomeWorkspaceDir: string;
  };
};

type SkillLibraryScope = "shared" | "agent";

type DashboardSkillLibrary = {
  id: string;
  scope: SkillLibraryScope;
  kind: "managed" | "personal" | "workspace" | "overlay" | "runtime";
  label: string;
  description: string;
  rootPath: string;
  source: string;
  agentId?: string;
  agentLabel?: string;
};

type DashboardSkillEntry = {
  id: string;
  libraryId: string;
  scope: SkillLibraryScope;
  kind: DashboardSkillLibrary["kind"];
  dirName: string;
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  rootPath: string;
  source: string;
  disableModelInvocation: boolean;
  updatedAtMs: number;
  agentId?: string;
  agentLabel?: string;
};

type DashboardSkillImportSourceType = "git" | "zip-url" | "zip-upload" | "skill-md";

type DashboardSkillImportPayload = {
  libraryId?: unknown;
  sourceType?: unknown;
  overwrite?: unknown;
  repoUrl?: unknown;
  ref?: unknown;
  sourcePath?: unknown;
  archiveUrl?: unknown;
  archiveBase64?: unknown;
  fileName?: unknown;
  dirName?: unknown;
  content?: unknown;
};

type ParsedEnvLine =
  | {
      kind: "entry";
      key: string;
      value: string;
    }
  | {
      kind: "raw";
      raw: string;
    };

const CONTROL_TOWER_UI_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(CONTROL_TOWER_UI_ROOT, "..");
const ELYTRAS_ROOT = PROJECT_ROOT;
const SIBLING_OPENCLAW_ROOT = path.resolve(PROJECT_ROOT, "..", "openclaw");
const DEFAULT_PROJECT_ENV_FILE =
  process.env.ELYTRAS_ENV_FILE || path.join(ELYTRAS_ROOT, ".env.local");
const BOOTSTRAP_PROJECT_ENV_VALUES = (() => {
  const raw = fsSync.existsSync(DEFAULT_PROJECT_ENV_FILE)
    ? fsSync.readFileSync(DEFAULT_PROJECT_ENV_FILE, "utf8")
    : "";
  const values: Record<string, string> = {};
  for (const line of parseEnvFile(raw)) {
    if (line.kind === "entry") {
      values[line.key] = line.value;
    }
  }
  return values;
})();

const DEFAULT_GATEWAY_URL =
  process.env.VITE_OPENCLAW_BASE_URL ||
  BOOTSTRAP_PROJECT_ENV_VALUES.VITE_OPENCLAW_BASE_URL ||
  "http://127.0.0.1:18789";
const DEFAULT_GATEWAY_TOKEN =
  process.env.VITE_OPENCLAW_GATEWAY_TOKEN ||
  BOOTSTRAP_PROJECT_ENV_VALUES.VITE_OPENCLAW_GATEWAY_TOKEN ||
  "openclaw-local-token";
const DEFAULT_STATE_DIR =
  process.env.OPENCLAW_STATE_DIR ||
  BOOTSTRAP_PROJECT_ENV_VALUES.OPENCLAW_STATE_DIR ||
  path.join(os.homedir(), ".openclaw");
const DEFAULT_WORKSPACE_ROOT =
  process.env.OPENCLAW_WORKSPACE_DIR ||
  BOOTSTRAP_PROJECT_ENV_VALUES.OPENCLAW_WORKSPACE_DIR ||
  path.join(os.homedir(), ".openclaw", "workspaces", "default");
const DEFAULT_MANAGED_SKILLS_DIR = path.join(os.homedir(), ".openclaw", "skills");
const DEFAULT_PERSONAL_SKILLS_DIR = path.join(os.homedir(), ".agents", "skills");
const DEFAULT_STORE_PATH =
  process.env.CONTROL_TOWER_STORE_PATH ||
  BOOTSTRAP_PROJECT_ENV_VALUES.CONTROL_TOWER_STORE_PATH ||
  path.join(os.homedir(), ".openclaw", "elytras", "runtime", "control-tower-store.json");
const DEFAULT_GATEWAY_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH ||
  BOOTSTRAP_PROJECT_ENV_VALUES.OPENCLAW_CONFIG_PATH ||
  path.join(path.dirname(DEFAULT_STORE_PATH), "openclaw.json");
const DEFAULT_BRIDGE_RUNTIME_URL =
  process.env.CONTROL_TOWER_BRIDGE_URL || "http://127.0.0.1:8317/v1";
const DEFAULT_BRIDGE_CONSOLE_URL =
  process.env.CONTROL_TOWER_BRIDGE_CONSOLE_URL || "http://127.0.0.1:8317";
const DASHBOARD_PROVIDER_ID = "cliproxyapi";
const DASHBOARD_ROOT_USER_ID = "__elytras-root__";
const DASHBOARD_ALL_TEAMS_SCOPE_ID = "__all_teams__";
const DASHBOARD_USER_HEADER = "x-ct-dashboard-user";
const DASHBOARD_TEAM_SCOPE_HEADER = "x-ct-dashboard-team-scope";
const DEFAULT_BACKEND_LOG_PATH = path.join(ELYTRAS_ROOT, ".logs", "backend.log");
const OPENCLAW_HOME_STATE_DIR = path.join(os.homedir(), ".openclaw");
const OPENCLAW_HOME_CONFIG_PATH = path.join(OPENCLAW_HOME_STATE_DIR, "openclaw.json");
const OPENCLAW_HOME_WORKSPACE_DIR = path.join(OPENCLAW_HOME_STATE_DIR, "workspaces", "default");
const DEFAULT_CLIPROXY_PROJECT_DIR =
  process.env.CONTROL_TOWER_CLIPROXY_DIR ||
  path.join(CONTROL_TOWER_UI_ROOT, ".runtime", "cliproxyapi");
const DEFAULT_CLIPROXY_CONFIG_PATH = path.join(DEFAULT_CLIPROXY_PROJECT_DIR, "config.yaml");
const CLIPROXY_AUTH_USAGE_CACHE_TTL_MS = 30_000;
const cliproxyAuthUsageCache = new Map<string, CachedValue<ProviderUsageStatus | undefined>>();
const DEFAULT_CLIPROXY_COMPOSE_PATH = path.join(DEFAULT_CLIPROXY_PROJECT_DIR, "docker-compose.yml");
const DEFAULT_CLIPROXY_AUTH_DIR = path.join(DEFAULT_CLIPROXY_PROJECT_DIR, "auths");
const DEFAULT_CLIPROXY_LOG_DIR = path.join(DEFAULT_CLIPROXY_PROJECT_DIR, "logs");
const DEFAULT_CLIPROXY_BOOTSTRAP_PATH = path.join(DEFAULT_CLIPROXY_PROJECT_DIR, "bootstrap.json");
const DEFAULT_CLIPROXY_SOURCE_PATH = path.join(DEFAULT_CLIPROXY_PROJECT_DIR, "src", "CLIProxyAPI");
const DEFAULT_CLIPROXY_BINARY_PATH = path.join(
  DEFAULT_CLIPROXY_PROJECT_DIR,
  "bin",
  "CLIProxyAPIPlus",
);
const DEFAULT_CLIPROXY_PID_PATH = path.join(DEFAULT_CLIPROXY_PROJECT_DIR, "cliproxyapi.pid");
const DEFAULT_CLIPROXY_RUNTIME_AUTH_DIR = DEFAULT_CLIPROXY_AUTH_DIR;
const OPENCLAW_REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";
const DEFAULT_OPENCLAW_AUTH_PROFILES_PATH =
  process.env.CONTROL_TOWER_OPENCLAW_AUTH_PROFILES_PATH ||
  path.join(DEFAULT_STATE_DIR, "agents", "main", "agent", "auth-profiles.json");
const DEFAULT_GATEWAY_OPERATOR_DEVICE_IDENTITY_PATH =
  process.env.CONTROL_TOWER_GATEWAY_OPERATOR_DEVICE_IDENTITY_PATH ||
  path.join(DEFAULT_STATE_DIR, "elytras", "operator-device.json");
const DETECTED_BACKEND_ROOT = fsSync.existsSync(path.join(ELYTRAS_ROOT, "openclaw.mjs"))
  ? ELYTRAS_ROOT
  : fsSync.existsSync(path.join(SIBLING_OPENCLAW_ROOT, "openclaw.mjs"))
    ? SIBLING_OPENCLAW_ROOT
    : path.resolve(ELYTRAS_ROOT, "..");
const DEFAULT_BACKEND_ROOT = process.env.CONTROL_TOWER_BACKEND_ROOT || DETECTED_BACKEND_ROOT;
const DEFAULT_OPENCLAW_ENTRYPOINT_PATH = path.join(DEFAULT_BACKEND_ROOT, "openclaw.mjs");
const DEFAULT_OPENCLAW_CLI_BIN = normalizeOptionalString(process.env.OPENCLAW_CLI_BIN);
const DEFAULT_BACKEND_START_SCRIPT =
  process.env.CONTROL_TOWER_BACKEND_START_SCRIPT ||
  path.join(ELYTRAS_ROOT, "scripts", "run-openclaw-backend.sh");
const DEFAULT_OPENCLAW_WRAPPER_SCRIPT =
  process.env.ELYTRAS_OPENCLAW_WRAPPER ||
  (fsSync.existsSync(path.join(DEFAULT_BACKEND_ROOT, "scripts", "openclaw-cli.sh"))
    ? path.join(DEFAULT_BACKEND_ROOT, "scripts", "openclaw-cli.sh")
    : path.join(ELYTRAS_ROOT, "scripts", "openclaw-cli.sh"));
const RUNTIME_LINK_ENV_KEYS = [
  "CONTROL_TOWER_BACKEND_ROOT",
  "OPENCLAW_CLI_BIN",
  "OPENCLAW_RUNTIME_DIR",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_WORKSPACE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_GATEWAY_TOKEN",
  "VITE_OPENCLAW_BASE_URL",
  "VITE_OPENCLAW_GATEWAY_TOKEN",
] as const;
const OPENCLAW_ENV_DOCS_URL =
  "https://docs.openclaw.ai/gateway/configuration-reference#env-inline-env-vars";
const CLIPROXY_MODEL_PROBE_CACHE_TTL_MS = 10 * 60 * 1000;
let sqliteModulePromise: Promise<typeof import("node:sqlite")> | null = null;
const CLIPROXY_PRIMARY_MODEL_ORDER = [
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-codex-mini",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-max",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
];

let lastDashboardPayload: JsonRecord | null = null;
const channelOperations = new Map<string, ChannelSetupOperation>();
const channelOperationOrder: string[] = [];
const cliproxyModelProbeCache = new Map<string, CachedValue<CliproxyModelProbeResult>>();
const HAS_PATH_OPENCLAW_CLI =
  !DEFAULT_OPENCLAW_CLI_BIN &&
  spawnSync(process.platform === "win32" ? "where" : "which", ["openclaw"], {
    stdio: "ignore",
  }).status === 0;

const MEMORY_FILE_NAMES = new Set([
  "AGENTS.md",
  "MEMORY.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "SOUL.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "memory.md",
]);

const STORE_RESOURCES = new Set([
  "users",
  "teams",
  "projects",
  "channels",
  "pipelines",
  "cronJobs",
  "grants",
  "agentBindings",
  "providerBridges",
]);

function maskToken(token: string): string {
  if (token.length <= 8) {
    return "***";
  }
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

type OpenClawCliInvocation = {
  command: string;
  args: string[];
  display: string;
  cwd: string;
};

function canResolveExecutable(command: string) {
  if (!command.trim()) {
    return false;
  }
  if (command.includes("/") || command.includes("\\")) {
    return fsSync.existsSync(command);
  }
  return (
    spawnSync(process.platform === "win32" ? "where" : "which", [command], {
      stdio: "ignore",
    }).status === 0
  );
}

function resolveOpenClawCliInvocation(args: string[]): OpenClawCliInvocation {
  const runtimeEnv = buildRuntimeEnvStatusSync();
  const backendRoot = runtimeEnv.effective.backendRoot;
  if (fsSync.existsSync(DEFAULT_OPENCLAW_WRAPPER_SCRIPT)) {
    const wrapperDisplayPath = path.relative(ELYTRAS_ROOT, DEFAULT_OPENCLAW_WRAPPER_SCRIPT);
    return {
      command: DEFAULT_OPENCLAW_WRAPPER_SCRIPT,
      args,
      display: [wrapperDisplayPath || "scripts/openclaw-cli.sh", ...args].join(" "),
      cwd: backendRoot,
    };
  }
  const cliBin = runtimeEnv.effective.cliBin || DEFAULT_OPENCLAW_CLI_BIN;
  const entrypointPath = path.join(backendRoot, "openclaw.mjs");
  if (cliBin && canResolveExecutable(cliBin)) {
    return {
      command: cliBin,
      args,
      display: [cliBin, ...args].join(" "),
      cwd: backendRoot,
    };
  }
  if (HAS_PATH_OPENCLAW_CLI) {
    return {
      command: "openclaw",
      args,
      display: ["openclaw", ...args].join(" "),
      cwd: backendRoot,
    };
  }
  if (fsSync.existsSync(entrypointPath)) {
    return {
      command: process.execPath,
      args: [entrypointPath, ...args],
      display: `node openclaw.mjs ${args.join(" ")}`,
      cwd: backendRoot,
    };
  }
  return {
    command: "openclaw",
    args,
    display: ["openclaw", ...args].join(" "),
    cwd: backendRoot,
  };
}

function buildOpenClawCliEnv() {
  const runtimeEnv = buildRuntimeEnvStatusSync();
  return {
    ...process.env,
    OPENCLAW_CONFIG_PATH: runtimeEnv.effective.configPath,
    OPENCLAW_STATE_DIR: runtimeEnv.effective.stateDir,
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function splitListInput(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  }
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(/[,|\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeIdList(value: unknown) {
  return Array.from(new Set(splitListInput(value)));
}

function normalizeUserRole(value: unknown): DashboardUser["role"] {
  const normalized = normalizeOptionalString(value);
  switch (normalized) {
    case "admin":
    case "operator":
    case "viewer":
      return normalized;
    default:
      return "member";
  }
}

function normalizeUserStatus(value: unknown): DashboardUser["status"] {
  const normalized = normalizeOptionalString(value);
  switch (normalized) {
    case "invited":
    case "disabled":
      return normalized;
    default:
      return "active";
  }
}

function normalizeGrantPermission(value: unknown): AccessGrant["permission"] {
  const normalized = normalizeOptionalString(value);
  switch (normalized) {
    case "admin":
    case "operate":
      return normalized;
    default:
      return "view";
  }
}

function normalizeExternalIdentityPatternList(value: unknown) {
  return Array.from(
    new Set(
      splitListInput(value)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function normalizeDashboardUserRecord(
  value: unknown,
  now: string,
  fallback?: Partial<DashboardUser>,
): DashboardUser {
  const record = isJsonRecord(value) ? value : {};
  const id = normalizeOptionalString(record.id) || fallback?.id || randomUUID();
  const name = normalizeOptionalString(record.name) || fallback?.name || id;
  return {
    id,
    name,
    email: normalizeOptionalString(record.email) || fallback?.email || `${slugify(name)}@local`,
    title: normalizeOptionalString(record.title) || fallback?.title || "",
    phone: normalizeOptionalString(record.phone) || fallback?.phone || "",
    location: normalizeOptionalString(record.location) || fallback?.location || "",
    notes: normalizeOptionalString(record.notes) || fallback?.notes || "",
    role: normalizeUserRole(record.role ?? fallback?.role),
    status: normalizeUserStatus(record.status ?? fallback?.status),
    teamIds: normalizeIdList(record.teamIds ?? fallback?.teamIds),
    channelIds: normalizeIdList(record.channelIds ?? fallback?.channelIds),
    agentIds: normalizeIdList(record.agentIds ?? fallback?.agentIds),
    externalIdentities: normalizeExternalIdentityPatternList(
      record.externalIdentities ?? fallback?.externalIdentities,
    ),
    createdAt: normalizeOptionalString(record.createdAt) || fallback?.createdAt || now,
    updatedAt: now,
  };
}

function normalizeDashboardTeamRecord(
  value: unknown,
  now: string,
  fallback?: Partial<DashboardTeam>,
): DashboardTeam {
  const record = isJsonRecord(value) ? value : {};
  const id = normalizeOptionalString(record.id) || fallback?.id || randomUUID();
  return {
    id,
    name: normalizeOptionalString(record.name) || fallback?.name || id,
    color: normalizeOptionalString(record.color) || fallback?.color || "#234b40",
    description: normalizeOptionalString(record.description) || fallback?.description || "",
    contactEmail: normalizeOptionalString(record.contactEmail) || fallback?.contactEmail || "",
    website: normalizeOptionalString(record.website) || fallback?.website || "",
    notes: normalizeOptionalString(record.notes) || fallback?.notes || "",
    memberIds: normalizeIdList(record.memberIds ?? fallback?.memberIds),
    agentIds: normalizeIdList(record.agentIds ?? fallback?.agentIds),
    channelIds: normalizeIdList(record.channelIds ?? fallback?.channelIds),
    createdAt: normalizeOptionalString(record.createdAt) || fallback?.createdAt || now,
    updatedAt: now,
  };
}

function normalizeDashboardProjectRecord(
  value: unknown,
  now: string,
  fallback?: Partial<DashboardProject>,
): DashboardProject {
  const record = isJsonRecord(value) ? value : {};
  const id = normalizeOptionalString(record.id) || fallback?.id || randomUUID();
  return {
    id,
    name: normalizeOptionalString(record.name) || fallback?.name || id,
    description: normalizeOptionalString(record.description) || fallback?.description || "",
    teamId: normalizeOptionalString(record.teamId) || fallback?.teamId || "",
    memberIds: normalizeIdList(record.memberIds ?? fallback?.memberIds),
    agentIds: normalizeIdList(record.agentIds ?? fallback?.agentIds),
    notes: normalizeOptionalString(record.notes) || fallback?.notes || "",
    createdAt: normalizeOptionalString(record.createdAt) || fallback?.createdAt || now,
    updatedAt: now,
  };
}

function normalizeAccessGrantRecord(
  value: unknown,
  now: string,
  fallback?: Partial<AccessGrant>,
): AccessGrant {
  const record = isJsonRecord(value) ? value : {};
  const resourceType = normalizeOptionalString(record.resourceType ?? fallback?.resourceType);
  const subjectType = normalizeOptionalString(record.subjectType ?? fallback?.subjectType);
  return {
    id: normalizeOptionalString(record.id) || fallback?.id || randomUUID(),
    subjectType: subjectType === "team" ? "team" : "user",
    subjectId: normalizeOptionalString(record.subjectId) || fallback?.subjectId || "",
    resourceType:
      resourceType === "agent" ||
      resourceType === "skill" ||
      resourceType === "channel" ||
      resourceType === "pipeline" ||
      resourceType === "workspace" ||
      resourceType === "provider" ||
      resourceType === "cron" ||
      resourceType === "*"
        ? resourceType
        : "*",
    resourceId: normalizeOptionalString(record.resourceId) || fallback?.resourceId || "*",
    permission: normalizeGrantPermission(record.permission ?? fallback?.permission),
    createdAt: normalizeOptionalString(record.createdAt) || fallback?.createdAt || now,
    updatedAt: now,
  };
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeOptionalNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseEnvValue(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/'"'"'"'"'"'"'"'"'/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function formatEnvValue(value: string) {
  if (!value) {
    return "";
  }
  if (/^[A-Za-z0-9_./:@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function parseEnvFile(raw: string): ParsedEnvLine[] {
  return raw.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) {
      return { kind: "raw", raw: line } satisfies ParsedEnvLine;
    }
    return {
      kind: "entry",
      key: match[1],
      value: parseEnvValue(match[2] || ""),
    } satisfies ParsedEnvLine;
  });
}

function readProjectEnvLinesSync() {
  const raw = fsSync.existsSync(DEFAULT_PROJECT_ENV_FILE)
    ? fsSync.readFileSync(DEFAULT_PROJECT_ENV_FILE, "utf8")
    : "";
  return {
    exists: Boolean(raw) || fsSync.existsSync(DEFAULT_PROJECT_ENV_FILE),
    lines: parseEnvFile(raw),
  };
}

function readProjectEnvValuesSync() {
  const { exists, lines } = readProjectEnvLinesSync();
  const values: Record<string, string> = {};
  for (const line of lines) {
    if (line.kind === "entry") {
      values[line.key] = line.value;
    }
  }
  return { exists, lines, values };
}

function computeEffectiveRuntimeEnv(values: Record<string, string>) {
  const runtimeDir =
    normalizeOptionalString(values.OPENCLAW_RUNTIME_DIR) ||
    path.join(os.homedir(), ".openclaw", "elytras", "runtime");
  const gatewayPort = normalizeOptionalString(values.OPENCLAW_GATEWAY_PORT) || "18789";
  const gatewayToken =
    normalizeOptionalString(values.OPENCLAW_GATEWAY_TOKEN) || "openclaw-local-token";
  const gatewayUrl =
    normalizeOptionalString(values.VITE_OPENCLAW_BASE_URL) || `http://127.0.0.1:${gatewayPort}`;
  return {
    backendRoot:
      normalizeOptionalString(values.CONTROL_TOWER_BACKEND_ROOT) || DETECTED_BACKEND_ROOT,
    cliBin: normalizeOptionalString(values.OPENCLAW_CLI_BIN) || "",
    runtimeDir,
    stateDir: normalizeOptionalString(values.OPENCLAW_STATE_DIR) || path.join(runtimeDir, "state"),
    workspaceDir:
      normalizeOptionalString(values.OPENCLAW_WORKSPACE_DIR) || path.join(runtimeDir, "workspace"),
    configPath:
      normalizeOptionalString(values.OPENCLAW_CONFIG_PATH) ||
      path.join(runtimeDir, "openclaw.json"),
    gatewayPort,
    gatewayToken,
    gatewayUrl,
    dashboardGatewayToken:
      normalizeOptionalString(values.VITE_OPENCLAW_GATEWAY_TOKEN) || gatewayToken,
  };
}

function createRuntimeLinkValues(values: Partial<RuntimeLinkValues>): RuntimeLinkValues {
  return {
    backendRoot: values.backendRoot || "",
    cliBin: values.cliBin || "",
    runtimeDir: values.runtimeDir || "",
    stateDir: values.stateDir || "",
    workspaceDir: values.workspaceDir || "",
    configPath: values.configPath || "",
    gatewayPort: values.gatewayPort || "",
    gatewayToken: values.gatewayToken || "",
    gatewayUrl: values.gatewayUrl || "",
    dashboardGatewayToken: values.dashboardGatewayToken || "",
  };
}

function readJson5FileSync(filePath: string) {
  if (!filePath || !fsSync.existsSync(filePath)) {
    return {} as JsonRecord;
  }
  try {
    const parsed = JSON5.parse(fsSync.readFileSync(filePath, "utf8"));
    return isJsonRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeChannelBindingId(value: unknown) {
  return normalizeOptionalString(value)?.toLowerCase() || "";
}

function parseOpenClawInboundRouteBindings(config: JsonRecord) {
  const rawBindings = Array.isArray(config.bindings) ? config.bindings : [];
  const bindings: OpenClawInboundRouteBinding[] = [];
  for (const entry of rawBindings) {
    if (!isJsonRecord(entry) || normalizeOptionalString(entry.type) !== "route") {
      continue;
    }
    const agentId = normalizeOptionalString(entry.agentId);
    const match = isJsonRecord(entry.match) ? entry.match : {};
    const channelId = normalizeChannelBindingId(match.channel);
    if (!agentId || !channelId) {
      continue;
    }
    const rawAccountId =
      normalizeOptionalString(match.accountId) || normalizeOptionalString(match.account);
    bindings.push({
      agentId,
      channelId,
      ...(rawAccountId ? { accountId: normalizeAccountId(rawAccountId) } : {}),
    });
  }
  return bindings;
}

function loadOpenClawInboundRouteBindingsSync(configPath: string) {
  return parseOpenClawInboundRouteBindings(readJson5FileSync(configPath));
}

function resolveBoundInboundAgentId(
  bindings: OpenClawInboundRouteBinding[],
  channelId: string,
  accountId?: string,
) {
  const normalizedChannelId = normalizeChannelBindingId(channelId);
  if (!normalizedChannelId || isSystemChannelKind(normalizedChannelId)) {
    return undefined;
  }
  const normalizedAccountId = normalizeAccountId(accountId);
  const exact = bindings.find(
    (binding) =>
      binding.channelId === normalizedChannelId &&
      binding.accountId &&
      normalizeAccountId(binding.accountId) === normalizedAccountId,
  );
  if (exact?.agentId) {
    return exact.agentId;
  }
  const fallback = bindings.find(
    (binding) =>
      binding.channelId === normalizedChannelId && !normalizeOptionalString(binding.accountId),
  );
  return fallback?.agentId;
}

function applyOpenClawInboundBindings(
  channels: DashboardChannel[],
  bindings: OpenClawInboundRouteBinding[],
) {
  return channels.map((channel) => {
    if (resolveDashboardChannelSurfaceType(channel) !== "transport") {
      const { inboundAgentId: _ignoredInboundAgentId, ...rest } = channel;
      void _ignoredInboundAgentId;
      return rest;
    }
    const inboundAgentId = resolveBoundInboundAgentId(bindings, channel.kind, channel.accountId);
    if (!inboundAgentId) {
      const { inboundAgentId: _ignoredInboundAgentId, ...rest } = channel;
      void _ignoredInboundAgentId;
      return rest;
    }
    return {
      ...channel,
      inboundAgentId,
    };
  });
}

function readGatewayHintsFromConfigPath(configPath: string) {
  const config = readJson5FileSync(configPath);
  const gateway = isJsonRecord(config.gateway) ? config.gateway : {};
  const auth = isJsonRecord(gateway.auth) ? gateway.auth : {};
  return {
    gatewayPort:
      normalizeOptionalNumber(gateway.port) !== undefined
        ? String(normalizeOptionalNumber(gateway.port))
        : "",
    gatewayToken: normalizeOptionalString(auth.token) || "",
  };
}

function buildIsolatedRuntimeLinkValues(currentValues: Record<string, string>) {
  const effective = computeEffectiveRuntimeEnv({});
  return createRuntimeLinkValues({
    backendRoot:
      normalizeOptionalString(currentValues.CONTROL_TOWER_BACKEND_ROOT) || DETECTED_BACKEND_ROOT,
    cliBin:
      normalizeOptionalString(currentValues.OPENCLAW_CLI_BIN) || DEFAULT_OPENCLAW_CLI_BIN || "",
    runtimeDir: effective.runtimeDir,
    stateDir: effective.stateDir,
    workspaceDir: effective.workspaceDir,
    configPath: effective.configPath,
    gatewayPort: effective.gatewayPort,
    gatewayToken: effective.gatewayToken,
    gatewayUrl: effective.gatewayUrl,
    dashboardGatewayToken: effective.dashboardGatewayToken,
  });
}

function buildLinkedOpenClawRuntimeValues(currentValues: Record<string, string>) {
  const gatewayHints = readGatewayHintsFromConfigPath(OPENCLAW_HOME_CONFIG_PATH);
  const gatewayPort =
    normalizeOptionalString(currentValues.OPENCLAW_GATEWAY_PORT) ||
    gatewayHints.gatewayPort ||
    "18789";
  const gatewayToken =
    normalizeOptionalString(currentValues.OPENCLAW_GATEWAY_TOKEN) ||
    gatewayHints.gatewayToken ||
    "openclaw-local-token";
  return createRuntimeLinkValues({
    backendRoot:
      normalizeOptionalString(currentValues.CONTROL_TOWER_BACKEND_ROOT) || DETECTED_BACKEND_ROOT,
    cliBin:
      normalizeOptionalString(currentValues.OPENCLAW_CLI_BIN) || DEFAULT_OPENCLAW_CLI_BIN || "",
    runtimeDir:
      normalizeOptionalString(currentValues.OPENCLAW_RUNTIME_DIR) ||
      path.join(os.homedir(), ".openclaw", "elytras", "runtime"),
    stateDir: normalizeOptionalString(currentValues.OPENCLAW_STATE_DIR) || OPENCLAW_HOME_STATE_DIR,
    workspaceDir:
      normalizeOptionalString(currentValues.OPENCLAW_WORKSPACE_DIR) || OPENCLAW_HOME_WORKSPACE_DIR,
    configPath:
      normalizeOptionalString(currentValues.OPENCLAW_CONFIG_PATH) || OPENCLAW_HOME_CONFIG_PATH,
    gatewayPort,
    gatewayToken,
    gatewayUrl:
      normalizeOptionalString(currentValues.VITE_OPENCLAW_BASE_URL) ||
      `http://127.0.0.1:${gatewayPort}`,
    dashboardGatewayToken:
      normalizeOptionalString(currentValues.VITE_OPENCLAW_GATEWAY_TOKEN) || gatewayToken,
  });
}

function serializeEnvLines(lines: ParsedEnvLine[]) {
  return `${lines
    .map((line) => (line.kind === "entry" ? `${line.key}=${formatEnvValue(line.value)}` : line.raw))
    .join("\n")
    .replace(/\n+$/g, "")}\n`;
}

function upsertProjectEnvValues(nextValues: Record<string, string>) {
  const { lines } = readProjectEnvLinesSync();
  const remaining = new Map(Object.entries(nextValues));
  const nextLines: ParsedEnvLine[] = [];

  for (const line of lines) {
    if (line.kind !== "entry") {
      nextLines.push(line);
      continue;
    }
    if (!remaining.has(line.key)) {
      nextLines.push(line);
      continue;
    }
    const nextValue = remaining.get(line.key) || "";
    remaining.delete(line.key);
    if (!nextValue.trim()) {
      continue;
    }
    nextLines.push({
      kind: "entry",
      key: line.key,
      value: nextValue,
    });
  }

  for (const [key, value] of remaining) {
    if (!value.trim()) {
      continue;
    }
    nextLines.push({
      kind: "entry",
      key,
      value,
    });
  }

  return nextLines;
}

function buildRuntimeLinkStatusSync(): RuntimeLinkStatus {
  const projectEnv = readProjectEnvValuesSync();
  const effective = computeEffectiveRuntimeEnv(projectEnv.values);
  const linkedOpenClaw = buildLinkedOpenClawRuntimeValues(projectEnv.values);
  const isolatedControlTower = buildIsolatedRuntimeLinkValues(projectEnv.values);
  const values = createRuntimeLinkValues({
    backendRoot: effective.backendRoot,
    cliBin: effective.cliBin,
    runtimeDir: effective.runtimeDir,
    stateDir: effective.stateDir,
    workspaceDir: effective.workspaceDir,
    configPath: effective.configPath,
    gatewayPort: effective.gatewayPort,
    gatewayToken: effective.gatewayToken,
    gatewayUrl: effective.gatewayUrl,
    dashboardGatewayToken: effective.dashboardGatewayToken,
  });
  return {
    ok: true,
    envFilePath: DEFAULT_PROJECT_ENV_FILE,
    envFileExists: projectEnv.exists,
    values,
    presets: {
      linkedOpenClaw,
      isolatedControlTower,
    },
    checks: {
      backendEntrypointExists: fsSync.existsSync(path.join(values.backendRoot, "openclaw.mjs")),
      cliResolvable: values.cliBin ? canResolveExecutable(values.cliBin) : HAS_PATH_OPENCLAW_CLI,
      envFileExists: projectEnv.exists,
      configExists: fsSync.existsSync(values.configPath),
      stateDirExists: fsSync.existsSync(values.stateDir),
      workspaceDirExists: fsSync.existsSync(values.workspaceDir),
      usingIsolatedRuntime:
        values.configPath === isolatedControlTower.configPath &&
        values.stateDir === isolatedControlTower.stateDir,
      linkedOpenClawConfigExists: fsSync.existsSync(OPENCLAW_HOME_CONFIG_PATH),
    },
    detected: {
      backendRoot: DETECTED_BACKEND_ROOT,
      openClawHomeStateDir: OPENCLAW_HOME_STATE_DIR,
      openClawHomeConfigPath: OPENCLAW_HOME_CONFIG_PATH,
      openClawHomeWorkspaceDir: OPENCLAW_HOME_WORKSPACE_DIR,
    },
  };
}

async function loadRuntimeLinkStatus() {
  return buildRuntimeLinkStatusSync();
}

function normalizeRuntimeLinkValue(value: unknown, label: keyof RuntimeLinkValues) {
  const normalized = normalizeOptionalString(value) || "";
  if (label === "backendRoot" && !normalized) {
    throw new Error("backendRoot is required.");
  }
  return normalized;
}

async function saveRuntimeLinkValues(body: JsonRecord) {
  const nextValues = Object.fromEntries(RUNTIME_LINK_ENV_KEYS.map((key) => [key, ""])) as Record<
    (typeof RUNTIME_LINK_ENV_KEYS)[number],
    string
  >;

  nextValues.CONTROL_TOWER_BACKEND_ROOT = normalizeRuntimeLinkValue(
    body.backendRoot,
    "backendRoot",
  );
  nextValues.OPENCLAW_CLI_BIN = normalizeRuntimeLinkValue(body.cliBin, "cliBin");
  nextValues.OPENCLAW_RUNTIME_DIR = normalizeRuntimeLinkValue(body.runtimeDir, "runtimeDir");
  nextValues.OPENCLAW_STATE_DIR = normalizeRuntimeLinkValue(body.stateDir, "stateDir");
  nextValues.OPENCLAW_WORKSPACE_DIR = normalizeRuntimeLinkValue(body.workspaceDir, "workspaceDir");
  nextValues.OPENCLAW_CONFIG_PATH = normalizeRuntimeLinkValue(body.configPath, "configPath");
  nextValues.OPENCLAW_GATEWAY_PORT = normalizeRuntimeLinkValue(body.gatewayPort, "gatewayPort");
  nextValues.OPENCLAW_GATEWAY_TOKEN = normalizeRuntimeLinkValue(body.gatewayToken, "gatewayToken");
  nextValues.VITE_OPENCLAW_BASE_URL = normalizeRuntimeLinkValue(body.gatewayUrl, "gatewayUrl");
  nextValues.VITE_OPENCLAW_GATEWAY_TOKEN = normalizeRuntimeLinkValue(
    body.dashboardGatewayToken,
    "dashboardGatewayToken",
  );

  await fs.mkdir(path.dirname(DEFAULT_PROJECT_ENV_FILE), { recursive: true });
  await fs.writeFile(
    DEFAULT_PROJECT_ENV_FILE,
    serializeEnvLines(upsertProjectEnvValues(nextValues)),
    {
      mode: 0o600,
    },
  );
  return await loadRuntimeLinkStatus();
}

function buildRuntimeEnvStatusSync(): Omit<RuntimeEnvStatus, "backendHealthy" | "openClawEnv"> {
  const { values } = readProjectEnvValuesSync();
  const effective = computeEffectiveRuntimeEnv(values);
  return {
    ok: true,
    backendLogPath: DEFAULT_BACKEND_LOG_PATH,
    startScriptPath: DEFAULT_BACKEND_START_SCRIPT,
    gatewayUrl: effective.gatewayUrl,
    gatewayToken: effective.dashboardGatewayToken,
    docsUrl: OPENCLAW_ENV_DOCS_URL,
    effective: {
      backendRoot: effective.backendRoot,
      cliBin: effective.cliBin,
      runtimeDir: effective.runtimeDir,
      stateDir: effective.stateDir,
      workspaceDir: effective.workspaceDir,
      configPath: effective.configPath,
      gatewayPort: effective.gatewayPort,
      gatewayToken: effective.gatewayToken,
      gatewayUrl: effective.gatewayUrl,
    },
  };
}

function looksSensitiveEnvVarName(key: string) {
  return /(TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SESSION|COOKIE|AUTH)/i.test(
    key,
  );
}

function sortRuntimeEnvFields(fields: RuntimeEnvField[]) {
  return [...fields].sort((left, right) => left.key.localeCompare(right.key));
}

function isEnvPlaceholderValue(value: string) {
  return /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value.trim());
}

async function readRawOpenClawEnvConfig() {
  const runtimeEnv = buildRuntimeEnvStatusSync();
  const configPath = runtimeEnv.effective.configPath;
  if (!fsSync.existsSync(configPath)) {
    return {
      configPath,
      envConfig: {} as JsonRecord,
      inlineValues: {} as Record<string, string>,
      varsValues: {} as Record<string, string>,
      shellEnvConfig: {} as JsonRecord,
    };
  }

  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON5.parse(raw);
  const config = isJsonRecord(parsed) ? parsed : {};
  const envConfig = isJsonRecord(config.env) ? config.env : {};
  const varsConfig = isJsonRecord(envConfig.vars) ? envConfig.vars : {};
  const shellEnvConfig = isJsonRecord(envConfig.shellEnv) ? envConfig.shellEnv : {};
  const inlineValues = Object.fromEntries(
    Object.entries(envConfig).filter(
      ([key, value]) => key !== "shellEnv" && key !== "vars" && typeof value === "string",
    ),
  ) as Record<string, string>;
  const varsValues = Object.fromEntries(
    Object.entries(varsConfig).filter(([, value]) => typeof value === "string"),
  ) as Record<string, string>;

  return {
    configPath,
    envConfig,
    inlineValues,
    varsValues,
    shellEnvConfig,
  };
}

function toDisplayRuntimeEnvField(key: string, value: string): RuntimeEnvField {
  const secret = looksSensitiveEnvVarName(key) && !isEnvPlaceholderValue(value);
  return {
    key,
    value: secret ? OPENCLAW_REDACTED_SENTINEL : value,
    secret,
    redacted: secret,
  };
}

async function readOpenClawEnvConfig() {
  const runtimeEnv = buildRuntimeEnvStatusSync();
  const rawConfig = await readRawOpenClawEnvConfig();

  const inlineFields = sortRuntimeEnvFields(
    Object.entries(rawConfig.inlineValues).map(([key, value]) =>
      toDisplayRuntimeEnvField(key, value),
    ),
  );
  const varsFields = sortRuntimeEnvFields(
    Object.entries(rawConfig.varsValues).map(([key, value]) =>
      toDisplayRuntimeEnvField(key, value),
    ),
  );

  return {
    configPath: rawConfig.configPath || runtimeEnv.effective.configPath,
    sourceOrder: ["process env", ".env courant", "~/.openclaw/.env", "config.env", "env.shellEnv"],
    inlineFields,
    varsFields,
    shellEnvEnabled: rawConfig.shellEnvConfig.enabled === true,
    shellEnvTimeoutMs:
      typeof rawConfig.shellEnvConfig.timeoutMs === "number"
        ? String(rawConfig.shellEnvConfig.timeoutMs)
        : normalizeOptionalString(rawConfig.shellEnvConfig.timeoutMs) || "",
  };
}

async function loadRuntimeEnvStatus() {
  const status = buildRuntimeEnvStatusSync();
  const [backendHealthy, openClawEnv] = await Promise.all([
    isGatewayHealthy(status.gatewayUrl),
    readOpenClawEnvConfig(),
  ]);
  return {
    ...status,
    backendHealthy,
    openClawEnv,
  } satisfies RuntimeEnvStatus;
}

function normalizeRuntimeEnvFieldList(value: unknown, label: string, redactedSentinel: string) {
  if (!Array.isArray(value)) {
    return [] as Array<{ key: string; value: string }>;
  }

  const fields: Array<{ key: string; value: string }> = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!isJsonRecord(entry)) {
      throw new Error(`${label}[${index}] must be an object.`);
    }
    const key = normalizeOptionalString(entry.key);
    if (!key) {
      continue;
    }
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new Error(
        `${label}[${index}].key must match /^[A-Z_][A-Z0-9_]*$/ to behave like a real env var.`,
      );
    }
    if (seen.has(key)) {
      throw new Error(`${label} contains duplicate key ${key}.`);
    }
    seen.add(key);
    const rawValue = typeof entry.value === "string" ? entry.value : "";
    if (!rawValue && rawValue !== redactedSentinel) {
      continue;
    }
    fields.push({
      key,
      value: rawValue,
    });
  }
  return fields;
}

async function saveRuntimeEnvValues(payload: Record<string, unknown>) {
  const inlineFields = normalizeRuntimeEnvFieldList(
    payload.inlineFields,
    "inlineFields",
    OPENCLAW_REDACTED_SENTINEL,
  );
  const varsFields = normalizeRuntimeEnvFieldList(
    payload.varsFields,
    "varsFields",
    OPENCLAW_REDACTED_SENTINEL,
  );
  const allKeys = new Set<string>();
  for (const field of [...inlineFields, ...varsFields]) {
    if (allKeys.has(field.key)) {
      throw new Error(`La variable ${field.key} est definie plusieurs fois dans le bloc env.`);
    }
    allKeys.add(field.key);
  }

  const rawConfig = await readRawOpenClawEnvConfig();
  const nextEnvConfig: JsonRecord = Object.fromEntries(
    Object.entries(rawConfig.envConfig).filter(
      ([key, value]) => key !== "shellEnv" && key !== "vars" && typeof value !== "string",
    ),
  );

  for (const field of inlineFields) {
    if (field.value === OPENCLAW_REDACTED_SENTINEL && !rawConfig.inlineValues[field.key]) {
      throw new Error(
        `Valeur redacted introuvable pour ${field.key}. Recharge la vue puis reessaie.`,
      );
    }
    nextEnvConfig[field.key] =
      field.value === OPENCLAW_REDACTED_SENTINEL
        ? rawConfig.inlineValues[field.key] || ""
        : field.value;
  }

  if (varsFields.length > 0) {
    nextEnvConfig.vars = Object.fromEntries(
      varsFields.map((field) => {
        if (field.value === OPENCLAW_REDACTED_SENTINEL && !rawConfig.varsValues[field.key]) {
          throw new Error(
            `Valeur redacted introuvable pour ${field.key}. Recharge la vue puis reessaie.`,
          );
        }
        return [
          field.key,
          field.value === OPENCLAW_REDACTED_SENTINEL
            ? rawConfig.varsValues[field.key] || ""
            : field.value,
        ];
      }),
    );
  }

  const shellEnvEnabled = payload.shellEnvEnabled === true;
  const shellEnvTimeoutRaw = normalizeOptionalString(payload.shellEnvTimeoutMs);
  if (shellEnvTimeoutRaw) {
    const parsedTimeout = Number(shellEnvTimeoutRaw);
    if (!Number.isInteger(parsedTimeout) || parsedTimeout <= 0) {
      throw new Error("shellEnv timeout must be a positive integer in milliseconds.");
    }
    nextEnvConfig.shellEnv = {
      ...(isJsonRecord(nextEnvConfig.shellEnv) ? nextEnvConfig.shellEnv : {}),
      timeoutMs: parsedTimeout,
      ...(shellEnvEnabled ? { enabled: true } : {}),
    };
  } else if (shellEnvEnabled) {
    nextEnvConfig.shellEnv = {
      ...(isJsonRecord(nextEnvConfig.shellEnv) ? nextEnvConfig.shellEnv : {}),
      enabled: true,
    };
  }

  if (Object.keys(nextEnvConfig).length > 0) {
    await runOpenClawCliCommand([
      "config",
      "set",
      "env",
      JSON.stringify(nextEnvConfig),
      "--strict-json",
    ]);
  } else {
    await runOpenClawCliCommand(["config", "unset", "env"]);
  }
  return await loadRuntimeEnvStatus();
}

function loadSqliteModule() {
  sqliteModulePromise ??= import("node:sqlite");
  return sqliteModulePromise;
}

function escapeSqlLikePattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function compactInsightPreview(value: unknown, limit = 220) {
  const text = stringifyUnknown(value).replace(/\s+/g, " ").trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function yamlSingleQuoted(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function looksLikeBcryptHash(value: string) {
  return /^\$2[aby]\$/.test(value);
}

function replaceTopLevelYamlValue(rawConfig: string, key: string, value: string) {
  const nextLine = `${key}: ${yamlSingleQuoted(value)}`;
  const pattern = new RegExp(`^${key}:.*$`, "m");
  if (pattern.test(rawConfig)) {
    return rawConfig.replace(pattern, nextLine);
  }
  const trimmed = rawConfig.trimEnd();
  return trimmed ? `${trimmed}\n${nextLine}\n` : `${nextLine}\n`;
}

function decodeJwtPayload(token: string) {
  const payload = token.split(".")[1];
  if (!payload) {
    throw new Error("Invalid JWT payload.");
  }
  return safeJsonParse<JsonRecord>(Buffer.from(payload, "base64url").toString("utf8"), {});
}

function formatCliproxyCodexFileName(email: string, planType: string, accountId: string) {
  const normalizedPlan = planType
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean)
    .join("-");
  if (!normalizedPlan) {
    return `codex-${email}.json`;
  }
  if (normalizedPlan === "team") {
    const hash = createHash("sha256").update(accountId).digest("hex").slice(0, 8);
    return `codex-${hash}-${email}-team.json`;
  }
  return `codex-${email}-${normalizedPlan}.json`;
}

function extractProjectCliproxyConfigSecrets(rawConfig: string) {
  let inRemoteManagement = false;
  let apiKey: string | undefined;
  let managementKey: string | undefined;

  for (const line of rawConfig.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const isTopLevel = !/^\s/.test(line);
    if (isTopLevel) {
      inRemoteManagement = trimmed === "remote-management:";
      if (trimmed.startsWith("key:")) {
        apiKey = normalizeOptionalString(
          trimmed
            .slice("key:".length)
            .trim()
            .replace(/^['"]|['"]$/g, ""),
        );
      }
      continue;
    }
    if (!inRemoteManagement) {
      continue;
    }
    if (/^\s{2}secret-key:/.test(line)) {
      managementKey = normalizeOptionalString(
        line
          .replace(/^\s*secret-key:\s*/, "")
          .trim()
          .replace(/^['"]|['"]$/g, ""),
      );
    }
  }

  return { apiKey, managementKey };
}

function buildProjectCliproxyConfig(bootstrap: ProjectCliproxyBootstrap) {
  return [
    "host: ''",
    "port: 8317",
    `key: ${yamlSingleQuoted(bootstrap.apiKey)}`,
    "",
    "remote-management:",
    "  allow-remote: true",
    `  secret-key: ${yamlSingleQuoted(bootstrap.managementKey)}`,
    "  disable-control-panel: false",
    "  panel-github-repository: 'https://github.com/router-for-me/Cli-Proxy-API-Management-Center'",
    "",
    `auth-dir: ${yamlSingleQuoted(DEFAULT_CLIPROXY_RUNTIME_AUTH_DIR)}`,
    "usage-statistics-enabled: true",
    "gemini-api-key: []",
    "codex-api-key: []",
    "claude-api-key: []",
    "openai-compatibility: []",
    "oauth-excluded-models: {}",
    "",
  ].join("\n");
}

function buildProjectCliproxyCompose() {
  return [
    "services:",
    "  cliproxyapi:",
    "    image: eceasy/cli-proxy-api-plus:latest",
    "    ports:",
    '      - "8317:8317"',
    "    volumes:",
    "      - ./config.yaml:/CLIProxyAPI/config.yaml",
    "      - ./auths:/root/.cli-proxy-api",
    "      - ./logs:/CLIProxyAPI/logs",
    "    restart: unless-stopped",
    "",
  ].join("\n");
}

async function ensureProjectCliproxyBootstrap(): Promise<ProjectCliproxyBootstrap> {
  await fs.mkdir(DEFAULT_CLIPROXY_PROJECT_DIR, { recursive: true });
  await fs.mkdir(DEFAULT_CLIPROXY_AUTH_DIR, { recursive: true });
  await fs.mkdir(DEFAULT_CLIPROXY_LOG_DIR, { recursive: true });

  let bootstrap = safeJsonParse<Partial<ProjectCliproxyBootstrap>>(
    await fs.readFile(DEFAULT_CLIPROXY_BOOTSTRAP_PATH, "utf8").catch(() => "{}"),
    {},
  );

  const rawConfig = await fs.readFile(DEFAULT_CLIPROXY_CONFIG_PATH, "utf8").catch(() => "");
  const extractedConfig = rawConfig ? extractProjectCliproxyConfigSecrets(rawConfig) : {};
  const configManagementKey =
    extractedConfig.managementKey && !looksLikeBcryptHash(extractedConfig.managementKey)
      ? extractedConfig.managementKey
      : undefined;

  const nextBootstrap: ProjectCliproxyBootstrap = {
    apiKey:
      extractedConfig.apiKey ||
      normalizeOptionalString(bootstrap.apiKey) ||
      `cliproxy-project-api-${randomUUID().replace(/-/g, "")}`,
    managementKey:
      normalizeOptionalString(bootstrap.managementKey) ||
      configManagementKey ||
      `cliproxy-project-mgmt-${randomUUID().replace(/-/g, "")}`,
    runtimeBaseUrl: normalizeBridgeRuntimeBaseUrl(
      bootstrap.runtimeBaseUrl || DEFAULT_BRIDGE_RUNTIME_URL,
    ),
    consoleUrl:
      normalizeBridgeConsoleUrl(bootstrap.consoleUrl || DEFAULT_BRIDGE_CONSOLE_URL) ||
      DEFAULT_BRIDGE_CONSOLE_URL,
    runtimeMode: "local-binary",
    projectDir: DEFAULT_CLIPROXY_PROJECT_DIR,
    configPath: DEFAULT_CLIPROXY_CONFIG_PATH,
    composePath: DEFAULT_CLIPROXY_COMPOSE_PATH,
    sourcePath: DEFAULT_CLIPROXY_SOURCE_PATH,
    binaryPath: DEFAULT_CLIPROXY_BINARY_PATH,
    pidPath: DEFAULT_CLIPROXY_PID_PATH,
    authDir: DEFAULT_CLIPROXY_AUTH_DIR,
    logDir: DEFAULT_CLIPROXY_LOG_DIR,
  };

  let configChanged = false;

  await fs.writeFile(
    DEFAULT_CLIPROXY_BOOTSTRAP_PATH,
    `${JSON.stringify(nextBootstrap, null, 2)}\n`,
    { mode: 0o600 },
  );

  if (!rawConfig) {
    await fs.writeFile(DEFAULT_CLIPROXY_CONFIG_PATH, buildProjectCliproxyConfig(nextBootstrap), {
      mode: 0o600,
    });
    configChanged = true;
  } else if (!rawConfig.includes(`auth-dir: '${DEFAULT_CLIPROXY_RUNTIME_AUTH_DIR}'`)) {
    await fs.writeFile(
      DEFAULT_CLIPROXY_CONFIG_PATH,
      replaceTopLevelYamlValue(rawConfig, "auth-dir", DEFAULT_CLIPROXY_RUNTIME_AUTH_DIR),
      { mode: 0o600 },
    );
    configChanged = true;
  }

  const composeFile = await fs.readFile(DEFAULT_CLIPROXY_COMPOSE_PATH, "utf8").catch(() => "");
  if (!composeFile.trim()) {
    await fs.writeFile(DEFAULT_CLIPROXY_COMPOSE_PATH, buildProjectCliproxyCompose(), {
      mode: 0o600,
    });
  }

  return {
    ...nextBootstrap,
    configChanged,
  };
}

async function runCommand(args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  const child = spawn(args[0]!, args.slice(1), {
    cwd: options?.cwd || process.cwd(),
    env: options?.env || process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `Command failed with code ${exitCode}.`);
  }

  return stdout.trim();
}

async function restartProjectCliproxyRuntime(bootstrap: ProjectCliproxyBootstrap) {
  await runCommand([path.join(ELYTRAS_ROOT, "scripts", "run-cliproxyapi-local.sh"), "restart"], {
    cwd: ELYTRAS_ROOT,
    env: {
      ...process.env,
      CONTROL_TOWER_CLIPROXY_DIR: bootstrap.projectDir,
      CLIPROXY_CONFIG_PATH: bootstrap.configPath,
      CLIPROXY_BINARY_PATH: bootstrap.binaryPath,
      CLIPROXY_PID_PATH: bootstrap.pidPath,
      CLIPROXY_SOURCE_DIR: bootstrap.sourcePath,
      CLIPROXY_LOG_DIR: bootstrap.logDir,
      CLIPROXY_PORT: "8317",
    },
  });
}

type CliproxyRuntimeAvailability = {
  available: boolean;
  restarted: boolean;
  projectBootstrap?: ProjectCliproxyBootstrap;
  probeResult: { ok: boolean; status: number; text: string; json: unknown };
};

async function probeCliproxyRuntimeModels(bridge: ProviderBridge) {
  return fetchJsonWithDetail(
    buildBridgeModelsUrl(normalizeBridgeRuntimeBaseUrl(bridge.runtimeBaseUrl)),
    {
      headers: buildBridgeRequestHeaders(bridge),
    },
  ).catch((error) => ({
    ok: false,
    status: 0,
    text: error instanceof Error ? error.message : String(error),
    json: null,
  }));
}

async function ensureProjectCliproxyRuntimeAvailable(
  bridge?: ProviderBridge | null,
): Promise<CliproxyRuntimeAvailability> {
  if (!bridge || !isCliproxyBridge(bridge)) {
    return {
      available: false,
      restarted: false,
      probeResult: { ok: false, status: 0, text: "No CLIProxyAPI bridge.", json: null },
    };
  }

  const projectBootstrap = await ensureProjectCliproxyBootstrap().catch(() => undefined);
  const firstProbe = await probeCliproxyRuntimeModels(bridge);
  if (firstProbe.ok) {
    return {
      available: true,
      restarted: false,
      projectBootstrap,
      probeResult: firstProbe,
    };
  }

  if (!projectBootstrap || projectBootstrap.runtimeMode !== "local-binary") {
    return {
      available: false,
      restarted: false,
      projectBootstrap,
      probeResult: firstProbe,
    };
  }

  await restartProjectCliproxyRuntime(projectBootstrap).catch(() => undefined);
  const secondProbe = await probeCliproxyRuntimeModels(bridge);
  return {
    available: secondProbe.ok,
    restarted: true,
    projectBootstrap,
    probeResult: secondProbe,
  };
}

async function importProjectLocalOpenClawAuthProfiles(): Promise<CliproxyImportOpenClawAuthResponse> {
  const bootstrap = await ensureProjectCliproxyBootstrap();
  const rawProfiles = await fs
    .readFile(DEFAULT_OPENCLAW_AUTH_PROFILES_PATH, "utf8")
    .catch(() => "");
  if (!rawProfiles.trim()) {
    throw new Error("Aucun auth profile OpenClaw local detecte.");
  }

  const parsed = safeJsonParse<{ profiles?: Record<string, JsonRecord> }>(rawProfiles, {});
  const profiles = parsed.profiles || {};
  const importedProviders = new Set<string>();
  let imported = 0;

  for (const profile of Object.values(profiles)) {
    const provider = normalizeOptionalString(profile.provider);
    const profileType = normalizeOptionalString(profile.type);
    if (provider !== "openai-codex" || profileType !== "oauth") {
      continue;
    }
    const access = normalizeOptionalString(profile.access);
    const refresh = normalizeOptionalString(profile.refresh);
    const accountId = normalizeOptionalString(profile.accountId);
    if (!access || !refresh || !accountId) {
      continue;
    }

    const payload = decodeJwtPayload(access);
    const authInfo = isJsonRecord(payload["https://api.openai.com/auth"])
      ? (payload["https://api.openai.com/auth"] as JsonRecord)
      : {};
    const profileInfo = isJsonRecord(payload["https://api.openai.com/profile"])
      ? (payload["https://api.openai.com/profile"] as JsonRecord)
      : {};
    const email = normalizeOptionalString(profileInfo.email);
    if (!email) {
      continue;
    }
    const expiresAt = (() => {
      const rawExp = payload.exp;
      const exp = typeof rawExp === "number" ? rawExp : Number(rawExp);
      return Number.isFinite(exp) ? new Date(exp * 1000).toISOString() : new Date().toISOString();
    })();
    const fileName = formatCliproxyCodexFileName(
      email,
      normalizeOptionalString(authInfo.chatgpt_plan_type) || "",
      accountId,
    );
    const authFile = {
      id_token: access,
      access_token: access,
      refresh_token: refresh,
      account_id: accountId,
      last_refresh: new Date().toISOString(),
      email,
      type: "codex",
      expired: expiresAt,
    };

    await fs.writeFile(
      path.join(bootstrap.authDir, fileName),
      `${JSON.stringify(authFile, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    imported += 1;
    importedProviders.add("codex");
  }

  if (!imported) {
    throw new Error("Aucun compte OAuth OpenClaw compatible n’a pu etre importe.");
  }

  await restartProjectCliproxyRuntime(bootstrap);

  return {
    ok: true,
    imported,
    providers: Array.from(importedProviders),
    restarted: true,
  };
}

function normalizeAccountId(value: unknown) {
  return normalizeOptionalString(value) || "default";
}

function isSystemChannelKind(value: unknown) {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized ? SYSTEM_CHANNEL_KINDS.has(normalized) : false;
}

function resolveDashboardChannelSurfaceType(channel: {
  id?: unknown;
  kind?: unknown;
  accountId?: unknown;
  deliveryTarget?: unknown;
  target?: unknown;
  source?: unknown;
  surfaceType?: unknown;
}) {
  const explicit = normalizeOptionalString(channel.surfaceType)?.toLowerCase();
  if (explicit === "transport" || explicit === "destination" || explicit === "system") {
    return explicit;
  }
  if (isSystemChannelKind(channel.kind)) {
    return "system" as const;
  }
  if (normalizeOptionalString(channel.deliveryTarget)) {
    return "destination" as const;
  }
  const normalizedSource = normalizeOptionalString(channel.source) || "detected";
  const normalizedTarget =
    normalizeOptionalString(channel.target) ||
    normalizeOptionalString(channel.deliveryTarget) ||
    "";
  const normalizedId = normalizeOptionalString(channel.id) || "";
  if (normalizedSource === "detected" && isDetectedSystemChannelTarget(normalizedTarget)) {
    return "system" as const;
  }
  if (normalizedSource === "detected" && normalizedId.startsWith("detected-")) {
    return "destination" as const;
  }
  if (normalizeOptionalString(channel.accountId)) {
    return "transport" as const;
  }
  return "system" as const;
}

function buildCustomChannelRouteId(
  channelId: string,
  accountId: unknown,
  deliveryTarget: unknown,
  destinationType?: unknown,
) {
  const normalizedChannelId = normalizeOptionalString(channelId) || "channel";
  const normalizedAccountId = normalizeAccountId(accountId);
  const normalizedDeliveryTarget = normalizeOptionalString(deliveryTarget) || "target";
  const normalizedDestinationType = normalizeOptionalString(destinationType) || "";
  const digest = createHash("sha1")
    .update(
      `${normalizedChannelId}:${normalizedAccountId}:${normalizedDeliveryTarget.toLowerCase()}:${normalizedDestinationType.toLowerCase()}`,
    )
    .digest("hex")
    .slice(0, 12);
  return `route:${slugify(normalizedChannelId) || "channel"}:${slugify(normalizedAccountId) || "default"}:${digest}`;
}

function isOutputRouteChannelRecord(channel: DashboardChannel) {
  return (
    channel.source === "custom" &&
    Boolean(normalizeOptionalString(channel.deliveryTarget)) &&
    !isSystemChannelKind(channel.kind)
  );
}

function isManagedDestinationChannelRecord(channel: DashboardChannel) {
  return resolveDashboardChannelSurfaceType(channel) === "destination";
}

function normalizeDashboardChannelRecord(
  value: unknown,
  now: string,
  fallback?: Partial<DashboardChannel>,
): DashboardChannel {
  const record = isJsonRecord(value) ? value : {};
  const source =
    record.source === "custom" || fallback?.source === "custom" ? "custom" : "detected";
  const kind = normalizeOptionalString(record.kind) || fallback?.kind || "internal";
  const accountId = normalizeOptionalString(record.accountId) || fallback?.accountId;
  const deliveryTarget =
    normalizeOptionalString(record.deliveryTarget) ||
    normalizeOptionalString(fallback?.deliveryTarget);
  const destinationType =
    normalizeOptionalString(record.destinationType) ||
    normalizeOptionalString(fallback?.destinationType);
  const target =
    normalizeOptionalString(record.target) ||
    normalizeOptionalString(fallback?.target) ||
    deliveryTarget ||
    normalizeAccountId(accountId);
  const computedId =
    source === "custom" && deliveryTarget
      ? buildCustomChannelRouteId(kind, accountId, deliveryTarget, destinationType)
      : buildChannelStoreId(kind, accountId);
  const surfaceType =
    source === "custom"
      ? resolveDashboardChannelSurfaceType({
          id: normalizeOptionalString(record.id) || fallback?.id || computedId,
          kind,
          accountId,
          deliveryTarget,
          target,
          source,
          surfaceType: record.surfaceType ?? fallback?.surfaceType,
        })
      : resolveDashboardChannelSurfaceType({
          id: normalizeOptionalString(record.id) || fallback?.id || computedId,
          kind,
          accountId,
          deliveryTarget,
          target,
          source,
        });
  return {
    id: normalizeOptionalString(record.id) || fallback?.id || computedId,
    name:
      normalizeOptionalString(record.name) ||
      normalizeOptionalString(fallback?.name) ||
      `${kind}:${target}`,
    kind,
    target,
    ...(accountId ? { accountId } : {}),
    ...(deliveryTarget ? { deliveryTarget } : {}),
    ...(destinationType ? { destinationType } : {}),
    surfaceType,
    ownerId: normalizeOptionalString(record.ownerId) || fallback?.ownerId,
    enabled:
      typeof record.enabled === "boolean"
        ? record.enabled
        : typeof fallback?.enabled === "boolean"
          ? fallback.enabled
          : true,
    source,
    createdAt: normalizeOptionalString(record.createdAt) || fallback?.createdAt || now,
    updatedAt: now,
  };
}

function remapChannelIdList(value: unknown, idMap: Map<string, string>) {
  return normalizeIdList(value).map((entry) => idMap.get(entry) || entry);
}

function remapChannelReferencesInStore(store: ControlTowerStore, idMap: Map<string, string>) {
  if (idMap.size === 0) {
    return;
  }

  store.users = store.users.map((user) => ({
    ...user,
    channelIds: remapChannelIdList(user.channelIds, idMap),
  }));
  store.teams = store.teams.map((team) => ({
    ...team,
    channelIds: remapChannelIdList(team.channelIds, idMap),
  }));
  store.agentBindings = store.agentBindings.map((binding) => ({
    ...binding,
    channelIds: remapChannelIdList(binding.channelIds, idMap),
    defaultOutputChannelIds: remapChannelIdList(binding.defaultOutputChannelIds, idMap),
  }));
  store.pipelines = store.pipelines.map((pipeline) => ({
    ...pipeline,
    outputTargets: remapChannelIdList(pipeline.outputTargets, idMap),
    steps: pipeline.steps.map((step) => ({
      ...step,
      output: remapChannelIdList(step.output, idMap).join(","),
    })),
  }));
  store.cronJobs = store.cronJobs.map((job) => ({
    ...job,
    outputTargets: remapChannelIdList(job.outputTargets, idMap),
  }));
  store.grants = store.grants.map((grant) =>
    grant.resourceType === "channel" && idMap.has(grant.resourceId)
      ? { ...grant, resourceId: idMap.get(grant.resourceId)! }
      : grant,
  );
}

function normalizeStoredChannels(
  rawChannels: unknown,
  discoveredChannels: DashboardChannel[],
  now: string,
) {
  const discoveredIds = new Set(discoveredChannels.map((channel) => channel.id));
  const normalized = Array.isArray(rawChannels)
    ? rawChannels.map((channel) => normalizeDashboardChannelRecord(channel, now))
    : [];
  const idMap = new Map<string, string>();
  const deduped = new Map<string, DashboardChannel>();

  for (const channel of normalized) {
    let next = channel;
    const legacyTransportId = buildChannelStoreId(channel.kind, channel.accountId);
    const shouldMigrateLegacyRoute =
      isOutputRouteChannelRecord(channel) &&
      (channel.id === legacyTransportId || discoveredIds.has(channel.id));
    if (shouldMigrateLegacyRoute) {
      const nextId = buildCustomChannelRouteId(
        channel.kind,
        channel.accountId,
        channel.deliveryTarget,
        channel.destinationType,
      );
      if (nextId !== channel.id) {
        idMap.set(channel.id, nextId);
        next = { ...channel, id: nextId, updatedAt: now };
      }
    }
    deduped.set(next.id, next);
  }

  return {
    channels: Array.from(deduped.values()),
    idMap,
  };
}

function normalizeBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "true" ||
      normalized === "1" ||
      normalized === "yes" ||
      normalized === "on"
    ) {
      return true;
    }
    if (
      normalized === "false" ||
      normalized === "0" ||
      normalized === "no" ||
      normalized === "off"
    ) {
      return false;
    }
  }
  return undefined;
}

function normalizeNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function splitLineList(value: unknown) {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(/[\n,]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const DASHBOARD_SINGLE_ACCOUNT_CHANNEL_KEYS = new Set([
  "name",
  "token",
  "tokenFile",
  "botToken",
  "appToken",
  "cliPath",
  "dbPath",
  "service",
  "region",
  "dmPolicy",
  "allowFrom",
  "groupPolicy",
  "groupAllowFrom",
  "defaultTo",
]);

const DASHBOARD_SINGLE_ACCOUNT_CHANNEL_KEYS_BY_CHANNEL: Record<string, ReadonlySet<string>> = {
  telegram: new Set(["streaming"]),
};

const DETECTED_SYSTEM_CHANNEL_TARGETS = new Set(["heartbeat", "session"]);

function isDetectedSystemChannelTarget(value: unknown) {
  const normalized = normalizeOptionalString(value)?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    DETECTED_SYSTEM_CHANNEL_TARGETS.has(normalized) ||
    normalized === "internal" ||
    normalized.startsWith("heartbeat:")
  );
}

function shouldMoveSingleAccountDashboardChannelKey(channelKey: string, key: string) {
  if (DASHBOARD_SINGLE_ACCOUNT_CHANNEL_KEYS.has(key)) {
    return true;
  }
  return DASHBOARD_SINGLE_ACCOUNT_CHANNEL_KEYS_BY_CHANNEL[channelKey]?.has(key) ?? false;
}

function promoteLegacyScopedChannelSectionToDefaultAccount(cfg: JsonRecord, channelKey: string) {
  const channels = isJsonRecord(cfg.channels) ? { ...cfg.channels } : {};
  const currentChannel = isJsonRecord(channels[channelKey]) ? { ...channels[channelKey] } : null;
  if (!currentChannel) {
    return cfg;
  }

  const keysToMove = Object.entries(currentChannel)
    .filter(([key, value]) => {
      if (key === "accounts" || key === "enabled" || value === undefined) {
        return false;
      }
      return shouldMoveSingleAccountDashboardChannelKey(channelKey, key);
    })
    .map(([key]) => key);

  if (!keysToMove.length) {
    return cfg;
  }

  const accounts = isJsonRecord(currentChannel.accounts) ? { ...currentChannel.accounts } : {};
  const defaultAccount = isJsonRecord(accounts.default) ? { ...accounts.default } : {};
  for (const key of keysToMove) {
    defaultAccount[key] = structuredClone(currentChannel[key]);
    delete currentChannel[key];
  }
  currentChannel.accounts = {
    ...accounts,
    default: defaultAccount,
  };
  channels[channelKey] = currentChannel;
  return {
    ...cfg,
    channels,
  };
}

function clearFieldsFromRecord(record: JsonRecord, clearFields: string[]) {
  for (const field of clearFields) {
    delete record[field];
  }
}

function upsertTopLevelChannelConfig(
  cfg: JsonRecord,
  channelKey: string,
  patch: JsonRecord,
  options?: { clearFields?: string[]; enabled?: boolean },
) {
  const channels = isJsonRecord(cfg.channels) ? { ...cfg.channels } : {};
  const current = isJsonRecord(channels[channelKey]) ? { ...channels[channelKey] } : {};
  clearFieldsFromRecord(current, options?.clearFields || []);
  channels[channelKey] = {
    ...current,
    ...(options?.enabled === true ? { enabled: true } : {}),
    ...patch,
  };
  return {
    ...cfg,
    channels,
  };
}

function upsertScopedChannelConfig(
  cfg: JsonRecord,
  channelKey: string,
  accountId: string,
  patch: JsonRecord,
  options?: { clearFields?: string[]; name?: string; enabled?: boolean },
) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const normalizedConfig = promoteLegacyScopedChannelSectionToDefaultAccount(cfg, channelKey);
  const channels = isJsonRecord(normalizedConfig.channels) ? { ...normalizedConfig.channels } : {};
  const currentChannel = isJsonRecord(channels[channelKey]) ? { ...channels[channelKey] } : {};
  const enabled = options?.enabled !== false;
  const accounts = isJsonRecord(currentChannel.accounts) ? { ...currentChannel.accounts } : {};
  const currentAccount = isJsonRecord(accounts[normalizedAccountId])
    ? { ...accounts[normalizedAccountId] }
    : {};
  clearFieldsFromRecord(currentAccount, options?.clearFields || []);
  accounts[normalizedAccountId] = {
    ...currentAccount,
    ...(enabled ? { enabled: true } : {}),
    ...(options?.name ? { name: options.name } : {}),
    ...patch,
  };
  channels[channelKey] = {
    ...currentChannel,
    ...(enabled ? { enabled: true } : {}),
    accounts,
  };
  return {
    ...normalizedConfig,
    channels,
  };
}

function upsertAccountsOnlyChannelConfig(
  cfg: JsonRecord,
  channelKey: string,
  accountId: string,
  patch: JsonRecord,
  options?: { clearFields?: string[]; name?: string; enabled?: boolean },
) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channels = isJsonRecord(cfg.channels) ? { ...cfg.channels } : {};
  const currentChannel = isJsonRecord(channels[channelKey]) ? { ...channels[channelKey] } : {};
  const accounts = isJsonRecord(currentChannel.accounts) ? { ...currentChannel.accounts } : {};
  const currentAccount = isJsonRecord(accounts[normalizedAccountId])
    ? { ...accounts[normalizedAccountId] }
    : {};
  clearFieldsFromRecord(currentAccount, options?.clearFields || []);
  accounts[normalizedAccountId] = {
    ...currentAccount,
    ...(options?.enabled === false ? {} : { enabled: true }),
    ...(options?.name ? { name: options.name } : {}),
    ...patch,
  };
  channels[channelKey] = {
    ...currentChannel,
    enabled: true,
    accounts,
  };
  return {
    ...cfg,
    channels,
  };
}

function readChannelAccountConfig(cfg: JsonRecord, channelKey: string, accountId: string) {
  const normalizedConfig = promoteLegacyScopedChannelSectionToDefaultAccount(cfg, channelKey);
  const channels = isJsonRecord(normalizedConfig.channels) ? normalizedConfig.channels : {};
  const currentChannel = isJsonRecord(channels[channelKey]) ? channels[channelKey] : {};
  const accounts = isJsonRecord(currentChannel.accounts) ? currentChannel.accounts : {};
  const currentAccount = accounts[normalizeAccountId(accountId)];
  return isJsonRecord(currentAccount) ? currentAccount : null;
}

function validateDashboardChannelCredentials(params: {
  template: ChannelSetupTemplateDefinition;
  accountId: string;
  values: Record<string, string | boolean | number>;
  config: JsonRecord;
}) {
  const { template, accountId, values, config } = params;
  const useEnv = normalizeBoolean(values.useEnv) === true;
  if (useEnv) {
    return;
  }

  switch (template.id) {
    case "discord": {
      const token = normalizeOptionalString(values.token);
      const existingAccount = readChannelAccountConfig(config, template.id, accountId);
      if (token || normalizeOptionalString(existingAccount?.token)) {
        return;
      }
      throw new Error(
        "Discord requiert un bot token. Renseigne un token ou active Use env vars avant de sauvegarder.",
      );
    }
    case "telegram": {
      const token = normalizeOptionalString(values.token);
      const tokenFile = normalizeOptionalString(values.tokenFile);
      const existingAccount = readChannelAccountConfig(config, template.id, accountId);
      if (
        token ||
        tokenFile ||
        normalizeOptionalString(existingAccount?.botToken) ||
        normalizeOptionalString(existingAccount?.tokenFile)
      ) {
        return;
      }
      throw new Error(
        "Telegram requiert un bot token, un token file, ou Use env vars. Un bot vide ne peut pas etre cree.",
      );
    }
  }
}

function upsertPluginEntryConfig(
  cfg: JsonRecord,
  pluginId: string,
  patch: JsonRecord,
  options?: { clearFields?: string[]; enabled?: boolean },
) {
  const plugins = isJsonRecord(cfg.plugins) ? { ...cfg.plugins } : {};
  const entries = isJsonRecord(plugins.entries) ? { ...plugins.entries } : {};
  const currentEntry = isJsonRecord(entries[pluginId]) ? { ...entries[pluginId] } : {};
  const currentConfig = isJsonRecord(currentEntry.config) ? { ...currentEntry.config } : {};
  clearFieldsFromRecord(currentConfig, options?.clearFields || []);
  entries[pluginId] = {
    ...currentEntry,
    ...(options?.enabled === false ? {} : { enabled: true }),
    config: {
      ...currentConfig,
      ...patch,
    },
  };
  plugins.entries = entries;
  return {
    ...cfg,
    plugins,
  };
}

function setPluginSlot(cfg: JsonRecord, slotKey: string, value?: string) {
  const plugins = isJsonRecord(cfg.plugins) ? { ...cfg.plugins } : {};
  const slots = isJsonRecord(plugins.slots) ? { ...plugins.slots } : {};
  if (value) {
    slots[slotKey] = value;
  } else {
    delete slots[slotKey];
  }
  if (Object.keys(slots).length > 0) {
    plugins.slots = slots;
  } else {
    delete plugins.slots;
  }
  return {
    ...cfg,
    plugins,
  };
}

function removePluginEntry(
  cfg: JsonRecord,
  pluginId: string,
  options?: { removeInstall?: boolean },
) {
  const plugins = isJsonRecord(cfg.plugins) ? { ...cfg.plugins } : {};
  const entries = isJsonRecord(plugins.entries) ? { ...plugins.entries } : {};
  const slots = isJsonRecord(plugins.slots) ? { ...plugins.slots } : {};
  delete entries[pluginId];
  for (const [slotKey, slotValue] of Object.entries(slots)) {
    if (normalizeOptionalString(slotValue) === pluginId) {
      delete slots[slotKey];
    }
  }
  if (Object.keys(entries).length > 0) {
    plugins.entries = entries;
  } else {
    delete plugins.entries;
  }
  if (Object.keys(slots).length > 0) {
    plugins.slots = slots;
  } else {
    delete plugins.slots;
  }
  if (options?.removeInstall) {
    const installs = isJsonRecord(plugins.installs) ? { ...plugins.installs } : {};
    delete installs[pluginId];
    if (Object.keys(installs).length > 0) {
      plugins.installs = installs;
    } else {
      delete plugins.installs;
    }
  }
  return {
    ...cfg,
    plugins,
  };
}

function upsertPluginEntrySubagent(cfg: JsonRecord, pluginId: string, patch: JsonRecord) {
  const plugins = isJsonRecord(cfg.plugins) ? { ...cfg.plugins } : {};
  const entries = isJsonRecord(plugins.entries) ? { ...plugins.entries } : {};
  const currentEntry = isJsonRecord(entries[pluginId]) ? { ...entries[pluginId] } : {};
  const currentSubagent = isJsonRecord(currentEntry.subagent) ? { ...currentEntry.subagent } : {};
  entries[pluginId] = {
    ...currentEntry,
    subagent: {
      ...currentSubagent,
      ...patch,
    },
  };
  plugins.entries = entries;
  return {
    ...cfg,
    plugins,
  };
}

function stringifyUnknown(value: unknown, fallback = "") {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`;
  }
  return fallback;
}

function errorMessage(value: unknown, fallback: string) {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (isJsonRecord(value)) {
    const nested = stringifyUnknown(value.message);
    if (nested.trim()) {
      return nested;
    }
  }
  return stringifyUnknown(value, fallback);
}

type PipelineConditionComparator =
  | ">"
  | ">="
  | "<"
  | "<="
  | "=="
  | "!="
  | "contains"
  | "not-contains";

type PipelineConditionEvaluation = {
  matched: boolean;
  reason: string;
};

function normalizeLooseText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parseLooseBooleanText(value: unknown) {
  const normalized = normalizeLooseText(stringifyUnknown(value));
  if (!normalized) {
    return undefined;
  }
  if (
    normalized === "true" ||
    normalized === "vrai" ||
    normalized === "yes" ||
    normalized === "oui" ||
    normalized === "on"
  ) {
    return true;
  }
  if (
    normalized === "false" ||
    normalized === "faux" ||
    normalized === "no" ||
    normalized === "non" ||
    normalized === "off"
  ) {
    return false;
  }
  return undefined;
}

function parseLooseNumberText(value: unknown) {
  const raw = stringifyUnknown(value).trim();
  if (!raw) {
    return undefined;
  }
  const match = raw.match(/^-?\d+(?:[.,]\d+)?$/);
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[0].replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractFirstNumber(value: unknown) {
  const raw = stringifyUnknown(value).trim();
  if (!raw) {
    return undefined;
  }
  const match = raw.match(/-?\d+(?:[.,]\d+)?/);
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[0].replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringifyConditionValue(value: unknown, fallback = "") {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`;
  }
  if (Array.isArray(value) || isJsonRecord(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function stripElseClauseFromCondition(value: string) {
  return value.replace(/\s*,?\s*(sinon|else)\b.*$/u, "").trim();
}

function resolveJsonPathValue(value: unknown, segments: string[]): unknown {
  let current: unknown = value;
  for (const segment of segments) {
    if (!isJsonRecord(current)) {
      return undefined;
    }
    const matchedEntry = Object.entries(current).find(
      ([key]) => normalizeLooseText(key) === normalizeLooseText(segment),
    );
    if (!matchedEntry) {
      return undefined;
    }
    current = matchedEntry[1];
  }
  return current;
}

function resolveConditionSubjectValue(subjectHint: string, output: string) {
  const rawOutput = normalizeOptionalString(output) || "";
  if (!rawOutput) {
    return "";
  }
  const parsedOutput = safeJsonParse<unknown>(rawOutput, rawOutput);
  if (
    typeof parsedOutput === "string" ||
    typeof parsedOutput === "number" ||
    typeof parsedOutput === "boolean"
  ) {
    return parsedOutput;
  }
  if (Array.isArray(parsedOutput)) {
    return parsedOutput.length === 1 ? parsedOutput[0] : rawOutput;
  }
  if (!isJsonRecord(parsedOutput)) {
    return rawOutput;
  }

  const trimmedSubjectHint = subjectHint.trim();
  if (trimmedSubjectHint) {
    const dottedSegments = trimmedSubjectHint
      .split(/[\.\[\]]+/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (dottedSegments.length > 0) {
      const directMatch = resolveJsonPathValue(parsedOutput, dottedSegments);
      if (directMatch !== undefined) {
        return directMatch;
      }
    }

    const tokens = normalizeLooseText(trimmedSubjectHint)
      .split(/[^a-z0-9_]+/)
      .filter(Boolean);
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      const token = tokens[index];
      const tokenMatch = resolveJsonPathValue(parsedOutput, [token]);
      if (tokenMatch !== undefined) {
        return tokenMatch;
      }
    }
  }

  const scalarEntries = Object.values(parsedOutput).filter(
    (entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
  );
  if (scalarEntries.length === 1) {
    return scalarEntries[0];
  }

  return rawOutput;
}

function comparePipelineCondition(
  actualValue: unknown,
  operator: PipelineConditionComparator,
  expectedValueRaw: string,
  rawOutput: string,
) {
  if (operator === "contains" || operator === "not-contains") {
    const actualText = normalizeLooseText(stringifyConditionValue(actualValue, rawOutput));
    const expectedText = normalizeLooseText(expectedValueRaw.replace(/^["']|["']$/g, ""));
    if (!expectedText) {
      return undefined;
    }
    const matched = actualText.includes(expectedText);
    return operator === "contains" ? matched : !matched;
  }

  const expectedBoolean = parseLooseBooleanText(expectedValueRaw);
  if (expectedBoolean !== undefined) {
    const actualBoolean = parseLooseBooleanText(actualValue) ?? parseLooseBooleanText(rawOutput);
    if (actualBoolean !== undefined) {
      return operator === "!="
        ? actualBoolean !== expectedBoolean
        : actualBoolean === expectedBoolean;
    }
  }

  const expectedNumber =
    parseLooseNumberText(expectedValueRaw) ?? extractFirstNumber(expectedValueRaw);
  const actualNumber =
    parseLooseNumberText(actualValue) ??
    extractFirstNumber(actualValue) ??
    extractFirstNumber(rawOutput);
  if (
    expectedNumber !== undefined &&
    actualNumber !== undefined &&
    (operator === ">" ||
      operator === ">=" ||
      operator === "<" ||
      operator === "<=" ||
      operator === "==" ||
      operator === "!=")
  ) {
    if (operator === ">") {
      return actualNumber > expectedNumber;
    }
    if (operator === ">=") {
      return actualNumber >= expectedNumber;
    }
    if (operator === "<") {
      return actualNumber < expectedNumber;
    }
    if (operator === "<=") {
      return actualNumber <= expectedNumber;
    }
    if (operator === "==") {
      return actualNumber === expectedNumber;
    }
    return actualNumber !== expectedNumber;
  }

  const actualText = normalizeLooseText(stringifyConditionValue(actualValue, rawOutput));
  const expectedText = normalizeLooseText(expectedValueRaw.replace(/^["']|["']$/g, ""));
  if (!expectedText) {
    return undefined;
  }
  if (operator === "==") {
    return actualText === expectedText;
  }
  if (operator === "!=") {
    return actualText !== expectedText;
  }
  return undefined;
}

function evaluatePipelineCondition(
  condition: string | undefined,
  output: string,
): PipelineConditionEvaluation {
  const rawCondition = normalizeOptionalString(condition);
  const rawOutput = normalizeOptionalString(output) || "";
  if (!rawCondition) {
    const matched =
      parseLooseBooleanText(rawOutput) ??
      (extractFirstNumber(rawOutput) !== undefined
        ? extractFirstNumber(rawOutput)! !== 0
        : Boolean(rawOutput));
    return {
      matched,
      reason: "Empty condition; used output truthiness.",
    };
  }

  const normalizedCondition = stripElseClauseFromCondition(
    normalizeLooseText(rawCondition).replace(/^si\s+/, ""),
  );
  const patterns: Array<{ regex: RegExp; operator: PipelineConditionComparator }> = [
    { regex: /^(.*?)\s*(>=|<=|==|=|!=|>|<)\s*(.+)$/u, operator: "==" },
    {
      regex:
        /^(.*?)\s+(?:est\s+)?(?:superieur ou egal a|plus grand ou egal a|greater than or equal to|at least|minimum)\s+(.+)$/u,
      operator: ">=",
    },
    {
      regex:
        /^(.*?)\s+(?:est\s+)?(?:inferieur ou egal a|plus petit ou egal a|less than or equal to|at most|maximum)\s+(.+)$/u,
      operator: "<=",
    },
    {
      regex:
        /^(.*?)\s+(?:est\s+)?(?:plus grand que|superieur a|greater than|more than|above)\s+(.+)$/u,
      operator: ">",
    },
    {
      regex:
        /^(.*?)\s+(?:est\s+)?(?:plus petit que|inferieur a|less than|lower than|below|under)\s+(.+)$/u,
      operator: "<",
    },
    {
      regex: /^(.*?)\s+(?:est\s+)?(?:egal a|equals?|equal to|is)\s+(.+)$/u,
      operator: "==",
    },
    {
      regex: /^(.*?)\s+(?:ne contient pas|does not contain|not contains?)\s+(.+)$/u,
      operator: "not-contains",
    },
    {
      regex: /^(.*?)\s+(?:contient|contains?|inclut|includes?)\s+(.+)$/u,
      operator: "contains",
    },
  ];

  for (const pattern of patterns) {
    const match = normalizedCondition.match(pattern.regex);
    if (!match) {
      continue;
    }
    const subjectHint = match[1]?.trim() || "";
    const expectedValueRaw = match.at(-1)?.trim() || "";
    const operator =
      pattern.regex.source.includes(">=") ||
      pattern.regex.source.includes("<=") ||
      pattern.regex.source.includes("==|=|!=|>|<")
        ? ((match[2] === "=" ? "==" : match[2]) as PipelineConditionComparator)
        : pattern.operator;
    const actualValue = resolveConditionSubjectValue(subjectHint, rawOutput);
    const compared = comparePipelineCondition(actualValue, operator, expectedValueRaw, rawOutput);
    if (compared !== undefined) {
      return {
        matched: compared,
        reason: `Evaluated ${subjectHint || "output"} ${operator} ${expectedValueRaw}.`,
      };
    }
    break;
  }

  const fallbackBoolean = parseLooseBooleanText(rawOutput);
  if (fallbackBoolean !== undefined) {
    return {
      matched: fallbackBoolean,
      reason: "Fell back to boolean output parsing.",
    };
  }

  const fallbackNumber = extractFirstNumber(rawOutput);
  if (fallbackNumber !== undefined) {
    return {
      matched: fallbackNumber !== 0,
      reason: "Fell back to numeric output truthiness.",
    };
  }

  const fallbackMatch = normalizeLooseText(rawOutput).includes(normalizedCondition);
  return {
    matched: fallbackMatch,
    reason: fallbackMatch
      ? "Fell back to substring match on the step output."
      : "Condition pattern unsupported; defaulted to no match.",
  };
}

function normalizeBridgeConsoleUrl(value: unknown) {
  const raw = normalizeOptionalString(value);
  if (!raw) {
    return undefined;
  }
  const url = new URL(raw.startsWith("http") ? raw : `http://${raw}`);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function normalizeSkillPolicy(value: unknown, skillIds: string[]): "all" | "selected" | "none" {
  if (value === "all" || value === "selected" || value === "none") {
    return value;
  }
  if (skillIds.length > 0) {
    return "selected";
  }
  return "all";
}

function normalizeResumePolicy(value: unknown): AgentBinding["resumePolicy"] {
  if (value === "manual" || value === "prefer-recent" || value === "sticky") {
    return value;
  }
  return "manual";
}

function normalizeDispatchPolicy(value: unknown): AgentBinding["dispatchPolicy"] {
  if (value === "manual" || value === "default-channels" || value === "broadcast") {
    return value;
  }
  return "manual";
}

function normalizePipelineRoutingMode(value: unknown): PipelineStep["routingMode"] {
  if (
    value === "linear" ||
    value === "fan-out" ||
    value === "conditional" ||
    value === "terminal"
  ) {
    return value;
  }
  return "linear";
}

function normalizePipelineOutputDeliveryMode(value: unknown): PipelineRecord["outputDeliveryMode"] {
  if (value === "final-only" || value === "step-only" || value === "step-and-final") {
    return value;
  }
  return "final-only";
}

function normalizePipelineNodePositions(value: unknown) {
  if (!isJsonRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([stepId, position]) => {
        const record = isJsonRecord(position) ? position : {};
        const x = Number(record.x);
        const y = Number(record.y);
        return Number.isFinite(x) && Number.isFinite(y) ? [stepId, { x, y }] : null;
      })
      .filter((entry): entry is [string, { x: number; y: number }] => Boolean(entry)),
  );
}

function normalizePipelineViewport(value: unknown): PipelineRecord["viewport"] | undefined {
  if (value == null) {
    return null;
  }
  const record = isJsonRecord(value) ? value : {};
  const x = Number(record.x);
  const y = Number(record.y);
  const zoom = Number(record.zoom);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) {
    return undefined;
  }
  return { x, y, zoom };
}

function normalizeProviderSkillPolicyMode(
  value: unknown,
): "inherit" | "allow-all" | "deny-all" | "selected" {
  if (
    value === "inherit" ||
    value === "allow-all" ||
    value === "deny-all" ||
    value === "selected"
  ) {
    return value;
  }
  return "inherit";
}

function normalizeProviderSkillPolicies(value: unknown) {
  if (!isJsonRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([providerId, policy]) => {
        const record = isJsonRecord(policy) ? policy : {};
        return [
          providerId,
          {
            mode: normalizeProviderSkillPolicyMode(record.mode),
            skillIds: normalizeIdList(record.skillIds),
          },
        ];
      })
      .filter(([providerId]) => normalizeOptionalString(providerId)),
  ) as AgentBinding["providerSkillPolicies"];
}

function normalizeProviderAccountIds(value: unknown) {
  if (!isJsonRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([providerId, accountIds]) => [providerId, normalizeIdList(accountIds)])
      .filter(
        ([providerId, accountIds]) =>
          Boolean(normalizeOptionalString(providerId)) && Array.isArray(accountIds),
      ),
  ) as NonNullable<AgentBinding["providerAccountIds"]>;
}

function normalizeBridgeRuntimeBaseUrl(value: unknown) {
  const raw = normalizeOptionalString(value) || DEFAULT_BRIDGE_RUNTIME_URL;
  const url = new URL(raw.startsWith("http") ? raw : `http://${raw}`);
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith("/v1")
    ? pathname || "/v1"
    : pathname && pathname !== "/"
      ? `${pathname}/v1`
      : "/v1";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function normalizeProviderApiMode(
  value: unknown,
): "openai-responses" | "openai-chat" | "openai-codex-responses" {
  if (
    value === "openai-responses" ||
    value === "openai-chat" ||
    value === "openai-codex-responses"
  ) {
    return value;
  }
  return "openai-responses";
}

function normalizeProviderAuthMode(value: unknown): ProviderBridge["authMode"] {
  if (value === "api-key" || value === "token" || value === "oauth") {
    return value;
  }
  return undefined;
}

function normalizeProviderBridgeStatus(value: unknown): ProviderBridge["status"] | undefined {
  if (value === "draft" || value === "ready" || value === "imported" || value === "error") {
    return value;
  }
  return undefined;
}

function parseBridgeHeaders(value: unknown) {
  if (typeof value === "string") {
    return Object.fromEntries(
      value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf(":");
          if (separator <= 0) {
            throw new Error(`Invalid bridge header: ${line}`);
          }
          return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
        })
        .filter(([key, headerValue]) => key && headerValue),
    );
  }

  if (!isJsonRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, headerValue]) => [key.trim(), normalizeOptionalString(headerValue)])
      .filter(([key, headerValue]) => key && headerValue) as Array<[string, string]>,
  );
}

function normalizeProviderBridgeModel(
  value: unknown,
  fallbackApiMode: ProviderBridge["apiMode"],
): ProviderBridgeModel | null {
  const record = isJsonRecord(value) ? value : {};
  const id = normalizeOptionalString(record.id) || normalizeOptionalString(record.name);
  if (!id) {
    return null;
  }
  return {
    id,
    name: normalizeOptionalString(record.name) || id,
    api: normalizeProviderApiMode(record.api ?? fallbackApiMode),
    reasoning: typeof record.reasoning === "boolean" ? record.reasoning : undefined,
    input: normalizeProviderBridgeModelInput(record, id),
    contextWindow:
      typeof record.contextWindow === "number"
        ? record.contextWindow
        : typeof record.context_window === "number"
          ? record.context_window
          : undefined,
    maxTokens:
      typeof record.maxTokens === "number"
        ? record.maxTokens
        : typeof record.max_tokens === "number"
          ? record.max_tokens
          : undefined,
  };
}

function normalizeProviderBridgeModelInput(
  record: JsonRecord,
  modelId: string,
): Array<"text" | "image"> | undefined {
  const direct = normalizeKnownInputCapabilities(record.input);
  if (direct.length > 0) {
    return direct;
  }
  const capabilities = normalizeKnownInputCapabilities(record.capabilities);
  if (capabilities.length > 0) {
    return capabilities;
  }
  const modalities = normalizeKnownInputCapabilities(record.modalities);
  if (modalities.length > 0) {
    return modalities;
  }
  return inferProviderBridgeModelInput(modelId);
}

function normalizeKnownInputCapabilities(value: unknown): Array<"text" | "image"> {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = new Set<"text" | "image">();
  for (const entry of value) {
    const token = normalizeOptionalString(entry)?.toLowerCase();
    if (token === "text" || token === "image") {
      normalized.add(token);
    }
  }
  return [...normalized];
}

function inferProviderBridgeModelInput(modelId: string): Array<"text" | "image"> | undefined {
  const lower = modelId.trim().toLowerCase();
  if (!lower) {
    return undefined;
  }
  if (
    lower.startsWith("gemini-") ||
    lower.includes("flash-image") ||
    lower.includes("vision") ||
    lower.includes("multimodal") ||
    /(^|[-_/])vl([:-_/]|$)/.test(lower)
  ) {
    return ["text", "image"];
  }
  return ["text"];
}

function normalizeProviderBridge(
  value: unknown,
  now: string,
  fallback: Partial<ProviderBridge> = {},
): ProviderBridge {
  const record = isJsonRecord(value) ? value : {};
  const apiMode = normalizeProviderApiMode(record.apiMode ?? fallback.apiMode);
  const discoveredModelsSource = Array.isArray(record.discoveredModels)
    ? record.discoveredModels
    : fallback.discoveredModels || [];
  const discoveredModels = discoveredModelsSource
    .map((entry) => normalizeProviderBridgeModel(entry, apiMode))
    .filter(Boolean) as ProviderBridgeModel[];
  const availableModelIds = new Set(discoveredModels.map((model) => model.id));
  const activeModelIdsSource = Array.isArray(record.activeModelIds)
    ? record.activeModelIds
    : fallback.activeModelIds || [];
  const activeModelIds = Array.from(
    new Set(
      activeModelIdsSource
        .map((entry) => normalizeOptionalString(entry))
        .filter(Boolean) as string[],
    ),
  ).filter((id) => availableModelIds.has(id));
  const resolvedActiveModelIds =
    activeModelIds.length > 0 ? activeModelIds : discoveredModels.map((model) => model.id);
  const primaryModelIdSource =
    normalizeOptionalString(record.primaryModelId) || fallback.primaryModelId;
  const primaryModelId =
    primaryModelIdSource && resolvedActiveModelIds.includes(primaryModelIdSource)
      ? primaryModelIdSource
      : resolvedActiveModelIds[0];
  const importedProviderId =
    normalizeOptionalString(record.importedProviderId) || fallback.importedProviderId;
  const normalizedId = normalizeOptionalString(record.id) || fallback.id || randomUUID();
  const normalizedName = normalizeOptionalString(record.name) || fallback.name || "CLIProxyAPI";
  const migratedDefaultBridge =
    (normalizedId === "local-bridge" && normalizedName === "Local bridge") ||
    (normalizedId === "cliproxyapi" && normalizedName === "Local bridge");
  const derivedStatus =
    normalizeProviderBridgeStatus(record.status) ||
    fallback.status ||
    (record.lastError || fallback.lastError
      ? "error"
      : importedProviderId
        ? "imported"
        : discoveredModels.length
          ? "ready"
          : "draft");

  return {
    id: migratedDefaultBridge ? "cliproxyapi" : normalizedId,
    name: migratedDefaultBridge ? "CLIProxyAPI" : normalizedName,
    kind: "openai-compatible",
    runtimeBaseUrl: normalizeBridgeRuntimeBaseUrl(
      record.runtimeBaseUrl ?? fallback.runtimeBaseUrl ?? DEFAULT_BRIDGE_RUNTIME_URL,
    ),
    consoleUrl: normalizeBridgeConsoleUrl(
      record.consoleUrl ?? fallback.consoleUrl ?? DEFAULT_BRIDGE_CONSOLE_URL,
    ),
    apiKey: normalizeOptionalString(record.apiKey) || fallback.apiKey,
    managementKey: normalizeOptionalString(record.managementKey) || fallback.managementKey,
    apiMode,
    authMode: normalizeProviderAuthMode(record.authMode ?? fallback.authMode),
    authHeader:
      typeof record.authHeader === "boolean"
        ? record.authHeader
        : typeof fallback.authHeader === "boolean"
          ? fallback.authHeader
          : true,
    headers: parseBridgeHeaders(record.headersText ?? record.headers ?? fallback.headers ?? {}),
    discoveredModels,
    activeModelIds: resolvedActiveModelIds,
    primaryModelId,
    applyAsDefaultModel:
      typeof record.applyAsDefaultModel === "boolean"
        ? record.applyAsDefaultModel
        : typeof fallback.applyAsDefaultModel === "boolean"
          ? fallback.applyAsDefaultModel
          : false,
    importedProviderId,
    status: derivedStatus,
    lastSyncAt: normalizeOptionalString(record.lastSyncAt) || fallback.lastSyncAt,
    lastImportAt: normalizeOptionalString(record.lastImportAt) || fallback.lastImportAt,
    lastError: normalizeOptionalString(record.lastError) || fallback.lastError,
    createdAt: normalizeOptionalString(record.createdAt) || fallback.createdAt || now,
    updatedAt: now,
  };
}

function seedProviderBridges(
  now: string,
  bootstrap?: Pick<
    ProjectCliproxyBootstrap,
    "apiKey" | "managementKey" | "runtimeBaseUrl" | "consoleUrl"
  >,
): ProviderBridge[] {
  return [
    normalizeProviderBridge(
      {
        id: "cliproxyapi",
        name: "CLIProxyAPI",
        runtimeBaseUrl: bootstrap?.runtimeBaseUrl || DEFAULT_BRIDGE_RUNTIME_URL,
        consoleUrl: bootstrap?.consoleUrl || DEFAULT_BRIDGE_CONSOLE_URL,
        apiKey: bootstrap?.apiKey,
        managementKey: bootstrap?.managementKey,
        apiMode: "openai-responses",
        authMode: "api-key",
        authHeader: true,
        headers: {},
        discoveredModels: [],
        activeModelIds: [],
        primaryModelId: undefined,
        applyAsDefaultModel: false,
        status: "draft",
        createdAt: now,
      },
      now,
    ),
  ];
}

function buildBridgeModelsUrl(runtimeBaseUrl: string) {
  const url = new URL(normalizeBridgeRuntimeBaseUrl(runtimeBaseUrl));
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function buildCliproxyManagementBaseUrl(bridge: ProviderBridge) {
  const base =
    normalizeOptionalString(bridge.consoleUrl) ||
    normalizeBridgeRuntimeBaseUrl(bridge.runtimeBaseUrl).replace(/\/v1\/?$/i, "");
  const url = new URL(base);
  url.pathname = "/v0/management";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function buildCliproxyManagementHeaders(bridge: ProviderBridge) {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (bridge.managementKey) {
    headers.Authorization = `Bearer ${bridge.managementKey}`;
  }
  return headers;
}

async function fetchJsonWithDetail(
  url: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; text: string; json: unknown }> {
  const response = await fetch(url, init);
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    text,
    json: safeJsonParse<unknown>(text, null),
  };
}

function buildCliproxyAuthFile(raw: unknown): CliproxyAuthFile | null {
  if (!isJsonRecord(raw)) {
    return null;
  }
  const name = normalizeOptionalString(raw.name);
  const provider = normalizeOptionalString(raw.provider) || "unknown";
  return {
    id:
      name ||
      `${provider}:${normalizeOptionalString(raw.account) || normalizeOptionalString(raw.email) || randomUUID()}`,
    name: name || `${provider}.json`,
    provider,
    label: normalizeOptionalString(raw.label),
    status: normalizeOptionalString(raw.status),
    statusMessage:
      normalizeOptionalString(raw.statusMessage) || normalizeOptionalString(raw.status_message),
    disabled: typeof raw.disabled === "boolean" ? raw.disabled : undefined,
    unavailable: typeof raw.unavailable === "boolean" ? raw.unavailable : undefined,
    runtimeOnly:
      typeof raw.runtimeOnly === "boolean"
        ? raw.runtimeOnly
        : typeof raw.runtime_only === "boolean"
          ? raw.runtime_only
          : undefined,
    source: normalizeOptionalString(raw.source),
    path: normalizeOptionalString(raw.path),
    size: typeof raw.size === "number" ? raw.size : undefined,
    modtime: normalizeOptionalString(raw.modtime),
    email: normalizeOptionalString(raw.email),
    accountType:
      normalizeOptionalString(raw.accountType) || normalizeOptionalString(raw.account_type),
    account: normalizeOptionalString(raw.account),
    createdAt: normalizeOptionalString(raw.createdAt) || normalizeOptionalString(raw.created_at),
    updatedAt: normalizeOptionalString(raw.updatedAt) || normalizeOptionalString(raw.updated_at),
    lastRefresh:
      normalizeOptionalString(raw.lastRefresh) || normalizeOptionalString(raw.last_refresh),
    usage: isJsonRecord(raw.usage) ? (raw.usage as unknown as ProviderUsageStatus) : undefined,
  };
}

type CliproxyCodexUsageResponse = {
  rate_limit?: {
    primary_window?: {
      limit_window_seconds?: number;
      used_percent?: number;
      reset_at?: number;
    };
    secondary_window?: {
      limit_window_seconds?: number;
      used_percent?: number;
      reset_at?: number;
    };
  };
  plan_type?: string;
  credits?: { balance?: number | string | null };
};

function clampUsagePercent(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function resolveCliproxyCodexSecondaryWindowLabel(params: {
  windowHours: number;
  secondaryResetAt?: number;
  primaryResetAt?: number;
}) {
  if (params.windowHours >= 168) {
    return "Week";
  }
  if (params.windowHours < 24) {
    return `${params.windowHours}h`;
  }
  if (
    typeof params.secondaryResetAt === "number" &&
    typeof params.primaryResetAt === "number" &&
    params.secondaryResetAt - params.primaryResetAt >= 3 * 24 * 60 * 60
  ) {
    return "Week";
  }
  return "Day";
}

async function fetchCliproxyCodexUsage(params: {
  accessToken: string;
  accountId?: string;
  cacheKey: string;
}): Promise<ProviderUsageStatus | undefined> {
  if (!params.accessToken.trim()) {
    return undefined;
  }
  const cached = cliproxyAuthUsageCache.get(params.cacheKey);
  if (
    cached?.value !== undefined &&
    typeof cached.updatedAt === "number" &&
    Date.now() - cached.updatedAt < CLIPROXY_AUTH_USAGE_CACHE_TTL_MS
  ) {
    return cached.value;
  }
  if (cached?.inFlight) {
    return cached.inFlight;
  }
  const task = (async () => {
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${params.accessToken}`,
        "User-Agent": "CodexBar",
        Accept: "application/json",
      };
      if (params.accountId) {
        headers["ChatGPT-Account-Id"] = params.accountId;
      }
      const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        return {
          provider: "openai-codex",
          displayName: "Codex",
          windows: [],
          error:
            response.status === 401 || response.status === 403
              ? "Token expired"
              : `HTTP ${response.status}`,
        } satisfies ProviderUsageStatus;
      }
      const data = (await response.json()) as CliproxyCodexUsageResponse;
      const windows: ProviderUsageWindow[] = [];
      if (data.rate_limit?.primary_window) {
        const primary = data.rate_limit.primary_window;
        const windowHours = Math.round((primary.limit_window_seconds || 10_800) / 3600);
        windows.push({
          label: `${windowHours}h`,
          usedPercent: clampUsagePercent(primary.used_percent || 0),
          resetAt: primary.reset_at ? primary.reset_at * 1000 : undefined,
        });
      }
      if (data.rate_limit?.secondary_window) {
        const secondary = data.rate_limit.secondary_window;
        const windowHours = Math.round((secondary.limit_window_seconds || 86_400) / 3600);
        windows.push({
          label: resolveCliproxyCodexSecondaryWindowLabel({
            windowHours,
            primaryResetAt: data.rate_limit.primary_window?.reset_at,
            secondaryResetAt: secondary.reset_at,
          }),
          usedPercent: clampUsagePercent(secondary.used_percent || 0),
          resetAt: secondary.reset_at ? secondary.reset_at * 1000 : undefined,
        });
      }
      let plan = normalizeOptionalString(data.plan_type);
      if (data.credits?.balance !== undefined && data.credits.balance !== null) {
        const balance =
          typeof data.credits.balance === "number"
            ? data.credits.balance
            : parseFloat(`${data.credits.balance}`) || 0;
        plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
      }
      return {
        provider: "openai-codex",
        displayName: "Codex",
        windows,
        plan: plan || undefined,
      } satisfies ProviderUsageStatus;
    } catch (error) {
      return {
        provider: "openai-codex",
        displayName: "Codex",
        windows: [],
        error: error instanceof Error ? error.message : String(error),
      } satisfies ProviderUsageStatus;
    }
  })();
  cliproxyAuthUsageCache.set(params.cacheKey, { ...cached, inFlight: task });
  const value = await task;
  cliproxyAuthUsageCache.set(params.cacheKey, {
    value,
    updatedAt: Date.now(),
    inFlight: undefined,
  });
  return value;
}

async function loadProjectCliproxyAuthFiles(authDir: string) {
  const entries = await fs.readdir(authDir, { withFileTypes: true }).catch(() => []);
  const authFiles: CliproxyAuthFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
      continue;
    }
    const raw = await fs.readFile(path.join(authDir, entry.name), "utf8").catch(() => "");
    if (!raw.trim()) {
      continue;
    }
    const parsed = safeJsonParse<JsonRecord>(raw, {});
    const provider = normalizeOptionalString(parsed.type) || "unknown";
    const usage =
      provider === "codex"
        ? await fetchCliproxyCodexUsage({
            accessToken: normalizeOptionalString(parsed.access_token) || "",
            accountId: normalizeOptionalString(parsed.account_id),
            cacheKey: `${entry.name}:${normalizeOptionalString(parsed.account_id) || ""}:${normalizeOptionalString(parsed.last_refresh) || ""}`,
          })
        : undefined;
    const authFile = buildCliproxyAuthFile({
      name: entry.name,
      provider,
      label: parsed.email,
      status: "ok",
      email: parsed.email,
      account: parsed.account_id,
      last_refresh: parsed.last_refresh,
      modtime: undefined,
      path: path.join(authDir, entry.name),
      usage,
    });
    if (authFile) {
      authFiles.push(authFile);
    }
  }
  return authFiles;
}

function mergeProjectCliproxyAuthFiles(
  managementAuthFiles: CliproxyAuthFile[],
  projectAuthFiles: CliproxyAuthFile[],
) {
  const projectByName = new Map(projectAuthFiles.map((entry) => [entry.name, entry]));
  return managementAuthFiles.map((entry) => {
    const match =
      projectByName.get(entry.name) ||
      projectAuthFiles.find(
        (candidate) =>
          candidate.provider === entry.provider &&
          (candidate.email || "") === (entry.email || "") &&
          (candidate.account || "") === (entry.account || ""),
      );
    if (!match) {
      return entry;
    }
    return {
      ...entry,
      label: entry.label || match.label,
      email: entry.email || match.email,
      account: entry.account || match.account,
      path: entry.path || match.path,
      lastRefresh: entry.lastRefresh || match.lastRefresh,
      usage: match.usage || entry.usage,
    };
  });
}

async function loadCliproxyStatus(bridge: ProviderBridge): Promise<CliproxyStatusResponse> {
  const warnings: string[] = [];
  const availability = await ensureProjectCliproxyRuntimeAvailable(bridge);
  const projectBootstrap = availability.projectBootstrap;
  const runtimeBaseUrl = normalizeBridgeRuntimeBaseUrl(bridge.runtimeBaseUrl);
  const managementBaseUrl = buildCliproxyManagementBaseUrl(bridge);
  const managementHeaders = buildCliproxyManagementHeaders(bridge);
  const managementConfigured = Boolean(bridge.managementKey);
  const modelResult = availability.probeResult;

  let modelsSource: "runtime" | "bridge" = "runtime";
  let models =
    modelResult.ok && isJsonRecord(modelResult.json)
      ? (
          (Array.isArray(modelResult.json.data)
            ? modelResult.json.data
            : Array.isArray(modelResult.json.models)
              ? modelResult.json.models
              : []
          )
            .map((entry) =>
              normalizeProviderBridgeModel(
                {
                  ...(isJsonRecord(entry) ? entry : {}),
                  contextWindow:
                    isJsonRecord(entry) && typeof entry.context_window === "number"
                      ? entry.context_window
                      : undefined,
                  maxTokens:
                    isJsonRecord(entry) && typeof entry.max_tokens === "number"
                      ? entry.max_tokens
                      : undefined,
                },
                bridge.apiMode,
              ),
            )
            .filter(Boolean) as ProviderBridgeModel[]
        ).toSorted((left, right) => left.id.localeCompare(right.id))
      : [];

  if (!modelResult.ok) {
    warnings.push(`Catalogue providers indisponible: ${modelResult.text || modelResult.status}`);
  }

  if (!managementConfigured) {
    warnings.push("Ajoute une cle d’administration providers pour piloter OAuth, API keys et quotas.");
    return {
      ok: true,
      available: modelResult.ok,
      runtimeBaseUrl,
      managementBaseUrl,
      importedProviderId: bridge.importedProviderId,
      projectDir: projectBootstrap?.projectDir,
      projectConfigPath: projectBootstrap?.configPath,
      projectComposePath: projectBootstrap?.composePath,
      projectAuthDir: projectBootstrap?.authDir,
      managementConfigured: false,
      remoteManagementDisabled: false,
      authFilesSource: "management",
      modelsSource,
      warnings,
      authFiles: [],
      geminiApiKeys: [],
      codexApiKeys: [],
      claudeApiKeys: [],
      openAiCompatibility: [],
      oauthExcludedModels: {},
      models,
    };
  }

  const sectionLoaders = {
    authFiles: fetchJsonWithDetail(`${managementBaseUrl}/auth-files`, {
      headers: managementHeaders,
    }),
    geminiApiKeys: fetchJsonWithDetail(`${managementBaseUrl}/gemini-api-key`, {
      headers: managementHeaders,
    }),
    codexApiKeys: fetchJsonWithDetail(`${managementBaseUrl}/codex-api-key`, {
      headers: managementHeaders,
    }),
    claudeApiKeys: fetchJsonWithDetail(`${managementBaseUrl}/claude-api-key`, {
      headers: managementHeaders,
    }),
    openAiCompatibility: fetchJsonWithDetail(`${managementBaseUrl}/openai-compatibility`, {
      headers: managementHeaders,
    }),
    oauthExcludedModels: fetchJsonWithDetail(`${managementBaseUrl}/oauth-excluded-models`, {
      headers: managementHeaders,
    }),
    usageStatisticsEnabled: fetchJsonWithDetail(`${managementBaseUrl}/usage-statistics-enabled`, {
      headers: managementHeaders,
    }),
    switchProjectOnQuotaExceeded: fetchJsonWithDetail(
      `${managementBaseUrl}/quota-exceeded/switch-project`,
      {
        headers: managementHeaders,
      },
    ),
    switchPreviewModelOnQuotaExceeded: fetchJsonWithDetail(
      `${managementBaseUrl}/quota-exceeded/switch-preview-model`,
      {
        headers: managementHeaders,
      },
    ),
  };

  const settled = await Promise.allSettled(Object.values(sectionLoaders));
  const resultMap = new Map<
    keyof typeof sectionLoaders,
    Awaited<(typeof sectionLoaders)[keyof typeof sectionLoaders]>
  >();
  (Object.keys(sectionLoaders) as Array<keyof typeof sectionLoaders>).forEach((key, index) => {
    const entry = settled[index];
    if (entry.status === "fulfilled") {
      resultMap.set(key, entry.value);
      if (!entry.value.ok) {
        warnings.push(`${key}: ${entry.value.text || entry.value.status}`);
      }
      return;
    }
    warnings.push(
      `${key}: ${entry.reason instanceof Error ? entry.reason.message : String(entry.reason)}`,
    );
  });

  const authFilesRaw = resultMap.get("authFiles")?.json;
  const authFilesSource = Array.isArray(authFilesRaw)
    ? authFilesRaw
    : isJsonRecord(authFilesRaw) && Array.isArray(authFilesRaw.files)
      ? (authFilesRaw.files as unknown[])
      : [];
  let authFilesSourceKind: "management" | "project-auth-dir" = "management";
  let authFiles = authFilesSource
    .map((entry) => buildCliproxyAuthFile(entry))
    .filter(Boolean) as CliproxyAuthFile[];
  const projectAuthFiles = projectBootstrap?.authDir
    ? await loadProjectCliproxyAuthFiles(projectBootstrap.authDir)
    : [];

  if (authFiles.length && projectAuthFiles.length) {
    authFiles = mergeProjectCliproxyAuthFiles(authFiles, projectAuthFiles);
  } else if (!authFiles.length && projectAuthFiles.length) {
    authFiles = projectAuthFiles;
    authFilesSourceKind = "project-auth-dir";
  }

  if (!models.length && bridge.activeModelIds.length) {
    models = bridge.activeModelIds.map((id) => ({
      id,
      displayName: id,
      provider: bridge.importedProviderId || "cliproxyapi",
      apiMode: bridge.apiMode,
      active: true,
    }));
    modelsSource = "bridge";
  }

  const oauthExcludedRaw = resultMap.get("oauthExcludedModels")?.json;
  const oauthExcludedModels = isJsonRecord(oauthExcludedRaw)
    ? Object.fromEntries(
        Object.entries(oauthExcludedRaw).map(([key, value]) => [
          key,
          Array.isArray(value)
            ? value.map((entry) => normalizeOptionalString(entry)).filter(Boolean)
            : [],
        ]),
      )
    : {};

  const booleanFrom = (key: keyof typeof sectionLoaders) => {
    const value = resultMap.get(key)?.json;
    if (typeof value === "boolean") {
      return value;
    }
    if (!isJsonRecord(value)) {
      return undefined;
    }
    if (key === "usageStatisticsEnabled") {
      return typeof value["usage-statistics-enabled"] === "boolean"
        ? (value["usage-statistics-enabled"] as boolean)
        : undefined;
    }
    if (key === "switchProjectOnQuotaExceeded") {
      return typeof value["switch-project"] === "boolean"
        ? (value["switch-project"] as boolean)
        : undefined;
    }
    if (key === "switchPreviewModelOnQuotaExceeded") {
      return typeof value["switch-preview-model"] === "boolean"
        ? (value["switch-preview-model"] as boolean)
        : undefined;
    }
    return undefined;
  };

  const remoteManagementDisabled = warnings.some(
    (warning) =>
      warning.toLowerCase().includes("remote") && warning.toLowerCase().includes("management"),
  );

  return {
    ok: true,
    available: modelResult.ok || resultMap.size > 0,
    runtimeBaseUrl,
    managementBaseUrl,
    importedProviderId: bridge.importedProviderId,
    runtimeMode: projectBootstrap?.runtimeMode,
    projectDir: projectBootstrap?.projectDir,
    projectConfigPath: projectBootstrap?.configPath,
    projectComposePath: projectBootstrap?.composePath,
    projectSourcePath: projectBootstrap?.sourcePath,
    projectBinaryPath: projectBootstrap?.binaryPath,
    projectPidPath: projectBootstrap?.pidPath,
    projectAuthDir: projectBootstrap?.authDir,
    managementConfigured: true,
    remoteManagementDisabled,
    authFilesSource: authFilesSourceKind,
    modelsSource,
    warnings,
    authFiles: authFiles.toSorted((left, right) => {
      const byProvider = left.provider.localeCompare(right.provider);
      if (byProvider !== 0) {
        return byProvider;
      }
      return left.name.localeCompare(right.name);
    }),
    geminiApiKeys: Array.isArray(resultMap.get("geminiApiKeys")?.json)
      ? ((resultMap.get("geminiApiKeys")?.json as unknown[]) || []).filter(isJsonRecord)
      : [],
    codexApiKeys: Array.isArray(resultMap.get("codexApiKeys")?.json)
      ? ((resultMap.get("codexApiKeys")?.json as unknown[]) || []).filter(isJsonRecord)
      : [],
    claudeApiKeys: Array.isArray(resultMap.get("claudeApiKeys")?.json)
      ? ((resultMap.get("claudeApiKeys")?.json as unknown[]) || []).filter(isJsonRecord)
      : [],
    openAiCompatibility: Array.isArray(resultMap.get("openAiCompatibility")?.json)
      ? ((resultMap.get("openAiCompatibility")?.json as unknown[]) || []).filter(isJsonRecord)
      : [],
    oauthExcludedModels,
    usageStatisticsEnabled: booleanFrom("usageStatisticsEnabled"),
    switchProjectOnQuotaExceeded: booleanFrom("switchProjectOnQuotaExceeded"),
    switchPreviewModelOnQuotaExceeded: booleanFrom("switchPreviewModelOnQuotaExceeded"),
    models,
  };
}

function splitModelRef(modelRef?: string | null) {
  const raw = normalizeOptionalString(modelRef);
  if (!raw) {
    return { providerId: undefined, modelId: undefined };
  }
  const separator = raw.indexOf("/");
  if (separator <= 0) {
    return { providerId: raw, modelId: undefined };
  }
  return {
    providerId: raw.slice(0, separator),
    modelId: raw.slice(separator + 1) || undefined,
  };
}

function isCliproxyModelRef(modelRef?: string | null) {
  return splitModelRef(modelRef).providerId === "cliproxyapi";
}

function isCliproxyBridge(bridge?: Partial<ProviderBridge> | null) {
  if (!bridge) {
    return false;
  }
  const bridgeId = normalizeOptionalString(bridge.id);
  const importedProviderId = normalizeOptionalString(bridge.importedProviderId);
  const bridgeName = normalizeOptionalString(bridge.name)?.toLowerCase();
  return (
    bridgeId === "cliproxyapi" ||
    importedProviderId === "cliproxyapi" ||
    bridgeName === "cliproxyapi"
  );
}

function buildBridgeResponsesUrl(runtimeBaseUrl: string) {
  const url = new URL(normalizeBridgeRuntimeBaseUrl(runtimeBaseUrl));
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/responses`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function buildCliproxyProbeCacheKey(bridge: ProviderBridge, modelIds: string[]) {
  return JSON.stringify({
    runtimeBaseUrl: normalizeBridgeRuntimeBaseUrl(bridge.runtimeBaseUrl),
    apiKey: bridge.apiKey || "",
    headers: buildBridgeRequestHeaders(bridge),
    modelIds: [...new Set(modelIds)].toSorted((left, right) => left.localeCompare(right)),
  });
}

function extractCliproxyErrorText(rawText: string, payload: unknown) {
  const record = isJsonRecord(payload) ? payload : {};
  const errorValue = isJsonRecord(record.error) ? record.error : {};
  const message =
    normalizeOptionalString(errorValue.message) ||
    normalizeOptionalString(record.message) ||
    normalizeOptionalString(record.error);
  return message || rawText;
}

function isUnknownCliproxyModelError(text: string) {
  return /unknown provider for model|unknown model/i.test(text);
}

function pickCliproxyPrimaryModelId(
  currentPrimaryModelId: string | undefined,
  supportedModelIds: string[],
) {
  if (!supportedModelIds.length) {
    return undefined;
  }
  if (currentPrimaryModelId && supportedModelIds.includes(currentPrimaryModelId)) {
    return currentPrimaryModelId;
  }
  for (const preferredModelId of CLIPROXY_PRIMARY_MODEL_ORDER) {
    if (supportedModelIds.includes(preferredModelId)) {
      return preferredModelId;
    }
  }
  return supportedModelIds[0];
}

function buildSyntheticBridgeModel(
  bridge: ProviderBridge,
  modelId: string,
  existingModel?: ProviderBridgeModel,
): ProviderBridgeModel {
  return {
    id: modelId,
    name: existingModel?.name || modelId,
    api: existingModel?.api || bridge.apiMode,
    reasoning: existingModel?.reasoning,
    input: existingModel?.input || inferProviderBridgeModelInput(modelId),
    contextWindow: existingModel?.contextWindow,
    maxTokens: existingModel?.maxTokens,
  };
}

async function probeCliproxyModelSupport(
  bridge: ProviderBridge,
  candidateModelIds: string[],
): Promise<CliproxyModelProbeResult> {
  const normalizedCandidates = Array.from(
    new Set(
      [...candidateModelIds, ...CLIPROXY_PRIMARY_MODEL_ORDER]
        .map((entry) => normalizeOptionalString(entry))
        .filter(Boolean) as string[],
    ),
  );
  if (!normalizedCandidates.length) {
    return {
      checkedAt: new Date().toISOString(),
      supportedModelIds: [],
      unsupportedModelIds: [],
    };
  }

  const cacheKey = buildCliproxyProbeCacheKey(bridge, normalizedCandidates);
  let cache = cliproxyModelProbeCache.get(cacheKey);
  if (!cache) {
    cache = {};
    cliproxyModelProbeCache.set(cacheKey, cache);
  }

  return getCachedValue(cache, CLIPROXY_MODEL_PROBE_CACHE_TTL_MS, async () => {
    const checks = await Promise.all(
      normalizedCandidates.map(async (modelId) => {
        const response = await fetchJsonWithDetail(buildBridgeResponsesUrl(bridge.runtimeBaseUrl), {
          method: "POST",
          headers: {
            ...buildBridgeRequestHeaders(bridge),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelId,
            input: "health-check",
            max_output_tokens: 1,
          }),
        }).catch((error) => ({
          ok: false,
          status: 0,
          text: error instanceof Error ? error.message : String(error),
          json: null,
        }));
        const errorText = extractCliproxyErrorText(response.text, response.json);
        return {
          modelId,
          supported: response.ok || !isUnknownCliproxyModelError(errorText),
        };
      }),
    );

    return {
      checkedAt: new Date().toISOString(),
      supportedModelIds: checks.filter((entry) => entry.supported).map((entry) => entry.modelId),
      unsupportedModelIds: checks.filter((entry) => !entry.supported).map((entry) => entry.modelId),
    };
  });
}

function buildCliproxyAgentDefaultsModelValue(bridge: ProviderBridge) {
  if (!bridge.activeModelIds.length) {
    return undefined;
  }
  const primaryModelId = bridge.primaryModelId || bridge.activeModelIds[0];
  if (!primaryModelId) {
    return undefined;
  }
  if (bridge.activeModelIds.length === 1) {
    return `cliproxyapi/${primaryModelId}`;
  }
  return {
    primary: `cliproxyapi/${primaryModelId}`,
    fallbacks: bridge.activeModelIds
      .filter((modelId) => modelId !== primaryModelId)
      .map((modelId) => `cliproxyapi/${modelId}`),
  };
}

function normalizeAgentDefaultsModelComparable(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (!isJsonRecord(value)) {
    return undefined;
  }
  return {
    primary: normalizeOptionalString(value.primary),
    fallbacks: Array.isArray(value.fallbacks)
      ? (value.fallbacks.map((entry) => normalizeOptionalString(entry)).filter(Boolean) as string[])
      : [],
  };
}

function bridgeModelComparableSignature(bridge: ProviderBridge) {
  return JSON.stringify({
    discoveredModels: bridge.discoveredModels,
    activeModelIds: bridge.activeModelIds,
    primaryModelId: bridge.primaryModelId,
    status: bridge.status,
    lastError: bridge.lastError || "",
  });
}

async function normalizeCliproxyBridgeRuntimeModels(bridge: ProviderBridge) {
  if (!isCliproxyBridge(bridge)) {
    return bridge;
  }

  let discoveredModels = bridge.discoveredModels;
  try {
    const runtimeDiscoveredModels = await discoverBridgeModels(bridge);
    if (runtimeDiscoveredModels.length > 0) {
      discoveredModels = runtimeDiscoveredModels;
    }
  } catch {
    // Keep the last known bridge catalog when the runtime probe is temporarily unavailable.
  }

  const candidateModelIds = Array.from(
    new Set(
      [...bridge.activeModelIds, ...discoveredModels.map((model) => model.id)]
        .map((entry) => normalizeOptionalString(entry))
        .filter(Boolean) as string[],
    ),
  );
  let resolvedCandidateModelIds = candidateModelIds;
  if (!resolvedCandidateModelIds.length) {
    return bridge;
  }

  const probe = await probeCliproxyModelSupport(bridge, resolvedCandidateModelIds);
  const supportedModelIds = resolvedCandidateModelIds.filter((modelId) =>
    probe.supportedModelIds.includes(modelId),
  );
  const recoveredFallbackModelIds = probe.supportedModelIds.filter(
    (modelId) => !supportedModelIds.includes(modelId),
  );
  const nextActiveModelIds =
    supportedModelIds.length > 0
      ? supportedModelIds
      : recoveredFallbackModelIds.length > 0
        ? recoveredFallbackModelIds
        : bridge.activeModelIds;

  if (!nextActiveModelIds.length) {
    return bridge;
  }

  const nextPrimaryModelId = pickCliproxyPrimaryModelId(bridge.primaryModelId, nextActiveModelIds);
  const discoveredModelMap = new Map(discoveredModels.map((model) => [model.id, model]));
  const nextDiscoveredModels = nextActiveModelIds.map((modelId) =>
    buildSyntheticBridgeModel(bridge, modelId, discoveredModelMap.get(modelId)),
  );
  const now = new Date().toISOString();
  const nextBridge = normalizeProviderBridge(
    {
      ...bridge,
      discoveredModels: nextDiscoveredModels,
      activeModelIds: nextActiveModelIds,
      primaryModelId: nextPrimaryModelId,
      status: bridge.importedProviderId ? "imported" : "ready",
      lastError: "",
      lastSyncAt: now,
      updatedAt: now,
    },
    now,
    bridge,
  );

  return bridgeModelComparableSignature(nextBridge) === bridgeModelComparableSignature(bridge)
    ? bridge
    : nextBridge;
}

function normalizeProviderConfigModelsComparable(
  value: unknown,
  apiMode?: ProviderBridge["apiMode"],
) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeProviderBridgeModel(entry, apiMode))
    .filter(Boolean)
    .map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      input: model.input || [],
    }));
}

function syncUserTeamMemberships(store: ControlTowerStore) {
  const validUserIds = new Set(store.users.map((user) => user.id));
  const validTeamIds = new Set(store.teams.map((team) => team.id));
  const teamMembers = new Map<string, Set<string>>();
  for (const team of store.teams) {
    teamMembers.set(
      team.id,
      new Set(normalizeIdList(team.memberIds).filter((memberId) => validUserIds.has(memberId))),
    );
  }

  const userTeams = new Map<string, Set<string>>();
  for (const user of store.users) {
    userTeams.set(
      user.id,
      new Set(normalizeIdList(user.teamIds).filter((teamId) => validTeamIds.has(teamId))),
    );
  }

  for (const [teamId, memberIds] of teamMembers.entries()) {
    for (const memberId of memberIds) {
      userTeams.get(memberId)?.add(teamId);
    }
  }

  for (const [userId, teamIds] of userTeams.entries()) {
    for (const teamId of teamIds) {
      teamMembers.get(teamId)?.add(userId);
    }
  }

  store.users = store.users.map((user) => ({
    ...user,
    teamIds: Array.from(userTeams.get(user.id) || []).toSorted((left, right) =>
      left.localeCompare(right),
    ),
  }));
  store.teams = store.teams.map((team) => ({
    ...team,
    memberIds: Array.from(teamMembers.get(team.id) || []).toSorted((left, right) =>
      left.localeCompare(right),
    ),
  }));
}

function syncTeamScopes(store: ControlTowerStore) {
  const validTeamIds = new Set(store.teams.map((team) => team.id));
  const validAgentIds = new Set(store.agentBindings.map((binding) => binding.agentId));
  const validChannelIds = new Set(
    store.channels
      .filter((channel) => isManagedDestinationChannelRecord(channel))
      .map((channel) => channel.id),
  );
  const bindingOwnedAgents = new Map<string, string>();
  for (const binding of store.agentBindings) {
    if (binding.teamId && validTeamIds.has(binding.teamId)) {
      bindingOwnedAgents.set(binding.agentId, binding.teamId);
    }
  }

  const nextTeamAgents = new Map<string, Set<string>>();
  for (const team of store.teams) {
    nextTeamAgents.set(
      team.id,
      new Set(normalizeIdList(team.agentIds).filter((agentId) => validAgentIds.has(agentId))),
    );
  }

  for (const [agentId, teamId] of bindingOwnedAgents.entries()) {
    nextTeamAgents.get(teamId)?.add(agentId);
  }

  store.teams = store.teams.map((team) => ({
    ...team,
    agentIds: Array.from(nextTeamAgents.get(team.id) || []).toSorted((left, right) =>
      left.localeCompare(right),
    ),
    channelIds: normalizeIdList(team.channelIds)
      .filter((channelId) => validChannelIds.has(channelId))
      .toSorted((left, right) => left.localeCompare(right)),
  }));
}

function syncProjectScopes(store: ControlTowerStore) {
  const validTeamIds = new Set(store.teams.map((team) => team.id));
  const validUserIds = new Set(store.users.map((user) => user.id));
  const validAgentIds = new Set(store.agentBindings.map((binding) => binding.agentId));
  const teamMemberIds = new Map(
    store.teams.map((team) => [team.id, new Set(normalizeIdList(team.memberIds))]),
  );

  store.projects = store.projects
    .map((project) => {
      const normalized = normalizeDashboardProjectRecord(project, project.updatedAt || new Date().toISOString());
      if (!validTeamIds.has(normalized.teamId)) {
        return null;
      }
      const teamMembers = teamMemberIds.get(normalized.teamId) || new Set<string>();
      return {
        ...normalized,
        memberIds: normalizeIdList(normalized.memberIds)
          .filter((memberId) => validUserIds.has(memberId) && teamMembers.has(memberId))
          .toSorted((left, right) => left.localeCompare(right)),
        agentIds: normalizeIdList(normalized.agentIds)
          .filter((agentId) => validAgentIds.has(agentId))
          .toSorted((left, right) => left.localeCompare(right)),
      };
    })
    .filter((project): project is DashboardProject => Boolean(project));
}

function syncAgentAccessTeamsInStore(params: {
  store: ControlTowerStore;
  agentId: string;
  ownerTeamId?: string;
  accessTeamIds: string[];
}) {
  const validTeamIds = new Set(params.store.teams.map((team) => team.id));
  const allowedTeamIds = new Set(
    normalizeIdList(params.accessTeamIds).filter((teamId) => validTeamIds.has(teamId)),
  );
  if (params.ownerTeamId && validTeamIds.has(params.ownerTeamId)) {
    allowedTeamIds.add(params.ownerTeamId);
  }
  params.store.teams = params.store.teams.map((team) => {
    const nextAgentIds = new Set(normalizeIdList(team.agentIds));
    if (allowedTeamIds.has(team.id)) {
      nextAgentIds.add(params.agentId);
    } else {
      nextAgentIds.delete(params.agentId);
    }
    return {
      ...team,
      agentIds: Array.from(nextAgentIds).toSorted((left, right) => left.localeCompare(right)),
    };
  });
}

function normalizeRedactedComparableSecret(value: string | undefined) {
  const normalized = normalizeOptionalString(value);
  if (!normalized || normalized === OPENCLAW_REDACTED_SENTINEL) {
    return normalized ? "__present__" : "";
  }
  return "__present__";
}

function isGatewayRestartTransientError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Gateway WebSocket closed before response: 1012") ||
    message.includes("Gateway WebSocket error: unknown") ||
    message.includes("ECONNREFUSED")
  );
}

async function gatewayBatchWithRestartRetry(
  baseUrl: string,
  token: string,
  calls: Record<string, GatewayCall>,
  options?: { timeoutMs?: number; retries?: number; retryDelayMs?: number },
) {
  const retries =
    typeof options?.retries === "number" && Number.isFinite(options.retries)
      ? Math.max(0, Math.floor(options.retries))
      : 1;
  const retryDelayMs =
    typeof options?.retryDelayMs === "number" && Number.isFinite(options.retryDelayMs)
      ? Math.max(100, Math.floor(options.retryDelayMs))
      : 1_500;
  let attempt = 0;
  while (true) {
    try {
      return await gatewayBatch(baseUrl, token, calls, options);
    } catch (error) {
      if (attempt >= retries || !isGatewayRestartTransientError(error)) {
        throw error;
      }
      attempt += 1;
      await ensureGatewayAvailable(baseUrl).catch(() => undefined);
      await sleep(retryDelayMs);
    }
  }
}

async function syncCliproxyBridgeInStore(store: ControlTowerStore) {
  const cliproxyBridgeIndex = store.providerBridges.findIndex((entry) => isCliproxyBridge(entry));
  if (cliproxyBridgeIndex < 0) {
    return { bridge: undefined, changed: false };
  }

  const currentBridge = store.providerBridges[cliproxyBridgeIndex]!;
  await ensureProjectCliproxyRuntimeAvailable(currentBridge).catch(() => undefined);
  const nextBridge = await normalizeCliproxyBridgeRuntimeModels(currentBridge);
  if (
    bridgeModelComparableSignature(nextBridge) === bridgeModelComparableSignature(currentBridge)
  ) {
    return { bridge: currentBridge, changed: false };
  }

  store.providerBridges[cliproxyBridgeIndex] = nextBridge;
  return { bridge: nextBridge, changed: true };
}

async function resolveSafeChatModelRef(
  requestedModelRef?: string | null,
  authStatus?: OpenClawModelsStatusJson,
) {
  const explicitModelRef = normalizeOptionalString(requestedModelRef) || undefined;
  const loadedAuthStatus =
    authStatus ||
    (await loadModelsStatusJson().catch(() => {
      return undefined;
    }));
  const preferredModelRef =
    explicitModelRef ||
    normalizeOptionalString(loadedAuthStatus?.resolvedDefault) ||
    normalizeOptionalString(loadedAuthStatus?.defaultModel) ||
    undefined;
  const store = await loadStore([], []);
  const { bridge, changed } = await syncCliproxyBridgeInStore(store);
  if (changed) {
    await saveStore(DEFAULT_STORE_PATH, store);
  }
  await ensureProjectCliproxyRuntimeAvailable(bridge).catch(() => undefined);
  const cliproxyModelId = bridge?.primaryModelId || bridge?.activeModelIds[0];
  if (!cliproxyModelId) {
    return preferredModelRef;
  }

  const preferredProvider = splitModelRef(preferredModelRef).providerId;
  const preferredModelId = splitModelRef(preferredModelRef).modelId;
  if (!preferredModelRef) {
    return `cliproxyapi/${cliproxyModelId}`;
  }
  if (
    preferredProvider === "cliproxyapi" &&
    preferredModelId &&
    bridge?.activeModelIds.includes(preferredModelId)
  ) {
    return preferredModelRef;
  }
  return `cliproxyapi/${cliproxyModelId}`;
}

function getSessionModelRef(session: JsonRecord) {
  const providerOverride = normalizeOptionalString(session.providerOverride);
  const modelOverride = normalizeOptionalString(session.modelOverride);
  if (providerOverride && modelOverride) {
    return `${providerOverride}/${modelOverride}`;
  }
  const provider = normalizeOptionalString(session.modelProvider);
  const model = normalizeOptionalString(session.model);
  if (provider && model) {
    return `${provider}/${model}`;
  }
  return undefined;
}

async function loadSessionRecord(
  gatewayUrl: string,
  gatewayToken: string,
  sessionKey: string,
): Promise<JsonRecord | undefined> {
  const response = await gatewayBatch(gatewayUrl, gatewayToken, {
    sessions: {
      method: "sessions.list",
      params: {
        includeDerivedTitles: false,
        includeLastMessage: false,
        includeGlobal: true,
        includeUnknown: true,
        limit: 500,
      },
    },
  });
  const payload = (response.results.sessions as JsonRecord | undefined) || {};
  const sessions = Array.isArray(payload.sessions) ? (payload.sessions as JsonRecord[]) : [];
  return sessions.find((entry) => normalizeOptionalString(entry.key) === sessionKey);
}

async function healSessionModelIfNeeded(
  gatewayUrl: string,
  gatewayToken: string,
  sessionKey: string,
) {
  const session = await loadSessionRecord(gatewayUrl, gatewayToken, sessionKey);
  const currentModelRef = session ? getSessionModelRef(session) : undefined;
  const safeModelRef = await resolveSafeChatModelRef(currentModelRef);
  if (!safeModelRef || safeModelRef === currentModelRef) {
    return currentModelRef;
  }
  await gatewayBatch(gatewayUrl, gatewayToken, {
    patch: {
      method: "sessions.patch",
      params: {
        key: sessionKey,
        model: safeModelRef,
      },
    },
  });
  return safeModelRef;
}

async function reconcileCliproxyOnlyGatewayConfig(
  gatewayUrl: string,
  gatewayToken: string,
  bridge: ProviderBridge,
) {
  const configGet = await gatewayBatch(gatewayUrl, gatewayToken, {
    config: { method: "config.get", params: {} },
  });
  const payload = (configGet.results.config as JsonRecord | undefined) || {};
  const baseHash = normalizeOptionalString(payload.hash);
  if (!baseHash) {
    return false;
  }

  const config = isJsonRecord(payload.config) ? payload.config : {};
  const currentModelsConfig = isJsonRecord(config.models) ? config.models : {};
  const currentProviders = isJsonRecord(currentModelsConfig.providers)
    ? currentModelsConfig.providers
    : {};
  const currentAgentsConfig = isJsonRecord(config.agents) ? config.agents : {};
  const currentAgentDefaults = isJsonRecord(currentAgentsConfig.defaults)
    ? currentAgentsConfig.defaults
    : {};
  const currentCliproxyProvider = isJsonRecord(currentProviders.cliproxyapi)
    ? (currentProviders.cliproxyapi as JsonRecord)
    : {};
  const nextCliproxyProvider = buildImportedProviderConfig(bridge);
  const currentDefaultModelComparable = normalizeAgentDefaultsModelComparable(
    currentAgentDefaults.model,
  );
  const nextDefaultModelValue = buildCliproxyAgentDefaultsModelValue(bridge);
  const nextDefaultModelComparable = normalizeAgentDefaultsModelComparable(nextDefaultModelValue);

  const currentCliproxyComparable = {
    baseUrl: normalizeOptionalString(currentCliproxyProvider.baseUrl),
    apiKey: normalizeRedactedComparableSecret(
      normalizeOptionalString(currentCliproxyProvider.apiKey),
    ),
    auth: normalizeOptionalString(currentCliproxyProvider.auth),
    api: normalizeOptionalString(currentCliproxyProvider.api),
    authHeader:
      typeof currentCliproxyProvider.authHeader === "boolean"
        ? currentCliproxyProvider.authHeader
        : undefined,
    models: normalizeProviderConfigModelsComparable(currentCliproxyProvider.models, bridge.apiMode),
  };
  const nextCliproxyComparable = {
    baseUrl: nextCliproxyProvider.baseUrl,
    apiKey: normalizeRedactedComparableSecret(nextCliproxyProvider.apiKey),
    auth: nextCliproxyProvider.auth,
    api: nextCliproxyProvider.api,
    authHeader: nextCliproxyProvider.authHeader,
    models: normalizeProviderConfigModelsComparable(nextCliproxyProvider.models, bridge.apiMode),
  };

  const providersAlreadyStrict =
    Object.keys(currentProviders).length === 1 && isJsonRecord(currentProviders.cliproxyapi);
  const cliproxyMatches =
    JSON.stringify(currentCliproxyComparable) === JSON.stringify(nextCliproxyComparable);
  const defaultsMatch =
    JSON.stringify(currentDefaultModelComparable) === JSON.stringify(nextDefaultModelComparable);
  if (providersAlreadyStrict && cliproxyMatches && defaultsMatch) {
    return false;
  }

  const nextConfig = structuredClone(config);
  const nextModelsConfig = isJsonRecord(nextConfig.models) ? nextConfig.models : {};
  nextModelsConfig.providers = {
    cliproxyapi: nextCliproxyProvider,
  };
  nextConfig.models = nextModelsConfig;
  const nextAgentsConfig = isJsonRecord(nextConfig.agents) ? nextConfig.agents : {};
  const nextAgentDefaults = isJsonRecord(nextAgentsConfig.defaults)
    ? nextAgentsConfig.defaults
    : {};
  if (nextDefaultModelValue === undefined) {
    delete nextAgentDefaults.model;
  } else {
    nextAgentDefaults.model = nextDefaultModelValue;
  }
  nextAgentsConfig.defaults = nextAgentDefaults;
  nextConfig.agents = nextAgentsConfig;

  await gatewayBatch(gatewayUrl, gatewayToken, {
    apply: {
      method: "config.apply",
      params: {
        raw: JSON.stringify(nextConfig, null, 2),
        baseHash,
      },
    },
  });
  await sleep(1500);
  await ensureGatewayAvailable(gatewayUrl);
  return true;
}

function buildBridgeRequestHeaders(bridge: ProviderBridge) {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...bridge.headers,
  };
  const hasAuthHeader =
    typeof headers.Authorization === "string" || typeof headers.authorization === "string";
  if (bridge.apiKey && bridge.authHeader && !hasAuthHeader) {
    headers.Authorization = `Bearer ${bridge.apiKey}`;
  }
  return headers;
}

async function discoverBridgeModels(bridge: ProviderBridge) {
  const response = await fetch(buildBridgeModelsUrl(bridge.runtimeBaseUrl), {
    headers: buildBridgeRequestHeaders(bridge),
  });
  const raw = await response.text();
  const payload = safeJsonParse<JsonRecord>(raw, {});
  if (!response.ok) {
    const bodySnippet = raw.trim().slice(0, 240);
    throw new Error(
      `Bridge discovery failed (${response.status}): ${bodySnippet || response.statusText || "unknown error"}`,
    );
  }

  const data = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : [];

  const models = data
    .map((entry) =>
      normalizeProviderBridgeModel(
        {
          ...(isJsonRecord(entry) ? entry : {}),
          contextWindow:
            isJsonRecord(entry) && typeof entry.context_window === "number"
              ? entry.context_window
              : undefined,
          maxTokens:
            isJsonRecord(entry) && typeof entry.max_tokens === "number"
              ? entry.max_tokens
              : undefined,
        },
        bridge.apiMode,
      ),
    )
    .filter(Boolean) as ProviderBridgeModel[];

  if (!models.length) {
    throw new Error("Bridge discovery returned no models.");
  }

  return models.toSorted((left, right) => left.id.localeCompare(right.id));
}

function buildImportedProviderConfig(bridge: ProviderBridge) {
  const selectedModels = bridge.discoveredModels.filter((model) =>
    bridge.activeModelIds.includes(model.id),
  );
  if (!selectedModels.length) {
    throw new Error("Select at least one model before importing this bridge.");
  }
  const providerConfig: JsonRecord = {
    baseUrl: normalizeBridgeRuntimeBaseUrl(bridge.runtimeBaseUrl),
    api: bridge.apiMode,
    authHeader: bridge.authHeader,
    models: selectedModels.map((model) => {
      const definition: JsonRecord = {
        id: model.id,
        name: model.name,
        api: model.api || bridge.apiMode,
      };
      if (typeof model.reasoning === "boolean") {
        definition.reasoning = model.reasoning;
      }
      if (Array.isArray(model.input) && model.input.length > 0) {
        definition.input = [...model.input];
      }
      if (typeof model.contextWindow === "number") {
        definition.contextWindow = model.contextWindow;
      }
      if (typeof model.maxTokens === "number") {
        definition.maxTokens = model.maxTokens;
      }
      return definition;
    }),
  };

  if (bridge.apiKey) {
    providerConfig.apiKey = bridge.apiKey;
  }
  if (bridge.authMode) {
    providerConfig.auth = bridge.authMode;
  }
  if (Object.keys(bridge.headers).length > 0) {
    providerConfig.headers = bridge.headers;
  }

  return providerConfig;
}

function normalizeGatewayHttpUrl(baseUrl: string): string {
  const value = baseUrl.trim() || DEFAULT_GATEWAY_URL;
  const normalized = value.startsWith("ws")
    ? value.replace(/^ws/i, (match) => (match === "wss" ? "https" : "http"))
    : value;
  const url = new URL(normalized);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toGatewayWsUrl(baseUrl: string): string {
  const httpUrl = normalizeGatewayHttpUrl(baseUrl);
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function isGatewayHealthy(baseUrl: string) {
  for (const probePath of ["/health", "/healthz"]) {
    const healthUrl = `${normalizeGatewayHttpUrl(baseUrl)}${probePath}`;
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return true;
      }
    } catch {
      // Try the next probe path.
    }
  }
  return false;
}

function spawnBackendCompanion() {
  const child = spawn(DEFAULT_BACKEND_START_SCRIPT, [], {
    cwd: DEFAULT_BACKEND_ROOT,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function bestEffortShell(command: string) {
  spawnSync(process.env.SHELL || "/bin/sh", ["-lc", command], {
    stdio: "ignore",
  });
}

async function restartRuntimeBackend() {
  const runtimeEnv = buildRuntimeEnvStatusSync();
  const supervisorPidPath = path.join(runtimeEnv.effective.runtimeDir, "backend-supervisor.pid");
  const supervisorPidRaw = fsSync.existsSync(supervisorPidPath)
    ? fsSync.readFileSync(supervisorPidPath, "utf8")
    : "";
  const supervisorPid = Number.parseInt(supervisorPidRaw.trim(), 10);
  if (Number.isFinite(supervisorPid) && supervisorPid > 0) {
    try {
      process.kill(supervisorPid, "SIGTERM");
    } catch {
      // Best effort only.
    }
  }
  bestEffortShell(
    `pkill -f ${formatEnvValue(DEFAULT_BACKEND_START_SCRIPT)} >/dev/null 2>&1 || true`,
  );
  bestEffortShell(
    `PIDS="$(lsof -ti tcp:${runtimeEnv.effective.gatewayPort} 2>/dev/null || true)"; [ -z "$PIDS" ] || kill $PIDS >/dev/null 2>&1 || true`,
  );
  await sleep(800);
  spawnBackendCompanion();
  const healthy = await ensureGatewayAvailable(runtimeEnv.effective.gatewayUrl);
  return {
    healthy,
    gatewayUrl: runtimeEnv.gatewayUrl,
    gatewayToken: runtimeEnv.gatewayToken,
  };
}

async function ensureGatewayAvailable(baseUrl: string) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await isGatewayHealthy(baseUrl)) {
      return true;
    }
    await sleep(500);
  }

  spawnBackendCompanion();

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await isGatewayHealthy(baseUrl)) {
      return true;
    }
    await sleep(1000);
  }

  return false;
}

function pushChannelOperation(operation: ChannelSetupOperation) {
  channelOperations.set(operation.id, operation);
  channelOperationOrder.unshift(operation.id);
  while (channelOperationOrder.length > 40) {
    const removedId = channelOperationOrder.pop();
    if (removedId) {
      channelOperations.delete(removedId);
    }
  }
  return operation;
}

function appendChannelOperationLog(operation: ChannelSetupOperation, line: string) {
  const trimmed = line.replace(/\r/g, "").trimEnd();
  if (!trimmed) {
    return;
  }
  operation.logs.push(trimmed);
  if (operation.logs.length > 300) {
    operation.logs.splice(0, operation.logs.length - 300);
  }
}

function finishChannelOperation(
  operation: ChannelSetupOperation,
  status: ChannelSetupOperation["status"],
  note?: string,
) {
  operation.status = status;
  operation.completedAt = new Date().toISOString();
  if (note) {
    appendChannelOperationLog(operation, note);
  }
}

async function runOpenClawCliOperation(params: {
  kind: ChannelSetupOperation["kind"];
  channelId: string;
  accountId?: string;
  args: string[];
}) {
  const invocation = resolveOpenClawCliInvocation(params.args);
  const operation = pushChannelOperation({
    id: randomUUID(),
    kind: params.kind,
    channelId: params.channelId,
    accountId: params.accountId,
    status: "running",
    command: invocation.display,
    logs: [],
    startedAt: new Date().toISOString(),
  });

  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: buildOpenClawCliEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    appendChannelOperationLog(operation, String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    appendChannelOperationLog(operation, String(chunk));
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });

  if (exitCode !== 0) {
    finishChannelOperation(operation, "failed", `Process exited with code ${exitCode}.`);
    throw new Error(
      operation.logs[operation.logs.length - 1] || `Command failed with code ${exitCode}.`,
    );
  }

  finishChannelOperation(operation, "done", "Commande terminee.");
  return operation;
}

async function runOpenClawCliCommand(args: string[]) {
  const invocation = resolveOpenClawCliInvocation(args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: buildOpenClawCliEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `Command failed with code ${exitCode}.`);
  }

  return {
    command: invocation.display,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

async function runOpenClawCliJson<T>(args: string[]) {
  const invocation = resolveOpenClawCliInvocation(args);
  return await runJsonCommand<T>(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: buildOpenClawCliEnv(),
  });
}

function buildOpenClawInboundBindingCliTarget(channelId: string, accountId?: string) {
  const normalizedChannelId = normalizeChannelBindingId(channelId);
  if (!normalizedChannelId) {
    throw new Error("channelId required");
  }
  return `${normalizedChannelId}:${normalizeAccountId(accountId)}`;
}

async function syncOpenClawInboundBinding(params: {
  channelId: string;
  accountId?: string;
  agentId?: string;
}) {
  const runtimeEnv = buildRuntimeEnvStatusSync();
  const normalizedChannelId = normalizeChannelBindingId(params.channelId);
  if (!normalizedChannelId) {
    throw new Error("channelId required");
  }
  if (isSystemChannelKind(normalizedChannelId)) {
    throw new Error(`Le channel ${normalizedChannelId} ne supporte pas de binding inbound.`);
  }
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const bindTarget = buildOpenClawInboundBindingCliTarget(normalizedChannelId, normalizedAccountId);
  const desiredAgentId = normalizeOptionalString(params.agentId);
  const currentBindings = loadOpenClawInboundRouteBindingsSync(runtimeEnv.effective.configPath);
  const matchingBindings = currentBindings.filter(
    (binding) =>
      binding.channelId === normalizedChannelId &&
      normalizeAccountId(binding.accountId) === normalizedAccountId,
  );

  for (const binding of matchingBindings) {
    if (desiredAgentId && binding.agentId === desiredAgentId) {
      continue;
    }
    await runOpenClawCliCommand([
      "agents",
      "unbind",
      "--agent",
      binding.agentId,
      "--bind",
      bindTarget,
      "--json",
    ]);
  }

  if (desiredAgentId && !matchingBindings.some((binding) => binding.agentId === desiredAgentId)) {
    await runOpenClawCliCommand([
      "agents",
      "bind",
      "--agent",
      desiredAgentId,
      "--bind",
      bindTarget,
      "--json",
    ]);
  }

  return loadOpenClawInboundRouteBindingsSync(runtimeEnv.effective.configPath);
}

async function runJsonCommand<T>(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) {
  const child = spawn(command, args, {
    cwd: options?.cwd || DEFAULT_BACKEND_ROOT,
    env: options?.env || process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `Command failed with code ${exitCode}.`);
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`Command returned no JSON output: ${args.join(" ")}`);
  }

  const candidateStarts = new Set<number>([0]);
  for (let index = 0; index < trimmed.length; index += 1) {
    const current = trimmed[index];
    if ((current === "{" || current === "[") && (index === 0 || trimmed[index - 1] === "\n")) {
      candidateStarts.add(index);
    }
  }
  for (const start of candidateStarts) {
    const candidate = start > 0 ? trimmed.slice(start) : trimmed;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try the next JSON-looking boundary; warnings may prefix the payload.
    }
  }
  throw new Error(stderr.trim() || `Command returned non-JSON output: ${args.join(" ")}`);
}

async function getCachedValue<T>(cache: CachedValue<T>, ttlMs: number, loader: () => Promise<T>) {
  const now = Date.now();
  if (cache.value !== undefined && cache.updatedAt !== undefined && now - cache.updatedAt < ttlMs) {
    return cache.value;
  }
  if (cache.inFlight) {
    return cache.inFlight;
  }
  cache.inFlight = loader()
    .then((value) => {
      cache.value = value;
      cache.updatedAt = Date.now();
      return value;
    })
    .finally(() => {
      cache.inFlight = undefined;
    });
  return cache.inFlight;
}

async function loadModelsStatusJson() {
  return await runOpenClawCliJson<OpenClawModelsStatusJson>(["models", "status", "--json"]);
}

async function loadConfiguredRuntimeProviderMap() {
  const runtimeProviderMap = new Map<
    string,
    { runtimeModelCount: number; runtimeModels: string[] }
  >();
  const runtimeEnv = buildRuntimeEnvStatusSync();
  const rawConfig = await fs.readFile(runtimeEnv.effective.configPath, "utf8");
  const parsedConfig = safeJsonParse<JsonRecord>(rawConfig, {});
  const modelsConfig = isJsonRecord(parsedConfig.models) ? parsedConfig.models : {};
  const providerConfig = isJsonRecord(modelsConfig.providers)
    ? modelsConfig.providers
    : isJsonRecord(parsedConfig.providers)
      ? parsedConfig.providers
      : {};

  for (const [providerId, rawProvider] of Object.entries(providerConfig)) {
    if (!providerId) {
      continue;
    }
    const modelIds = Array.isArray((rawProvider as JsonRecord | undefined)?.models)
      ? (((rawProvider as JsonRecord).models as unknown[]) || [])
          .map((entry) => {
            if (isJsonRecord(entry)) {
              return (
                normalizeOptionalString(entry.id) ||
                normalizeOptionalString(entry.name) ||
                undefined
              );
            }
            return normalizeOptionalString(entry);
          })
          .filter((entry): entry is string => Boolean(entry))
      : [];
    runtimeProviderMap.set(providerId, {
      runtimeModelCount: modelIds.length,
      runtimeModels: modelIds.slice(0, 8),
    });
  }

  return runtimeProviderMap;
}

async function mutateGatewayConfig(
  gatewayUrl: string,
  gatewayToken: string,
  mutate: (config: JsonRecord) => JsonRecord,
) {
  const configGet = await gatewayBatch(gatewayUrl, gatewayToken, {
    config: { method: "config.get", params: {} },
  });
  const payload = (configGet.results.config as JsonRecord | undefined) || {};
  const baseHash = normalizeOptionalString(payload.hash);
  if (!baseHash) {
    throw new Error("Gateway config hash unavailable; retry after refreshing the dashboard.");
  }
  const config = isJsonRecord(payload.config) ? payload.config : {};
  const nextConfig = mutate(structuredClone(config));
  const applied = await gatewayBatch(gatewayUrl, gatewayToken, {
    apply: {
      method: "config.apply",
      params: {
        raw: JSON.stringify(nextConfig, null, 2),
        baseHash,
      },
    },
  });
  await sleep(3000);
  await ensureGatewayAvailable(gatewayUrl);
  return applied.results.apply || null;
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function readManagedMemoryConfig(value: unknown): ManagedMemoryEngineConfig {
  const record = isJsonRecord(value) ? value : {};
  return {
    dbPath: normalizeOptionalString(record.dbPath),
    storePath: normalizeOptionalString(record.storePath),
    dataRoot: normalizeOptionalString(record.dataRoot),
    injectUserContext:
      typeof record.injectUserContext === "boolean" ? record.injectUserContext : undefined,
    injectTeamContext:
      typeof record.injectTeamContext === "boolean" ? record.injectTeamContext : undefined,
    injectProjectContext:
      typeof record.injectProjectContext === "boolean"
        ? record.injectProjectContext
        : undefined,
    auditLogPath: normalizeOptionalString(record.auditLogPath),
    maxInjectedChars: normalizeOptionalNumber(record.maxInjectedChars),
    summaryModel: normalizeOptionalString(record.summaryModel),
    expansionModel: normalizeOptionalString(record.expansionModel),
    freshTailCount: normalizeOptionalNumber(record.freshTailCount),
    contextThreshold: normalizeOptionalNumber(record.contextThreshold),
    incrementalMaxDepth: normalizeOptionalNumber(record.incrementalMaxDepth),
    ignoreSessionPatterns: normalizeStringArray(record.ignoreSessionPatterns),
    statelessSessionPatterns: normalizeStringArray(record.statelessSessionPatterns),
    skipStatelessSessions: record.skipStatelessSessions === true,
  };
}

function readManagedMemorySubagent(value: unknown) {
  const record = isJsonRecord(value) ? value : {};
  return {
    allowModelOverride: record.allowModelOverride === true,
    allowedModels: normalizeStringArray(record.allowedModels),
  };
}

function toManagedMemoryConfigPatch(value: unknown) {
  const config = readManagedMemoryConfig(value);
  const patch: JsonRecord = {};
  if (config.dbPath) {
    patch.dbPath = config.dbPath;
  }
  if (config.storePath) {
    patch.storePath = config.storePath;
  }
  if (config.dataRoot) {
    patch.dataRoot = config.dataRoot;
  }
  if (config.auditLogPath) {
    patch.auditLogPath = config.auditLogPath;
  }
  if (config.injectUserContext !== undefined) {
    patch.injectUserContext = config.injectUserContext;
  }
  if (config.injectTeamContext !== undefined) {
    patch.injectTeamContext = config.injectTeamContext;
  }
  if (config.injectProjectContext !== undefined) {
    patch.injectProjectContext = config.injectProjectContext;
  }
  if (config.maxInjectedChars !== undefined) {
    patch.maxInjectedChars = config.maxInjectedChars;
  }
  if (config.summaryModel) {
    patch.summaryModel = config.summaryModel;
  }
  if (config.expansionModel) {
    patch.expansionModel = config.expansionModel;
  }
  if (config.freshTailCount !== undefined) {
    patch.freshTailCount = config.freshTailCount;
  }
  if (config.contextThreshold !== undefined) {
    patch.contextThreshold = config.contextThreshold;
  }
  if (config.incrementalMaxDepth !== undefined) {
    patch.incrementalMaxDepth = config.incrementalMaxDepth;
  }
  if (config.ignoreSessionPatterns.length > 0) {
    patch.ignoreSessionPatterns = config.ignoreSessionPatterns;
  }
  if (config.statelessSessionPatterns.length > 0) {
    patch.statelessSessionPatterns = config.statelessSessionPatterns;
  }
  if (config.skipStatelessSessions) {
    patch.skipStatelessSessions = true;
  }
  return patch;
}

function toManagedMemorySubagentPatch(value: unknown) {
  const subagent = readManagedMemorySubagent(value);
  if (!subagent.allowModelOverride && subagent.allowedModels.length === 0) {
    return null;
  }
  return {
    allowModelOverride: subagent.allowModelOverride,
    allowedModels: subagent.allowedModels,
  } satisfies JsonRecord;
}

function resolveManagedMemoryPaths(params: {
  managedPluginId: string;
  config: ManagedMemoryEngineConfig;
  defaultDbPath: string;
}) {
  const dataRoot =
    params.managedPluginId === "elytrasless"
      ? params.config.dataRoot ||
        normalizeOptionalString(process.env.ELYTRAS_DATA_ROOT) ||
        normalizeOptionalString(BOOTSTRAP_PROJECT_ENV_VALUES.ELYTRAS_DATA_ROOT) ||
        path.join(os.homedir(), ".openclaw", "elytras")
      : undefined;
  const storePath =
    params.managedPluginId === "elytrasless"
      ? params.config.storePath ||
        normalizeOptionalString(process.env.CONTROL_TOWER_STORE_PATH) ||
        normalizeOptionalString(BOOTSTRAP_PROJECT_ENV_VALUES.CONTROL_TOWER_STORE_PATH) ||
        DEFAULT_STORE_PATH
      : undefined;
  const auditLogPath =
    params.managedPluginId === "elytrasless"
      ? params.config.auditLogPath ||
        (dataRoot ? path.join(dataRoot, ".elytrasless", "events.jsonl") : undefined)
      : undefined;
  return {
    dbPath: params.config.dbPath || params.defaultDbPath,
    storePath,
    dataRoot,
    auditLogPath,
  };
}

async function loadManagedMemoryDbStats(dbPath: string) {
  try {
    const stat = await fs.stat(dbPath);
    const { DatabaseSync } = await loadSqliteModule();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare(
          `
            select
              (select count(*) from conversations) as conversations,
              (select count(*) from messages) as messages,
              (select count(*) from summaries) as summaries
          `,
        )
        .get() as Record<string, number> | undefined;
      return {
        available: true,
        sizeBytes: stat.size,
        updatedAtMs: stat.mtimeMs,
        conversations: typeof row?.conversations === "number" ? row.conversations : 0,
        messages: typeof row?.messages === "number" ? row.messages : 0,
        summaries: typeof row?.summaries === "number" ? row.summaries : 0,
      };
    } finally {
      db.close();
    }
  } catch {
    return {
      available: false,
    };
  }
}

async function loadManagedMemoryAuditStatus(auditLogPath?: string) {
  if (!auditLogPath) {
    return { exists: false };
  }
  try {
    const stat = await fs.stat(auditLogPath);
    const raw = await fs.readFile(auditLogPath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const lastRecord = safeJsonParse<JsonRecord>(lines.at(-1) || "", {});
    return {
      path: auditLogPath,
      exists: true,
      sizeBytes: stat.size,
      updatedAtMs: stat.mtimeMs,
      lineCount: lines.length,
      lastEventAt: normalizeOptionalString(lastRecord.timestamp),
      lastEventType:
        normalizeOptionalString(lastRecord.event) || normalizeOptionalString(lastRecord.type),
      lastSessionKey: normalizeOptionalString(lastRecord.sessionKey),
    };
  } catch {
    return {
      path: auditLogPath,
      exists: false,
    };
  }
}

async function loadMemoryEngineStatus(
  gatewayUrl: string,
  gatewayToken: string,
): Promise<MemoryEngineStatus> {
  const runtimeEnv = buildRuntimeEnvStatusSync();
  await ensureGatewayAvailable(gatewayUrl);
  const response = await gatewayBatch(gatewayUrl, gatewayToken, {
    config: { method: "config.get", params: {} },
  });
  const configPayload = (response.results.config as JsonRecord | undefined) || {};
  const config = isJsonRecord(configPayload.config) ? configPayload.config : {};
  const pluginsConfig = isJsonRecord(config.plugins) ? config.plugins : {};
  const pluginSlots = isJsonRecord(pluginsConfig.slots) ? pluginsConfig.slots : {};
  const pluginEntries = isJsonRecord(pluginsConfig.entries) ? pluginsConfig.entries : {};
  const activeEngineId = normalizeOptionalString(pluginSlots.contextEngine) || "legacy";
  const pluginList = await runOpenClawCliJson<OpenClawPluginListJson>([
    "plugins",
    "list",
    "--json",
  ]);
  const elytraslessPlugin =
    pluginList.plugins?.find((plugin) => normalizeOptionalString(plugin.id) === "elytrasless") ||
    null;
  const losslessPlugin =
    pluginList.plugins?.find((plugin) => normalizeOptionalString(plugin.id) === "lossless-claw") ||
    null;
  const managedPluginId =
    activeEngineId === "elytrasless" && elytraslessPlugin
      ? "elytrasless"
      : activeEngineId === "lossless-claw" && losslessPlugin
        ? "lossless-claw"
        : elytraslessPlugin
          ? "elytrasless"
          : losslessPlugin
            ? "lossless-claw"
            : activeEngineId === "lossless-claw"
              ? "lossless-claw"
              : "elytrasless";
  const managedPluginRecord =
    managedPluginId === "lossless-claw" ? losslessPlugin : elytraslessPlugin;
  const managedPluginEntry = isJsonRecord(pluginEntries[managedPluginId])
    ? pluginEntries[managedPluginId]
    : {};
  const managedPluginConfig = readManagedMemoryConfig(managedPluginEntry.config);
  const managedPluginSubagent = readManagedMemorySubagent(managedPluginEntry.subagent);
  const defaultDbPath = path.join(
    runtimeEnv.effective.stateDir,
    managedPluginId === "elytrasless" ? "elytrasless.sqlite" : "lossless-claw.sqlite",
  );
  const resolvedPaths = resolveManagedMemoryPaths({
    managedPluginId,
    config: managedPluginConfig,
    defaultDbPath,
  });
  const [dbStats, auditLog] = await Promise.all([
    loadManagedMemoryDbStats(resolvedPaths.dbPath),
    loadManagedMemoryAuditStatus(resolvedPaths.auditLogPath),
  ]);

  return {
    ok: true,
    activeEngineId,
    configPath: runtimeEnv.effective.configPath,
    defaultDbPath,
    resolvedPaths,
    dbStats,
    auditLog,
    managedPluginId,
    managedPluginLabel: managedPluginId === "elytrasless" ? "Elytrasless" : "Lossless Claw",
    managedPlugin: {
      installed: Boolean(managedPluginRecord),
      enabled: managedPluginEntry.enabled === true,
      selected: activeEngineId === managedPluginId,
      status: normalizeOptionalString(managedPluginRecord?.status),
      version: normalizeOptionalString(managedPluginRecord?.version),
      source: normalizeOptionalString(managedPluginRecord?.source),
      description: normalizeOptionalString(managedPluginRecord?.description),
      toolNames: normalizeStringArray(managedPluginRecord?.toolNames),
      config: managedPluginConfig,
      subagent: managedPluginSubagent,
    },
  };
}

function summarizeChannelAccountStatus(account: JsonRecord) {
  const configured = account.configured === true;
  const linked = account.linked === true;
  const connected = account.connected === true;
  const running = account.running === true;
  if (connected) {
    return "connected";
  }
  if (linked) {
    return "linked";
  }
  if (configured) {
    return "configured";
  }
  if (running) {
    return "running";
  }
  return "not configured";
}

function resolveChannelAccountConfigRecord(
  channelConfig: JsonRecord | null,
  accountId: string,
): JsonRecord | null {
  if (!channelConfig) {
    return null;
  }
  const accounts = isJsonRecord(channelConfig.accounts) ? channelConfig.accounts : {};
  const normalizedAccountId = normalizeAccountId(accountId);
  if (isJsonRecord(accounts[normalizedAccountId])) {
    return accounts[normalizedAccountId];
  }
  const matchedAccountKey = Object.keys(accounts).find(
    (candidate) => normalizeAccountId(candidate) === normalizedAccountId,
  );
  return matchedAccountKey && isJsonRecord(accounts[matchedAccountKey])
    ? accounts[matchedAccountKey]
    : null;
}

function readLegacyDmPolicy(record: JsonRecord | null) {
  if (!record) {
    return undefined;
  }
  const dmConfig = isJsonRecord(record.dm) ? record.dm : null;
  return normalizeOptionalString(record.dmPolicy) || normalizeOptionalString(dmConfig?.policy);
}

function readLegacyAllowFrom(record: JsonRecord | null) {
  if (!record) {
    return [];
  }
  const dmConfig = isJsonRecord(record.dm) ? record.dm : null;
  const direct = normalizeStringArray(record.allowFrom);
  if (direct.length) {
    return direct;
  }
  return normalizeStringArray(dmConfig?.allowFrom);
}

function resolveChannelAccountAccessConfig(
  config: JsonRecord | null,
  channelId: string,
  accountId: string,
) {
  const channels = isJsonRecord(config?.channels) ? config.channels : {};
  const channelConfig = isJsonRecord(channels[channelId]) ? channels[channelId] : null;
  const accountConfig = resolveChannelAccountConfigRecord(channelConfig, accountId);

  return {
    dmPolicy: readLegacyDmPolicy(accountConfig) || readLegacyDmPolicy(channelConfig),
    allowFrom: readLegacyAllowFrom(accountConfig).length
      ? readLegacyAllowFrom(accountConfig)
      : readLegacyAllowFrom(channelConfig),
  };
}

const DASHBOARD_CHANNEL_CONFIG_META_KEYS = new Set([
  "name",
  "enabled",
  "dmPolicy",
  "allowFrom",
  "groupPolicy",
  "groupAllowFrom",
  "streaming",
  "defaultTo",
  "dm",
  "group",
  "accounts",
]);

function hasMeaningfulChannelConfigValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "boolean") {
    return value === true;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasMeaningfulChannelConfigValue(entry));
  }
  if (isJsonRecord(value)) {
    return Object.values(value).some((entry) => hasMeaningfulChannelConfigValue(entry));
  }
  return false;
}

function hasMeaningfulConfiguredChannelAccount(record: JsonRecord | null) {
  if (!record) {
    return false;
  }
  for (const [key, value] of Object.entries(record)) {
    if (DASHBOARD_CHANNEL_CONFIG_META_KEYS.has(key)) {
      continue;
    }
    if (hasMeaningfulChannelConfigValue(value)) {
      return true;
    }
  }
  return false;
}

function normalizeConfiguredChannelAccountsFromConfig(
  template: ChannelSetupTemplateDefinition,
  config?: JsonRecord | null,
): ChannelRuntimeAccount[] {
  if (!config) {
    return [];
  }
  const channels = isJsonRecord(config.channels) ? config.channels : {};
  const rawChannelConfig = isJsonRecord(channels[template.id]) ? channels[template.id] : null;
  if (!rawChannelConfig) {
    return [];
  }

  const normalizedConfig =
    template.accountScope === "top-level-only"
      ? config
      : promoteLegacyScopedChannelSectionToDefaultAccount(config, template.id);
  const normalizedChannels = isJsonRecord(normalizedConfig.channels)
    ? normalizedConfig.channels
    : {};
  const channelConfig = isJsonRecord(normalizedChannels[template.id])
    ? normalizedChannels[template.id]
    : rawChannelConfig;
  const accountEntries: Array<[string, JsonRecord]> =
    template.accountScope === "top-level-only"
      ? [["default", channelConfig]]
      : Object.entries(isJsonRecord(channelConfig.accounts) ? channelConfig.accounts : {}).filter(
          ([, entry]): entry is JsonRecord => isJsonRecord(entry),
        );

  return accountEntries
    .map(([rawAccountId, rawAccount]) => {
      const accountId = normalizeAccountId(rawAccountId);
      const configuredAccess = resolveChannelAccountAccessConfig(config, template.id, accountId);
      const configured = hasMeaningfulConfiguredChannelAccount(rawAccount);
      const detailLines = [
        configuredAccess.dmPolicy,
        configuredAccess.allowFrom.length
          ? `${configuredAccess.allowFrom.length} allowed sender(s)`
          : undefined,
        normalizeOptionalString(rawAccount.baseUrl),
        normalizeOptionalString(rawAccount.webhookPath),
        normalizeOptionalString(rawAccount.webhookUrl),
      ].filter((entry): entry is string => Boolean(entry));
      return {
        accountId,
        name: normalizeOptionalString(rawAccount.name),
        enabled:
          rawAccount.enabled !== false &&
          (template.accountScope === "top-level-only" ? channelConfig.enabled !== false : true),
        configured,
        linked: false,
        connected: false,
        running: false,
        dmPolicy: configuredAccess.dmPolicy,
        allowFrom: configuredAccess.allowFrom,
        lastInboundAt: null,
        lastOutboundAt: null,
        lastError: null,
        statusLabel: configured ? "configured" : "not configured",
        detailLines,
      } satisfies ChannelRuntimeAccount;
    })
    .filter((account) => account.enabled || account.configured || account.allowFrom.length > 0)
    .toSorted((left, right) => {
      if (left.accountId === "default") {
        return -1;
      }
      if (right.accountId === "default") {
        return 1;
      }
      return left.accountId.localeCompare(right.accountId);
    });
}

function mergeChannelRuntimeAccounts(
  runtimeAccounts: ChannelRuntimeAccount[],
  configAccounts: ChannelRuntimeAccount[],
) {
  const merged = new Map<string, ChannelRuntimeAccount>();
  for (const account of configAccounts) {
    merged.set(normalizeAccountId(account.accountId), account);
  }
  for (const runtimeAccount of runtimeAccounts) {
    const accountId = normalizeAccountId(runtimeAccount.accountId);
    const configuredAccount = merged.get(accountId);
    merged.set(accountId, {
      ...(configuredAccount || {}),
      ...runtimeAccount,
      name: runtimeAccount.name || configuredAccount?.name,
      dmPolicy: runtimeAccount.dmPolicy || configuredAccount?.dmPolicy,
      allowFrom:
        runtimeAccount.allowFrom.length > 0
          ? runtimeAccount.allowFrom
          : configuredAccount?.allowFrom || [],
      detailLines:
        runtimeAccount.detailLines.length > 0
          ? runtimeAccount.detailLines
          : configuredAccount?.detailLines || [],
      configured: runtimeAccount.configured || configuredAccount?.configured === true,
    });
  }
  return Array.from(merged.values()).toSorted((left, right) => {
    if (left.accountId === "default") {
      return -1;
    }
    if (right.accountId === "default") {
      return 1;
    }
    return left.accountId.localeCompare(right.accountId);
  });
}

function normalizeChannelRuntimeAccounts(
  value: unknown,
  options?: { channelId?: string; config?: JsonRecord | null },
): ChannelRuntimeAccount[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isJsonRecord).map((account) => {
    const accountId = normalizeAccountId(account.accountId);
    const configuredAccess =
      options?.channelId && options?.config
        ? resolveChannelAccountAccessConfig(options.config, options.channelId, accountId)
        : { dmPolicy: undefined, allowFrom: [] as string[] };
    const dmPolicy = configuredAccess.dmPolicy || normalizeOptionalString(account.dmPolicy);
    const allowFrom =
      configuredAccess.allowFrom.length > 0
        ? configuredAccess.allowFrom
        : normalizeStringArray(account.allowFrom);
    const detailLines = [
      normalizeOptionalString(account.mode),
      dmPolicy,
      allowFrom.length ? `${allowFrom.length} allowed sender(s)` : undefined,
      normalizeOptionalString(account.baseUrl),
      normalizeOptionalString(account.webhookPath),
      normalizeOptionalString(account.webhookUrl),
      normalizeOptionalString(account.lastError),
    ].filter((entry): entry is string => Boolean(entry));
    return {
      accountId,
      name: normalizeOptionalString(account.name),
      enabled: account.enabled !== false,
      configured: account.configured === true,
      linked: account.linked === true,
      connected: account.connected === true,
      running: account.running === true,
      dmPolicy,
      allowFrom,
      lastInboundAt: typeof account.lastInboundAt === "number" ? account.lastInboundAt : null,
      lastOutboundAt: typeof account.lastOutboundAt === "number" ? account.lastOutboundAt : null,
      lastError: normalizeOptionalString(account.lastError) || null,
      statusLabel: summarizeChannelAccountStatus(account),
      detailLines,
    };
  });
}

async function fetchChannelStatusCatalog(gatewayUrl: string, gatewayToken: string) {
  const response = await gatewayBatch(gatewayUrl, gatewayToken, {
    channels: { method: "channels.status", params: { probe: false } },
  });
  return (response.results.channels as JsonRecord | undefined) || {};
}

function parseAgentIdFromSessionKey(key: string): string {
  const parts = key.split(":");
  return parts[0] === "agent" && parts[1] ? parts[1] : "main";
}

function inferSessionActivityStatus(session: JsonRecord): string {
  const explicit = typeof session.status === "string" ? session.status : "";
  if (explicit) {
    return explicit;
  }
  if (session.abortedLastRun === true) {
    return "failed";
  }
  return "idle";
}

function resolveSessionRouteFromKey(session: JsonRecord): {
  channel?: string;
  target?: string;
  peerKind?: string;
} {
  const sessionKey = normalizeOptionalString(session.key) || "";
  if (!sessionKey.startsWith("agent:")) {
    return {};
  }
  const parts = sessionKey.split(":");
  if (parts.length < 4) {
    return {};
  }
  const routeParts = parts.slice(2);
  const candidateChannel = normalizeOptionalString(routeParts[0])?.toLowerCase();
  if (!candidateChannel || candidateChannel === "main") {
    return {};
  }
  if (routeParts.length >= 3) {
    const peerKind = normalizeOptionalString(routeParts[1])?.toLowerCase();
    const target = normalizeOptionalString(routeParts.slice(2).join(":"));
    if (peerKind && target) {
      return {
        channel: candidateChannel,
        target,
        peerKind,
      };
    }
  }
  return {
    channel: candidateChannel,
    target: normalizeOptionalString(routeParts.slice(1).join(":")) || undefined,
  };
}

function resolveSessionChannelAndTarget(session: JsonRecord) {
  const origin = isJsonRecord(session.origin) ? session.origin : {};
  const routeFromKey = resolveSessionRouteFromKey(session);
  const channel =
    normalizeOptionalString(session.channel) ||
    normalizeOptionalString(origin.provider) ||
    routeFromKey.channel ||
    "internal";
  const target =
    normalizeOptionalString(session.lastTo) ||
    normalizeOptionalString(origin.to) ||
    routeFromKey.target ||
    "session";
  return { channel, target };
}

function resolveSessionAccountId(session: JsonRecord) {
  const origin = isJsonRecord(session.origin) ? session.origin : {};
  const deliveryContext = isJsonRecord(session.deliveryContext) ? session.deliveryContext : {};
  return (
    normalizeOptionalString(session.lastAccountId) ||
    normalizeOptionalString(origin.accountId) ||
    normalizeOptionalString(deliveryContext.accountId) ||
    undefined
  );
}

function resolveSessionTargetAgentId(session: JsonRecord, channels: DashboardChannel[]) {
  const explicitAgentId = normalizeOptionalString(session.agentId);
  if (explicitAgentId) {
    return explicitAgentId;
  }
  const sessionKey = normalizeOptionalString(session.key) || "";
  if (sessionKey.startsWith("agent:")) {
    return parseAgentIdFromSessionKey(sessionKey);
  }
  const { channel } = resolveSessionChannelAndTarget(session);
  const normalizedChannel = normalizeChannelBindingId(channel);
  if (!normalizedChannel || isSystemChannelKind(normalizedChannel)) {
    return "main";
  }
  return (
    resolveBoundInboundAgentId(channels, normalizedChannel, resolveSessionAccountId(session)) ||
    "main"
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchExternalIdentityPattern(pattern: string, candidate: string) {
  if (pattern === candidate) {
    return { matched: true, kind: "exact" as const, score: 10_000 + pattern.length };
  }
  if (!pattern.includes("*")) {
    return { matched: false, kind: "pattern" as const, score: 0 };
  }
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`, "i");
  if (!regex.test(candidate)) {
    return { matched: false, kind: "pattern" as const, score: 0 };
  }
  return {
    matched: true,
    kind: "pattern" as const,
    score: 1_000 + pattern.replace(/\*/g, "").length,
  };
}

function addExternalIdentityCandidates(bucket: Set<string>, channelId: string, rawValue: unknown) {
  const raw = normalizeOptionalString(rawValue)?.toLowerCase();
  if (!raw) {
    return;
  }
  bucket.add(raw);
  if (!channelId) {
    return;
  }
  if (raw.startsWith(`${channelId}:`)) {
    bucket.add(raw);
    return;
  }
  if (
    raw.startsWith("user:") ||
    raw.startsWith("channel:") ||
    raw.startsWith("chat:") ||
    raw.startsWith("thread:") ||
    raw.startsWith("room:") ||
    raw.startsWith("dm:") ||
    raw.startsWith("group:") ||
    raw.startsWith("peer:")
  ) {
    bucket.add(`${channelId}:${raw}`);
  }
  if (channelId === "discord") {
    if (raw.startsWith("channel:") || raw.startsWith("user:") || raw.startsWith("thread:")) {
      bucket.add(`discord:${raw}`);
      return;
    }
    if (/^\d+$/.test(raw)) {
      bucket.add(`discord:user:${raw}`);
      bucket.add(`discord:channel:${raw}`);
    }
    return;
  }
  if (channelId === "telegram") {
    if (raw.startsWith("user:")) {
      bucket.add(`telegram:${raw.slice("user:".length)}`);
      return;
    }
    if (raw.startsWith("chat:")) {
      bucket.add(`telegram:${raw.slice("chat:".length)}`);
      return;
    }
    bucket.add(`telegram:${raw}`);
    return;
  }
  bucket.add(`${channelId}:${raw}`);
}

function addTelegramTopicIdentityCandidates(
  bucket: Set<string>,
  rawValue: unknown,
  threadId: string | undefined,
) {
  const raw = normalizeOptionalString(rawValue)?.toLowerCase();
  const normalizedThreadId = normalizeOptionalString(threadId)?.toLowerCase();
  if (!raw || !normalizedThreadId) {
    return;
  }
  const base = raw.startsWith("telegram:") ? raw.slice("telegram:".length) : raw;
  if (!base || base.includes(":topic:")) {
    return;
  }
  bucket.add(`${base}:topic:${normalizedThreadId}`);
  bucket.add(`telegram:${base}:topic:${normalizedThreadId}`);
}

function buildSessionDestinationIdentityCandidates(session: JsonRecord) {
  const { channel, target } = resolveSessionChannelAndTarget(session);
  const normalizedChannel = normalizeOptionalString(channel)?.toLowerCase() || "";
  const origin = isJsonRecord(session.origin) ? session.origin : {};
  const deliveryContext = isJsonRecord(session.deliveryContext) ? session.deliveryContext : {};
  const threadId =
    normalizeOptionalRouteValue(deliveryContext.threadId) ||
    normalizeOptionalRouteValue(session.lastThreadId) ||
    normalizeOptionalRouteValue(origin.threadId);
  const bucket = new Set<string>();
  for (const rawValue of [
    origin.from,
    origin.to,
    deliveryContext.to,
    session.lastTo,
    target,
    session.subject,
  ]) {
    addExternalIdentityCandidates(bucket, normalizedChannel, rawValue);
    if (normalizedChannel === "telegram") {
      addTelegramTopicIdentityCandidates(bucket, rawValue, threadId);
    }
  }
  return Array.from(bucket);
}

const INBOUND_CONVERSATION_INFO_SENTINEL = "Conversation info (untrusted metadata):";
const INBOUND_SENDER_INFO_SENTINEL = "Sender (untrusted metadata):";
const SYNTHETIC_INBOUND_SENDER_IDS = new Set([
  "cli",
  "dashboard",
  "openclaw-control-ui",
  "openclaw-dashboard",
  "openclaw-webchat",
  "webchat-ui",
]);
const persistedSessionInboundSenderCache = new Map<
  string,
  { mtimeMs: number; size: number; sender: PersistedSessionInboundSender | null }
>();

function extractInboundMetaJsonBlock(text: string, sentinel: string): JsonRecord | null {
  if (!text.includes(sentinel)) {
    return null;
  }
  const escaped = escapeRegExp(sentinel);
  const match = text.match(new RegExp(`${escaped}\\s*\\n\`\`\`json\\s*\\n([\\s\\S]*?)\\n\`\`\``));
  if (!match?.[1]) {
    return null;
  }
  const parsed = safeJsonParse<unknown>(match[1], null);
  return isJsonRecord(parsed) ? parsed : null;
}

function addSenderIdentityCandidates(
  bucket: Set<string>,
  channelId: string,
  rawValue: unknown,
  opts: { kind?: "id" | "username" | "tag" | "label" | "e164" } = {},
) {
  const raw = normalizeOptionalString(rawValue)?.toLowerCase();
  if (!raw) {
    return;
  }
  addExternalIdentityCandidates(bucket, channelId, raw);
  if (opts.kind === "username" || opts.kind === "tag") {
    const stripped = raw.replace(/^@+/, "");
    if (stripped) {
      bucket.add(stripped);
      if (channelId) {
        bucket.add(`${channelId}:${stripped}`);
      }
    }
  }
  if (opts.kind === "label" && channelId) {
    bucket.add(`${channelId}:${raw}`);
  }
}

function buildSessionSenderIdentityCandidates(
  channelId: string,
  senderInfo: JsonRecord | null,
  conversationInfo: JsonRecord | null,
) {
  const bucket = new Set<string>();
  for (const rawValue of [
    senderInfo?.id,
    senderInfo?.e164,
    conversationInfo?.sender_id,
    senderInfo?.username,
    senderInfo?.tag,
    senderInfo?.label,
  ]) {
    addSenderIdentityCandidates(bucket, channelId, rawValue, {
      kind:
        rawValue === senderInfo?.e164
          ? "e164"
          : rawValue === senderInfo?.username
            ? "username"
            : rawValue === senderInfo?.tag
              ? "tag"
              : rawValue === senderInfo?.label
                ? "label"
                : "id",
    });
  }
  return Array.from(bucket);
}

function isSyntheticInboundSender(sender: PersistedSessionInboundSender | null | undefined) {
  if (!sender) {
    return false;
  }
  for (const value of [sender.id, sender.username, sender.tag, sender.label]) {
    const normalized = normalizeOptionalString(value)?.toLowerCase();
    if (normalized && SYNTHETIC_INBOUND_SENDER_IDS.has(normalized)) {
      return true;
    }
  }
  return false;
}

async function loadPersistedSessionInboundSender(params: {
  sessionFile?: string;
  channelId?: string;
}) {
  const sessionFile = normalizeOptionalString(params.sessionFile);
  const channelId = normalizeOptionalString(params.channelId)?.toLowerCase() || "";
  if (!sessionFile || !channelId || SYSTEM_CHANNEL_KINDS.has(channelId)) {
    return null;
  }

  let stat: fsSync.Stats;
  try {
    stat = await fs.stat(sessionFile);
  } catch {
    return null;
  }
  const cached = persistedSessionInboundSenderCache.get(sessionFile);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.sender;
  }

  let content = "";
  try {
    content = await fs.readFile(sessionFile, "utf-8");
  } catch {
    persistedSessionInboundSenderCache.set(sessionFile, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sender: null,
    });
    return null;
  }

  let syntheticFallback: PersistedSessionInboundSender | null = null;
  const lines = content.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    const parsed = safeJsonParse<unknown>(line, null);
    if (!isJsonRecord(parsed) || parsed.type !== "message") {
      continue;
    }
    const message = isJsonRecord(parsed.message) ? parsed.message : {};
    if (normalizeOptionalString(message.role) !== "user") {
      continue;
    }
    const text = extractMessageText(
      message.content ?? parsed.content ?? message.text ?? parsed.text,
    );
    if (
      !text.includes(INBOUND_SENDER_INFO_SENTINEL) &&
      !text.includes(INBOUND_CONVERSATION_INFO_SENTINEL)
    ) {
      continue;
    }
    const senderInfo = extractInboundMetaJsonBlock(text, INBOUND_SENDER_INFO_SENTINEL);
    const conversationInfo = extractInboundMetaJsonBlock(text, INBOUND_CONVERSATION_INFO_SENTINEL);
    if (!senderInfo && !conversationInfo) {
      continue;
    }
    const sender: PersistedSessionInboundSender = {
      label:
        normalizeOptionalString(senderInfo?.label) ||
        normalizeOptionalString(conversationInfo?.sender) ||
        undefined,
      id:
        normalizeOptionalString(senderInfo?.id) ||
        normalizeOptionalString(conversationInfo?.sender_id) ||
        undefined,
      name: normalizeOptionalString(senderInfo?.name) || undefined,
      username: normalizeOptionalString(senderInfo?.username) || undefined,
      tag: normalizeOptionalString(senderInfo?.tag) || undefined,
      e164: normalizeOptionalString(senderInfo?.e164) || undefined,
      externalIds: buildSessionSenderIdentityCandidates(channelId, senderInfo, conversationInfo),
    };
    if (!syntheticFallback) {
      syntheticFallback = sender;
    }
    if (!isSyntheticInboundSender(sender)) {
      persistedSessionInboundSenderCache.set(sessionFile, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        sender,
      });
      return sender;
    }
  }

  persistedSessionInboundSenderCache.set(sessionFile, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    sender: syntheticFallback,
  });
  return syntheticFallback;
}

function collectUserIdentityMatches(users: DashboardUser[], candidateExternalIds: string[]) {
  const matches: Array<{
    user: DashboardUser;
    pattern: string;
    matchedExternalId: string;
    matchedBy: "exact" | "pattern";
    score: number;
  }> = [];
  for (const user of users) {
    for (const pattern of user.externalIdentities || []) {
      for (const candidate of candidateExternalIds) {
        const match = matchExternalIdentityPattern(pattern, candidate);
        if (!match.matched) {
          continue;
        }
        matches.push({
          user,
          pattern,
          matchedExternalId: candidate,
          matchedBy: match.kind,
          score: match.score,
        });
      }
    }
  }
  return matches;
}

function resolveUserTeamIds(user: DashboardUser, teams: DashboardTeam[]) {
  const ids = new Set(normalizeIdList(user.teamIds));
  for (const team of teams) {
    if (team.memberIds.includes(user.id)) {
      ids.add(team.id);
    }
  }
  return Array.from(ids);
}

function resolveTeamAccessibleAgentIds(
  teamIds: string[],
  teams: DashboardTeam[],
  agentBindings: AgentBinding[],
) {
  const ids = new Set<string>();
  for (const teamId of teamIds) {
    const team = teams.find((entry) => entry.id === teamId);
    for (const agentId of team?.agentIds || []) {
      ids.add(agentId);
    }
    for (const binding of agentBindings) {
      if (binding.teamId === teamId) {
        ids.add(binding.agentId);
      }
    }
  }
  return Array.from(ids);
}

function resolveTeamAccessibleChannelIds(
  teamIds: string[],
  teams: DashboardTeam[],
  agentBindings: AgentBinding[],
) {
  const ids = new Set<string>();
  for (const teamId of teamIds) {
    const team = teams.find((entry) => entry.id === teamId);
    const teamAgentIds = new Set(team?.agentIds || []);
    for (const channelId of team?.channelIds || []) {
      ids.add(channelId);
    }
    for (const binding of agentBindings) {
      if (binding.teamId !== teamId && !teamAgentIds.has(binding.agentId)) {
        continue;
      }
      for (const channelId of binding.channelIds || []) {
        ids.add(channelId);
      }
      for (const channelId of binding.defaultOutputChannelIds || []) {
        ids.add(channelId);
      }
    }
  }
  return Array.from(ids);
}

function teamHasScopedGrant(params: {
  teamId: string;
  grants: AccessGrant[];
  resourceType: AccessGrant["resourceType"];
  resourceId: string;
  minimumPermission: AccessGrant["permission"];
}) {
  return principalHasGrant({
    grants: params.grants,
    userId: "",
    teamIds: [params.teamId],
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    minimumPermission: params.minimumPermission,
  });
}

function teamOwnsAgentAccess(params: {
  teamId: string;
  agentId: string;
  teams: DashboardTeam[];
  agentBindings: AgentBinding[];
  grants: AccessGrant[];
}) {
  if (
    teamHasScopedGrant({
      teamId: params.teamId,
      grants: params.grants,
      resourceType: "agent",
      resourceId: params.agentId,
      minimumPermission: "operate",
    })
  ) {
    return true;
  }
  return resolveTeamAccessibleAgentIds(
    [params.teamId],
    params.teams,
    params.agentBindings,
  ).includes(params.agentId);
}

function resolveTeamAgentScopedChannelIds(params: {
  teamId: string;
  agentId: string;
  teams: DashboardTeam[];
  agentBindings: AgentBinding[];
}) {
  const ids = new Set<string>();
  const team = params.teams.find((entry) => entry.id === params.teamId);
  for (const channelId of team?.channelIds || []) {
    ids.add(channelId);
  }
  const teamAgentIds = new Set(team?.agentIds || []);
  for (const binding of params.agentBindings) {
    if (binding.agentId !== params.agentId) {
      continue;
    }
    if (binding.teamId !== params.teamId && !teamAgentIds.has(params.agentId)) {
      continue;
    }
    for (const channelId of binding.channelIds || []) {
      ids.add(channelId);
    }
    for (const channelId of binding.defaultOutputChannelIds || []) {
      ids.add(channelId);
    }
  }
  return Array.from(ids);
}

function resolveInboundAuthorizingTeamIds(params: {
  teamIds: string[];
  agentId: string;
  matchedChannelIds: string[];
  teams: DashboardTeam[];
  agentBindings: AgentBinding[];
  grants: AccessGrant[];
}) {
  const ids = new Set<string>();
  for (const teamId of params.teamIds) {
    const teamAllowsAgent = teamOwnsAgentAccess({
      teamId,
      agentId: params.agentId,
      teams: params.teams,
      agentBindings: params.agentBindings,
      grants: params.grants,
    });
    if (!teamAllowsAgent) {
      continue;
    }
    const teamChannelIds = new Set(
      resolveTeamAgentScopedChannelIds({
        teamId,
        agentId: params.agentId,
        teams: params.teams,
        agentBindings: params.agentBindings,
      }),
    );
    const teamAllowsChannel = params.matchedChannelIds.some(
      (channelId) =>
        teamChannelIds.has(channelId) ||
        teamHasScopedGrant({
          teamId,
          grants: params.grants,
          resourceType: "channel",
          resourceId: channelId,
          minimumPermission: "operate",
        }),
    );
    if (teamAllowsChannel) {
      ids.add(teamId);
    }
  }
  return Array.from(ids);
}

function sessionUsesBoundInboundDirectTransport(params: {
  session: JsonRecord;
  agentId: string;
  channels: DashboardChannel[];
  matchedChannelIds: string[];
  senderExternalIds: string[];
  resolutionSurface: "sender" | "destination";
}) {
  if (params.resolutionSurface !== "sender" || params.senderExternalIds.length === 0) {
    return false;
  }
  const { channel } = resolveSessionChannelAndTarget(params.session);
  const normalizedChannel = normalizeChannelBindingId(channel);
  if (!normalizedChannel || isSystemChannelKind(normalizedChannel)) {
    return false;
  }
  const boundInboundAgentId = resolveBoundInboundAgentId(
    params.channels,
    normalizedChannel,
    resolveSessionAccountId(params.session),
  );
  if (boundInboundAgentId !== params.agentId) {
    return false;
  }
  const origin = isJsonRecord(params.session.origin) ? params.session.origin : {};
  const deliveryContext = isJsonRecord(params.session.deliveryContext)
    ? params.session.deliveryContext
    : {};
  const chatType =
    normalizeOptionalString(params.session.chatType) ||
    normalizeOptionalString(origin.chatType) ||
    normalizeOptionalString(deliveryContext.chatType);
  if (normalizeOptionalString(chatType)?.toLowerCase() === "direct") {
    return true;
  }
  return params.matchedChannelIds.some((channelId) =>
    channelId.startsWith(`detected-${normalizedChannel}-user-`),
  );
}

function permissionRank(permission: AccessGrant["permission"]) {
  switch (permission) {
    case "admin":
      return 3;
    case "operate":
      return 2;
    default:
      return 1;
  }
}

function principalHasGrant(params: {
  grants: AccessGrant[];
  userId: string;
  teamIds: string[];
  resourceType: AccessGrant["resourceType"];
  resourceId: string;
  minimumPermission: AccessGrant["permission"];
}) {
  return params.grants.some((grant) => {
    const matchesSubject =
      (grant.subjectType === "user" && grant.subjectId === params.userId) ||
      (grant.subjectType === "team" && params.teamIds.includes(grant.subjectId));
    if (!matchesSubject) {
      return false;
    }
    const matchesResourceType =
      grant.resourceType === "*" || grant.resourceType === params.resourceType;
    const matchesResourceId = grant.resourceId === "*" || grant.resourceId === params.resourceId;
    return (
      matchesResourceType &&
      matchesResourceId &&
      permissionRank(grant.permission) >= permissionRank(params.minimumPermission)
    );
  });
}

const MANAGED_INBOUND_ALLOWLIST_CHANNELS = ["discord", "telegram"] as const;

type ManagedInboundAllowlistChannelId = (typeof MANAGED_INBOUND_ALLOWLIST_CHANNELS)[number];

function resolveUsersAllowedToUseAgent(
  store: Pick<ControlTowerStore, "users" | "teams" | "grants" | "agentBindings">,
  agentId: string,
) {
  return store.users.filter((user) => {
    if (user.status !== "active") {
      return false;
    }
    const teamIds = resolveUserTeamIds(user, store.teams);
    const hasAdminAccess =
      user.role === "admin" ||
      principalHasGrant({
        grants: store.grants,
        userId: user.id,
        teamIds,
        resourceType: "*",
        resourceId: "*",
        minimumPermission: "admin",
      });
    if (hasAdminAccess) {
      return true;
    }
    if (user.role === "viewer") {
      return false;
    }
    if (user.agentIds.includes(agentId)) {
      return true;
    }
    if (
      principalHasGrant({
        grants: store.grants,
        userId: user.id,
        teamIds,
        resourceType: "agent",
        resourceId: agentId,
        minimumPermission: "operate",
      })
    ) {
      return true;
    }
    return resolveTeamAccessibleAgentIds(teamIds, store.teams, store.agentBindings).includes(
      agentId,
    );
  });
}

function normalizeDiscordAllowFromEntry(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "*" || trimmed.includes("*")) {
    return null;
  }
  let candidate = trimmed;
  while (candidate.startsWith("discord:")) {
    candidate = candidate.slice("discord:".length);
  }
  while (candidate.startsWith("user:")) {
    candidate = candidate.slice("user:".length);
  }
  while (candidate.startsWith("pk:")) {
    candidate = candidate.slice("pk:".length);
  }
  if (candidate.startsWith("<@")) {
    candidate = candidate.replace(/^<@!?/, "").replace(/>$/, "");
  }
  return /^\d+$/.test(candidate) ? candidate : null;
}

function normalizeTelegramAllowFromEntry(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "*" || trimmed.includes("*")) {
    return null;
  }
  let candidate = trimmed;
  while (candidate.startsWith("telegram:") || candidate.startsWith("tg:")) {
    if (candidate.startsWith("telegram:")) {
      candidate = candidate.slice("telegram:".length);
      continue;
    }
    candidate = candidate.slice("tg:".length);
  }
  if (candidate.startsWith("user:")) {
    candidate = candidate.slice("user:".length);
  } else if (candidate.startsWith("chat:")) {
    candidate = candidate.slice("chat:".length);
  }
  const topicIndex = candidate.indexOf(":topic:");
  if (topicIndex >= 0) {
    candidate = candidate.slice(0, topicIndex);
  }
  return /^\d+$/.test(candidate) ? candidate : null;
}

function normalizeManagedInboundAllowFromEntry(
  channelId: ManagedInboundAllowlistChannelId,
  value: string,
) {
  if (channelId === "discord") {
    return normalizeDiscordAllowFromEntry(value);
  }
  return normalizeTelegramAllowFromEntry(value);
}

function resolveManagedInboundAllowFromForAgentChannel(
  store: Pick<ControlTowerStore, "users" | "teams" | "grants" | "agentBindings">,
  agentId: string,
  channelId: ManagedInboundAllowlistChannelId,
) {
  const allowFrom = new Set<string>();
  for (const user of resolveUsersAllowedToUseAgent(store, agentId)) {
    for (const identity of user.externalIdentities) {
      const normalized = normalizeManagedInboundAllowFromEntry(channelId, identity);
      if (normalized) {
        allowFrom.add(normalized);
      }
    }
  }
  return Array.from(allowFrom).toSorted((left, right) => left.localeCompare(right));
}

function listManagedInboundAccountIds(
  config: JsonRecord,
  channelId: ManagedInboundAllowlistChannelId,
) {
  const channels = isJsonRecord(config.channels) ? config.channels : {};
  const channelConfig = isJsonRecord(channels[channelId]) ? channels[channelId] : null;
  if (!channelConfig) {
    return [];
  }
  const accounts = isJsonRecord(channelConfig.accounts) ? channelConfig.accounts : {};
  const accountIds = Object.keys(accounts)
    .map((accountId) => normalizeAccountId(accountId))
    .filter(Boolean);
  if (accountIds.length > 0) {
    return Array.from(new Set(accountIds)).toSorted((left, right) => left.localeCompare(right));
  }
  return Object.keys(channelConfig).length > 0 ? ["default"] : [];
}

function buildManagedInboundDmAccessPatch(
  channelId: ManagedInboundAllowlistChannelId,
  allowFrom: string[],
) {
  const dmPolicy = allowFrom.length > 0 ? "allowlist" : "disabled";
  if (channelId === "discord") {
    return {
      dmPolicy,
      allowFrom,
      dm: {
        enabled: true,
        policy: dmPolicy,
        allowFrom,
      },
    } satisfies JsonRecord;
  }
  return {
    dmPolicy,
    allowFrom,
  } satisfies JsonRecord;
}

function reconcileManagedInboundAllowlistsInConfig(
  config: JsonRecord,
  store: Pick<ControlTowerStore, "users" | "teams" | "grants" | "agentBindings">,
) {
  let nextConfig = config;
  let changed = false;
  for (const channelId of MANAGED_INBOUND_ALLOWLIST_CHANNELS) {
    const promotedConfig = promoteLegacyScopedChannelSectionToDefaultAccount(nextConfig, channelId);
    if (promotedConfig !== nextConfig) {
      nextConfig = promotedConfig;
      changed = true;
    }
    const bindings = parseOpenClawInboundRouteBindings(nextConfig);
    const accountIds = new Set<string>(listManagedInboundAccountIds(nextConfig, channelId));
    for (const binding of bindings) {
      if (binding.channelId === channelId) {
        accountIds.add(normalizeAccountId(binding.accountId));
      }
    }
    for (const accountId of accountIds) {
      const agentId = resolveBoundInboundAgentId(bindings, channelId, accountId);
      const allowFrom =
        agentId && normalizeOptionalString(agentId)
          ? resolveManagedInboundAllowFromForAgentChannel(store, agentId, channelId)
          : [];
      const desiredPolicy = allowFrom.length > 0 ? "allowlist" : "disabled";
      const currentAccess = resolveChannelAccountAccessConfig(nextConfig, channelId, accountId);
      const currentPolicy = currentAccess.dmPolicy || "disabled";
      const currentAllowFrom = Array.from(
        new Set(currentAccess.allowFrom.map((entry) => entry.trim()).filter(Boolean)),
      ).toSorted((left, right) => left.localeCompare(right));
      if (
        currentPolicy === desiredPolicy &&
        currentAllowFrom.length === allowFrom.length &&
        currentAllowFrom.every((entry, index) => entry === allowFrom[index])
      ) {
        continue;
      }
      nextConfig = upsertAccountsOnlyChannelConfig(
        nextConfig,
        channelId,
        accountId,
        buildManagedInboundDmAccessPatch(channelId, allowFrom),
        { enabled: true },
      );
      changed = true;
    }
  }
  return { config: nextConfig, changed };
}

async function syncManagedInboundAllowlists(params: {
  gatewayUrl: string;
  gatewayToken: string;
  store?: Pick<ControlTowerStore, "users" | "teams" | "grants" | "agentBindings">;
}) {
  const store: Pick<ControlTowerStore, "users" | "teams" | "grants" | "agentBindings"> =
    params.store || (await loadStore([], []));
  const configGet = await gatewayBatch(params.gatewayUrl, params.gatewayToken, {
    config: { method: "config.get", params: {} },
  });
  const payload = (configGet.results.config as JsonRecord | undefined) || {};
  const baseHash = normalizeOptionalString(payload.hash);
  if (!baseHash) {
    throw new Error("Gateway config hash unavailable; retry after refreshing the dashboard.");
  }
  const currentConfig = isJsonRecord(payload.config) ? payload.config : {};
  const reconciled = reconcileManagedInboundAllowlistsInConfig(currentConfig, store);
  if (!reconciled.changed) {
    return { changed: false as const };
  }
  await gatewayBatch(params.gatewayUrl, params.gatewayToken, {
    apply: {
      method: "config.apply",
      params: {
        raw: JSON.stringify(reconciled.config, null, 2),
        baseHash,
      },
    },
  });
  await sleep(3000);
  await ensureGatewayAvailable(params.gatewayUrl);
  return { changed: true as const };
}

function resolveDashboardActorContext(
  req: IncomingMessage,
  store: Pick<
    ControlTowerStore,
    "users" | "teams" | "channels" | "pipelines" | "cronJobs" | "grants" | "agentBindings"
  >,
): DashboardActorContext {
  const requestedUserId =
    normalizeOptionalString(readHeader(req, DASHBOARD_USER_HEADER, DASHBOARD_ROOT_USER_ID)) ||
    DASHBOARD_ROOT_USER_ID;
  const requestedTeamScopeId =
    normalizeOptionalString(
      readHeader(req, DASHBOARD_TEAM_SCOPE_HEADER, DASHBOARD_ALL_TEAMS_SCOPE_ID),
    ) || DASHBOARD_ALL_TEAMS_SCOPE_ID;
  const isRootActor = requestedUserId === DASHBOARD_ROOT_USER_ID;
  const user = isRootActor
    ? null
    : store.users.find((entry) => entry.id === requestedUserId) || null;
  const currentUserCanManageAdminViews =
    isRootActor || Boolean(user && user.role === "admin" && user.status === "active");
  const currentUserCanOperate =
    isRootActor || Boolean(user && user.status === "active" && user.role !== "viewer");
  const selectedTeamIds = currentUserCanManageAdminViews
    ? store.teams.map((team) => team.id)
    : user
      ? (() => {
          const availableTeamIds = resolveUserTeamIds(user, store.teams);
          if (
            requestedTeamScopeId !== DASHBOARD_ALL_TEAMS_SCOPE_ID &&
            availableTeamIds.includes(requestedTeamScopeId)
          ) {
            return [requestedTeamScopeId];
          }
          return availableTeamIds;
        })()
      : [];
  const includeLegacyDirectAssignments =
    currentUserCanManageAdminViews || requestedTeamScopeId === DASHBOARD_ALL_TEAMS_SCOPE_ID;
  const selectedAgentIds = currentUserCanManageAdminViews
    ? Array.from(new Set(store.agentBindings.map((binding) => binding.agentId)))
    : Array.from(
        new Set([
          ...(user && includeLegacyDirectAssignments ? user.agentIds : []),
          ...resolveTeamAccessibleAgentIds(selectedTeamIds, store.teams, store.agentBindings),
        ]),
      );
  const selectedChannelIds = currentUserCanManageAdminViews
    ? Array.from(
        new Set(
          store.channels
            .filter((channel) => isManagedDestinationChannelRecord(channel))
            .map((channel) => channel.id),
        ),
      )
    : Array.from(
        new Set([
          ...(user && includeLegacyDirectAssignments ? user.channelIds : []),
          ...resolveTeamAccessibleChannelIds(selectedTeamIds, store.teams, store.agentBindings),
        ]),
      );
  const selectedTeamIdSet = new Set(selectedTeamIds);
  const selectedAgentIdSet = new Set(selectedAgentIds);
  const selectedChannelIdSet = new Set(selectedChannelIds);
  const hasGrant = (
    resourceType: AccessGrant["resourceType"],
    resourceId: string,
    minimumPermission: AccessGrant["permission"],
  ) => {
    if (currentUserCanManageAdminViews) {
      return true;
    }
    if (!user) {
      return false;
    }
    return principalHasGrant({
      grants: store.grants,
      userId: user.id,
      teamIds: selectedTeamIds,
      resourceType,
      resourceId,
      minimumPermission,
    });
  };
  const canViewAgentRecord = (agentId: string) =>
    currentUserCanManageAdminViews ||
    selectedAgentIdSet.has(agentId) ||
    hasGrant("agent", agentId, "view");
  const canOperateAgentRecord = (agentId: string) =>
    currentUserCanManageAdminViews ||
    (currentUserCanOperate &&
      (selectedAgentIdSet.has(agentId) || hasGrant("agent", agentId, "operate")));
  const hasImplicitPipelineAccess = (pipeline: PipelineRecord) => {
    if (pipeline.teamId && selectedTeamIdSet.has(pipeline.teamId)) {
      return true;
    }
    if (pipeline.agentIds.some((agentId) => selectedAgentIdSet.has(agentId))) {
      return true;
    }
    return pipeline.steps.some((step) => selectedAgentIdSet.has(step.agentId));
  };
  const canViewPipelineRecord = (pipeline: PipelineRecord) =>
    currentUserCanManageAdminViews ||
    hasImplicitPipelineAccess(pipeline) ||
    hasGrant("pipeline", pipeline.id, "view");
  const canOperatePipelineRecord = (pipeline: PipelineRecord) =>
    currentUserCanManageAdminViews ||
    (currentUserCanOperate &&
      (hasImplicitPipelineAccess(pipeline) || hasGrant("pipeline", pipeline.id, "operate")));
  const canViewCronJobRecord = (job: { id?: string; pipelineId?: string; agentId?: string }) => {
    if (currentUserCanManageAdminViews) {
      return true;
    }
    if (job.id && hasGrant("cron", job.id, "view")) {
      return true;
    }
    if (job.pipelineId) {
      const pipeline = store.pipelines.find((entry) => entry.id === job.pipelineId);
      if (pipeline) {
        return canViewPipelineRecord(pipeline);
      }
    }
    return Boolean(job.agentId && canViewAgentRecord(job.agentId));
  };
  const canOperateCronJobRecord = (job: { id?: string; pipelineId?: string; agentId?: string }) => {
    if (currentUserCanManageAdminViews) {
      return true;
    }
    if (!currentUserCanOperate) {
      return false;
    }
    if (job.id && hasGrant("cron", job.id, "operate")) {
      return true;
    }
    if (job.pipelineId) {
      const pipeline = store.pipelines.find((entry) => entry.id === job.pipelineId);
      if (pipeline) {
        return canOperatePipelineRecord(pipeline);
      }
    }
    return Boolean(job.agentId && canOperateAgentRecord(job.agentId));
  };
  const canViewChannelRoute = (channelId: string) =>
    currentUserCanManageAdminViews ||
    selectedChannelIdSet.has(channelId) ||
    hasGrant("channel", channelId, "view");
  const canOperateChannelRoute = (channelId?: string) => {
    if (currentUserCanManageAdminViews) {
      return true;
    }
    if (!currentUserCanOperate) {
      return false;
    }
    if (!channelId) {
      return selectedTeamIds.length > 0 || hasGrant("channel", "*", "operate");
    }
    return selectedChannelIdSet.has(channelId) || hasGrant("channel", channelId, "operate");
  };
  const canViewSessionRecord = (session: {
    key?: string;
    agentId?: string;
    pipelineId?: string;
  }) => {
    if (currentUserCanManageAdminViews) {
      return true;
    }
    const agentId =
      normalizeOptionalString(session.agentId) ||
      parseAgentIdFromSessionKey(normalizeOptionalString(session.key) || "");
    if (agentId && hasGrant("agent", agentId, "view")) {
      return true;
    }
    if (session.pipelineId) {
      const pipeline = store.pipelines.find((entry) => entry.id === session.pipelineId);
      if (pipeline) {
        return canViewPipelineRecord(pipeline);
      }
    }
    return Boolean(agentId && canViewAgentRecord(agentId));
  };
  const canOperateSessionRecord = (
    session: { key?: string; agentId?: string; pipelineId?: string } | null | undefined,
  ) => {
    if (!session) {
      return false;
    }
    if (currentUserCanManageAdminViews) {
      return true;
    }
    if (!currentUserCanOperate) {
      return false;
    }
    const agentId =
      normalizeOptionalString(session.agentId) ||
      parseAgentIdFromSessionKey(normalizeOptionalString(session.key) || "");
    if (agentId && hasGrant("agent", agentId, "operate")) {
      return true;
    }
    if (session.pipelineId) {
      const pipeline = store.pipelines.find((entry) => entry.id === session.pipelineId);
      if (pipeline) {
        return canOperatePipelineRecord(pipeline);
      }
    }
    return Boolean(agentId && selectedAgentIdSet.has(agentId));
  };

  return {
    user,
    requestedUserId,
    requestedTeamScopeId,
    currentUserCanManageAdminViews,
    currentUserCanOperate,
    selectedTeamIds,
    selectedTeamIdSet,
    selectedAgentIds,
    selectedAgentIdSet,
    selectedChannelIds,
    selectedChannelIdSet,
    hasGrant,
    canViewAgentRecord,
    canOperateAgentRecord,
    canViewPipelineRecord,
    canOperatePipelineRecord,
    canViewCronJobRecord,
    canOperateCronJobRecord,
    canViewChannelRoute,
    canOperateChannelRoute,
    canViewSessionRecord,
    canOperateSessionRecord,
  };
}

function splitStoredRouteIds(value: unknown) {
  if (Array.isArray(value)) {
    return normalizeIdList(value);
  }
  return splitListInput(value);
}

function assertDashboardAdminAccess(
  req: IncomingMessage,
  store: ControlTowerStore,
  message: string,
) {
  const actor = resolveDashboardActorContext(req, store);
  if (!actor.currentUserCanManageAdminViews) {
    throw new Error(message);
  }
  return actor;
}

function assertDashboardStoreMutationAllowed(params: {
  req: IncomingMessage;
  store: ControlTowerStore;
  resource: string;
  action: "create" | "patch" | "delete";
  entry?: unknown;
  id?: string;
}) {
  const actor = resolveDashboardActorContext(params.req, params.store);
  if (actor.currentUserCanManageAdminViews) {
    return actor;
  }
  const operationalResource =
    params.resource === "pipelines" ||
    params.resource === "cronJobs" ||
    params.resource === "channels";
  if (!operationalResource) {
    throw new Error("Cette action est reservee a l'admin Elytras.");
  }
  if (!actor.currentUserCanOperate) {
    throw new Error("Cette action demande un utilisateur actif avec droits d'operation.");
  }

  if (params.resource === "channels") {
    const channelId =
      normalizeOptionalString((params.entry as JsonRecord | undefined)?.id) || params.id || "";
    if (params.action === "create") {
      if (!actor.canOperateChannelRoute()) {
        throw new Error("Aucune destination d'equipe n'est editable pour ce user.");
      }
      return actor;
    }
    if (!channelId || !actor.canOperateChannelRoute(channelId)) {
      throw new Error("Cette destination n'est pas dans le perimetre du user courant.");
    }
    return actor;
  }

  if (params.resource === "pipelines") {
    const current = params.id
      ? params.store.pipelines.find((entry) => entry.id === params.id)
      : undefined;
    if (current && !actor.canOperatePipelineRecord(current)) {
      throw new Error("Cette pipeline n'est pas dans le perimetre du user courant.");
    }
    const entry = (params.entry as JsonRecord | undefined) || {};
    const teamId = normalizeOptionalString(entry.teamId) || current?.teamId || "";
    if (!current && !teamId) {
      throw new Error("Choisis une equipe avant de sauver un pipeline.");
    }
    if (teamId && !actor.selectedTeamIdSet.has(teamId)) {
      throw new Error("Ce pipeline doit appartenir a l'une des equipes du user courant.");
    }
    const referencedAgentIds = new Set<string>();
    for (const agentId of normalizeIdList(entry.agentIds)) {
      if (agentId && agentId !== "__static__") {
        referencedAgentIds.add(agentId);
      }
    }
    const steps = Array.isArray(entry.steps) ? (entry.steps as JsonRecord[]) : [];
    for (const step of steps) {
      const stepAgentId = normalizeOptionalString(step.agentId);
      if (stepAgentId && stepAgentId !== "__static__") {
        referencedAgentIds.add(stepAgentId);
      }
    }
    for (const agentId of referencedAgentIds) {
      if (!actor.canOperateAgentRecord(agentId)) {
        throw new Error(`L'agent ${agentId} n'est pas dans le perimetre du user courant.`);
      }
    }
    const referencedChannelIds = new Set<string>();
    for (const channelId of normalizeIdList(entry.outputTargets)) {
      referencedChannelIds.add(channelId);
    }
    for (const step of steps) {
      for (const channelId of splitStoredRouteIds(step.output)) {
        referencedChannelIds.add(channelId);
      }
    }
    for (const channelId of referencedChannelIds) {
      if (!actor.canOperateChannelRoute(channelId)) {
        throw new Error(`La destination ${channelId} n'est pas dans le perimetre du user courant.`);
      }
    }
    return actor;
  }

  if (params.resource === "cronJobs") {
    const current = params.id
      ? params.store.cronJobs.find((entry) => entry.id === params.id)
      : undefined;
    if (current && !actor.canOperateCronJobRecord(current)) {
      throw new Error("Ce cron job n'est pas dans le perimetre du user courant.");
    }
    const entry = (params.entry as JsonRecord | undefined) || {};
    const targetType = resolveCustomCronTargetType(entry);
    if (targetType === "pipeline") {
      const pipelineId = normalizeOptionalString(entry.pipelineId) || current?.pipelineId || "";
      const pipeline = params.store.pipelines.find((candidate) => candidate.id === pipelineId);
      if (!pipeline || !actor.canOperatePipelineRecord(pipeline)) {
        throw new Error("Ce cron job doit viser une pipeline autorisee pour ce user.");
      }
      return actor;
    }
    const agentId = normalizeOptionalString(entry.agentId) || current?.agentId || "";
    if (!agentId || !actor.canOperateAgentRecord(agentId)) {
      throw new Error("Ce cron job doit viser un agent autorise pour ce user.");
    }
  }

  return actor;
}

function resolveAgentAllowedSkillIds(params: {
  binding?: AgentBinding;
  providerId?: string;
  allSkillIds: string[];
}) {
  const binding = params.binding;
  let allowedSkillIds =
    !binding || binding.skillPolicy === "all" || !binding.skillPolicy
      ? params.allSkillIds
      : binding.skillPolicy === "none"
        ? []
        : binding.skillIds.filter((skillId) => params.allSkillIds.includes(skillId));
  const providerPolicy =
    params.providerId && binding?.providerSkillPolicies
      ? binding.providerSkillPolicies[params.providerId]
      : undefined;
  if (!providerPolicy || providerPolicy.mode === "inherit") {
    return allowedSkillIds;
  }
  if (providerPolicy.mode === "allow-all") {
    return params.allSkillIds;
  }
  if (providerPolicy.mode === "deny-all") {
    return [];
  }
  return providerPolicy.skillIds.filter((skillId) => params.allSkillIds.includes(skillId));
}

function buildRouteComparisonTokens(value: unknown) {
  const normalized = normalizeOptionalString(value)?.toLowerCase() || "";
  if (!normalized) {
    return [];
  }
  const tokens = new Set<string>([normalized]);
  let cursor = normalized;
  while (cursor.includes(":")) {
    cursor = cursor.slice(cursor.indexOf(":") + 1);
    if (cursor) {
      tokens.add(cursor);
    }
  }
  if (normalized.startsWith("@") && normalized.length > 1) {
    tokens.add(normalized.slice(1));
  }
  return Array.from(tokens);
}

function resolveSessionMatchedChannelIds(session: JsonRecord, channels: DashboardChannel[]) {
  const origin = isJsonRecord(session.origin) ? session.origin : {};
  const deliveryContext = isJsonRecord(session.deliveryContext) ? session.deliveryContext : {};
  const { channel, target } = resolveSessionChannelAndTarget(session);
  const normalizedChannel = normalizeOptionalString(channel)?.toLowerCase() || "";
  if (!normalizedChannel || SYSTEM_CHANNEL_KINDS.has(normalizedChannel)) {
    return [];
  }

  const accountCandidates = new Set(
    [
      normalizeOptionalString(session.lastAccountId),
      normalizeOptionalString(origin.accountId),
      normalizeOptionalString(deliveryContext.accountId),
    ]
      .filter((value): value is string => Boolean(value))
      .map((value) => normalizeAccountId(value)),
  );
  const targetCandidates = new Set<string>();
  for (const value of [
    target,
    normalizeOptionalString(session.lastTo),
    normalizeOptionalString(origin.to),
    normalizeOptionalString(origin.from),
  ]) {
    for (const token of buildRouteComparisonTokens(value)) {
      targetCandidates.add(token);
    }
  }

  return channels
    .filter((entry) => {
      if (!isManagedDestinationChannelRecord(entry)) {
        return false;
      }
      if ((normalizeOptionalString(entry.kind)?.toLowerCase() || "") !== normalizedChannel) {
        return false;
      }
      const entryAccountId = normalizeOptionalString(entry.accountId);
      if (
        accountCandidates.size > 0 &&
        entryAccountId &&
        !accountCandidates.has(normalizeAccountId(entryAccountId))
      ) {
        return false;
      }
      const routeTokens = new Set([
        ...buildRouteComparisonTokens(entry.deliveryTarget),
        ...buildRouteComparisonTokens(entry.target),
      ]);
      if (!routeTokens.size || !targetCandidates.size) {
        return false;
      }
      return Array.from(routeTokens).some((token) => targetCandidates.has(token));
    })
    .map((entry) => entry.id);
}

function resolveSessionInboundPrincipal(params: {
  session: JsonRecord;
  users: DashboardUser[];
  teams: DashboardTeam[];
  grants: AccessGrant[];
  agentBindings: AgentBinding[];
  channels: DashboardChannel[];
  allSkillIds: string[];
}): SessionInboundPrincipal {
  const { channel } = resolveSessionChannelAndTarget(params.session);
  const normalizedChannel = normalizeOptionalString(channel)?.toLowerCase() || "";
  if (!normalizedChannel || SYSTEM_CHANNEL_KINDS.has(normalizedChannel)) {
    return {
      status: "n/a",
      candidateExternalIds: [],
      senderExternalIds: [],
      destinationExternalIds: [],
      authorizingTeamIds: [],
      authorizingTeamNames: [],
      teamIds: [],
      teamNames: [],
      accessibleAgentIds: [],
      accessibleChannelIds: [],
      matchedChannelIds: [],
      canUseChannel: true,
      canUseAgent: true,
      allowedSkillIds: [],
      reason: "system-surface",
    };
  }
  const matchedChannelIds = resolveSessionMatchedChannelIds(params.session, params.channels);
  const senderSnapshot = isJsonRecord(params.session.inboundSender)
    ? params.session.inboundSender
    : {};
  const senderExternalIds = Array.isArray(senderSnapshot.externalIds)
    ? (senderSnapshot.externalIds as unknown[]).filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
  const destinationExternalIds = buildSessionDestinationIdentityCandidates(params.session);
  const senderLabel =
    normalizeOptionalString(senderSnapshot.label) ||
    normalizeOptionalString(senderSnapshot.name) ||
    normalizeOptionalString(senderSnapshot.username) ||
    normalizeOptionalString(senderSnapshot.id) ||
    undefined;
  const preferSenderResolution =
    senderExternalIds.length > 0 &&
    !isSyntheticInboundSender({
      label: normalizeOptionalString(senderSnapshot.label) || undefined,
      id: normalizeOptionalString(senderSnapshot.id) || undefined,
      name: normalizeOptionalString(senderSnapshot.name) || undefined,
      username: normalizeOptionalString(senderSnapshot.username) || undefined,
      tag: normalizeOptionalString(senderSnapshot.tag) || undefined,
      e164: normalizeOptionalString(senderSnapshot.e164) || undefined,
      externalIds: senderExternalIds,
    });
  const resolutionSurface = preferSenderResolution ? "sender" : "destination";
  const candidateExternalIds =
    resolutionSurface === "sender" ? senderExternalIds : destinationExternalIds;
  const matches = collectUserIdentityMatches(params.users, candidateExternalIds);

  if (!matches.length) {
    return {
      status: "unresolved",
      candidateExternalIds,
      senderExternalIds,
      destinationExternalIds,
      senderLabel,
      resolutionSurface,
      authorizingTeamIds: [],
      authorizingTeamNames: [],
      teamIds: [],
      teamNames: [],
      accessibleAgentIds: [],
      accessibleChannelIds: [],
      matchedChannelIds,
      canUseChannel: false,
      canUseAgent: false,
      allowedSkillIds: [],
      reason: candidateExternalIds.length
        ? resolutionSurface === "sender"
          ? "Aucun user Elytras ne matche cet expediteur externe."
          : "Aucun user Elytras ne matche cette destination externe."
        : resolutionSurface === "sender"
          ? "Aucune identite expediteur exploitable trouvee sur la session."
          : "Aucune identite destination exploitable trouvee sur la session.",
    };
  }

  matches.sort((left, right) => right.score - left.score);
  const bestScore = matches[0]?.score || 0;
  const bestMatches = matches.filter((entry) => entry.score === bestScore);
  const bestUserIds = Array.from(new Set(bestMatches.map((entry) => entry.user.id)));
  if (bestUserIds.length !== 1) {
    return {
      status: "ambiguous",
      candidateExternalIds,
      senderExternalIds,
      destinationExternalIds,
      senderLabel,
      resolutionSurface,
      authorizingTeamIds: [],
      authorizingTeamNames: [],
      teamIds: [],
      teamNames: [],
      accessibleAgentIds: [],
      accessibleChannelIds: [],
      matchedChannelIds,
      canUseChannel: false,
      canUseAgent: false,
      allowedSkillIds: [],
      ambiguousUserIds: bestUserIds,
      reason:
        resolutionSurface === "sender"
          ? "Plusieurs users Elytras correspondent a cet expediteur externe."
          : "Plusieurs users Elytras correspondent a cette destination externe.",
    };
  }

  const resolved = bestMatches[0]!;
  const user = resolved.user;
  const teamIds = resolveUserTeamIds(user, params.teams);
  const teamNames = teamIds.map((teamId) => {
    return params.teams.find((team) => team.id === teamId)?.name || teamId;
  });
  const teamAccessibleAgentIds = resolveTeamAccessibleAgentIds(
    teamIds,
    params.teams,
    params.agentBindings,
  );
  const teamAccessibleChannelIds = resolveTeamAccessibleChannelIds(
    teamIds,
    params.teams,
    params.agentBindings,
  );
  const accessibleAgentIds = Array.from(new Set([...user.agentIds, ...teamAccessibleAgentIds]));
  const accessibleChannelIds = Array.from(
    new Set([...user.channelIds, ...teamAccessibleChannelIds]),
  );
  const accessibleTeamAgentIds = new Set(teamAccessibleAgentIds);
  const accessibleTeamChannelIds = new Set(teamAccessibleChannelIds);
  const agentId = resolveSessionTargetAgentId(params.session, params.channels);
  const binding = params.agentBindings.find((entry) => entry.agentId === agentId);
  const providerId =
    normalizeOptionalString(params.session.modelProvider) ||
    splitModelRef(normalizeOptionalString(binding?.preferredModelRef)).providerId ||
    undefined;
  const baseAllowedSkillIds = resolveAgentAllowedSkillIds({
    binding,
    providerId,
    allSkillIds: params.allSkillIds,
  });

  const hasAdminAccess =
    user.role === "admin" ||
    principalHasGrant({
      grants: params.grants,
      userId: user.id,
      teamIds,
      resourceType: "*",
      resourceId: "*",
      minimumPermission: "admin",
    });
  const hasExplicitAgentAccess = principalHasGrant({
    grants: params.grants,
    userId: user.id,
    teamIds,
    resourceType: "agent",
    resourceId: agentId,
    minimumPermission: "operate",
  });
  const hasDirectAgentAccess = Boolean(agentId) && user.agentIds.includes(agentId);
  const hasTeamAgentAccess =
    user.status === "active" &&
    user.role !== "viewer" &&
    Boolean(agentId) &&
    (accessibleTeamAgentIds.has(agentId) ||
      (binding?.teamId ? teamIds.includes(binding.teamId) : false) ||
      false);
  const hasExplicitChannelAccess = matchedChannelIds.some((channelId) =>
    principalHasGrant({
      grants: params.grants,
      userId: user.id,
      teamIds,
      resourceType: "channel",
      resourceId: channelId,
      minimumPermission: "operate",
    }),
  );
  const hasDirectChannelAccess = matchedChannelIds.some((channelId) =>
    user.channelIds.includes(channelId),
  );
  const hasTeamChannelAccess = matchedChannelIds.some((channelId) =>
    accessibleTeamChannelIds.has(channelId),
  );
  const hasBoundInboundDirectTransportAccess = Boolean(agentId)
    ? sessionUsesBoundInboundDirectTransport({
        session: params.session,
        agentId,
        channels: params.channels,
        matchedChannelIds,
        senderExternalIds,
        resolutionSurface,
      })
    : false;
  const authorizingTeamIds = agentId
    ? resolveInboundAuthorizingTeamIds({
        teamIds,
        agentId,
        matchedChannelIds,
        teams: params.teams,
        agentBindings: params.agentBindings,
        grants: params.grants,
      })
    : [];
  const authorizingTeamNames = authorizingTeamIds.map((teamId) => {
    return params.teams.find((team) => team.id === teamId)?.name || teamId;
  });
  const hasInboundTransportPairAccess =
    user.status === "active" &&
    user.role !== "viewer" &&
    hasBoundInboundDirectTransportAccess &&
    (hasDirectAgentAccess ||
      hasExplicitAgentAccess ||
      hasTeamAgentAccess ||
      authorizingTeamIds.length > 0);
  const hasDirectPairAccess =
    user.status === "active" &&
    user.role !== "viewer" &&
    hasDirectAgentAccess &&
    hasDirectChannelAccess;
  const hasImplicitTeamPairAccess =
    user.status === "active" &&
    user.role !== "viewer" &&
    (authorizingTeamIds.length > 0 || hasInboundTransportPairAccess);
  const canUseChannel =
    hasAdminAccess ||
    hasInboundTransportPairAccess ||
    (matchedChannelIds.length > 0 &&
      (hasExplicitChannelAccess || hasDirectPairAccess || hasImplicitTeamPairAccess));
  const canUseAgent =
    (hasAdminAccess ||
      hasExplicitAgentAccess ||
      hasInboundTransportPairAccess ||
      hasDirectPairAccess ||
      hasImplicitTeamPairAccess) &&
    canUseChannel;
  const hasAnyScopedAgentAccess =
    Boolean(agentId) && (hasExplicitAgentAccess || hasDirectAgentAccess || hasTeamAgentAccess);
  const hasAnyScopedChannelAccess =
    matchedChannelIds.length > 0 &&
    (hasExplicitChannelAccess || hasDirectChannelAccess || hasTeamChannelAccess);
  const missingCommonTeamAccess =
    !hasAdminAccess &&
    !hasDirectPairAccess &&
    !hasImplicitTeamPairAccess &&
    !(hasExplicitAgentAccess && hasExplicitChannelAccess) &&
    hasAnyScopedAgentAccess &&
    hasAnyScopedChannelAccess;

  const explicitSkillGrantIds = new Set<string>();
  let hasExplicitSkillRestriction = false;
  let hasWildcardSkillAccess = hasAdminAccess;
  for (const grant of params.grants) {
    const matchesSubject =
      (grant.subjectType === "user" && grant.subjectId === user.id) ||
      (grant.subjectType === "team" && teamIds.includes(grant.subjectId));
    if (!matchesSubject || permissionRank(grant.permission) < permissionRank("operate")) {
      continue;
    }
    if (grant.resourceType === "*" && grant.resourceId === "*") {
      hasWildcardSkillAccess = true;
      hasExplicitSkillRestriction = false;
      explicitSkillGrantIds.clear();
      break;
    }
    if (grant.resourceType !== "skill") {
      continue;
    }
    hasExplicitSkillRestriction = true;
    if (grant.resourceId === "*") {
      hasWildcardSkillAccess = true;
      explicitSkillGrantIds.clear();
      break;
    }
    if (params.allSkillIds.includes(grant.resourceId)) {
      explicitSkillGrantIds.add(grant.resourceId);
    }
  }

  let allowedSkillIds = canUseAgent ? baseAllowedSkillIds : [];
  let restrictionSource = "agent";
  if (hasAdminAccess) {
    restrictionSource = "admin";
  } else if (hasExplicitSkillRestriction) {
    restrictionSource = "grants";
    if (!hasWildcardSkillAccess) {
      allowedSkillIds = allowedSkillIds.filter((skillId) => explicitSkillGrantIds.has(skillId));
    }
  }

  return {
    status: "resolved",
    candidateExternalIds,
    senderExternalIds,
    destinationExternalIds,
    senderLabel,
    resolutionSurface,
    matchedExternalId: resolved.matchedExternalId,
    matchedBy: resolved.matchedBy,
    userId: user.id,
    userName: user.name,
    userRole: user.role,
    userStatus: user.status,
    teamIds,
    teamNames,
    authorizingTeamIds,
    authorizingTeamNames,
    targetAgentId: agentId,
    accessibleAgentIds,
    accessibleChannelIds,
    matchedChannelIds,
    canUseChannel,
    canUseAgent,
    allowedSkillIds,
    accessSource: hasAdminAccess
      ? "admin"
      : hasExplicitAgentAccess || hasExplicitChannelAccess
        ? "grant"
        : hasDirectPairAccess
          ? "direct"
          : hasImplicitTeamPairAccess
            ? "team"
            : "none",
    restrictionSource,
    reason: canUseAgent
      ? undefined
      : !canUseChannel
        ? matchedChannelIds.length
          ? missingCommonTeamAccess
            ? "Aucune equipe commune n'autorise a la fois cet agent et ce bot/destination."
            : `User ${user.name} n'a pas acces a la destination de cette conversation.`
          : "Cette conversation ne correspond a aucune destination Elytras geree."
        : user.status !== "active"
          ? `User ${user.name} n'est pas actif.`
          : user.role === "viewer"
            ? `User ${user.name} est en role viewer.`
            : missingCommonTeamAccess
              ? "Aucune equipe commune n'autorise a la fois cet agent et ce bot/destination."
              : `User ${user.name} n'a pas acces a l'agent ${agentId}.`,
  };
}

function parsePipelineSessionLabel(label: unknown) {
  const value = normalizeOptionalString(label);
  if (!value) {
    return null;
  }
  const match = value.match(/^\[pipeline:([^:\]]+):([^:\]]+):([^:\]]+)\]\s*(.*)$/);
  if (!match) {
    return null;
  }
  return {
    pipelineId: match[1],
    pipelineRunId: match[2],
    pipelineStepId: match[3],
    displayLabel: match[4] || value,
  };
}

function classifySession(session: JsonRecord) {
  const label =
    normalizeOptionalString(session.label) ||
    normalizeOptionalString(session.displayName) ||
    normalizeOptionalString(session.derivedTitle);
  const pipelineMeta = parsePipelineSessionLabel(label);
  if (pipelineMeta) {
    return {
      sessionKind: "pipeline" as const,
      sessionKindLabel: "pipeline",
      sessionKindDescription: "Session creee automatiquement par un run pipeline Elytras.",
      ...pipelineMeta,
    };
  }

  const sessionKey = normalizeOptionalString(session.key);
  if (sessionKey.includes(":dashboard:")) {
    return {
      sessionKind: "chat" as const,
      sessionKindLabel: "chat",
      sessionKindDescription: "Session ouverte depuis le dashboard Elytras.",
    };
  }

  const { channel, target } = resolveSessionChannelAndTarget(session);
  if (channel === "heartbeat" || target === "heartbeat") {
    return {
      sessionKind: "heartbeat" as const,
      sessionKindLabel: "heartbeat",
      sessionKindDescription:
        "Pulse systeme ou keepalive pour verifier qu’un transport, un routeur ou un canal reste vivant.",
    };
  }
  if (channel === "internal") {
    return {
      sessionKind: "internal" as const,
      sessionKindLabel: "internal",
      sessionKindDescription:
        "Session interne au runtime OpenClaw / gateway, utile pour le control plane et le debug.",
    };
  }
  if (channel === "webchat") {
    return {
      sessionKind: "webchat" as const,
      sessionKindLabel: "webchat",
      sessionKindDescription: "Session issue de la surface WebChat native d’OpenClaw.",
    };
  }
  return {
    sessionKind: "chat" as const,
    sessionKindLabel: "chat",
    sessionKindDescription: "Session conversationnelle classique.",
  };
}

function inferCronStatus(job: JsonRecord): string {
  const state = (job.state as JsonRecord | undefined) || {};
  if (state.runningAtMs) {
    return "running";
  }
  if (job.enabled === false) {
    return "paused";
  }
  if (state.lastRunStatus === "failed" || state.lastError) {
    return "failed";
  }
  if (state.nextRunAtMs) {
    return "queued";
  }
  if (state.lastRunStatus === "ok" || state.lastStatus === "ok") {
    return "done";
  }
  return "queued";
}

function readHeader(req: IncomingMessage, name: string, fallback: string): string {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0] || fallback;
  }
  return raw || fallback;
}

async function readBody(req: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (!chunks.length) {
    return {};
  }
  return safeJsonParse<JsonRecord>(Buffer.concat(chunks).toString("utf-8"), {});
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function gatewayBatch(
  baseUrl: string,
  token: string,
  calls: Record<string, GatewayCall>,
  options?: { timeoutMs?: number },
) {
  const names = Object.keys(calls);
  if (names.length === 0) {
    return { snapshot: null, results: {} satisfies Record<string, unknown> };
  }

  const timeoutMs =
    typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.max(1_000, Math.floor(options.timeoutMs))
      : 10_000;
  const wsUrl = toGatewayWsUrl(baseUrl);
  const operatorScopes = [
    "operator.read",
    "operator.write",
    "operator.admin",
    "operator.approvals",
    "operator.pairing",
  ];
  const deviceIdentity = loadOrCreateDeviceIdentity(DEFAULT_GATEWAY_OPERATOR_DEVICE_IDENTITY_PATH);
  let client: GatewayClient | null = null;
  let settled = false;
  let snapshot: JsonRecord | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(
          new Error(`Gateway request timeout after ${Math.round(timeoutMs / 1000)}s (${wsUrl})`),
        );
      }, timeoutMs);
      const cleanup = () => clearTimeout(timer);
      const rejectOnce = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };
      const resolveOnce = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };

      client = new GatewayClient({
        url: wsUrl,
        token,
        scopes: operatorScopes,
        requestTimeoutMs: timeoutMs,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        clientVersion: "0.1.0",
        mode: GATEWAY_CLIENT_MODES.CLI,
        role: "operator",
        platform: "node",
        deviceIdentity,
        onHelloOk: (hello) => {
          snapshot = isJsonRecord(hello.snapshot) ? hello.snapshot : null;
          resolveOnce();
        },
        onConnectError: (error) => {
          rejectOnce(
            error instanceof Error
              ? new Error(`Gateway connect error: ${error.message} (${wsUrl})`)
              : new Error(`Gateway connect error: ${String(error)} (${wsUrl})`),
          );
        },
        onClose: (code, reason) => {
          if (settled) {
            return;
          }
          const detail = reason ? `${code}: ${reason}` : String(code);
          rejectOnce(new Error(`Gateway WebSocket closed before response: ${detail} (${wsUrl})`));
        },
      });
      client.start();
    });

    if (!client) {
      throw new Error(`Gateway client unavailable (${wsUrl})`);
    }

    const results = Object.fromEntries(
      await Promise.all(
        Object.entries(calls).map(async ([name, call]) => [
          name,
          await client!.request(call.method, call.params || {}, { timeoutMs }),
        ]),
      ),
    );
    return { snapshot, results };
  } finally {
    await client?.stopAndWait().catch(() => undefined);
  }
}

async function loadSessionSkillCatalog(stateDir: string) {
  const sessionRoot = path.join(stateDir, "agents");
  const skills = new Map<string, JsonRecord>();

  let agentDirs: string[] = [];
  try {
    const entries = await fs.readdir(sessionRoot, { withFileTypes: true });
    agentDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }

  for (const agentId of agentDirs) {
    const sessionsPath = path.join(sessionRoot, agentId, "sessions", "sessions.json");
    let content = "{}";
    try {
      content = await fs.readFile(sessionsPath, "utf-8");
    } catch {
      continue;
    }
    const store = safeJsonParse<Record<string, JsonRecord>>(content, {});
    for (const entry of Object.values(store)) {
      const snapshot = (entry.skillsSnapshot as JsonRecord | undefined) || {};
      const resolved = Array.isArray(snapshot.resolvedSkills)
        ? (snapshot.resolvedSkills as JsonRecord[])
        : [];
      for (const skill of resolved) {
        const name = typeof skill.name === "string" ? skill.name : "";
        if (!name) {
          continue;
        }
        const filePath = normalizeOptionalString(skill.filePath);
        const baseDir = normalizeOptionalString(skill.baseDir);
        const rootPath = resolveRuntimeSkillRootPath(skill);
        if (rootPath && isLegacyProjectSkillRoot(rootPath)) {
          continue;
        }
        const resolvedSkillPath =
          filePath || (baseDir ? path.join(baseDir, "SKILL.md") : undefined);
        if (!resolvedSkillPath) {
          continue;
        }
        try {
          await fs.access(resolvedSkillPath);
        } catch {
          continue;
        }
        skills.set(name, {
          name,
          description: skill.description || "",
          filePath: resolvedSkillPath,
          baseDir: baseDir || path.dirname(resolvedSkillPath),
          source: skill.source || "openclaw-bundled",
          disableModelInvocation: Boolean(skill.disableModelInvocation),
        });
      }
    }
  }

  return Array.from(skills.values()).toSorted((left, right) =>
    String(left.name).localeCompare(String(right.name)),
  );
}

async function listAgentIdsWithSessionStores(stateDir: string) {
  const sessionRoot = path.join(stateDir, "agents");
  try {
    const entries = await fs.readdir(sessionRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function resolveSkillSnapshotInvalidationAgentIds(
  stateDir: string,
  library: DashboardSkillLibrary,
) {
  if (library.scope === "agent" && library.agentId) {
    return [library.agentId];
  }
  return await listAgentIdsWithSessionStores(stateDir);
}

async function clearCachedSessionSkillSnapshots(params: { stateDir: string; agentIds: string[] }) {
  const uniqueAgentIds = Array.from(
    new Set(params.agentIds.map((agentId) => agentId.trim()).filter(Boolean)),
  );
  if (!uniqueAgentIds.length) {
    return { changedAgents: 0, changedSessions: 0 };
  }

  let changedAgents = 0;
  let changedSessions = 0;

  for (const agentId of uniqueAgentIds) {
    const sessionsPath = path.join(params.stateDir, "agents", agentId, "sessions", "sessions.json");
    let rawStore = "{}";
    try {
      rawStore = await fs.readFile(sessionsPath, "utf-8");
    } catch {
      continue;
    }

    const store = safeJsonParse<Record<string, JsonRecord>>(rawStore, {});
    let changed = false;

    for (const [sessionKey, entry] of Object.entries(store)) {
      if (!isJsonRecord(entry)) {
        continue;
      }
      if (!("skillsSnapshot" in entry) && !("systemPromptReport" in entry)) {
        continue;
      }

      const nextEntry = { ...entry };
      delete nextEntry.skillsSnapshot;
      delete nextEntry.systemPromptReport;
      store[sessionKey] = nextEntry;
      changed = true;
      changedSessions += 1;
    }

    if (!changed) {
      continue;
    }

    const tempPath = `${sessionsPath}.${Date.now()}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf-8");
    await fs.rename(tempPath, sessionsPath);
    changedAgents += 1;
  }

  return { changedAgents, changedSessions };
}

async function patchPersistedSessionEntry(params: {
  stateDir: string;
  sessionKey: string;
  patch: Record<string, unknown>;
}) {
  const agentId = parseAgentIdFromSessionKey(params.sessionKey);
  const sessionsPath = path.join(params.stateDir, "agents", agentId, "sessions", "sessions.json");
  let rawStore = "{}";
  try {
    rawStore = await fs.readFile(sessionsPath, "utf-8");
  } catch {
    return false;
  }

  const store = safeJsonParse<Record<string, JsonRecord>>(rawStore, {});
  const matchingKey =
    Object.keys(store).find((key) => key.toLowerCase() === params.sessionKey.toLowerCase()) ||
    params.sessionKey;
  const currentEntry = isJsonRecord(store[matchingKey]) ? store[matchingKey] : null;
  if (!currentEntry) {
    return false;
  }

  store[matchingKey] = {
    ...currentEntry,
    ...params.patch,
  };
  const tempPath = `${sessionsPath}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf-8");
  await fs.rename(tempPath, sessionsPath);
  return true;
}

async function invalidateSkillSnapshotsForLibrary(library: DashboardSkillLibrary) {
  const runtimeEnv = buildRuntimeEnvStatusSync();
  const agentIds = await resolveSkillSnapshotInvalidationAgentIds(
    runtimeEnv.effective.stateDir,
    library,
  );
  return await clearCachedSessionSkillSnapshots({
    stateDir: runtimeEnv.effective.stateDir,
    agentIds,
  });
}

async function invalidateSkillSnapshotsForAgentIds(agentIds: string[]) {
  const runtimeEnv = buildRuntimeEnvStatusSync();
  return await clearCachedSessionSkillSnapshots({
    stateDir: runtimeEnv.effective.stateDir,
    agentIds,
  });
}

async function loadPersistedSessionCatalog(stateDir: string) {
  const sessionRoot = path.join(stateDir, "agents");
  const sessions = new Map<string, JsonRecord>();

  let agentDirs: string[] = [];
  try {
    const entries = await fs.readdir(sessionRoot, { withFileTypes: true });
    agentDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }

  for (const agentId of agentDirs) {
    const sessionsPath = path.join(sessionRoot, agentId, "sessions", "sessions.json");
    let content = "{}";
    try {
      content = await fs.readFile(sessionsPath, "utf-8");
    } catch {
      continue;
    }
    const store = safeJsonParse<Record<string, JsonRecord>>(content, {});
    for (const [sessionKey, rawValue] of Object.entries(store)) {
      const key = normalizeOptionalString(sessionKey);
      if (!key || !isJsonRecord(rawValue)) {
        continue;
      }
      const origin = isJsonRecord(rawValue.origin) ? rawValue.origin : {};
      const rawChannelId =
        normalizeOptionalString(rawValue.channel) || normalizeOptionalString(origin.provider) || "";
      const sessionFile = normalizeOptionalString(rawValue.sessionFile) || undefined;
      const inboundSender = await loadPersistedSessionInboundSender({
        sessionFile,
        channelId: rawChannelId,
      });
      const label = normalizeOptionalString(rawValue.label);
      const displayName = normalizeOptionalString(rawValue.displayName) || label;
      const providerOverride = normalizeOptionalString(rawValue.providerOverride);
      const modelOverride = normalizeOptionalString(rawValue.modelOverride);
      const modelProvider = normalizeOptionalString(rawValue.modelProvider) || providerOverride;
      const model = normalizeOptionalString(rawValue.model) || modelOverride;
      sessions.set(key, {
        ...rawValue,
        key,
        kind: normalizeOptionalString(rawValue.kind) || "direct",
        label: label || undefined,
        displayName: displayName || undefined,
        derivedTitle:
          normalizeOptionalString(rawValue.derivedTitle) || displayName || label || undefined,
        subject: normalizeOptionalString(rawValue.subject) || undefined,
        chatType: normalizeOptionalString(rawValue.chatType) || undefined,
        channel: normalizeOptionalString(rawValue.channel) || undefined,
        lastTo: normalizeOptionalString(rawValue.lastTo) || undefined,
        updatedAt: typeof rawValue.updatedAt === "number" ? rawValue.updatedAt : null,
        sessionId: normalizeOptionalString(rawValue.sessionId) || undefined,
        sessionFile,
        inboundSender: inboundSender || undefined,
        status: normalizeOptionalString(rawValue.status) || undefined,
        parentSessionKey: normalizeOptionalString(rawValue.parentSessionKey) || undefined,
        childSessions: Array.isArray(rawValue.childSessions)
          ? (rawValue.childSessions as unknown[]).filter(
              (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
            )
          : undefined,
        providerOverride: providerOverride || undefined,
        modelOverride: modelOverride || undefined,
        modelProvider: modelProvider || undefined,
        model: model || undefined,
        contextTokens:
          typeof rawValue.contextTokens === "number" ? rawValue.contextTokens : undefined,
        totalTokens: typeof rawValue.totalTokens === "number" ? rawValue.totalTokens : undefined,
        estimatedCostUsd:
          typeof rawValue.estimatedCostUsd === "number" ? rawValue.estimatedCostUsd : undefined,
        thinkingLevel: normalizeOptionalString(rawValue.thinkingLevel) || undefined,
        fastMode: typeof rawValue.fastMode === "boolean" ? Boolean(rawValue.fastMode) : undefined,
        verboseLevel: normalizeOptionalString(rawValue.verboseLevel) || undefined,
        reasoningLevel: normalizeOptionalString(rawValue.reasoningLevel) || undefined,
      });
    }
  }

  return Array.from(sessions.values()).toSorted((left, right) => {
    const leftUpdatedAt = typeof left.updatedAt === "number" ? left.updatedAt : 0;
    const rightUpdatedAt = typeof right.updatedAt === "number" ? right.updatedAt : 0;
    if (rightUpdatedAt !== leftUpdatedAt) {
      return rightUpdatedAt - leftUpdatedAt;
    }
    return stringifyUnknown(left.key).localeCompare(stringifyUnknown(right.key));
  });
}

function stripQuotedValue(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseSkillFrontmatterPreview(
  content: string,
  fallbackName: string,
): Pick<DashboardSkillEntry, "name" | "description" | "disableModelInvocation"> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return {
      name: fallbackName,
      description: "",
      disableModelInvocation: false,
    };
  }
  let name = fallbackName;
  let description = "";
  let disableModelInvocation = false;
  for (const line of match[1].split(/\r?\n/g)) {
    const entry = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!entry) {
      continue;
    }
    const key = entry[1].trim();
    const value = stripQuotedValue(entry[2] || "");
    if (key === "name" && value) {
      name = value;
    } else if (key === "description" && value) {
      description = value;
    } else if (key === "disable-model-invocation") {
      disableModelInvocation = value.toLowerCase() === "true";
    }
  }
  return {
    name,
    description,
    disableModelInvocation,
  };
}

function formatSkillFrontmatterScalar(value: string) {
  return JSON.stringify(value.trim());
}

function stripMarkdownPreviewMarkers(value: string) {
  return value
    .replace(/^#+\s*/, "")
    .replace(/^[-*+]\s*/, "")
    .replace(/\[(.*?)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveFallbackSkillDescription(content: string, fallbackName: string) {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
  const previewLine = body
    .split(/\r?\n/g)
    .map((line) => stripMarkdownPreviewMarkers(line))
    .find((line) => line.length > 0);
  const fallback = previewLine || `Instructions for ${fallbackName}.`;
  if (fallback.length <= 240) {
    return fallback;
  }
  return `${fallback.slice(0, 237).trimEnd()}...`;
}

function normalizeDashboardSkillContentForRuntime(
  content: string,
  dirName: string,
  warnings?: string[],
) {
  const preview = parseSkillFrontmatterPreview(content, dirName);
  const fallbackDescription = deriveFallbackSkillDescription(content, dirName);
  const description = preview.description.trim() || fallbackDescription;
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

  if (!match) {
    warnings?.push(
      `"${dirName}" n'avait pas de frontmatter. Elytras a ajoute name/description pour le rendre chargeable par OpenClaw.`,
    );
    return [
      "---",
      `name: ${dirName}`,
      `description: ${formatSkillFrontmatterScalar(description)}`,
      "---",
      "",
      content.trimStart(),
    ].join("\n");
  }

  let hadName = false;
  let hadDescription = false;
  const lines = match[1].split(/\r?\n/g).map((line) => {
    const entry = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!entry) {
      return line;
    }
    const key = entry[1].trim();
    const value = stripQuotedValue(entry[2] || "");
    if (key === "name") {
      hadName = true;
      return value ? line : `name: ${dirName}`;
    }
    if (key === "description") {
      hadDescription = true;
      return `description: ${formatSkillFrontmatterScalar(value || description)}`;
    }
    return line;
  });

  if (!hadName) {
    lines.unshift(`name: ${dirName}`);
  }
  if (!hadDescription) {
    const nameLineIndex = lines.findIndex((line) => /^name\s*:/.test(line));
    const descriptionLine = `description: ${formatSkillFrontmatterScalar(description)}`;
    if (nameLineIndex >= 0) {
      lines.splice(nameLineIndex + 1, 0, descriptionLine);
    } else {
      lines.unshift(descriptionLine);
    }
    warnings?.push(
      `"${dirName}" n'avait pas de description frontmatter. Elytras en a genere une pour le rendre chargeable par OpenClaw.`,
    );
  }

  const rest = content.slice(match[0].length);
  const separator = rest.startsWith("\n") || rest.startsWith("\r") ? "" : "\n";
  return `---\n${lines.join("\n")}\n---${separator}${rest}`;
}

function isSafeSkillDirName(value: string) {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function resolveSafeSkillDirName(value: unknown) {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed || !isSafeSkillDirName(trimmed)) {
    throw new Error(
      "Skill directory name must use only letters, numbers, dots, underscores, or dashes.",
    );
  }
  return trimmed;
}

function resolveSkillFilePath(rootPath: string, dirName: string) {
  const rootResolved = path.resolve(rootPath);
  const baseDir = path.resolve(rootResolved, dirName);
  if (baseDir !== rootResolved && !baseDir.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error("Invalid skill path.");
  }
  return {
    rootResolved,
    baseDir,
    filePath: path.join(baseDir, "SKILL.md"),
  };
}

function normalizeDashboardSkillImportSourceType(
  value: unknown,
): DashboardSkillImportSourceType | undefined {
  switch (normalizeOptionalString(value)) {
    case "git":
    case "zip-url":
    case "zip-upload":
    case "skill-md":
      return normalizeOptionalString(value) as DashboardSkillImportSourceType;
    default:
      return undefined;
  }
}

function buildImportedSkillDirName(seed: string) {
  const normalized = normalizeOptionalString(seed);
  if (normalized && isSafeSkillDirName(normalized)) {
    return normalized;
  }
  const slug = slugify(normalized || "skill");
  if (slug && isSafeSkillDirName(slug)) {
    return slug;
  }
  return `skill-${createHash("sha1")
    .update(seed || "skill")
    .digest("hex")
    .slice(0, 8)}`;
}

function resolveAvailableImportedSkillDirName(
  rootPath: string,
  requestedDirName: string,
  overwrite: boolean,
  reserved: Set<string>,
  warnings: string[],
) {
  const baseDirName = buildImportedSkillDirName(requestedDirName);
  let candidate = baseDirName;
  let index = 2;
  while (
    reserved.has(candidate) ||
    (!overwrite && fsSync.existsSync(resolveSkillFilePath(rootPath, candidate).baseDir))
  ) {
    candidate = `${baseDirName}-${index}`;
    index += 1;
  }
  if (candidate !== baseDirName) {
    warnings.push(`"${baseDirName}" existe deja, import renomme en "${candidate}".`);
  }
  reserved.add(candidate);
  return candidate;
}

async function runExternalCommand(command: string, args: string[], cwd?: string) {
  if (!canResolveExecutable(command)) {
    throw new Error(`Command ${command} is not available on this machine.`);
  }
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}.`));
    });
  });
}

async function extractZipArchiveToDirectory(archivePath: string, destinationDir: string) {
  const commands =
    process.platform === "win32"
      ? [["tar", ["-xf", archivePath, "-C", destinationDir]]]
      : [
          ["unzip", ["-q", archivePath, "-d", destinationDir]],
          ["tar", ["-xf", archivePath, "-C", destinationDir]],
        ];
  let lastError: Error | null = null;
  for (const [command, args] of commands) {
    try {
      await runExternalCommand(command, args);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError || new Error("Unable to extract archive.");
}

async function resolveSkillImportSourceRoot(rootPath: string, sourcePath?: string) {
  const rootResolved = path.resolve(rootPath);
  const requested = normalizeOptionalString(sourcePath);
  if (!requested) {
    return rootResolved;
  }
  const candidate = path.resolve(rootResolved, requested);
  if (candidate !== rootResolved && !candidate.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error("sourcePath must stay inside the imported repository or archive.");
  }
  const stat = await fs.stat(candidate).catch(() => null);
  if (!stat) {
    throw new Error(`sourcePath not found: ${requested}`);
  }
  if (stat.isFile()) {
    if (path.basename(candidate) !== "SKILL.md") {
      throw new Error("sourcePath can point to a directory or directly to SKILL.md.");
    }
    return path.dirname(candidate);
  }
  if (!stat.isDirectory()) {
    throw new Error("sourcePath must point to a directory.");
  }
  return candidate;
}

async function collectImportableSkillDirectories(rootPath: string) {
  const results: string[] = [];
  const skipDirectories = new Set([
    ".git",
    ".next",
    ".turbo",
    "build",
    "coverage",
    "dist",
    "node_modules",
  ]);

  async function visit(currentDir: string): Promise<void> {
    let entries: fsSync.Dirent[] = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      results.push(currentDir);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (skipDirectories.has(entry.name)) {
        continue;
      }
      await visit(path.join(currentDir, entry.name));
    }
  }

  await visit(path.resolve(rootPath));
  return results.toSorted((left, right) => left.localeCompare(right));
}

async function copyImportedSkillDirectory(
  sourceDir: string,
  destinationDir: string,
  warnings: string[],
  relativePrefix = "",
) {
  await fs.mkdir(destinationDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") {
      continue;
    }
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    const relativePath = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name;
    if (entry.isSymbolicLink()) {
      warnings.push(`Lien symbolique ignore: ${relativePath}`);
      continue;
    }
    if (entry.isDirectory()) {
      await copyImportedSkillDirectory(sourcePath, destinationPath, warnings, relativePath);
      continue;
    }
    if (!entry.isFile()) {
      warnings.push(`Element non supporte ignore: ${relativePath}`);
      continue;
    }
    await fs.copyFile(sourcePath, destinationPath);
    const sourceStats = await fs.stat(sourcePath);
    await fs.chmod(destinationPath, sourceStats.mode);
  }
}

async function readDashboardSkillContentForLibrary(
  library: DashboardSkillLibrary,
  dirName: string,
) {
  const normalizedDirName = resolveSafeSkillDirName(dirName);
  const resolved = resolveSkillFilePath(library.rootPath, normalizedDirName);
  const content = await fs.readFile(resolved.filePath, "utf8");
  const preview = parseSkillFrontmatterPreview(content, normalizedDirName);
  const updatedAtMs = (await fs.stat(resolved.filePath)).mtimeMs;
  return {
    skill: {
      id: `${library.id}:${normalizedDirName}`,
      libraryId: library.id,
      scope: library.scope,
      kind: library.kind,
      dirName: normalizedDirName,
      name: preview.name,
      description: preview.description,
      filePath: resolved.filePath,
      baseDir: resolved.baseDir,
      rootPath: library.rootPath,
      source: library.source,
      disableModelInvocation: preview.disableModelInvocation,
      updatedAtMs,
      agentId: library.agentId,
      agentLabel: library.agentLabel,
    },
    content,
  };
}

async function listSkillEntriesForLibrary(
  library: DashboardSkillLibrary,
): Promise<DashboardSkillEntry[]> {
  let dirEntries: fsSync.Dirent[] = [];
  try {
    dirEntries = await fs.readdir(library.rootPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: DashboardSkillEntry[] = [];
  for (const entry of dirEntries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const candidateDir = path.join(library.rootPath, entry.name);
    let isDirectory = entry.isDirectory();
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = (await fs.stat(candidateDir)).isDirectory();
      } catch {
        isDirectory = false;
      }
    }
    if (!isDirectory) {
      continue;
    }

    const filePath = path.join(candidateDir, "SKILL.md");
    let raw = "";
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const preview = parseSkillFrontmatterPreview(raw, entry.name);
    let updatedAtMs = 0;
    try {
      updatedAtMs = (await fs.stat(filePath)).mtimeMs;
    } catch {
      updatedAtMs = 0;
    }
    skills.push({
      id: `${library.id}:${entry.name}`,
      libraryId: library.id,
      scope: library.scope,
      kind: library.kind,
      dirName: entry.name,
      name: preview.name,
      description: preview.description,
      filePath,
      baseDir: candidateDir,
      rootPath: library.rootPath,
      source: library.source,
      disableModelInvocation: preview.disableModelInvocation,
      updatedAtMs,
      agentId: library.agentId,
      agentLabel: library.agentLabel,
    });
  }

  return skills.toSorted((left, right) => left.name.localeCompare(right.name));
}

function describeSkillLibraryLabel(rootPath: string) {
  const baseName = path.basename(rootPath);
  const parentName = path.basename(path.dirname(rootPath));
  if (parentName && parentName !== "." && parentName !== path.sep && parentName !== baseName) {
    return `${parentName}/${baseName}`;
  }
  return baseName || rootPath;
}

function describeRuntimeSkillSource(source: string) {
  switch (source) {
    case "openclaw-bundled":
      return "bundled";
    case "openclaw-managed":
      return "managed";
    case "agents-skills-personal":
      return "personal";
    case "openclaw-workspace":
      return "workspace";
    default:
      return source || "runtime";
  }
}

function resolveRuntimeSkillRootPath(skill: { baseDir?: unknown; filePath?: unknown }) {
  const baseDir = normalizeOptionalString(skill.baseDir);
  if (baseDir) {
    return path.dirname(baseDir);
  }
  const filePath = normalizeOptionalString(skill.filePath);
  if (filePath) {
    return path.dirname(path.dirname(filePath));
  }
  return "";
}

function isLegacyProjectSkillRoot(rootPath: string) {
  return path.resolve(rootPath) === path.resolve(PROJECT_ROOT, "skills");
}

function buildSkillLibrariesFromDashboard(
  dashboard: Awaited<ReturnType<typeof buildDashboardSnapshot>>,
): DashboardSkillLibrary[] {
  const agentNameById = new Map(
    dashboard.agents.map((agent) => [
      agent.id,
      normalizeOptionalString(agent.identity?.name) ||
        normalizeOptionalString(agent.name) ||
        agent.id,
    ]),
  );

  const libraries: DashboardSkillLibrary[] = [
    {
      id: "shared-managed",
      scope: "shared",
      kind: "managed",
      label: "Shared OpenClaw",
      description:
        "Bibliotheque partagee native de l'installation OpenClaw dans ~/.openclaw/skills.",
      rootPath: DEFAULT_MANAGED_SKILLS_DIR,
      source: "openclaw-managed",
    },
    {
      id: "shared-personal",
      scope: "shared",
      kind: "personal",
      label: "Shared Personal",
      description: "Bibliotheque partagee perso dans ~/.agents/skills.",
      rootPath: DEFAULT_PERSONAL_SKILLS_DIR,
      source: "agents-skills-personal",
    },
  ];

  for (const workspace of dashboard.workspaces) {
    const agentLabel = agentNameById.get(workspace.agentId) || workspace.agentId;
    libraries.push({
      id: `agent:${workspace.agentId}:workspace`,
      scope: "agent",
      kind: "workspace",
      label: `${agentLabel} · workspace`,
      description: `Skills propres a l'agent dans ${workspace.path}/skills.`,
      rootPath: path.join(workspace.path, "skills"),
      source: "openclaw-workspace",
      agentId: workspace.agentId,
      agentLabel,
    });
    libraries.push({
      id: `agent:${workspace.agentId}:overlay`,
      scope: "agent",
      kind: "overlay",
      label: `${agentLabel} · overlay`,
      description: `Overlay agent dans ${workspace.path}/.agents/skills.`,
      rootPath: path.join(workspace.path, ".agents", "skills"),
      source: "agents-skills-project",
      agentId: workspace.agentId,
      agentLabel,
    });
  }

  const knownRootPaths = new Set(libraries.map((library) => path.resolve(library.rootPath)));
  const discoveredSharedLibraries = new Map<
    string,
    { rootPath: string; source: string; description: string; label: string }
  >();
  for (const skill of dashboard.skills || []) {
    const rootPath = resolveRuntimeSkillRootPath(skill);
    if (!rootPath) {
      continue;
    }
    const resolvedRootPath = path.resolve(rootPath);
    if (isLegacyProjectSkillRoot(resolvedRootPath)) {
      continue;
    }
    if (knownRootPaths.has(resolvedRootPath) || discoveredSharedLibraries.has(resolvedRootPath)) {
      continue;
    }
    const source = normalizeOptionalString(skill.source) || "runtime";
    if (source === "openclaw-bundled") {
      continue;
    }
    const sourceLabel = describeRuntimeSkillSource(source);
    discoveredSharedLibraries.set(resolvedRootPath, {
      rootPath: resolvedRootPath,
      source,
      label: `Shared ${sourceLabel} · ${describeSkillLibraryLabel(resolvedRootPath)}`,
      description: `Bibliotheque partagee detectee via le runtime dans ${resolvedRootPath}.`,
    });
  }

  libraries.push(
    ...Array.from(discoveredSharedLibraries.values()).map((library) => ({
      id: `shared:runtime:${createHash("sha1").update(library.rootPath).digest("hex").slice(0, 10)}`,
      scope: "shared" as const,
      kind: "runtime" as const,
      label: library.label,
      description: library.description,
      rootPath: library.rootPath,
      source: library.source,
    })),
  );

  return libraries;
}

async function loadSkillsCatalogForDashboard(req: IncomingMessage) {
  const dashboard = await buildDashboardSnapshot(req);
  const libraries = buildSkillLibrariesFromDashboard(dashboard);
  const skills = (
    await Promise.all(libraries.map((library) => listSkillEntriesForLibrary(library)))
  ).flat();
  return {
    libraries,
    skills: skills.toSorted((left, right) => {
      if (left.libraryId !== right.libraryId) {
        return left.libraryId.localeCompare(right.libraryId);
      }
      return left.name.localeCompare(right.name);
    }),
    precedence: [
      "shared extraDirs",
      "shared ~/.openclaw/skills",
      "shared ~/.agents/skills",
      "agent .agents/skills",
      "agent workspace/skills",
    ],
  };
}

async function resolveDashboardSkillLibrary(req: IncomingMessage, libraryId: string) {
  const catalog = await loadSkillsCatalogForDashboard(req);
  const library = catalog.libraries.find((entry) => entry.id === libraryId);
  if (!library) {
    throw new Error(`Unknown skill library ${libraryId}.`);
  }
  return {
    catalog,
    library,
  };
}

async function loadDashboardSkillContent(req: IncomingMessage, libraryId: string, dirName: string) {
  const { library } = await resolveDashboardSkillLibrary(req, libraryId);
  return await readDashboardSkillContentForLibrary(library, dirName);
}

async function saveDashboardSkillContent(req: IncomingMessage, payload: Record<string, unknown>) {
  const libraryId = normalizeOptionalString(payload.libraryId);
  if (!libraryId) {
    throw new Error("libraryId is required.");
  }
  const dirName = resolveSafeSkillDirName(payload.dirName);
  const previousDirName = normalizeOptionalString(payload.previousDirName);
  const rawContent = typeof payload.content === "string" ? payload.content : "";
  if (!rawContent.trim()) {
    throw new Error("Skill content cannot be empty.");
  }
  const content = normalizeDashboardSkillContentForRuntime(rawContent, dirName);

  const { library } = await resolveDashboardSkillLibrary(req, libraryId);
  const target = resolveSkillFilePath(library.rootPath, dirName);
  await fs.mkdir(target.rootResolved, { recursive: true });

  if (previousDirName && previousDirName !== dirName) {
    const previous = resolveSkillFilePath(
      library.rootPath,
      resolveSafeSkillDirName(previousDirName),
    );
    const previousExists = fsSync.existsSync(previous.baseDir);
    if (previousExists && !fsSync.existsSync(target.baseDir)) {
      await fs.rename(previous.baseDir, target.baseDir);
    }
  }

  await fs.mkdir(target.baseDir, { recursive: true });
  await fs.writeFile(target.filePath, content, "utf8");
  await invalidateSkillSnapshotsForLibrary(library);
  return await readDashboardSkillContentForLibrary(library, dirName);
}

async function deleteDashboardSkillContent(
  req: IncomingMessage,
  libraryId: string,
  dirName: string,
) {
  const normalizedDirName = resolveSafeSkillDirName(dirName);
  const { library } = await resolveDashboardSkillLibrary(req, libraryId);
  const resolved = resolveSkillFilePath(library.rootPath, normalizedDirName);
  await fs.rm(resolved.baseDir, { recursive: true, force: true });
  await invalidateSkillSnapshotsForLibrary(library);
}

async function importDashboardSkillContent(
  req: IncomingMessage,
  payload: DashboardSkillImportPayload,
) {
  const libraryId = normalizeOptionalString(payload.libraryId);
  if (!libraryId) {
    throw new Error("libraryId is required.");
  }
  const sourceType = normalizeDashboardSkillImportSourceType(payload.sourceType);
  if (!sourceType) {
    throw new Error("sourceType must be one of git, zip-url, zip-upload, or skill-md.");
  }
  const overwrite = payload.overwrite === true;
  const { library } = await resolveDashboardSkillLibrary(req, libraryId);
  await fs.mkdir(library.rootPath, { recursive: true });

  const warnings: string[] = [];
  const reservedDirNames = new Set<string>();
  const importedDirNames: string[] = [];

  async function importSkillDirectory(sourceDir: string, requestedDirName?: string) {
    const sourceSkillPath = path.join(sourceDir, "SKILL.md");
    const rawContent = await fs.readFile(sourceSkillPath, "utf8");
    const preview = parseSkillFrontmatterPreview(
      rawContent,
      requestedDirName || path.basename(sourceDir),
    );
    const dirName = resolveAvailableImportedSkillDirName(
      library.rootPath,
      requestedDirName || path.basename(sourceDir) || preview.name || "skill",
      overwrite,
      reservedDirNames,
      warnings,
    );
    const target = resolveSkillFilePath(library.rootPath, dirName);
    if (overwrite) {
      await fs.rm(target.baseDir, { recursive: true, force: true });
    }
    await copyImportedSkillDirectory(sourceDir, target.baseDir, warnings, dirName);
    const normalizedContent = normalizeDashboardSkillContentForRuntime(
      rawContent,
      dirName,
      warnings,
    );
    await fs.writeFile(path.join(target.baseDir, "SKILL.md"), normalizedContent, "utf8");
    importedDirNames.push(dirName);
  }

  if (sourceType === "skill-md") {
    const rawContent = typeof payload.content === "string" ? payload.content : "";
    if (!rawContent.trim()) {
      throw new Error("content is required for skill-md imports.");
    }
    const requestedDirName = resolveSafeSkillDirName(payload.dirName);
    const dirName = resolveAvailableImportedSkillDirName(
      library.rootPath,
      requestedDirName,
      overwrite,
      reservedDirNames,
      warnings,
    );
    const target = resolveSkillFilePath(library.rootPath, dirName);
    if (overwrite) {
      await fs.rm(target.baseDir, { recursive: true, force: true });
    }
    await fs.mkdir(target.baseDir, { recursive: true });
    await fs.writeFile(
      target.filePath,
      normalizeDashboardSkillContentForRuntime(rawContent, dirName, warnings),
      "utf8",
    );
    importedDirNames.push(dirName);
  } else {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "elytras-skill-import-"));
    try {
      let sourceRoot = tempRoot;
      if (sourceType === "git") {
        const repoUrl = normalizeOptionalString(payload.repoUrl);
        if (!repoUrl) {
          throw new Error("repoUrl is required for git imports.");
        }
        const cloneDir = path.join(tempRoot, "repo");
        const ref = normalizeOptionalString(payload.ref);
        if (ref) {
          await runExternalCommand("git", ["clone", repoUrl, cloneDir]);
          await runExternalCommand("git", ["checkout", ref], cloneDir);
        } else {
          await runExternalCommand("git", ["clone", "--depth", "1", repoUrl, cloneDir]);
        }
        sourceRoot = cloneDir;
      } else {
        const archiveDir = path.join(tempRoot, "archive");
        await fs.mkdir(archiveDir, { recursive: true });
        const archivePath = path.join(
          tempRoot,
          normalizeOptionalString(payload.fileName) || "skill-import.zip",
        );
        if (sourceType === "zip-url") {
          const archiveUrl = normalizeOptionalString(payload.archiveUrl);
          if (!archiveUrl) {
            throw new Error("archiveUrl is required for zip-url imports.");
          }
          const targetUrl = new URL(archiveUrl);
          if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
            throw new Error("archiveUrl must use http or https.");
          }
          const response = await fetch(targetUrl);
          if (!response.ok) {
            throw new Error(`Archive download failed with HTTP ${response.status}.`);
          }
          const archiveBuffer = Buffer.from(await response.arrayBuffer());
          await fs.writeFile(archivePath, archiveBuffer);
        } else {
          const archiveBase64 = normalizeOptionalString(payload.archiveBase64);
          if (!archiveBase64) {
            throw new Error("archiveBase64 is required for zip-upload imports.");
          }
          await fs.writeFile(archivePath, Buffer.from(archiveBase64, "base64"));
        }
        await extractZipArchiveToDirectory(archivePath, archiveDir);
        sourceRoot = archiveDir;
      }

      const scopedSourceRoot = await resolveSkillImportSourceRoot(
        sourceRoot,
        normalizeOptionalString(payload.sourcePath),
      );
      const skillDirectories = await collectImportableSkillDirectories(scopedSourceRoot);
      if (!skillDirectories.length) {
        throw new Error("Aucun dossier contenant SKILL.md n’a ete trouve dans cette source.");
      }
      for (const skillDirectory of skillDirectories) {
        await importSkillDirectory(skillDirectory);
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }

  const imported = await Promise.all(
    importedDirNames.map(
      async (dirName) => (await readDashboardSkillContentForLibrary(library, dirName)).skill,
    ),
  );
  await invalidateSkillSnapshotsForLibrary(library);
  return {
    libraryId: library.id,
    imported,
    warnings,
  };
}

async function readWorkspaceState(workspaceDir: string) {
  const statePath = path.join(workspaceDir, ".openclaw", "workspace-state.json");
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return safeJsonParse<JsonRecord>(raw, {});
  } catch {
    return {};
  }
}

function isMemoryWorkspaceSurface(name: string) {
  return MEMORY_FILE_NAMES.has(name) || name.startsWith("memory/");
}

function normalizeWorkspaceMarkdownName(name: string) {
  const normalized = normalizeOptionalString(name).replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error("Invalid workspace markdown path.");
  }
  if (!normalized.toLowerCase().endsWith(".md")) {
    throw new Error("Only markdown files are supported.");
  }
  return normalized;
}

function resolveWorkspaceMarkdownPath(workspaceDir: string, name: string) {
  const normalizedName = normalizeWorkspaceMarkdownName(name);
  const workspaceRoot = path.resolve(workspaceDir);
  const targetPath = path.resolve(workspaceRoot, normalizedName);
  if (targetPath !== workspaceRoot && !targetPath.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("Workspace markdown path escapes the workspace root.");
  }
  return {
    name: normalizedName,
    targetPath,
    workspaceRoot,
  };
}

async function listWorkspaceMarkdownFiles(workspaceDir: string) {
  const discovered = new Map<
    string,
    {
      name: string;
      path: string;
      missing: boolean;
      size: number;
      updatedAtMs: number;
      extension: string;
      type: "memory" | "workspace";
    }
  >();
  const skipDirectories = new Set([".git", ".openclaw", "node_modules"]);

  async function visit(currentDir: string): Promise<void> {
    let entries: fsSync.Dirent[] = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirectories.has(entry.name)) {
          continue;
        }
        await visit(path.join(currentDir, entry.name));
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(workspaceDir, absolutePath).replace(/\\/g, "/");
      let stats: fsSync.Stats | null = null;
      try {
        stats = await fs.stat(absolutePath);
      } catch {
        stats = null;
      }
      discovered.set(relativePath, {
        name: relativePath,
        path: absolutePath,
        missing: false,
        size: stats?.size || 0,
        updatedAtMs: stats?.mtimeMs || 0,
        extension: path.extname(relativePath).replace(/^\./, "") || "md",
        type: isMemoryWorkspaceSurface(relativePath) ? "memory" : "workspace",
      });
    }
  }

  await visit(workspaceDir);
  return Array.from(discovered.values()).toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
}

async function resolveAgentWorkspaceDir(
  gatewayUrl: string,
  gatewayToken: string,
  agentId: string,
  fallbackWorkspaceRoot: string,
) {
  const response = await gatewayBatch(gatewayUrl, gatewayToken, {
    files: { method: "agents.files.list", params: { agentId } },
  });
  const payload = (response.results.files as JsonRecord | undefined) || {};
  return stringifyUnknown(payload.workspace, path.join(fallbackWorkspaceRoot, agentId));
}

async function readAgentMarkdownDirect(
  gatewayUrl: string,
  gatewayToken: string,
  agentId: string,
  name: string,
  fallbackWorkspaceRoot: string,
) {
  const workspaceDir = await resolveAgentWorkspaceDir(
    gatewayUrl,
    gatewayToken,
    agentId,
    fallbackWorkspaceRoot,
  );
  const resolved = resolveWorkspaceMarkdownPath(workspaceDir, name);
  const content = await fs.readFile(resolved.targetPath, "utf8");
  const stats = await fs.stat(resolved.targetPath);
  return {
    workspace: workspaceDir,
    name: resolved.name,
    path: resolved.targetPath,
    content,
    size: stats.size,
    updatedAtMs: stats.mtimeMs,
    missing: false,
  };
}

async function writeAgentMarkdownDirect(
  gatewayUrl: string,
  gatewayToken: string,
  agentId: string,
  name: string,
  content: string,
  fallbackWorkspaceRoot: string,
) {
  const workspaceDir = await resolveAgentWorkspaceDir(
    gatewayUrl,
    gatewayToken,
    agentId,
    fallbackWorkspaceRoot,
  );
  const resolved = resolveWorkspaceMarkdownPath(workspaceDir, name);
  await fs.mkdir(path.dirname(resolved.targetPath), { recursive: true });
  await fs.writeFile(resolved.targetPath, content, "utf8");
  const stats = await fs.stat(resolved.targetPath);
  return {
    workspace: workspaceDir,
    name: resolved.name,
    path: resolved.targetPath,
    content,
    size: stats.size,
    updatedAtMs: stats.mtimeMs,
    missing: false,
  };
}

function defaultStore(discoveredAgentIds: string[], discoveredChannels: DashboardChannel[]) {
  const now = new Date().toISOString();
  const username = os.userInfo().username || "operator";
  const userId = `${slugify(username)}-admin`;
  return {
    version: 4,
    users: [
      {
        id: userId,
        name: username,
        email: `${slugify(username)}@local`,
        title: "Administrator",
        phone: "",
        location: "",
        notes: "",
        role: "admin",
        status: "active",
        teamIds: ["operations"],
        channelIds: discoveredChannels.map((channel) => channel.id),
        agentIds: discoveredAgentIds,
        externalIdentities: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    teams: [
      {
        id: "operations",
        name: "Operations",
        color: "#234b40",
        description: "Equipe operateur du control tower.",
        contactEmail: "",
        website: "",
        notes: "",
        memberIds: [userId],
        agentIds: discoveredAgentIds,
        channelIds: discoveredChannels.map((channel) => channel.id),
        createdAt: now,
        updatedAt: now,
      },
    ],
    projects: [],
    channels: discoveredChannels,
    pipelines: [],
    pipelineRuns: [],
    cronJobs: [],
    grants: [
      {
        id: "grant-admin-root",
        subjectType: "user",
        subjectId: userId,
        resourceType: "*",
        resourceId: "*",
        permission: "admin",
        createdAt: now,
        updatedAt: now,
      },
    ],
    agentBindings: discoveredAgentIds.map((agentId) => ({
      id: agentId,
      agentId,
      ownerId: userId,
      teamId: "operations",
      purpose: `Pilotage de l'agent ${agentId}`,
      channelIds: discoveredChannels.map((channel) => channel.id),
      defaultOutputChannelIds: [],
      providerIds: [],
      providerAccountIds: {},
      providerSkillPolicies: {},
      skillPolicy: "all",
      skillIds: [],
      tags: [],
      preferredModelRef: undefined,
      resumePolicy: "manual",
      dispatchPolicy: "manual",
      thinkingLevel: undefined,
      fastMode: undefined,
      verboseLevel: undefined,
      reasoningLevel: undefined,
      createdAt: now,
      updatedAt: now,
    })),
    providerBridges: seedProviderBridges(now),
  } satisfies ControlTowerStore;
}

async function saveStore(storePath: string, store: ControlTowerStore) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const tempPath = `${storePath}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf-8");
  await fs.rename(tempPath, storePath);
}

async function loadStore(discoveredAgentIds: string[], discoveredChannels: DashboardChannel[]) {
  const cliproxyBootstrap = await ensureProjectCliproxyBootstrap().catch(() => undefined);
  let store: ControlTowerStore | null = null;
  try {
    const raw = await fs.readFile(DEFAULT_STORE_PATH, "utf-8");
    store = safeJsonParse<ControlTowerStore>(
      raw,
      defaultStore(discoveredAgentIds, discoveredChannels),
    );
  } catch {
    store = defaultStore(discoveredAgentIds, discoveredChannels);
    await saveStore(DEFAULT_STORE_PATH, store);
  }

  const now = new Date().toISOString();
  store.users = Array.isArray(store.users)
    ? store.users.map((user) => normalizeDashboardUserRecord(user, now))
    : [];
  store.teams = Array.isArray(store.teams)
    ? store.teams.map((team) => normalizeDashboardTeamRecord(team, now))
    : [];
  store.projects = Array.isArray(store.projects)
    ? store.projects.map((project) => normalizeDashboardProjectRecord(project, now))
    : [];
  store.grants = Array.isArray(store.grants)
    ? store.grants
        .map((grant) => normalizeAccessGrantRecord(grant, now))
        .filter((grant) => grant.subjectId)
    : [];
  const normalizedChannels = normalizeStoredChannels(store.channels, discoveredChannels, now);
  store.channels = normalizedChannels.channels;
  remapChannelReferencesInStore(store, normalizedChannels.idMap);
  store.pipelines = Array.isArray(store.pipelines)
    ? store.pipelines.map((pipeline) => {
        const { recurrence: _ignoredRecurrence, ...normalizedPipeline } = pipeline as JsonRecord &
          PipelineRecord & { recurrence?: unknown };
        const viewport = normalizePipelineViewport((pipeline as JsonRecord).viewport);
        return {
          ...normalizedPipeline,
          outputDeliveryMode: normalizePipelineOutputDeliveryMode(
            (pipeline as JsonRecord).outputDeliveryMode,
          ),
          nodePositions: normalizePipelineNodePositions((pipeline as JsonRecord).nodePositions),
          ...(viewport !== undefined ? { viewport } : {}),
        };
      })
    : [];
  store.pipelineRuns = Array.isArray(store.pipelineRuns)
    ? store.pipelineRuns
        .map((run) => {
          if (!isJsonRecord(run)) {
            return null;
          }
          const steps = Array.isArray(run.steps)
            ? run.steps
                .map((step) =>
                  isJsonRecord(step)
                    ? {
                        stepId: normalizeOptionalString(step.stepId) || "",
                        stepName: normalizeOptionalString(step.stepName) || "",
                        agentId: normalizeOptionalString(step.agentId) || undefined,
                        sessionKey: normalizeOptionalString(step.sessionKey) || "",
                        runId: normalizeOptionalString(step.runId) || "",
                        status: normalizeOptionalString(step.status) || "unknown",
                        output: normalizeOptionalString(step.output) || "",
                      }
                    : null,
                )
                .filter((step): step is PipelineRunRecord["steps"][number] => Boolean(step))
            : [];
          const deliveries = Array.isArray(run.deliveries)
            ? run.deliveries
                .map((delivery) =>
                  isJsonRecord(delivery)
                    ? {
                        channelId: normalizeOptionalString(delivery.channelId) || "",
                        channel: normalizeOptionalString(delivery.channel) || "",
                        accountId: normalizeOptionalString(delivery.accountId) || undefined,
                        to: normalizeOptionalString(delivery.to) || "",
                        messageId: normalizeOptionalString(delivery.messageId) || undefined,
                        chatId: normalizeOptionalString(delivery.chatId) || undefined,
                        scope:
                          normalizeOptionalString(delivery.scope) === "step" ? "step" : "final",
                        stepId: normalizeOptionalString(delivery.stepId) || undefined,
                        stepName: normalizeOptionalString(delivery.stepName) || undefined,
                        status:
                          normalizeOptionalString(delivery.status) === "sent" ? "sent" : "skipped",
                        reason: normalizeOptionalString(delivery.reason) || undefined,
                      }
                    : null,
                )
                .filter((delivery): delivery is PipelineRunRecord["deliveries"][number] =>
                  Boolean(delivery),
                )
            : [];
          const logs = Array.isArray(run.logs)
            ? run.logs
                .map((entry) =>
                  isJsonRecord(entry)
                    ? {
                        timestamp: normalizeOptionalString(entry.timestamp) || now,
                        level:
                          normalizeOptionalString(entry.level) === "error"
                            ? "error"
                            : normalizeOptionalString(entry.level) === "success"
                              ? "success"
                              : "info",
                        stepId: normalizeOptionalString(entry.stepId) || undefined,
                        stepName: normalizeOptionalString(entry.stepName) || undefined,
                        message: normalizeOptionalString(entry.message) || "",
                      }
                    : null,
                )
                .filter((entry): entry is PipelineRunRecord["logs"][number] => Boolean(entry))
            : [];
          return {
            id: normalizeOptionalString(run.id) || randomUUID(),
            pipelineId: normalizeOptionalString(run.pipelineId) || "",
            pipelineName: normalizeOptionalString(run.pipelineName) || "",
            outputDeliveryMode: normalizePipelineOutputDeliveryMode(
              normalizeOptionalString(run.outputDeliveryMode),
            ),
            startedAt: normalizeOptionalString(run.startedAt) || now,
            completedAt: normalizeOptionalString(run.completedAt) || undefined,
            input: normalizeOptionalString(run.input) || undefined,
            status:
              normalizeOptionalString(run.status) === "running"
                ? "running"
                : normalizeOptionalString(run.status) === "failed"
                  ? "failed"
                  : "done",
            finalOutput: normalizeOptionalString(run.finalOutput) || "",
            finalSessionKey: normalizeOptionalString(run.finalSessionKey) || undefined,
            error: normalizeOptionalString(run.error) || undefined,
            steps,
            deliveries,
            logs,
          } satisfies PipelineRunRecord;
        })
        .filter((run): run is PipelineRunRecord => Boolean(run))
        .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt) * -1)
        .slice(0, 150)
    : [];
  if (!Array.isArray(store.providerBridges)) {
    store.providerBridges = seedProviderBridges(now, cliproxyBootstrap);
  } else if (store.providerBridges.length === 0) {
    store.providerBridges = seedProviderBridges(now, cliproxyBootstrap);
  } else {
    store.providerBridges = store.providerBridges.map((bridge) => {
      const bootstrapFallback =
        cliproxyBootstrap &&
        (normalizeOptionalString((bridge as JsonRecord).id) === "cliproxyapi" ||
          normalizeOptionalString((bridge as JsonRecord).importedProviderId) === "cliproxyapi" ||
          normalizeOptionalString((bridge as JsonRecord).name)?.toLowerCase() === "cliproxyapi")
          ? {
              ...bridge,
              runtimeBaseUrl: cliproxyBootstrap.runtimeBaseUrl,
              consoleUrl: cliproxyBootstrap.consoleUrl,
              apiKey: cliproxyBootstrap.apiKey,
              managementKey: cliproxyBootstrap.managementKey,
            }
          : bridge;
      return normalizeProviderBridge(bridge, now, bootstrapFallback);
    });
  }
  const channelIds = new Set(store.channels.map((item) => item.id));
  for (const channel of discoveredChannels) {
    const existingIndex = store.channels.findIndex((item) => item.id === channel.id);
    if (existingIndex >= 0) {
      const existingChannel = store.channels[existingIndex];
      if (existingChannel.source === "detected") {
        store.channels[existingIndex] = {
          ...existingChannel,
          ...channel,
          accountId: channel.accountId || existingChannel.accountId,
          deliveryTarget: existingChannel.deliveryTarget,
          ownerId: existingChannel.ownerId,
          createdAt: existingChannel.createdAt,
          updatedAt: now,
        };
      }
      continue;
    }
    if (!channelIds.has(channel.id)) {
      store.channels.push({ ...channel, createdAt: now, updatedAt: now });
    }
  }

  const outputRouteChannelIds = new Set(
    store.channels
      .filter((channel) => isOutputRouteChannelRecord(channel))
      .map((channel) => channel.id),
  );

  const bindingIds = new Set(store.agentBindings.map((item) => item.agentId));
  const fallbackOwnerId = store.users[0]?.id;
  for (const agentId of discoveredAgentIds) {
    if (!bindingIds.has(agentId)) {
      store.agentBindings.push({
        id: agentId,
        agentId,
        ownerId: fallbackOwnerId,
        teamId: store.teams[0]?.id,
        purpose: `Pilotage de l'agent ${agentId}`,
        channelIds: Array.from(outputRouteChannelIds),
        defaultOutputChannelIds: [],
        providerIds: [],
        providerAccountIds: {},
        providerSkillPolicies: {},
        skillPolicy: "all",
        skillIds: [],
        tags: [],
        preferredModelRef: undefined,
        resumePolicy: "manual",
        dispatchPolicy: "manual",
        thinkingLevel: undefined,
        fastMode: undefined,
        verboseLevel: undefined,
        reasoningLevel: undefined,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  syncUserTeamMemberships(store);
  syncTeamScopes(store);
  syncProjectScopes(store);

  await saveStore(DEFAULT_STORE_PATH, store);
  return store;
}

function normalizeChannelDiscoveryFromSessions(sessions: JsonRecord[]) {
  const discovered = new Map<string, DashboardChannel>();
  for (const session of sessions) {
    const { channel: sessionChannel, target } = resolveSessionChannelAndTarget(session);
    const accountId = resolveSessionAccountId(session);
    const id = `detected-${slugify(`${sessionChannel}-${target}`)}`;
    if (discovered.has(id)) {
      continue;
    }
    const surfaceType = resolveDashboardChannelSurfaceType({
      id,
      kind: sessionChannel,
      target,
      accountId,
      source: "detected",
    });
    discovered.set(id, {
      id,
      name: `${sessionChannel}:${target}`,
      kind: sessionChannel,
      target,
      accountId,
      surfaceType,
      enabled: true,
      source: "detected",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  return Array.from(discovered.values());
}

function normalizeChannelDiscoveryFromRuntimeStatus(status: JsonRecord) {
  const discovered = new Map<string, DashboardChannel>();
  const channelAccounts = isJsonRecord(status.channelAccounts) ? status.channelAccounts : {};
  const channelLabels = isJsonRecord(status.channelLabels) ? status.channelLabels : {};
  const now = new Date().toISOString();

  for (const [channelId, rawAccounts] of Object.entries(channelAccounts)) {
    const label = stringifyUnknown(channelLabels[channelId], channelId);
    const accounts = normalizeChannelRuntimeAccounts(rawAccounts);
    for (const account of accounts) {
      const id = `${channelId}/${account.accountId}`;
      discovered.set(id, {
        id,
        name: account.name ? `${label}: ${account.name}` : `${label}: ${account.accountId}`,
        kind: channelId,
        target: account.name || account.accountId,
        accountId: account.accountId,
        surfaceType: isSystemChannelKind(channelId) ? "system" : "transport",
        enabled: account.enabled,
        source: "detected",
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  return Array.from(discovered.values());
}

function normalizeChannelDiscoveryFromConfig(config: JsonRecord) {
  const discovered = new Map<string, DashboardChannel>();
  const now = new Date().toISOString();
  for (const template of CHANNEL_SETUP_TEMPLATES) {
    const configuredAccounts = normalizeConfiguredChannelAccountsFromConfig(
      template,
      config,
    ).filter((account) => account.configured);
    for (const account of configuredAccounts) {
      const id = `${template.id}/${account.accountId}`;
      discovered.set(id, {
        id,
        name: account.name
          ? `${template.label}: ${account.name}`
          : `${template.label}: ${account.accountId}`,
        kind: template.id,
        target: account.name || account.accountId,
        accountId: account.accountId,
        surfaceType: isSystemChannelKind(template.id) ? "system" : "transport",
        enabled: account.enabled,
        source: "detected",
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  return Array.from(discovered.values());
}

function mergeDiscoveredChannels(...channelSets: DashboardChannel[][]) {
  const merged = new Map<string, DashboardChannel>();
  for (const channelSet of channelSets) {
    for (const channel of channelSet) {
      const previous = merged.get(channel.id);
      merged.set(channel.id, previous ? { ...previous, ...channel } : channel);
    }
  }
  return Array.from(merged.values());
}

function buildChannelCatalogEntries(
  status: JsonRecord,
  config?: JsonRecord | null,
): ChannelCatalogEntry[] {
  const channelMeta = isJsonRecord(status.channelMeta) ? status.channelMeta : {};
  const channelAccounts = isJsonRecord(status.channelAccounts) ? status.channelAccounts : {};
  const channelDefaultAccountId = isJsonRecord(status.channelDefaultAccountId)
    ? status.channelDefaultAccountId
    : {};

  return CHANNEL_SETUP_TEMPLATES.map((template) => {
    const installed = template.installPath ? isJsonRecord(channelMeta[template.id]) : true;
    const runtimeAccounts = normalizeChannelRuntimeAccounts(channelAccounts[template.id], {
      channelId: template.id,
      config: config || null,
    });
    const configAccounts = normalizeConfiguredChannelAccountsFromConfig(template, config || null);
    const accounts = mergeChannelRuntimeAccounts(runtimeAccounts, configAccounts);
    const configured = accounts.some(
      (account) => account.configured || account.linked || account.connected || account.running,
    );
    return {
      id: template.id,
      installed,
      configured,
      defaultAccountId:
        normalizeOptionalString(channelDefaultAccountId[template.id]) || accounts[0]?.accountId,
      template,
      accounts,
    };
  });
}

function parseChannelFieldValues(value: unknown) {
  if (!isJsonRecord(value)) {
    return {} as Record<string, string | boolean | number>;
  }
  const next: Record<string, string | boolean | number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "boolean" || typeof entry === "number") {
      next[key] = entry;
    }
  }
  return next;
}

function buildChannelConfigPatch(params: {
  template: ChannelSetupTemplateDefinition;
  accountId: string;
  name?: string;
  values: Record<string, string | boolean | number>;
  config: JsonRecord;
}) {
  const values = params.values;
  const name = normalizeOptionalString(params.name);
  const channelId = params.template.id;
  const accountId = normalizeAccountId(params.accountId);
  const useEnv = normalizeBoolean(values.useEnv) === true;

  const scoped = (patch: JsonRecord, options?: { clearFields?: string[] }) =>
    upsertScopedChannelConfig(params.config, channelId, accountId, patch, {
      clearFields: options?.clearFields,
      name,
      enabled: true,
    });

  const accountsOnly = (patch: JsonRecord, options?: { clearFields?: string[] }) =>
    upsertAccountsOnlyChannelConfig(params.config, channelId, accountId, patch, {
      clearFields: options?.clearFields,
      name,
      enabled: true,
    });

  const topLevel = (patch: JsonRecord, options?: { clearFields?: string[] }) =>
    upsertTopLevelChannelConfig(params.config, channelId, patch, {
      clearFields: options?.clearFields,
      enabled: true,
    });

  // Elytras later widens this to the real per-agent allowlist.
  // Safe default: a newly configured bot should not accept inbound DMs until
  // a dashboard-managed binding and user mapping exist.
  const elytrasManagedDmAccessPatch = {
    dmPolicy: "disabled",
    allowFrom: [],
  } satisfies JsonRecord;

  switch (channelId) {
    case "bluebubbles":
      return scoped({
        ...(normalizeOptionalString(values.httpUrl)
          ? { serverUrl: normalizeOptionalString(values.httpUrl) }
          : {}),
        ...(normalizeOptionalString(values.password)
          ? { password: normalizeOptionalString(values.password) }
          : {}),
        ...(normalizeOptionalString(values.webhookPath)
          ? { webhookPath: normalizeOptionalString(values.webhookPath) }
          : {}),
      });
    case "discord":
      return upsertAccountsOnlyChannelConfig(
        promoteLegacyScopedChannelSectionToDefaultAccount(params.config, channelId),
        channelId,
        accountId,
        {
          ...(useEnv
            ? {}
            : normalizeOptionalString(values.token)
              ? { token: normalizeOptionalString(values.token) }
              : {}),
          ...elytrasManagedDmAccessPatch,
        },
        {
          clearFields: useEnv ? ["token"] : [],
          name,
          enabled: true,
        },
      );
    case "feishu": {
      const patch: JsonRecord = {
        ...(normalizeOptionalString(values.appId)
          ? { appId: normalizeOptionalString(values.appId) }
          : {}),
        ...(normalizeOptionalString(values.appSecret)
          ? { appSecret: normalizeOptionalString(values.appSecret) }
          : {}),
        ...(normalizeOptionalString(values.connectionMode)
          ? { connectionMode: normalizeOptionalString(values.connectionMode) }
          : {}),
        ...(normalizeOptionalString(values.domain)
          ? { domain: normalizeOptionalString(values.domain) }
          : {}),
      };
      if (normalizeOptionalString(values.connectionMode) === "webhook") {
        if (normalizeOptionalString(values.verificationToken)) {
          patch.verificationToken = normalizeOptionalString(values.verificationToken);
        }
        if (normalizeOptionalString(values.encryptKey)) {
          patch.encryptKey = normalizeOptionalString(values.encryptKey);
        }
        if (normalizeOptionalString(values.webhookPath)) {
          patch.webhookPath = normalizeOptionalString(values.webhookPath);
        }
      }
      return topLevel(patch);
    }
    case "googlechat":
      return scoped(
        useEnv
          ? {
              ...(normalizeOptionalString(values.audienceType)
                ? { audienceType: normalizeOptionalString(values.audienceType) }
                : {}),
              ...(normalizeOptionalString(values.audience)
                ? { audience: normalizeOptionalString(values.audience) }
                : {}),
              ...(normalizeOptionalString(values.webhookPath)
                ? { webhookPath: normalizeOptionalString(values.webhookPath) }
                : {}),
              ...(normalizeOptionalString(values.webhookUrl)
                ? { webhookUrl: normalizeOptionalString(values.webhookUrl) }
                : {}),
            }
          : {
              ...(normalizeOptionalString(values.tokenFile)
                ? { serviceAccountFile: normalizeOptionalString(values.tokenFile) }
                : normalizeOptionalString(values.token)
                  ? { serviceAccount: normalizeOptionalString(values.token) }
                  : {}),
              ...(normalizeOptionalString(values.audienceType)
                ? { audienceType: normalizeOptionalString(values.audienceType) }
                : {}),
              ...(normalizeOptionalString(values.audience)
                ? { audience: normalizeOptionalString(values.audience) }
                : {}),
              ...(normalizeOptionalString(values.webhookPath)
                ? { webhookPath: normalizeOptionalString(values.webhookPath) }
                : {}),
              ...(normalizeOptionalString(values.webhookUrl)
                ? { webhookUrl: normalizeOptionalString(values.webhookUrl) }
                : {}),
            },
        { clearFields: useEnv ? ["serviceAccount", "serviceAccountFile"] : [] },
      );
    case "imessage":
      return upsertAccountsOnlyChannelConfig(
        promoteLegacyScopedChannelSectionToDefaultAccount(params.config, channelId),
        channelId,
        accountId,
        {
          ...(normalizeOptionalString(values.cliPath)
            ? { cliPath: normalizeOptionalString(values.cliPath) }
            : {}),
          ...(normalizeOptionalString(values.dbPath)
            ? { dbPath: normalizeOptionalString(values.dbPath) }
            : {}),
          ...(normalizeOptionalString(values.service)
            ? { service: normalizeOptionalString(values.service) }
            : {}),
          ...(normalizeOptionalString(values.region)
            ? { region: normalizeOptionalString(values.region) }
            : {}),
          ...(normalizeOptionalString(values.dmPolicy)
            ? { dmPolicy: normalizeOptionalString(values.dmPolicy) }
            : {}),
          ...(splitLineList(values.allowFrom).length
            ? { allowFrom: splitLineList(values.allowFrom) }
            : {}),
        },
        {
          name,
          enabled: true,
        },
      );
    case "irc":
      return scoped({
        ...(normalizeOptionalString(values.host)
          ? { host: normalizeOptionalString(values.host) }
          : {}),
        ...(normalizeNumber(values.port) !== undefined
          ? { port: normalizeNumber(values.port) }
          : {}),
        ...(normalizeBoolean(values.tls) !== undefined
          ? { tls: normalizeBoolean(values.tls) }
          : {}),
        ...(normalizeOptionalString(values.nick)
          ? { nick: normalizeOptionalString(values.nick) }
          : {}),
        ...(normalizeOptionalString(values.username)
          ? { username: normalizeOptionalString(values.username) }
          : {}),
        ...(normalizeOptionalString(values.realname)
          ? { realname: normalizeOptionalString(values.realname) }
          : {}),
        ...(normalizeOptionalString(values.password)
          ? { password: normalizeOptionalString(values.password) }
          : {}),
        ...(splitLineList(values.channels).length
          ? { channels: splitLineList(values.channels) }
          : {}),
      });
    case "line":
      return scoped({
        ...(normalizeOptionalString(values.token)
          ? { channelAccessToken: normalizeOptionalString(values.token) }
          : {}),
        ...(normalizeOptionalString(values.password)
          ? { channelSecret: normalizeOptionalString(values.password) }
          : {}),
      });
    case "matrix":
      return scoped({
        ...(normalizeOptionalString(values.homeserver)
          ? { homeserver: normalizeOptionalString(values.homeserver) }
          : {}),
        ...(normalizeBoolean(values.allowPrivateNetwork) !== undefined
          ? { allowPrivateNetwork: normalizeBoolean(values.allowPrivateNetwork) }
          : {}),
        ...(normalizeOptionalString(values.userId)
          ? { userId: normalizeOptionalString(values.userId) }
          : {}),
        ...(normalizeOptionalString(values.accessToken)
          ? { accessToken: normalizeOptionalString(values.accessToken) }
          : {}),
        ...(normalizeOptionalString(values.password)
          ? { password: normalizeOptionalString(values.password) }
          : {}),
        ...(normalizeOptionalString(values.deviceName)
          ? { deviceName: normalizeOptionalString(values.deviceName) }
          : {}),
        ...(normalizeNumber(values.initialSyncLimit) !== undefined
          ? { initialSyncLimit: normalizeNumber(values.initialSyncLimit) }
          : {}),
      });
    case "mattermost":
      return scoped({
        ...(normalizeOptionalString(values.httpUrl)
          ? { baseUrl: normalizeOptionalString(values.httpUrl) }
          : {}),
        ...(normalizeOptionalString(values.botToken)
          ? { botToken: normalizeOptionalString(values.botToken) }
          : {}),
      });
    case "msteams":
      return topLevel({
        ...(normalizeOptionalString(values.appId)
          ? { appId: normalizeOptionalString(values.appId) }
          : {}),
        ...(normalizeOptionalString(values.appPassword)
          ? { appPassword: normalizeOptionalString(values.appPassword) }
          : {}),
        ...(normalizeOptionalString(values.tenantId)
          ? { tenantId: normalizeOptionalString(values.tenantId) }
          : {}),
      });
    case "nextcloud-talk":
      return scoped({
        ...(normalizeOptionalString(values.baseUrl)
          ? { baseUrl: normalizeOptionalString(values.baseUrl) }
          : {}),
        ...(normalizeOptionalString(values.secret)
          ? { botSecret: normalizeOptionalString(values.secret) }
          : {}),
      });
    case "nostr":
      return scoped({
        ...(normalizeOptionalString(values.privateKey)
          ? { privateKey: normalizeOptionalString(values.privateKey) }
          : {}),
        ...(splitLineList(values.relayUrls).length
          ? { relayUrls: splitLineList(values.relayUrls).join(",") }
          : {}),
      });
    case "signal":
      return scoped({
        ...(normalizeOptionalString(values.signalNumber)
          ? { account: normalizeOptionalString(values.signalNumber) }
          : {}),
        ...(normalizeOptionalString(values.cliPath)
          ? { cliPath: normalizeOptionalString(values.cliPath) }
          : {}),
        ...(normalizeOptionalString(values.httpUrl)
          ? { httpUrl: normalizeOptionalString(values.httpUrl) }
          : {}),
        ...(normalizeOptionalString(values.httpHost)
          ? { httpHost: normalizeOptionalString(values.httpHost) }
          : {}),
        ...(normalizeNumber(values.httpPort) !== undefined
          ? { httpPort: normalizeNumber(values.httpPort) }
          : {}),
      });
    case "slack":
      return scoped(
        useEnv
          ? {}
          : {
              ...(normalizeOptionalString(values.botToken)
                ? { botToken: normalizeOptionalString(values.botToken) }
                : {}),
              ...(normalizeOptionalString(values.appToken)
                ? { appToken: normalizeOptionalString(values.appToken) }
                : {}),
            },
        { clearFields: useEnv ? ["botToken", "appToken"] : [] },
      );
    case "synology-chat":
      return scoped({
        ...(normalizeOptionalString(values.token)
          ? { token: normalizeOptionalString(values.token) }
          : {}),
        ...(normalizeOptionalString(values.url)
          ? { incomingUrl: normalizeOptionalString(values.url) }
          : {}),
        ...(normalizeOptionalString(values.webhookPath)
          ? { webhookPath: normalizeOptionalString(values.webhookPath) }
          : {}),
      });
    case "telegram":
      return upsertAccountsOnlyChannelConfig(
        promoteLegacyScopedChannelSectionToDefaultAccount(params.config, channelId),
        channelId,
        accountId,
        {
          ...(useEnv
            ? {}
            : normalizeOptionalString(values.tokenFile)
              ? { tokenFile: normalizeOptionalString(values.tokenFile) }
              : normalizeOptionalString(values.token)
                ? { botToken: normalizeOptionalString(values.token) }
                : {}),
          ...elytrasManagedDmAccessPatch,
        },
        {
          clearFields: useEnv ? ["botToken", "tokenFile"] : [],
          name,
          enabled: true,
        },
      );
    case "tlon":
      return scoped({
        ...(normalizeOptionalString(values.ship)
          ? { ship: normalizeOptionalString(values.ship) }
          : {}),
        ...(normalizeOptionalString(values.url)
          ? { url: normalizeOptionalString(values.url) }
          : {}),
        ...(normalizeOptionalString(values.code)
          ? { code: normalizeOptionalString(values.code) }
          : {}),
        ...(splitLineList(values.groupChannels).length
          ? { groupChannels: splitLineList(values.groupChannels) }
          : {}),
        ...(splitLineList(values.dmAllowlist).length
          ? { dmAllowlist: splitLineList(values.dmAllowlist) }
          : {}),
        ...(normalizeBoolean(values.autoDiscoverChannels) !== undefined
          ? { autoDiscoverChannels: normalizeBoolean(values.autoDiscoverChannels) }
          : {}),
      });
    case "twitch":
      return accountsOnly({
        ...(normalizeOptionalString(values.username)
          ? { username: normalizeOptionalString(values.username) }
          : {}),
        ...(normalizeOptionalString(values.accessToken)
          ? { accessToken: normalizeOptionalString(values.accessToken) }
          : {}),
        ...(normalizeOptionalString(values.clientId)
          ? { clientId: normalizeOptionalString(values.clientId) }
          : {}),
        ...(normalizeOptionalString(values.channel)
          ? { channel: normalizeOptionalString(values.channel) }
          : {}),
        ...(normalizeOptionalString(values.clientSecret)
          ? { clientSecret: normalizeOptionalString(values.clientSecret) }
          : {}),
        ...(normalizeOptionalString(values.refreshToken)
          ? { refreshToken: normalizeOptionalString(values.refreshToken) }
          : {}),
      });
    case "voice-call":
      return upsertPluginEntryConfig(params.config, "voice-call", {
        ...(normalizeOptionalString(values.provider)
          ? { provider: normalizeOptionalString(values.provider) }
          : {}),
        ...(normalizeOptionalString(values.fromNumber)
          ? { fromNumber: normalizeOptionalString(values.fromNumber) }
          : {}),
        ...(normalizeOptionalString(values.toNumber)
          ? { toNumber: normalizeOptionalString(values.toNumber) }
          : {}),
        ...(normalizeOptionalString(values.publicUrl)
          ? { publicUrl: normalizeOptionalString(values.publicUrl) }
          : {}),
        ...(normalizeNumber(values.servePort) !== undefined ||
        normalizeOptionalString(values.servePath)
          ? {
              serve: {
                ...(normalizeNumber(values.servePort) !== undefined
                  ? { port: normalizeNumber(values.servePort) }
                  : {}),
                ...(normalizeOptionalString(values.servePath)
                  ? { path: normalizeOptionalString(values.servePath) }
                  : {}),
              },
            }
          : {}),
        ...(normalizeOptionalString(values.twilioAccountSid) ||
        normalizeOptionalString(values.twilioAuthToken)
          ? {
              twilio: {
                ...(normalizeOptionalString(values.twilioAccountSid)
                  ? { accountSid: normalizeOptionalString(values.twilioAccountSid) }
                  : {}),
                ...(normalizeOptionalString(values.twilioAuthToken)
                  ? { authToken: normalizeOptionalString(values.twilioAuthToken) }
                  : {}),
              },
            }
          : {}),
        ...(normalizeOptionalString(values.telnyxApiKey) ||
        normalizeOptionalString(values.telnyxConnectionId) ||
        normalizeOptionalString(values.telnyxPublicKey)
          ? {
              telnyx: {
                ...(normalizeOptionalString(values.telnyxApiKey)
                  ? { apiKey: normalizeOptionalString(values.telnyxApiKey) }
                  : {}),
                ...(normalizeOptionalString(values.telnyxConnectionId)
                  ? { connectionId: normalizeOptionalString(values.telnyxConnectionId) }
                  : {}),
                ...(normalizeOptionalString(values.telnyxPublicKey)
                  ? { publicKey: normalizeOptionalString(values.telnyxPublicKey) }
                  : {}),
              },
            }
          : {}),
        ...(normalizeOptionalString(values.plivoAuthId) ||
        normalizeOptionalString(values.plivoAuthToken)
          ? {
              plivo: {
                ...(normalizeOptionalString(values.plivoAuthId)
                  ? { authId: normalizeOptionalString(values.plivoAuthId) }
                  : {}),
                ...(normalizeOptionalString(values.plivoAuthToken)
                  ? { authToken: normalizeOptionalString(values.plivoAuthToken) }
                  : {}),
              },
            }
          : {}),
      });
    case "whatsapp":
      return scoped({
        ...(normalizeOptionalString(values.authDir)
          ? { authDir: normalizeOptionalString(values.authDir) }
          : {}),
      });
    case "zalo": {
      const updateMode = normalizeOptionalString(values.updateMode);
      return scoped(
        useEnv
          ? {
              ...(updateMode ? { updateMode } : {}),
              ...(normalizeOptionalString(values.webhookUrl)
                ? { webhookUrl: normalizeOptionalString(values.webhookUrl) }
                : {}),
              ...(normalizeOptionalString(values.webhookSecret)
                ? { webhookSecret: normalizeOptionalString(values.webhookSecret) }
                : {}),
              ...(normalizeOptionalString(values.webhookPath)
                ? { webhookPath: normalizeOptionalString(values.webhookPath) }
                : {}),
            }
          : {
              ...(normalizeOptionalString(values.tokenFile)
                ? { tokenFile: normalizeOptionalString(values.tokenFile) }
                : normalizeOptionalString(values.token)
                  ? { botToken: normalizeOptionalString(values.token) }
                  : {}),
              ...(updateMode ? { updateMode } : {}),
              ...(normalizeOptionalString(values.webhookUrl)
                ? { webhookUrl: normalizeOptionalString(values.webhookUrl) }
                : {}),
              ...(normalizeOptionalString(values.webhookSecret)
                ? { webhookSecret: normalizeOptionalString(values.webhookSecret) }
                : {}),
              ...(normalizeOptionalString(values.webhookPath)
                ? { webhookPath: normalizeOptionalString(values.webhookPath) }
                : {}),
            },
        { clearFields: useEnv ? ["botToken", "tokenFile"] : [] },
      );
    }
    case "zalouser":
      return scoped({}, {});
    default:
      return params.config;
  }
}

function extractMessageText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (!entry || typeof entry !== "object") {
          return "";
        }
        const item = entry as JsonRecord;
        if (item.type === "text" && typeof item.text === "string") {
          return item.text;
        }
        if (item.type === "tool_result" || item.type === "tool_use") {
          return JSON.stringify(item);
        }
        if (typeof item.output === "string") {
          return item.output;
        }
        if (item.output) {
          return JSON.stringify(item.output);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
    return JSON.stringify(record);
  }
  return "";
}

function extractAttachmentFileName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutHash = trimmed.split("#")[0] ?? trimmed;
  const withoutQuery = withoutHash.split("?")[0] ?? withoutHash;
  try {
    const parsed = new URL(withoutQuery);
    const base = path.basename(parsed.pathname);
    return base ? decodeURIComponent(base) : undefined;
  } catch {
    const base = path.basename(withoutQuery);
    return base && base !== "." && base !== "/" ? base : undefined;
  }
}

function inferAttachmentKind(source: string): "image" | "audio" | "video" | "file" {
  const lower = source.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif)(?:$|[?#])/.test(lower)) {
    return "image";
  }
  if (/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)(?:$|[?#])/.test(lower)) {
    return "audio";
  }
  if (/\.(mp4|mov|m4v|webm|avi|mkv)(?:$|[?#])/.test(lower)) {
    return "video";
  }
  return "file";
}

function inferAttachmentKindFromMime(
  mimeType?: string,
): "image" | "audio" | "video" | "file" | undefined {
  const normalized = normalizeOptionalString(mimeType)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  return "file";
}

function resolveDashboardLocalMediaPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("data:")) {
    return undefined;
  }
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return undefined;
    }
  }
  return path.resolve(trimmed);
}

function buildDashboardLocalMediaHref(source: string) {
  const localPath = resolveDashboardLocalMediaPath(source);
  if (!localPath) {
    return undefined;
  }
  const search = new URLSearchParams({ path: localPath });
  return `/ct-api/media/local?${search.toString()}`;
}

function buildHistoryAttachment(params: { source: string; mimeType?: string; fileName?: string }) {
  const source = params.source.trim();
  if (!source) {
    return null;
  }
  const inferredKind = inferAttachmentKindFromMime(params.mimeType) || inferAttachmentKind(source);
  const href =
    /^https?:\/\//i.test(source) || source.startsWith("data:")
      ? source
      : buildDashboardLocalMediaHref(source);
  return {
    kind: inferredKind,
    mimeType: normalizeOptionalString(params.mimeType) || undefined,
    fileName:
      normalizeOptionalString(params.fileName) ||
      extractAttachmentFileName(source) ||
      `${inferredKind}-attachment`,
    href,
    source,
  };
}

type ParsedInboundMediaNoteLine =
  | { type: "summary" }
  | { type: "attachment"; source: string; mimeType?: string; fileName?: string };

function parseInboundMediaNoteLine(line: string): ParsedInboundMediaNoteLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[media attached")) {
    return null;
  }
  if (/^\[media attached: \d+ files\]$/i.test(trimmed)) {
    return { type: "summary" };
  }
  const match = /^\[media attached(?: \d+\/\d+)?: (.+)\]$/i.exec(trimmed);
  if (!match) {
    return null;
  }
  let descriptor = match[1]?.trim() || "";
  if (!descriptor) {
    return null;
  }
  let explicitSource: string | undefined;
  const separatorIndex = descriptor.lastIndexOf(" | ");
  if (separatorIndex >= 0) {
    explicitSource = descriptor.slice(separatorIndex + 3).trim() || undefined;
    descriptor = descriptor.slice(0, separatorIndex).trim();
  }
  let mimeType: string | undefined;
  const mimeMatch = /^(.*)\s+\(([a-z0-9.+-]+\/[a-z0-9.+-]+)\)$/i.exec(descriptor);
  if (mimeMatch) {
    descriptor = mimeMatch[1]?.trim() || descriptor;
    mimeType = mimeMatch[2]?.trim().toLowerCase() || undefined;
  }
  const source = explicitSource || descriptor;
  if (!source) {
    return null;
  }
  return {
    type: "attachment",
    source,
    mimeType,
    fileName: extractAttachmentFileName(descriptor) || extractAttachmentFileName(source),
  };
}

function stripInboundMediaNoteLines(text: string) {
  if (!text.includes("[media attached")) {
    return {
      text,
      attachments: [] as Array<{
        kind: "image" | "audio" | "video" | "file";
        mimeType?: string;
        fileName?: string;
        href?: string;
        source: string;
      }>,
    };
  }
  const remainingLines: string[] = [];
  const attachments: Array<{
    kind: "image" | "audio" | "video" | "file";
    mimeType?: string;
    fileName?: string;
    href?: string;
    source: string;
  }> = [];
  let foundAny = false;
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseInboundMediaNoteLine(line);
    if (!parsed) {
      remainingLines.push(line);
      continue;
    }
    foundAny = true;
    if (parsed.type !== "attachment") {
      continue;
    }
    const attachment = buildHistoryAttachment(parsed);
    if (attachment) {
      attachments.push(attachment);
    }
  }
  return {
    text: foundAny
      ? remainingLines
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim()
      : text,
    attachments,
  };
}

async function resolveDashboardLocalMediaFile(rawPath: string) {
  const candidatePath = resolveDashboardLocalMediaPath(rawPath);
  if (!candidatePath) {
    return { error: "invalid-path" as const };
  }
  const realPath = await fs.realpath(candidatePath).catch(() => null);
  if (!realPath) {
    return { error: "not-found" as const };
  }
  const runtimeEnv = buildRuntimeEnvStatusSync();
  const allowedRoots = Array.from(
    new Set(
      [
        ...getDefaultMediaLocalRoots(),
        runtimeEnv.effective.stateDir,
        runtimeEnv.effective.workspaceDir,
        path.join(runtimeEnv.effective.stateDir, "media"),
        path.join(runtimeEnv.effective.stateDir, "agents"),
        path.join(runtimeEnv.effective.stateDir, "workspace"),
        path.join(runtimeEnv.effective.stateDir, "sandboxes"),
        OPENCLAW_HOME_STATE_DIR,
        OPENCLAW_HOME_WORKSPACE_DIR,
        path.join(OPENCLAW_HOME_STATE_DIR, "media"),
        path.join(OPENCLAW_HOME_STATE_DIR, "agents"),
        path.join(OPENCLAW_HOME_STATE_DIR, "workspace"),
        path.join(OPENCLAW_HOME_STATE_DIR, "sandboxes"),
      ]
        .filter(Boolean)
        .map((root) => path.resolve(root)),
    ),
  );
  if (!allowedRoots.some((root) => isPathInside(root, realPath))) {
    return { error: "outside-root" as const };
  }
  const stat = await fs.stat(realPath).catch(() => null);
  if (!stat?.isFile()) {
    return { error: "not-found" as const };
  }
  if (stat.size > DASHBOARD_LOCAL_MEDIA_MAX_BYTES) {
    return { error: "too-large" as const, size: stat.size };
  }
  return { realPath, stat };
}

function normalizeHistoryMediaAttachments(text: string) {
  const parsed = splitMediaFromOutput(text || "");
  const outboundAttachments = (parsed.mediaUrls || [])
    .map((mediaUrl) => buildHistoryAttachment({ source: mediaUrl }))
    .filter((attachment): attachment is NonNullable<typeof attachment> => Boolean(attachment));
  const inboundMedia = stripInboundMediaNoteLines(parsed.text);
  return {
    text: inboundMedia.text,
    attachments: [...outboundAttachments, ...inboundMedia.attachments],
  };
}

function normalizeHistoryMessages(messages: unknown[]) {
  return messages.map((raw, index) => {
    const item = raw && typeof raw === "object" ? (raw as JsonRecord) : {};
    const message =
      item.message && typeof item.message === "object" ? (item.message as JsonRecord) : item;
    const contentEntries = Array.isArray(message.content)
      ? message.content
      : Array.isArray(item.content)
        ? item.content
        : [];
    const role =
      (typeof message.role === "string" && message.role) ||
      (typeof item.role === "string" && item.role) ||
      "other";
    const rawText = extractMessageText(
      message.content ?? item.content ?? message.text ?? item.text,
    );
    const stopReason =
      normalizeOptionalString(message.stopReason) || normalizeOptionalString(item.stopReason);
    const runtimeError =
      normalizeOptionalString(message.errorMessage) || normalizeOptionalString(item.errorMessage);
    const baseText =
      rawText || (stopReason === "error" && runtimeError ? `[error] ${runtimeError}` : rawText);
    const parsedMedia = normalizeHistoryMediaAttachments(baseText || "");
    return {
      id:
        (typeof item.id === "string" && item.id) ||
        (typeof message.id === "string" && message.id) ||
        `message-${index}`,
      role,
      text: parsedMedia.text || (baseText.startsWith("[error]") ? baseText : ""),
      provider: typeof message.provider === "string" ? message.provider : undefined,
      model: typeof message.model === "string" ? message.model : undefined,
      timestamp:
        (typeof message.timestamp === "number" && message.timestamp) ||
        (typeof item.timestamp === "number" && item.timestamp) ||
        null,
      usage:
        message.usage && typeof message.usage === "object"
          ? (message.usage as JsonRecord)
          : undefined,
      attachments: [
        ...contentEntries
          .map((entry, attachmentIndex) => {
            if (!entry || typeof entry !== "object") {
              return null;
            }
            const record = entry as JsonRecord;
            if (normalizeOptionalString(record.type) !== "image") {
              return null;
            }
            const source =
              record.source && typeof record.source === "object"
                ? (record.source as JsonRecord)
                : null;
            if (!source || normalizeOptionalString(source.type) !== "base64") {
              return null;
            }
            const base64 = normalizeOptionalString(source.data);
            if (!base64) {
              return null;
            }
            const mimeType = normalizeOptionalString(source.media_type) || "image/png";
            const dataUrl = `data:${mimeType};base64,${base64}`;
            return {
              kind: "image" as const,
              mimeType,
              fileName: normalizeOptionalString(record.fileName) || `image-${attachmentIndex + 1}`,
              dataUrl,
              href: dataUrl,
              source: dataUrl,
            };
          })
          .filter((attachment): attachment is NonNullable<typeof attachment> =>
            Boolean(attachment),
          ),
        ...parsedMedia.attachments,
      ],
    };
  });
}

function normalizeOptionalRouteValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return normalizeOptionalString(value);
}

function sanitizeRelayAttachmentFileName(value: string | undefined, index: number): string {
  const fallback = `attachment-${index + 1}.bin`;
  const normalized = path.basename((value || "").trim()) || fallback;
  const sanitized = normalized.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}

async function persistDashboardRelayAttachments(params: {
  sessionKey: string;
  attachments: Array<{
    type?: string;
    mimeType?: string;
    fileName?: string;
    content?: unknown;
  }>;
}): Promise<string[]> {
  if (params.attachments.length === 0) {
    return [];
  }
  const runtimeEnv = buildRuntimeEnvStatusSync();
  const relayDir = path.join(
    runtimeEnv.effective.stateDir,
    "media",
    "elytras-relay",
    slugify(params.sessionKey) || "session",
  );
  await fs.mkdir(relayDir, { recursive: true });
  const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(params.attachments);
  const mediaUrls: string[] = [];
  for (const [index, attachment] of normalizedAttachments.entries()) {
    if (typeof attachment.content !== "string" || !attachment.content.trim()) {
      continue;
    }
    const targetPath = path.join(
      relayDir,
      `${Date.now()}-${randomUUID()}-${sanitizeRelayAttachmentFileName(attachment.fileName, index)}`,
    );
    await fs.writeFile(targetPath, Buffer.from(attachment.content, "base64"));
    mediaUrls.push(targetPath);
  }
  return mediaUrls;
}

function resolveDashboardRelayRoute(
  snapshot: Awaited<ReturnType<typeof buildDashboardSnapshot>>,
  sessionKey: string,
) {
  const session = Array.isArray(snapshot.sessions)
    ? (snapshot.sessions as JsonRecord[]).find(
        (entry) => normalizeOptionalString(entry.key)?.toLowerCase() === sessionKey.toLowerCase(),
      )
    : undefined;
  if (!session) {
    throw new Error(`Session introuvable pour relai: ${sessionKey}`);
  }
  const deliveryContext = isJsonRecord(session.deliveryContext) ? session.deliveryContext : {};
  const origin = isJsonRecord(session.origin) ? session.origin : {};
  const channel =
    normalizeOptionalString(deliveryContext.channel) ||
    normalizeOptionalString(session.lastChannel) ||
    normalizeOptionalString(origin.provider) ||
    normalizeOptionalString(session.channel);
  const to =
    normalizeOptionalString(deliveryContext.to) ||
    normalizeOptionalString(session.lastTo) ||
    normalizeOptionalString(origin.to);
  const accountId =
    normalizeOptionalString(deliveryContext.accountId) ||
    normalizeOptionalString(session.lastAccountId) ||
    normalizeOptionalString(origin.accountId);
  const threadId =
    normalizeOptionalRouteValue(deliveryContext.threadId) ||
    normalizeOptionalRouteValue((session as JsonRecord).lastThreadId) ||
    normalizeOptionalRouteValue(origin.threadId);
  if (!channel || channel === "internal" || channel === "webchat" || channel === "heartbeat") {
    throw new Error(`Session ${sessionKey} n'a pas de route bot relayable.`);
  }
  if (!to) {
    throw new Error(`Session ${sessionKey} n'a pas de destinataire relayable.`);
  }
  return {
    channel,
    to,
    accountId,
    threadId,
  };
}

function readNumericValue(record: JsonRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function normalizeRuntimeModelRef(value: unknown) {
  const raw = normalizeOptionalString(value);
  return raw || undefined;
}

function extractRuntimeDefaults(config: JsonRecord) {
  const agentsConfig = isJsonRecord(config.agents) ? config.agents : {};
  const defaults = isJsonRecord(agentsConfig.defaults) ? agentsConfig.defaults : {};
  const modelValue = defaults.model;

  if (typeof modelValue === "string") {
    return {
      agentPrimaryModelRef: modelValue,
      agentFallbackModelRefs: [] as string[],
    };
  }

  if (isJsonRecord(modelValue)) {
    const primary = normalizeRuntimeModelRef(modelValue.primary);
    const fallbacks = Array.isArray(modelValue.fallbacks)
      ? (modelValue.fallbacks
          .map((entry) => normalizeRuntimeModelRef(entry))
          .filter(Boolean) as string[])
      : [];
    return {
      agentPrimaryModelRef: primary,
      agentFallbackModelRefs: fallbacks,
    };
  }

  return {
    agentPrimaryModelRef: undefined,
    agentFallbackModelRefs: [] as string[],
  };
}

function extractConfiguredAgents(config: JsonRecord): JsonRecord[] {
  const agentsConfig = isJsonRecord(config.agents) ? config.agents : null;
  const configuredList = Array.isArray(agentsConfig?.list) ? (agentsConfig.list as unknown[]) : [];
  return configuredList
    .filter(isJsonRecord)
    .map((agent) => {
      const id = normalizeOptionalString(agent.id);
      if (!id) {
        return null;
      }
      const workspace = normalizeOptionalString(agent.workspace);
      const name =
        normalizeOptionalString(agent.name) || normalizeOptionalString(agent.label) || id;
      const model =
        normalizeOptionalString(agent.model) ||
        normalizeOptionalString(
          isJsonRecord(agent.modelDefaults) ? agent.modelDefaults.primary : undefined,
        );
      return {
        id,
        name,
        workspace,
        model,
      } satisfies JsonRecord;
    })
    .filter((agent): agent is JsonRecord => Boolean(agent));
}

function extractActiveProviderIds(config: JsonRecord) {
  const modelsConfig = isJsonRecord(config.models) ? config.models : {};
  const providerConfig = isJsonRecord(modelsConfig.providers) ? modelsConfig.providers : {};
  const modelProviderIds = Object.keys(providerConfig);
  if (modelProviderIds.length > 0) {
    return new Set(modelProviderIds);
  }

  const legacyProviders = isJsonRecord(config.providers) ? config.providers : {};
  return new Set(Object.keys(legacyProviders));
}

function createOverview(params: {
  agents: JsonRecord[];
  sessions: JsonRecord[];
  cronJobs: JsonRecord[];
  pipelines: PipelineRecord[];
  files: JsonRecord[];
  memories: JsonRecord[];
}) {
  return {
    agentCount: params.agents.length,
    runningAgents: params.sessions.filter(
      (session) => inferSessionActivityStatus(session) === "running",
    ).length,
    sessionCount: params.sessions.length,
    runningSessions: params.sessions.filter(
      (session) => inferSessionActivityStatus(session) === "running",
    ).length,
    pipelineCount: params.pipelines.length,
    activePipelines: params.pipelines.filter((entry) => entry.status === "running").length,
    cronCount: params.cronJobs.length,
    activeCronJobs: params.cronJobs.filter((entry) => inferCronStatus(entry) === "running").length,
    fileCount: params.files.length,
    memorySurfaceCount: params.memories.length,
  };
}

function filterDashboardSnapshotForActor(
  req: IncomingMessage,
  store: ControlTowerStore,
  snapshot: {
    ok: boolean;
    meta: JsonRecord;
    overview: JsonRecord;
    agents: JsonRecord[];
    sessions: JsonRecord[];
    files: JsonRecord[];
    memories: JsonRecord[];
    workspaces: JsonRecord[];
    cronJobs: JsonRecord[];
    pipelines: PipelineRecord[];
    users: DashboardUser[];
    teams: DashboardTeam[];
    projects: DashboardProject[];
    channels: DashboardChannel[];
    grants: AccessGrant[];
    agentBindings: AgentBinding[];
    providerBridges: ProviderBridge[];
    providers: JsonRecord[];
    runtimeModels: JsonRecord[];
    runtimeDefaults: JsonRecord;
    skills: JsonRecord;
  },
) {
  const actor = resolveDashboardActorContext(req, store);
  if (actor.currentUserCanManageAdminViews) {
    return snapshot;
  }
  const agents = snapshot.agents.filter((agent) =>
    actor.canViewAgentRecord(normalizeOptionalString(agent.id) || ""),
  );
  const agentIdSet = new Set(
    agents
      .map((agent) => normalizeOptionalString(agent.id))
      .filter((entry): entry is string => Boolean(entry)),
  );
  const teams = snapshot.teams.filter((team) => actor.selectedTeamIdSet.has(team.id));
  const projects = snapshot.projects.filter((project) => {
    if (!actor.user) {
      return true;
    }
    if (!actor.selectedTeamIdSet.has(project.teamId)) {
      return false;
    }
    return project.memberIds.length === 0 || project.memberIds.includes(actor.user.id);
  });
  const channels = snapshot.channels.filter(
    (channel) =>
      isManagedDestinationChannelRecord(channel) && actor.canViewChannelRoute(channel.id),
  );
  const pipelines = snapshot.pipelines.filter((pipeline) => actor.canViewPipelineRecord(pipeline));
  const cronJobs = snapshot.cronJobs.filter((job) => actor.canViewCronJobRecord(job));
  const sessions = snapshot.sessions.filter(
    (session) =>
      actor.canViewSessionRecord({
        key: normalizeOptionalString(session.key) || undefined,
        agentId: normalizeOptionalString(session.agentId) || undefined,
        pipelineId: normalizeOptionalString(session.pipelineId) || undefined,
      }) &&
      session.sessionKind !== "heartbeat" &&
      session.sessionKind !== "internal",
  );
  const files = snapshot.files.filter((file) =>
    agentIdSet.has(normalizeOptionalString(file.agentId) || ""),
  );
  const memories = snapshot.memories.filter((memory) =>
    agentIdSet.has(normalizeOptionalString(memory.agentId) || ""),
  );
  const workspaces = snapshot.workspaces.filter((workspace) =>
    agentIdSet.has(normalizeOptionalString(workspace.agentId) || ""),
  );
  const grants = snapshot.grants.filter(
    (grant) =>
      (grant.subjectType === "user" && actor.user?.id === grant.subjectId) ||
      (grant.subjectType === "team" && actor.selectedTeamIdSet.has(grant.subjectId)),
  );
  const agentBindings = snapshot.agentBindings.filter((binding) => agentIdSet.has(binding.agentId));

  return {
    ...snapshot,
    overview: createOverview({
      agents,
      sessions,
      cronJobs: cronJobs as JsonRecord[],
      pipelines,
      files,
      memories,
    }),
    agents,
    sessions,
    files,
    memories,
    workspaces,
    cronJobs,
    pipelines,
    users: actor.user ? [actor.user] : [],
    teams,
    projects,
    channels,
    grants,
    agentBindings,
    providerBridges: [],
    skills: [],
  };
}

async function buildDashboardSnapshot(req: IncomingMessage) {
  const runtimeEnv = buildRuntimeEnvStatusSync();
  const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
  const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
  const storeForConfigSync = await loadStore([], []);
  let { bridge: syncedCliproxyBridge, changed: cliproxyBridgeChanged } =
    await syncCliproxyBridgeInStore(storeForConfigSync);
  if (syncedCliproxyBridge?.activeModelIds.length) {
    const reconciled = await reconcileCliproxyOnlyGatewayConfig(
      gatewayUrl,
      gatewayToken,
      syncedCliproxyBridge,
    ).catch(() => false);
    const cliproxyBridgeIndex = storeForConfigSync.providerBridges.findIndex((entry) =>
      isCliproxyBridge(entry),
    );
    if (cliproxyBridgeIndex >= 0) {
      const currentBridge = storeForConfigSync.providerBridges[cliproxyBridgeIndex]!;
      if (
        reconciled ||
        (currentBridge.activeModelIds.length > 0 &&
          normalizeOptionalString(currentBridge.importedProviderId) !== DASHBOARD_PROVIDER_ID)
      ) {
        const now = new Date().toISOString();
        syncedCliproxyBridge = normalizeProviderBridge(
          {
            ...currentBridge,
            importedProviderId: DASHBOARD_PROVIDER_ID,
            status: "imported",
            lastImportAt: currentBridge.lastImportAt || now,
            updatedAt: now,
          },
          now,
          currentBridge,
        );
        storeForConfigSync.providerBridges[cliproxyBridgeIndex] = syncedCliproxyBridge;
        cliproxyBridgeChanged = true;
      }
    }
  }
  if (cliproxyBridgeChanged) {
    await saveStore(DEFAULT_STORE_PATH, storeForConfigSync);
  }
  void syncedCliproxyBridge;
  const { snapshot, results } = await gatewayBatchWithRestartRetry(gatewayUrl, gatewayToken, {
    agents: { method: "agents.list", params: {} },
    sessions: {
      method: "sessions.list",
      params: {
        includeDerivedTitles: true,
        includeLastMessage: true,
        includeGlobal: true,
        includeUnknown: true,
        limit: 200,
      },
    },
    cron: { method: "cron.list", params: { includeDisabled: true, limit: 200 } },
    channels: { method: "channels.status", params: { probe: false } },
    models: { method: "models.list", params: {} },
    config: { method: "config.get", params: {} },
  });

  const agentsResult = (results.agents as JsonRecord | undefined) || {};
  const sessionsResult = (results.sessions as JsonRecord | undefined) || {};
  const cronResult = (results.cron as JsonRecord | undefined) || {};
  const channelsResult = (results.channels as JsonRecord | undefined) || {};
  const modelsResult = (results.models as JsonRecord | undefined) || {};
  const configResult = (results.config as JsonRecord | undefined) || {};

  const runtimeAgents = Array.isArray(agentsResult.agents)
    ? (agentsResult.agents as JsonRecord[])
    : [];
  const sessions = Array.isArray(sessionsResult.sessions)
    ? (sessionsResult.sessions as JsonRecord[])
    : [];
  const persistedSessions = await loadPersistedSessionCatalog(runtimeEnv.effective.stateDir);
  const mergedSessionsByKey = new Map<string, JsonRecord>();
  for (const session of persistedSessions) {
    const key = normalizeOptionalString(session.key);
    if (!key) {
      continue;
    }
    mergedSessionsByKey.set(key, session);
  }
  for (const session of sessions) {
    const key = normalizeOptionalString(session.key);
    if (!key) {
      continue;
    }
    const persisted = mergedSessionsByKey.get(key);
    mergedSessionsByKey.set(key, persisted ? { ...persisted, ...session, key } : session);
  }
  const mergedSessions = Array.from(mergedSessionsByKey.values()).toSorted((left, right) => {
    const leftUpdatedAt = typeof left.updatedAt === "number" ? left.updatedAt : 0;
    const rightUpdatedAt = typeof right.updatedAt === "number" ? right.updatedAt : 0;
    if (rightUpdatedAt !== leftUpdatedAt) {
      return rightUpdatedAt - leftUpdatedAt;
    }
    return stringifyUnknown(left.key).localeCompare(stringifyUnknown(right.key));
  });
  const nativeCronJobs = Array.isArray(cronResult.jobs) ? (cronResult.jobs as JsonRecord[]) : [];
  const models = Array.isArray(modelsResult.models) ? (modelsResult.models as JsonRecord[]) : [];
  const config = isJsonRecord(configResult.config) ? configResult.config : {};
  const runtimeDefaults = extractRuntimeDefaults(config);
  const configuredAgents = extractConfiguredAgents(config);
  const agentMap = new Map<string, JsonRecord>();
  for (const agent of configuredAgents) {
    const agentId = stringifyUnknown(agent.id);
    if (!agentId) {
      continue;
    }
    agentMap.set(agentId, { ...agent });
  }
  for (const agent of runtimeAgents) {
    const agentId = stringifyUnknown(agent.id);
    if (!agentId) {
      continue;
    }
    const configured = agentMap.get(agentId);
    agentMap.set(agentId, configured ? { ...configured, ...agent, id: agentId } : agent);
  }
  const agents = Array.from(agentMap.values());

  const fileBatchCalls = Object.fromEntries(
    agents.map((agent) => {
      const agentId = stringifyUnknown(agent.id, "main");
      return [agentId, { method: "agents.files.list", params: { agentId } }];
    }),
  );
  const filesBatch = await gatewayBatch(gatewayUrl, gatewayToken, fileBatchCalls);
  const workspaceFiles: JsonRecord[] = [];
  const workspaces: JsonRecord[] = [];
  const memories: JsonRecord[] = [];

  for (const [agentId, result] of Object.entries(filesBatch.results)) {
    const payload = (result as JsonRecord | undefined) || {};
    const workspace = stringifyUnknown(
      payload.workspace,
      path.join(runtimeEnv.effective.workspaceDir, agentId),
    );
    const gatewayFiles = Array.isArray(payload.files) ? (payload.files as JsonRecord[]) : [];
    const overlayFiles = await listWorkspaceMarkdownFiles(workspace);
    const mergedFiles = new Map<string, JsonRecord>();
    for (const file of gatewayFiles) {
      const name = stringifyUnknown(file.name);
      if (!name) {
        continue;
      }
      mergedFiles.set(name, file);
    }
    for (const file of overlayFiles) {
      const existing = mergedFiles.get(file.name);
      mergedFiles.set(file.name, {
        ...(existing || {}),
        ...file,
      });
    }
    const files = Array.from(mergedFiles.values()).toSorted((left, right) =>
      stringifyUnknown(left.name).localeCompare(stringifyUnknown(right.name)),
    );
    const workspaceState = await readWorkspaceState(workspace);
    workspaces.push({
      agentId,
      path: workspace,
      fileCount: files.length,
      memoryFileCount: files.filter((entry) =>
        isMemoryWorkspaceSurface(stringifyUnknown(entry.name)),
      ).length,
      state: workspaceState,
    });

    for (const file of files) {
      const name = stringifyUnknown(file.name);
      const normalized = {
        agentId,
        workspace,
        name,
        path: stringifyUnknown(file.path, path.join(workspace, name)),
        missing: Boolean(file.missing),
        size: typeof file.size === "number" ? file.size : 0,
        updatedAtMs: typeof file.updatedAtMs === "number" ? file.updatedAtMs : 0,
        extension: path.extname(name).replace(/^\./, "") || "file",
        type: isMemoryWorkspaceSurface(name) ? "memory" : "workspace",
      };
      workspaceFiles.push(normalized);
      if (isMemoryWorkspaceSurface(name)) {
        memories.push(normalized);
      }
    }
  }

  const discoveredChannels = mergeDiscoveredChannels(
    normalizeChannelDiscoveryFromRuntimeStatus(channelsResult),
    normalizeChannelDiscoveryFromSessions(mergedSessions),
    normalizeChannelDiscoveryFromConfig(config),
  );
  const store = await loadStore(
    agents.map((agent) => stringifyUnknown(agent.id, "main")),
    discoveredChannels,
  );
  const nativeInboundBindings = loadOpenClawInboundRouteBindingsSync(
    runtimeEnv.effective.configPath,
  );
  const skills = await loadSessionSkillCatalog(runtimeEnv.effective.stateDir);
  const allSkillIds = skills.map((skill) => skill.name);
  const activeProviderIds = new Set<string>([DASHBOARD_PROVIDER_ID]);
  const activeProviderIdList = [DASHBOARD_PROVIDER_ID];
  const outputRouteChannelIds = new Set(
    store.channels
      .filter((channel) => isOutputRouteChannelRecord(channel))
      .map((channel) => channel.id),
  );

  const providerMap = new Map<string, { provider: string; count: number; models: string[] }>();
  const runtimeModelMap = new Map<
    string,
    {
      ref: string;
      provider: string;
      modelId: string;
      label: string;
      contextWindow?: number;
      maxTokens?: number;
    }
  >();
  for (const model of models) {
    const provider = stringifyUnknown(model.provider, "unknown");
    if (provider !== DASHBOARD_PROVIDER_ID) {
      continue;
    }
    const modelId = stringifyUnknown(model.id, stringifyUnknown(model.name, "unknown"));
    const entry = providerMap.get(provider) || { provider, count: 0, models: [] };
    entry.count += 1;
    if (entry.models.length < 8) {
      entry.models.push(modelId);
    }
    providerMap.set(provider, entry);

    const ref = `${provider}/${modelId}`;
    if (!runtimeModelMap.has(ref)) {
      runtimeModelMap.set(ref, {
        ref,
        provider,
        modelId,
        label: `${provider} / ${modelId}`,
        contextWindow: readNumericValue(model, "contextWindow", "context_window"),
        maxTokens: readNumericValue(model, "maxTokens", "max_tokens"),
      });
    }
  }

  const agentBindings = store.agentBindings.map((binding) => ({
    ...binding,
    channelIds: Array.isArray((binding as JsonRecord).channelIds)
      ? Array.from(
          new Set(
            ((binding as JsonRecord).channelIds as unknown[])
              .filter(
                (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
              )
              .filter((entry) => outputRouteChannelIds.has(entry)),
          ),
        )
      : Array.from(outputRouteChannelIds),
    defaultOutputChannelIds: Array.isArray((binding as JsonRecord).defaultOutputChannelIds)
      ? Array.from(
          new Set(
            ((binding as JsonRecord).defaultOutputChannelIds as unknown[])
              .filter(
                (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
              )
              .filter((entry) => outputRouteChannelIds.has(entry)),
          ),
        )
      : [],
    providerIds: (() => {
      const candidateIds = Array.isArray((binding as JsonRecord).providerIds)
        ? Array.from(
            new Set(
              ((binding as JsonRecord).providerIds as unknown[])
                .filter(
                  (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
                )
                .filter((entry) => activeProviderIds.has(entry)),
            ),
          )
        : [];
      return candidateIds.length > 0 ? candidateIds : activeProviderIdList;
    })(),
    providerAccountIds: (() => {
      const selectedProviderIds = Array.isArray((binding as JsonRecord).providerIds)
        ? normalizeIdList((binding as JsonRecord).providerIds)
        : activeProviderIdList;
      const next = normalizeProviderAccountIds((binding as JsonRecord).providerAccountIds);
      return Object.fromEntries(
        Object.entries(next).filter(([providerId, accountIds]) => {
          return selectedProviderIds.includes(providerId) && accountIds.length > 0;
        }),
      );
    })(),
    providerSkillPolicies: normalizeProviderSkillPolicies(
      (binding as JsonRecord).providerSkillPolicies,
    ),
    skillIds: Array.isArray((binding as JsonRecord).skillIds)
      ? ((binding as JsonRecord).skillIds as unknown[]).filter(
          (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
        )
      : [],
    skillPolicy: normalizeSkillPolicy(
      (binding as JsonRecord).skillPolicy,
      Array.isArray((binding as JsonRecord).skillIds)
        ? ((binding as JsonRecord).skillIds as unknown[]).filter(
            (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
          )
        : [],
    ),
    thinkingLevel: normalizeOptionalString((binding as JsonRecord).thinkingLevel),
    fastMode:
      typeof (binding as JsonRecord).fastMode === "boolean"
        ? Boolean((binding as JsonRecord).fastMode)
        : undefined,
    resumePolicy: normalizeResumePolicy((binding as JsonRecord).resumePolicy),
    dispatchPolicy: normalizeDispatchPolicy((binding as JsonRecord).dispatchPolicy),
    verboseLevel: normalizeOptionalString((binding as JsonRecord).verboseLevel),
    reasoningLevel: normalizeOptionalString((binding as JsonRecord).reasoningLevel),
  }));
  const users = store.users;
  const teams = store.teams;
  const projects = store.projects;
  const channels = applyOpenClawInboundBindings(store.channels, nativeInboundBindings);
  const pipelines = store.pipelines.map((pipeline) => {
    const { recurrence: _ignoredRecurrence, ...normalizedPipeline } = pipeline as JsonRecord &
      PipelineRecord & { recurrence?: unknown };
    return {
      ...normalizedPipeline,
      outputTargets: normalizeIdList((pipeline as JsonRecord).outputTargets).filter((entry) =>
        outputRouteChannelIds.has(entry),
      ),
      outputDeliveryMode: normalizePipelineOutputDeliveryMode(
        (pipeline as JsonRecord).outputDeliveryMode,
      ),
      steps: pipeline.steps.map((step) => ({
        ...step,
        output: normalizeIdList((step as JsonRecord).output)
          .filter((entry) => outputRouteChannelIds.has(entry))
          .join(","),
        prompt: normalizeOptionalString((step as JsonRecord).prompt),
        nextStepIds: Array.isArray((step as JsonRecord).nextStepIds)
          ? ((step as JsonRecord).nextStepIds as unknown[]).filter(
              (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
            )
          : [],
        routingMode: normalizePipelineRoutingMode((step as JsonRecord).routingMode),
        condition: normalizeOptionalString((step as JsonRecord).condition),
        modelRef: normalizeOptionalString((step as JsonRecord).modelRef),
        thinkingLevel: normalizeOptionalString((step as JsonRecord).thinkingLevel),
        fastMode:
          typeof (step as JsonRecord).fastMode === "boolean"
            ? Boolean((step as JsonRecord).fastMode)
            : undefined,
        verboseLevel: normalizeOptionalString((step as JsonRecord).verboseLevel),
        reasoningLevel: normalizeOptionalString((step as JsonRecord).reasoningLevel),
      })),
    };
  });
  const normalizedCronJobs = store.cronJobs.map((job) => ({
    ...job,
    targetType: resolveCustomCronTargetType(job as JsonRecord),
    schedule: normalizeOptionalString((job as JsonRecord).schedule),
    input: normalizeOptionalString((job as JsonRecord).input),
    status:
      normalizeCustomCronJobStatus((job as JsonRecord).status) ||
      inferCustomCronJobStatus(normalizeOptionalString((job as JsonRecord).schedule)),
    outputTargets: resolveCustomCronOutputTargets(store, job as JsonRecord).filter((entry) =>
      outputRouteChannelIds.has(entry),
    ),
  }));
  const customCronJobs = normalizedCronJobs;
  const grants = store.grants;
  const providerBridges = store.providerBridges;

  const resolvedSessionAgentIds = new Map<string, string>();
  for (const session of mergedSessions) {
    const sessionKey = normalizeOptionalString(session.key);
    if (!sessionKey) {
      continue;
    }
    resolvedSessionAgentIds.set(sessionKey, resolveSessionTargetAgentId(session, channels));
  }

  const enrichedSessions = mergedSessions.map((session) => {
    const sessionMeta = classifySession(session);
    const sessionKey = stringifyUnknown(session.key);
    const resolvedAgentId = resolvedSessionAgentIds.get(sessionKey) || "main";
    return {
      ...session,
      displayName:
        sessionMeta.sessionKind === "pipeline"
          ? sessionMeta.displayLabel
          : stringifyUnknown(
              session.displayName,
              normalizeOptionalString(session.label) ||
                normalizeOptionalString(session.derivedTitle) ||
                stringifyUnknown(session.key),
            ),
      agentId: resolvedAgentId,
      activityStatus: inferSessionActivityStatus(session),
      sessionKind: sessionMeta.sessionKind,
      sessionKindLabel: sessionMeta.sessionKindLabel,
      sessionKindDescription: sessionMeta.sessionKindDescription,
      pipelineId: "pipelineId" in sessionMeta ? sessionMeta.pipelineId : undefined,
      pipelineRunId: "pipelineRunId" in sessionMeta ? sessionMeta.pipelineRunId : undefined,
      pipelineStepId: "pipelineStepId" in sessionMeta ? sessionMeta.pipelineStepId : undefined,
      projectId:
        normalizeOptionalString(session.projectId) ||
        normalizeOptionalString(session.runtimeProjectId) ||
        (isJsonRecord(session.project) ? normalizeOptionalString(session.project.id) : undefined),
      projectName: (() => {
        const projectId =
          normalizeOptionalString(session.projectId) ||
          normalizeOptionalString(session.runtimeProjectId) ||
          (isJsonRecord(session.project) ? normalizeOptionalString(session.project.id) : undefined);
        return projectId ? projects.find((project) => project.id === projectId)?.name || projectId : undefined;
      })(),
      inboundPrincipal: resolveSessionInboundPrincipal({
        session,
        users,
        teams,
        grants,
        agentBindings,
        channels,
        allSkillIds,
      }),
    };
  });

  const enrichedAgents = agents.map((agent) => {
    const agentId = stringifyUnknown(agent.id, "main");
    const binding = agentBindings.find((entry) => entry.agentId === agentId);
    const agentSessions = enrichedSessions.filter((session) => session.agentId === agentId);
    const workspace = workspaces.find((entry) => entry.agentId === agentId);
    const running = agentSessions.find(
      (session) => inferSessionActivityStatus(session) === "running",
    );
    return {
      ...agent,
      ownerId: binding?.ownerId,
      teamId: binding?.teamId,
      purpose: binding?.purpose || "",
      tags: binding?.tags || [],
      skillIds: binding?.skillIds || [],
      channelIds: binding?.channelIds || [],
      defaultOutputChannelIds: binding?.defaultOutputChannelIds || [],
      providerIds: binding?.providerIds || activeProviderIdList,
      providerAccountIds: binding?.providerAccountIds || {},
      providerSkillPolicies: binding?.providerSkillPolicies || {},
      preferredModelRef: binding?.preferredModelRef,
      effectiveModelRef: binding?.preferredModelRef || runtimeDefaults.agentPrimaryModelRef,
      resumePolicy: binding?.resumePolicy || "manual",
      dispatchPolicy: binding?.dispatchPolicy || "manual",
      workspace,
      sessionCount: agentSessions.length,
      currentStatus: running ? "running" : agentSessions.length ? "active" : "idle",
      currentActivity: running
        ? `Repond sur ${stringifyUnknown(running.displayName, stringifyUnknown(running.key, agentId))}`
        : agentSessions[0]
          ? `Derniere activite ${stringifyUnknown(
              agentSessions[0].displayName,
              stringifyUnknown(agentSessions[0].key),
            )}`
          : "Aucune session active",
    };
  });

  const cronJobs = [
    ...nativeCronJobs.map((job) => ({
      ...job,
      source: "openclaw",
      activityStatus: inferCronStatus(job),
    })),
    ...customCronJobs.map((job) => ({
      ...job,
      source: "control-tower",
      activityStatus: job.status,
    })),
  ];

  const response = {
    ok: true,
    meta: {
      generatedAt: new Date().toISOString(),
      gatewayHttpUrl: normalizeGatewayHttpUrl(gatewayUrl),
      gatewayWsUrl: toGatewayWsUrl(gatewayUrl),
      gatewayTokenMasked: maskToken(gatewayToken),
      configPath: snapshot?.configPath || null,
      stateDir: snapshot?.stateDir || runtimeEnv.effective.stateDir,
      workspaceRoot: runtimeEnv.effective.workspaceDir,
      storePath: DEFAULT_STORE_PATH,
      uptimeMs: snapshot?.uptimeMs || null,
      authMode: snapshot?.authMode || null,
    },
    overview: createOverview({
      agents: enrichedAgents,
      sessions: enrichedSessions,
      cronJobs,
      pipelines,
      files: workspaceFiles,
      memories,
    }),
    agents: enrichedAgents,
    sessions: enrichedSessions,
    files: workspaceFiles,
    memories,
    workspaces,
    cronJobs,
    pipelines,
    users,
    teams,
    projects,
    channels,
    grants,
    agentBindings,
    providerBridges,
    providers: Array.from(providerMap.values()).toSorted((left, right) =>
      left.provider.localeCompare(right.provider),
    ),
    runtimeModels: Array.from(runtimeModelMap.values()).toSorted((left, right) =>
      left.ref.localeCompare(right.ref),
    ),
    runtimeDefaults,
    skills,
  };

  return filterDashboardSnapshotForActor(req, store, response);
}

async function loadAgentMemoryInsight(
  req: IncomingMessage,
  agentId: string,
  rawSearchTerm: string,
): Promise<AgentMemoryInsight> {
  const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
  const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
  const [dashboard, memoryStatus] = await Promise.all([
    buildDashboardSnapshot(req),
    loadMemoryEngineStatus(gatewayUrl, gatewayToken),
  ]);
  const dbPath = memoryStatus.managedPlugin.config.dbPath || memoryStatus.defaultDbPath;
  const searchTerm = rawSearchTerm.trim();
  const agentSessions = Array.isArray(dashboard.sessions)
    ? (dashboard.sessions as JsonRecord[]).filter(
        (session) => stringifyUnknown(session.agentId) === agentId,
      )
    : [];
  const trackedSessionKeys = Array.from(
    new Set(
      agentSessions
        .map((session) => normalizeOptionalString(session.key))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ).toSorted((left, right) => left.localeCompare(right));
  const sessionLabelByKey = new Map(
    agentSessions.map((session) => {
      const key = stringifyUnknown(session.key);
      const displayName =
        normalizeOptionalString(session.displayName) ||
        normalizeOptionalString(session.derivedTitle) ||
        key;
      return [key, displayName];
    }),
  );
  const result: AgentMemoryInsight = {
    agentId,
    searchTerm,
    engine: {
      active: memoryStatus.activeEngineId === memoryStatus.managedPluginId,
      installed: memoryStatus.managedPlugin.installed,
      selected: memoryStatus.managedPlugin.selected,
      dbPath,
      available: false,
    },
    stats: {
      dashboardSessionCount: trackedSessionKeys.length,
      indexedSessionCount: 0,
      conversationCount: 0,
      summaryCount: 0,
      messageCount: 0,
    },
    trackedSessionKeys,
    conversations: [],
    summaries: [],
    matches: [],
  };

  if (!dbPath || !fsSync.existsSync(dbPath)) {
    result.engine.reason = "Base SQLite absente sur le runtime local.";
    return result;
  }

  try {
    const { DatabaseSync } = await loadSqliteModule();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const sessionPrefixLike = `${escapeSqlLikePattern(`agent:${agentId}:`)}%`;
      const statsRow = (db
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM conversations c WHERE c.session_key LIKE ? ESCAPE '\\') AS conversationCount,
              (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id WHERE c.session_key LIKE ? ESCAPE '\\') AS messageCount,
              (SELECT COUNT(*) FROM summaries s JOIN conversations c ON c.conversation_id = s.conversation_id WHERE c.session_key LIKE ? ESCAPE '\\') AS summaryCount,
              (SELECT MAX(COALESCE(c.updated_at, c.created_at)) FROM conversations c WHERE c.session_key LIKE ? ESCAPE '\\') AS lastConversationAt,
              (SELECT MAX(s.created_at) FROM summaries s JOIN conversations c ON c.conversation_id = s.conversation_id WHERE c.session_key LIKE ? ESCAPE '\\') AS lastSummaryAt,
              (SELECT COUNT(DISTINCT c.session_key) FROM conversations c WHERE c.session_key LIKE ? ESCAPE '\\') AS indexedSessionCount
          `,
        )
        .get(
          sessionPrefixLike,
          sessionPrefixLike,
          sessionPrefixLike,
          sessionPrefixLike,
          sessionPrefixLike,
          sessionPrefixLike,
        ) || {}) as JsonRecord;
      result.stats = {
        dashboardSessionCount: trackedSessionKeys.length,
        indexedSessionCount: Number(statsRow.indexedSessionCount || 0),
        conversationCount: Number(statsRow.conversationCount || 0),
        summaryCount: Number(statsRow.summaryCount || 0),
        messageCount: Number(statsRow.messageCount || 0),
        lastConversationAt: normalizeOptionalString(statsRow.lastConversationAt),
        lastSummaryAt: normalizeOptionalString(statsRow.lastSummaryAt),
      };

      const conversationRows = db
        .prepare(
          `
            SELECT
              c.conversation_id AS conversationId,
              c.session_id AS sessionId,
              c.session_key AS sessionKey,
              c.title AS title,
              COALESCE(c.updated_at, c.created_at) AS updatedAt,
              COALESCE(msg.messageCount, 0) AS messageCount,
              COALESCE(sumry.summaryCount, 0) AS summaryCount,
              sumry.lastSummaryAt AS lastSummaryAt
            FROM conversations c
            LEFT JOIN (
              SELECT conversation_id, COUNT(*) AS messageCount
              FROM messages
              GROUP BY conversation_id
            ) msg ON msg.conversation_id = c.conversation_id
            LEFT JOIN (
              SELECT conversation_id, COUNT(*) AS summaryCount, MAX(created_at) AS lastSummaryAt
              FROM summaries
              GROUP BY conversation_id
            ) sumry ON sumry.conversation_id = c.conversation_id
            WHERE c.session_key LIKE ? ESCAPE '\\'
            ORDER BY updatedAt DESC
            LIMIT 8
          `,
        )
        .all(sessionPrefixLike) as JsonRecord[];
      result.conversations = conversationRows.map((row) => {
        const sessionKey = stringifyUnknown(row.sessionKey);
        return {
          conversationId: stringifyUnknown(row.conversationId),
          sessionId: normalizeOptionalString(row.sessionId),
          sessionKey,
          sessionLabel: sessionLabelByKey.get(sessionKey) || sessionKey,
          title: normalizeOptionalString(row.title),
          updatedAt: normalizeOptionalString(row.updatedAt),
          messageCount: Number(row.messageCount || 0),
          summaryCount: Number(row.summaryCount || 0),
          lastSummaryAt: normalizeOptionalString(row.lastSummaryAt),
        };
      });

      const summaryRows = db
        .prepare(
          `
            SELECT
              s.summary_id AS summaryId,
              s.conversation_id AS conversationId,
              c.session_key AS sessionKey,
              s.kind AS kind,
              s.depth AS depth,
              s.token_count AS tokenCount,
              s.model AS model,
              s.created_at AS createdAt,
              s.content AS content
            FROM summaries s
            JOIN conversations c ON c.conversation_id = s.conversation_id
            WHERE c.session_key LIKE ? ESCAPE '\\'
            ORDER BY s.created_at DESC
            LIMIT 6
          `,
        )
        .all(sessionPrefixLike) as JsonRecord[];
      result.summaries = summaryRows.map((row) => {
        const sessionKey = stringifyUnknown(row.sessionKey);
        return {
          summaryId: stringifyUnknown(row.summaryId),
          conversationId: stringifyUnknown(row.conversationId),
          sessionKey,
          sessionLabel: sessionLabelByKey.get(sessionKey) || sessionKey,
          kind: stringifyUnknown(row.kind),
          depth: Number(row.depth || 0),
          tokenCount: normalizeOptionalNumber(row.tokenCount),
          model: normalizeOptionalString(row.model),
          createdAt: normalizeOptionalString(row.createdAt),
          preview: compactInsightPreview(row.content),
        };
      });

      if (searchTerm) {
        const searchLike = `%${escapeSqlLikePattern(searchTerm)}%`;
        const matchRows = db
          .prepare(
            `
              SELECT *
              FROM (
                SELECT
                  'summary' AS type,
                  s.summary_id AS id,
                  s.conversation_id AS conversationId,
                  c.session_key AS sessionKey,
                  '' AS role,
                  s.created_at AS createdAt,
                  s.model AS model,
                  s.content AS content
                FROM summaries s
                JOIN conversations c ON c.conversation_id = s.conversation_id
                WHERE c.session_key LIKE ? ESCAPE '\\'
                  AND lower(s.content) LIKE lower(?) ESCAPE '\\'
                UNION ALL
                SELECT
                  'message' AS type,
                  m.message_id AS id,
                  m.conversation_id AS conversationId,
                  c.session_key AS sessionKey,
                  m.role AS role,
                  m.created_at AS createdAt,
                  '' AS model,
                  m.content AS content
                FROM messages m
                JOIN conversations c ON c.conversation_id = m.conversation_id
                WHERE c.session_key LIKE ? ESCAPE '\\'
                  AND lower(m.content) LIKE lower(?) ESCAPE '\\'
              )
              ORDER BY createdAt DESC
              LIMIT 12
            `,
          )
          .all(sessionPrefixLike, searchLike, sessionPrefixLike, searchLike) as JsonRecord[];
        result.matches = matchRows.map((row) => {
          const sessionKey = stringifyUnknown(row.sessionKey);
          const type = stringifyUnknown(row.type) === "message" ? "message" : "summary";
          return {
            type,
            id: stringifyUnknown(row.id),
            conversationId: stringifyUnknown(row.conversationId),
            sessionKey,
            sessionLabel: sessionLabelByKey.get(sessionKey) || sessionKey,
            role: normalizeOptionalString(row.role),
            createdAt: normalizeOptionalString(row.createdAt),
            model: normalizeOptionalString(row.model),
            preview: compactInsightPreview(row.content, 260),
          };
        });
      }

      result.engine.available = true;
      return result;
    } finally {
      db.close();
    }
  } catch (error) {
    result.engine.reason = error instanceof Error ? error.message : String(error);
    return result;
  }
}

function resolveBridgeFromStore(store: ControlTowerStore, id: string) {
  const bridge = store.providerBridges.find((entry) => entry.id === id);
  if (!bridge) {
    throw new Error(`Unknown provider bridge id: ${id}`);
  }
  return bridge;
}

function desiredImportedProviderId(bridge: ProviderBridge) {
  const normalizedName = slugify(bridge.name || bridge.id) || "openai-compatible";
  if (
    bridge.id === "cliproxyapi" ||
    normalizedName === "cliproxyapi" ||
    bridge.importedProviderId === "bridge-local-bridge"
  ) {
    return "cliproxyapi";
  }
  return `bridge-${normalizedName}`;
}

async function discoverProviderBridgeInStore(id: string) {
  const store = await loadStore([], []);
  const bridge = resolveBridgeFromStore(store, id);
  const models = await discoverBridgeModels(bridge);
  const now = new Date().toISOString();
  const previousActive = bridge.activeModelIds.filter((modelId) =>
    models.some((model) => model.id === modelId),
  );
  const nextActive = previousActive.length > 0 ? previousActive : models.map((model) => model.id);
  const nextPrimary =
    bridge.primaryModelId && nextActive.includes(bridge.primaryModelId)
      ? bridge.primaryModelId
      : nextActive[0];
  const next = normalizeProviderBridge(
    {
      ...bridge,
      discoveredModels: models,
      activeModelIds: nextActive,
      primaryModelId: nextPrimary,
      status: bridge.importedProviderId ? "imported" : "ready",
      lastSyncAt: now,
      lastError: "",
      updatedAt: now,
    },
    now,
    bridge,
  );
  store.providerBridges = store.providerBridges.map((entry) => (entry.id === id ? next : entry));
  await saveStore(DEFAULT_STORE_PATH, store);
  return next;
}

async function importProviderBridge(req: IncomingMessage, id: string) {
  const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
  const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
  const store = await loadStore([], []);
  let bridge = resolveBridgeFromStore(store, id);

  if (!bridge.discoveredModels.length) {
    bridge = await discoverProviderBridgeInStore(id);
  }
  if (isCliproxyBridge(bridge)) {
    const nextBridge = await normalizeCliproxyBridgeRuntimeModels(bridge);
    if (bridgeModelComparableSignature(nextBridge) !== bridgeModelComparableSignature(bridge)) {
      bridge = nextBridge;
      store.providerBridges = store.providerBridges.map((entry) =>
        entry.id === id ? bridge : entry,
      );
      await saveStore(DEFAULT_STORE_PATH, store);
    }
  }

  const configGet = await gatewayBatch(gatewayUrl, gatewayToken, {
    config: { method: "config.get", params: {} },
  });
  const payload = (configGet.results.config as JsonRecord | undefined) || {};
  const baseHash = normalizeOptionalString(payload.hash);
  if (!baseHash) {
    throw new Error("Gateway config hash unavailable; retry after refreshing the dashboard.");
  }

  const config = isJsonRecord(payload.config) ? payload.config : {};
  const modelsConfig = isJsonRecord(config.models) ? config.models : {};
  const currentProviders = isJsonRecord(modelsConfig.providers) ? modelsConfig.providers : {};

  const currentBridgeProviderId = normalizeOptionalString(bridge.importedProviderId);
  const preferredProviderId = desiredImportedProviderId(bridge);
  let providerId = currentBridgeProviderId || preferredProviderId;
  if (!currentBridgeProviderId) {
    let suffix = 2;
    while (currentProviders[providerId] !== undefined) {
      providerId = `${preferredProviderId}-${suffix}`;
      suffix += 1;
    }
  }

  const nextConfig = structuredClone(config);
  const nextModelsConfig = isJsonRecord(nextConfig.models) ? nextConfig.models : {};
  const nextProviders = isJsonRecord(nextModelsConfig.providers) ? nextModelsConfig.providers : {};
  const allowBridgeAsRuntimeDefault =
    providerId !== "cliproxyapi" || bridge.activeModelIds.length > 0;

  if (currentBridgeProviderId && currentBridgeProviderId !== providerId) {
    delete nextProviders[currentBridgeProviderId];
  }

  // Replace the provider entry wholesale so deselected models disappear from runtime.
  nextProviders[providerId] = buildImportedProviderConfig(bridge);
  nextModelsConfig.providers = nextProviders;
  nextConfig.models = nextModelsConfig;

  if (
    bridge.applyAsDefaultModel &&
    bridge.activeModelIds.length > 0 &&
    allowBridgeAsRuntimeDefault
  ) {
    const primaryModelId = bridge.primaryModelId || bridge.activeModelIds[0];
    const nextAgentsConfig = isJsonRecord(nextConfig.agents) ? nextConfig.agents : {};
    const nextAgentDefaults = isJsonRecord(nextAgentsConfig.defaults)
      ? nextAgentsConfig.defaults
      : {};

    nextAgentDefaults.model =
      providerId === "cliproxyapi"
        ? buildCliproxyAgentDefaultsModelValue(bridge)
        : bridge.activeModelIds.length === 1
          ? `${providerId}/${primaryModelId}`
          : {
              primary: `${providerId}/${primaryModelId}`,
              fallbacks: bridge.activeModelIds
                .filter((modelId) => modelId !== primaryModelId)
                .map((modelId) => `${providerId}/${modelId}`),
            };

    nextAgentsConfig.defaults = nextAgentDefaults;
    nextConfig.agents = nextAgentsConfig;
  }

  const response = await gatewayBatch(gatewayUrl, gatewayToken, {
    apply: {
      method: "config.apply",
      params: {
        raw: JSON.stringify(nextConfig, null, 2),
        baseHash,
      },
    },
  });
  await sleep(3000);
  await ensureGatewayAvailable(gatewayUrl);

  const now = new Date().toISOString();
  const nextBridge = normalizeProviderBridge(
    {
      ...bridge,
      importedProviderId: providerId,
      status: "imported",
      lastImportAt: now,
      lastError: "",
      updatedAt: now,
    },
    now,
    bridge,
  );
  store.providerBridges = store.providerBridges.map((entry) =>
    entry.id === id ? nextBridge : entry,
  );
  await saveStore(DEFAULT_STORE_PATH, store);
  return {
    bridge: nextBridge,
    providerId,
    gateway: response.results.patch || {},
  };
}

async function buildChannelCatalog(req: IncomingMessage) {
  const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
  const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
  const runtimeEnv = buildRuntimeEnvStatusSync();
  try {
    const response = await gatewayBatch(gatewayUrl, gatewayToken, {
      channels: { method: "channels.status", params: { probe: false } },
      config: { method: "config.get", params: {} },
    });
    const status = (response.results.channels as JsonRecord | undefined) || {};
    const configPayload = (response.results.config as JsonRecord | undefined) || {};
    const config = isJsonRecord(configPayload.config) ? configPayload.config : {};
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      entries: buildChannelCatalogEntries(status, config),
    };
  } catch (error) {
    return {
      ok: true,
      degraded: true,
      warning: error instanceof Error ? error.message : String(error),
      generatedAt: new Date().toISOString(),
      entries: buildChannelCatalogEntries({}, readJson5FileSync(runtimeEnv.effective.configPath)),
    };
  }
}

function buildChannelStoreId(channelId: string, accountId?: string) {
  return `${channelId}/${normalizeAccountId(accountId)}`;
}

function resolveAgentBinding(store: ControlTowerStore, agentId: string) {
  return store.agentBindings.find((binding) => binding.agentId === agentId);
}

function filterKnownOutputRouteIds(store: ControlTowerStore, channelIds: string[]) {
  const known = new Set(
    store.channels
      .filter((channel) => isOutputRouteChannelRecord(channel))
      .map((channel) => channel.id),
  );
  return channelIds.filter((channelId) => known.has(channelId));
}

function getAutoDispatchTargetsForAgent(store: ControlTowerStore, agentId: string) {
  const binding = resolveAgentBinding(store, agentId);
  if (!binding) {
    return [];
  }
  if (binding.dispatchPolicy === "broadcast") {
    return filterKnownOutputRouteIds(store, binding.channelIds);
  }
  if (binding.dispatchPolicy === "default-channels") {
    return filterKnownOutputRouteIds(store, binding.defaultOutputChannelIds);
  }
  return [];
}

function normalizeCustomCronJobStatus(value: unknown): CustomCronJob["status"] | undefined {
  return value === "queued" ||
    value === "running" ||
    value === "paused" ||
    value === "failed" ||
    value === "done"
    ? value
    : undefined;
}

function inferCustomCronJobStatus(schedule?: string): CustomCronJob["status"] {
  return schedule?.trim() ? "running" : "paused";
}

function resolveCustomCronTargetType(value: JsonRecord): CustomCronJob["targetType"] {
  if (normalizeOptionalString(value.targetType) === "request") {
    return "request";
  }
  return normalizeOptionalString(value.pipelineId) ? "pipeline" : "request";
}

function resolveCustomCronOutputTargets(store: ControlTowerStore, value: JsonRecord) {
  const targetType = resolveCustomCronTargetType(value);
  if (targetType === "pipeline") {
    const pipelineId = normalizeOptionalString(value.pipelineId);
    if (!pipelineId) {
      return [];
    }
    const pipeline = store.pipelines.find((entry) => entry.id === pipelineId);
    return pipeline
      ? filterKnownOutputRouteIds(store, normalizeIdList((pipeline as JsonRecord).outputTargets))
      : [];
  }
  const agentId = normalizeOptionalString(value.agentId);
  return agentId ? getAutoDispatchTargetsForAgent(store, agentId) : [];
}

function normalizeCustomCronJob(
  store: ControlTowerStore,
  value: JsonRecord,
  now: string,
  current?: JsonRecord,
): CustomCronJob {
  const base = current ? { ...current, ...value } : value;
  const schedule = normalizeOptionalString(base.schedule);
  return {
    id: stringifyUnknown(base.id, randomUUID()),
    name: stringifyUnknown(base.name, "Cron job"),
    description: normalizeOptionalString(base.description),
    ownerId: normalizeOptionalString(base.ownerId),
    agentId: normalizeOptionalString(base.agentId),
    pipelineId: normalizeOptionalString(base.pipelineId),
    targetType: resolveCustomCronTargetType(base),
    schedule,
    input: normalizeOptionalString(base.input),
    status:
      normalizeCustomCronJobStatus(value.status) ||
      normalizeCustomCronJobStatus(base.status) ||
      inferCustomCronJobStatus(schedule),
    outputTargets: resolveCustomCronOutputTargets(store, base),
    createdAt: stringifyUnknown(base.createdAt, now),
    updatedAt: now,
  };
}

function filterRequestedOutputTargetsForAgent(
  store: ControlTowerStore,
  agentId: string,
  requestedTargets: string[],
) {
  if (!requestedTargets.length) {
    return [];
  }
  const normalizedAgentId = normalizeOptionalString(agentId);
  if (!normalizedAgentId || normalizedAgentId === "__static__") {
    return filterKnownOutputRouteIds(store, requestedTargets);
  }
  const accessibleChannelIds = new Set(resolveAgentBinding(store, agentId)?.channelIds || []);
  const knownChannelIds = new Set(
    store.channels
      .filter((channel) => isOutputRouteChannelRecord(channel))
      .map((channel) => channel.id),
  );
  return requestedTargets.filter(
    (target) => !knownChannelIds.has(target) || accessibleChannelIds.has(target),
  );
}

function getEffectivePipelineStepNextStepIds(
  step: PipelineRecord["steps"][number],
  steps: PipelineRecord["steps"],
  index: number,
) {
  if (step.routingMode === "terminal") {
    return [];
  }
  const validStepIds = new Set(steps.map((entry) => entry.id));
  const explicitNext = (step.nextStepIds || []).filter(
    (nextStepId) => nextStepId !== step.id && validStepIds.has(nextStepId),
  );
  if (explicitNext.length > 0) {
    return explicitNext;
  }
  const sequentialNext = steps[index + 1];
  return sequentialNext ? [sequentialNext.id] : [];
}

function resolvePipelineStepNextStepIdsForRun(
  step: PipelineRecord["steps"][number],
  steps: PipelineRecord["steps"],
  index: number,
  output: string,
) {
  const nextStepIds = getEffectivePipelineStepNextStepIds(step, steps, index);
  if (step.routingMode !== "conditional") {
    return {
      nextStepIds,
      evaluation: undefined as PipelineConditionEvaluation | undefined,
    };
  }

  const evaluation = evaluatePipelineCondition(step.condition, output);
  const matchedBranch = nextStepIds[0] ? [nextStepIds[0]] : [];
  const fallbackBranch = nextStepIds[1] ? [nextStepIds[1]] : [];
  return {
    nextStepIds: evaluation.matched ? matchedBranch : fallbackBranch,
    evaluation,
  };
}

function getEffectivePipelineStepOutputTargets(
  store: ControlTowerStore,
  step: PipelineRecord["steps"][number],
) {
  const requestedTargets = filterRequestedOutputTargetsForAgent(
    store,
    step.agentId,
    splitListInput(step.output || ""),
  );
  return requestedTargets;
}

function resolveLastAssistantOutput(messages: unknown[]) {
  const normalized = normalizeHistoryMessages(messages);
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const message = normalized[index];
    if (message.role === "assistant" && message.text.trim()) {
      return message.text.trim();
    }
  }
  return "";
}

function renderPipelinePrompt(params: {
  pipeline: PipelineRecord;
  step: PipelineRecord["steps"][number];
  input?: string;
  previousOutput?: string;
  outputsByStepId: Map<string, string>;
}) {
  const basePrompt = normalizeOptionalString(params.step.prompt) || params.step.name.trim();
  if (!basePrompt) {
    throw new Error(`Pipeline step ${params.step.id} has no prompt.`);
  }

  let prompt = basePrompt
    .replaceAll("{{pipeline.name}}", params.pipeline.name)
    .replaceAll("{{pipeline.description}}", params.pipeline.description || "")
    .replaceAll("{{pipeline.input}}", params.input || "")
    .replaceAll("{{previous.output}}", params.previousOutput || "")
    .replaceAll("{{prev.output}}", params.previousOutput || "");

  for (const [stepId, output] of params.outputsByStepId.entries()) {
    prompt = prompt.replaceAll(`{{step.${stepId}.output}}`, output);
  }

  if (params.input && !basePrompt.includes("{{pipeline.input}}")) {
    prompt = `${prompt}\n\nPipeline input:\n${params.input}`;
  }
  if (
    params.previousOutput &&
    !basePrompt.includes("{{previous.output}}") &&
    !basePrompt.includes("{{prev.output}}")
  ) {
    prompt = `${prompt}\n\nPrevious step output:\n${params.previousOutput}`;
  }

  return prompt.trim();
}

async function updateStoredPipeline(
  pipelineId: string,
  updater: (pipeline: PipelineRecord) => PipelineRecord,
) {
  const store = await loadStore([], []);
  const index = store.pipelines.findIndex((pipeline) => pipeline.id === pipelineId);
  if (index < 0) {
    throw new Error(`Unknown pipeline id: ${pipelineId}`);
  }
  const next = updater(store.pipelines[index]);
  store.pipelines[index] = next;
  await saveStore(DEFAULT_STORE_PATH, store);
  return next;
}

function buildPipelineRunSummary(run: PipelineRunRecord) {
  return {
    id: run.id,
    pipelineId: run.pipelineId,
    pipelineName: run.pipelineName,
    outputDeliveryMode: run.outputDeliveryMode,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    input: run.input,
    status: run.status,
    finalSessionKey: run.finalSessionKey,
    error: run.error,
    stepCount: run.steps.length,
    sessionCount: run.steps.filter((step) => Boolean(step.sessionKey)).length,
    sentDeliveryCount: run.deliveries.filter((entry) => entry.status === "sent").length,
    totalDeliveryCount: run.deliveries.length,
  };
}

async function upsertStoredPipelineRun(
  runId: string,
  updater: (current?: PipelineRunRecord) => PipelineRunRecord,
) {
  const store = await loadStore([], []);
  const index = store.pipelineRuns.findIndex((run) => run.id === runId);
  const next = updater(index >= 0 ? store.pipelineRuns[index] : undefined);
  if (index >= 0) {
    store.pipelineRuns[index] = next;
  } else {
    store.pipelineRuns.unshift(next);
  }
  store.pipelineRuns = store.pipelineRuns
    .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, 150);
  await saveStore(DEFAULT_STORE_PATH, store);
  return next;
}

async function deliverPipelineOutput(params: {
  gatewayUrl: string;
  gatewayToken: string;
  channel: DashboardChannel;
  message: string;
}) {
  const target = normalizeOptionalString(params.channel.deliveryTarget);
  if (!target) {
    return {
      channelId: params.channel.id,
      channel: params.channel.kind,
      accountId: params.channel.accountId,
      to: "",
      status: "skipped" as const,
      reason: "No delivery target configured for this channel.",
    };
  }

  const response = await gatewayBatch(
    params.gatewayUrl,
    params.gatewayToken,
    {
      send: {
        method: "send",
        params: {
          channel: params.channel.kind,
          ...(params.channel.accountId ? { accountId: params.channel.accountId } : {}),
          to: target,
          message: params.message,
          idempotencyKey: randomUUID(),
        },
      },
    },
    { timeoutMs: 30_000 },
  );
  const payload = (response.results.send as JsonRecord | undefined) || {};
  return {
    channelId: params.channel.id,
    channel: params.channel.kind,
    accountId: params.channel.accountId,
    to: target,
    messageId: normalizeOptionalString(payload.messageId),
    chatId: normalizeOptionalString(payload.chatId),
    status: "sent" as const,
  };
}

async function runPipelineFromDashboard(
  req: IncomingMessage,
  pipelineId: string,
  body: JsonRecord,
) {
  const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
  const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
  const store = await loadStore([], []);
  const actor = resolveDashboardActorContext(req, store);
  const pipeline = store.pipelines.find((entry) => entry.id === pipelineId);
  if (!pipeline) {
    throw new Error(`Unknown pipeline id: ${pipelineId}`);
  }
  if (!actor.canOperatePipelineRecord(pipeline)) {
    throw new Error("Le user courant n'a pas le droit de lancer cette pipeline.");
  }
  if (!pipeline.steps.length) {
    throw new Error(`Pipeline ${pipeline.name} has no steps.`);
  }
  const cliproxyBridge = store.providerBridges.find((entry) => isCliproxyBridge(entry));
  await ensureProjectCliproxyRuntimeAvailable(cliproxyBridge).catch(() => undefined);

  const startedAt = new Date().toISOString();
  const pipelineRunId = randomUUID();
  const requestedInput = normalizeOptionalString(body.input);
  await updateStoredPipeline(pipelineId, (current) => ({
    ...current,
    status: "running",
    lastRunAt: startedAt,
    updatedAt: startedAt,
    steps: current.steps.map((step, index) => ({
      ...step,
      status: index === 0 ? "queued" : "draft",
    })),
  }));

  const outputsByStepId = new Map<string, string>();
  const stepResults: PipelineRunStepResult[] = [];
  const deliveryResults: PipelineRunDeliveryResult[] = [];
  const logs: Array<{
    timestamp: string;
    level: "info" | "error" | "success";
    stepId?: string;
    stepName?: string;
    message: string;
  }> = [];
  const appendLog = (entry: {
    level: "info" | "error" | "success";
    stepId?: string;
    stepName?: string;
    message: string;
  }) => {
    logs.push({
      timestamp: new Date().toISOString(),
      ...entry,
    });
  };
  const outputDeliveryMode = normalizePipelineOutputDeliveryMode(pipeline.outputDeliveryMode);
  await upsertStoredPipelineRun(pipelineRunId, () => ({
    id: pipelineRunId,
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    outputDeliveryMode,
    startedAt,
    input: requestedInput || undefined,
    status: "running",
    finalOutput: "",
    steps: [],
    deliveries: [],
    logs: [],
  }));

  let previousOutput = "";
  let finalSessionKey = "";
  let finalOutput = "";
  let failedStepId = "";
  const queuedStepIds = new Set<string>();
  const visitedStepIds = new Set<string>();
  const queue: string[] = [pipeline.steps[0]?.id].filter(Boolean) as string[];
  const shouldSendStepOutputs =
    outputDeliveryMode === "step-only" || outputDeliveryMode === "step-and-final";
  const shouldSendFinalOutputs =
    outputDeliveryMode === "final-only" || outputDeliveryMode === "step-and-final";
  appendLog({
    level: "info",
    message: `Pipeline ${pipeline.name} started with ${pipeline.steps.length} step(s) in ${outputDeliveryMode} mode.`,
  });
  try {
    while (queue.length > 0) {
      const stepId = queue.shift();
      if (!stepId || visitedStepIds.has(stepId)) {
        continue;
      }
      const stepIndex = pipeline.steps.findIndex((entry) => entry.id === stepId);
      if (stepIndex < 0) {
        continue;
      }
      const step = pipeline.steps[stepIndex];
      visitedStepIds.add(stepId);
      failedStepId = step.id;
      appendLog({
        level: "info",
        stepId: step.id,
        stepName: step.name,
        message: `Running step on agent ${step.agentId || "__static__"}.`,
      });

      await updateStoredPipeline(pipelineId, (current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        steps: current.steps.map((entry) =>
          entry.id === step.id ? { ...entry, status: "running" } : entry,
        ),
      }));

      const prompt = renderPipelinePrompt({
        pipeline,
        step,
        input: requestedInput,
        previousOutput,
        outputsByStepId,
      });
      const stepAgentId = normalizeOptionalString(step.agentId);

      if (!stepAgentId || stepAgentId === "__static__") {
        previousOutput = prompt;
        finalOutput = prompt;
        outputsByStepId.set(step.id, prompt);
        appendLog({
          level: "success",
          stepId: step.id,
          stepName: step.name,
          message: "Static step completed from rendered prompt.",
        });

        stepResults.push({
          stepId: step.id,
          stepName: step.name,
          agentId: stepAgentId || undefined,
          sessionKey: "",
          runId: `static:${step.id}`,
          status: "done",
          output: prompt,
        });

        const stepOutputTargets = getEffectivePipelineStepOutputTargets(store, step);
        if (shouldSendStepOutputs) {
          for (const channelId of stepOutputTargets) {
            const channel = store.channels.find((entry) => entry.id === channelId);
            if (!channel) {
              appendLog({
                level: "error",
                stepId: step.id,
                stepName: step.name,
                message: `Output channel ${channelId} not found.`,
              });
              continue;
            }
            const delivery = await deliverPipelineOutput({
              gatewayUrl,
              gatewayToken,
              channel,
              message: prompt,
            });
            deliveryResults.push({
              ...delivery,
              scope: "step",
              stepId: step.id,
              stepName: step.name,
            });
            appendLog({
              level: delivery.status === "sent" ? "success" : "error",
              stepId: step.id,
              stepName: step.name,
              message:
                delivery.status === "sent"
                  ? `Sent output via ${delivery.channel} to ${delivery.to}.`
                  : `Skipped output via ${delivery.channel}: ${delivery.reason || "unknown reason"}.`,
            });
          }
        } else if (stepOutputTargets.length) {
          appendLog({
            level: "info",
            stepId: step.id,
            stepName: step.name,
            message: "Intermediate outputs disabled; only final pipeline delivery will be sent.",
          });
        }

        const { nextStepIds, evaluation } = resolvePipelineStepNextStepIdsForRun(
          step,
          pipeline.steps,
          stepIndex,
          prompt,
        );
        queuedStepIds.delete(step.id);
        if (evaluation) {
          const selectedTitles = nextStepIds
            .map(
              (nextStepId) =>
                pipeline.steps.find((entry) => entry.id === nextStepId)?.name || nextStepId,
            )
            .join(", ");
          appendLog({
            level: "info",
            stepId: step.id,
            stepName: step.name,
            message: evaluation.matched
              ? `Condition matched. ${evaluation.reason} Routing to ${selectedTitles || "no next step"}.`
              : `Condition did not match. ${evaluation.reason} Routing to ${selectedTitles || "no fallback step"}.`,
          });
        }
        for (const nextStepId of nextStepIds) {
          if (!visitedStepIds.has(nextStepId) && !queuedStepIds.has(nextStepId)) {
            queue.push(nextStepId);
            queuedStepIds.add(nextStepId);
          }
        }

        await updateStoredPipeline(pipelineId, (current) => ({
          ...current,
          updatedAt: new Date().toISOString(),
          steps: current.steps.map((entry) =>
            entry.id === step.id ? { ...entry, status: "done" } : entry,
          ),
        }));
        continue;
      }

      const created = await gatewayBatch(
        gatewayUrl,
        gatewayToken,
        {
          create: {
            method: "sessions.create",
            params: {
              agentId: stepAgentId,
              label: `[pipeline:${pipeline.id}:${pipelineRunId}:${step.id}] ${pipeline.name} · ${step.name}`,
              ...(step.modelRef ? { model: step.modelRef } : {}),
            },
          },
        },
        { timeoutMs: 30_000 },
      );
      const createdPayload = (created.results.create as JsonRecord | undefined) || {};
      const sessionKey = normalizeOptionalString(createdPayload.key);
      if (!sessionKey) {
        throw new Error(`Pipeline step ${step.name} did not return a session key.`);
      }
      finalSessionKey = sessionKey;
      appendLog({
        level: "info",
        stepId: step.id,
        stepName: step.name,
        message: `Session created: ${sessionKey}.`,
      });

      const patchPayload: JsonRecord = { key: sessionKey };
      if (step.thinkingLevel) {
        patchPayload.thinkingLevel = step.thinkingLevel;
      }
      if (typeof step.fastMode === "boolean") {
        patchPayload.fastMode = step.fastMode;
      }
      if (step.verboseLevel) {
        patchPayload.verboseLevel = step.verboseLevel;
      }
      if (step.reasoningLevel) {
        patchPayload.reasoningLevel = step.reasoningLevel;
      }
      if (Object.keys(patchPayload).length > 1) {
        await gatewayBatch(
          gatewayUrl,
          gatewayToken,
          {
            patch: {
              method: "sessions.patch",
              params: patchPayload,
            },
          },
          { timeoutMs: 30_000 },
        );
      }

      const send = await gatewayBatch(
        gatewayUrl,
        gatewayToken,
        {
          send: {
            method: "chat.send",
            params: {
              sessionKey,
              message: prompt,
              idempotencyKey: randomUUID(),
            },
          },
        },
        { timeoutMs: 30_000 },
      );
      const sendPayload = (send.results.send as JsonRecord | undefined) || {};
      const runId = normalizeOptionalString(sendPayload.runId);
      if (!runId) {
        throw new Error(`Pipeline step ${step.name} did not start a run.`);
      }
      appendLog({
        level: "info",
        stepId: step.id,
        stepName: step.name,
        message: `Run started: ${runId}.`,
      });

      const waited = await gatewayBatch(
        gatewayUrl,
        gatewayToken,
        {
          wait: {
            method: "agent.wait",
            params: {
              runId,
              timeoutMs: 180_000,
            },
          },
        },
        { timeoutMs: 190_000 },
      );
      const waitPayload = (waited.results.wait as JsonRecord | undefined) || {};
      const runStatus = normalizeOptionalString(waitPayload.status) || "unknown";
      appendLog({
        level: runStatus === "ok" ? "success" : "info",
        stepId: step.id,
        stepName: step.name,
        message: `Run finished with status ${runStatus}.`,
      });

      const history = await gatewayBatch(
        gatewayUrl,
        gatewayToken,
        {
          history: {
            method: "chat.history",
            params: {
              sessionKey,
              limit: 120,
            },
          },
        },
        { timeoutMs: 30_000 },
      );
      const historyPayload = (history.results.history as JsonRecord | undefined) || {};
      const output = resolveLastAssistantOutput(
        Array.isArray(historyPayload.messages) ? historyPayload.messages : [],
      );
      previousOutput = output;
      finalOutput = output;
      outputsByStepId.set(step.id, output);
      appendLog({
        level: "info",
        stepId: step.id,
        stepName: step.name,
        message: output
          ? `Collected assistant output (${output.length} chars).`
          : "No assistant output returned.",
      });

      stepResults.push({
        stepId: step.id,
        stepName: step.name,
        agentId: stepAgentId,
        sessionKey,
        runId,
        status: runStatus,
        output,
      });

      const effectiveOutputTargets = getEffectivePipelineStepOutputTargets(store, step);
      if (shouldSendStepOutputs) {
        for (const channelId of effectiveOutputTargets) {
          const channel = store.channels.find((entry) => entry.id === channelId);
          if (!channel) {
            deliveryResults.push({
              channelId,
              channel: channelId,
              to: "",
              scope: "step",
              stepId: step.id,
              stepName: step.name,
              status: "skipped",
              reason: "Channel not found in dashboard store.",
            });
            appendLog({
              level: "error",
              stepId: step.id,
              stepName: step.name,
              message: `Skipped unknown output channel ${channelId}.`,
            });
            continue;
          }
          const delivery = await deliverPipelineOutput({
            gatewayUrl,
            gatewayToken,
            channel,
            message: output || prompt,
          });
          deliveryResults.push({
            ...delivery,
            scope: "step",
            stepId: step.id,
            stepName: step.name,
          });
          appendLog({
            level: delivery.status === "sent" ? "success" : "error",
            stepId: step.id,
            stepName: step.name,
            message:
              delivery.status === "sent"
                ? `Sent output via ${delivery.channel} to ${delivery.to}.`
                : `Skipped output via ${delivery.channel}: ${delivery.reason || "unknown reason"}.`,
          });
        }
      } else if (effectiveOutputTargets.length) {
        appendLog({
          level: "info",
          stepId: step.id,
          stepName: step.name,
          message: "Intermediate outputs disabled; only final pipeline delivery will be sent.",
        });
      }

      const { nextStepIds, evaluation } = resolvePipelineStepNextStepIdsForRun(
        step,
        pipeline.steps,
        stepIndex,
        output,
      );
      queuedStepIds.delete(step.id);
      if (evaluation) {
        const selectedTitles = nextStepIds
          .map(
            (nextStepId) =>
              pipeline.steps.find((entry) => entry.id === nextStepId)?.name || nextStepId,
          )
          .join(", ");
        appendLog({
          level: "info",
          stepId: step.id,
          stepName: step.name,
          message: evaluation.matched
            ? `Condition matched. ${evaluation.reason} Routing to ${selectedTitles || "no next step"}.`
            : `Condition did not match. ${evaluation.reason} Routing to ${selectedTitles || "no fallback step"}.`,
        });
      }
      for (const nextStepId of nextStepIds) {
        if (!queuedStepIds.has(nextStepId) && !visitedStepIds.has(nextStepId)) {
          queue.push(nextStepId);
          queuedStepIds.add(nextStepId);
        }
      }

      await updateStoredPipeline(pipelineId, (current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        steps: current.steps.map((entry) => {
          if (entry.id === step.id) {
            return { ...entry, status: runStatus === "ok" ? "done" : "failed" };
          }
          if (nextStepIds.includes(entry.id) && entry.status === "draft") {
            return { ...entry, status: "queued" };
          }
          return entry;
        }),
      }));

      if (runStatus !== "ok") {
        const reason = normalizeOptionalString(waitPayload.error) || `status=${runStatus}`;
        throw new Error(`Pipeline step ${step.name} failed: ${reason}`);
      }
    }

    finalOutput = previousOutput;
    if (!shouldSendFinalOutputs && pipeline.outputTargets.length) {
      appendLog({
        level: "info",
        message: "Final deliveries disabled for this run; pipeline outputs were not sent.",
      });
    }
    if (shouldSendFinalOutputs) {
      for (const channelId of pipeline.outputTargets) {
        const channel = store.channels.find((entry) => entry.id === channelId);
        if (!channel) {
          deliveryResults.push({
            channelId,
            channel: channelId,
            to: "",
            scope: "final",
            status: "skipped",
            reason: "Channel not found in dashboard store.",
          });
          appendLog({
            level: "error",
            message: `Skipped unknown pipeline output channel ${channelId}.`,
          });
          continue;
        }
        const delivery = await deliverPipelineOutput({
          gatewayUrl,
          gatewayToken,
          channel,
          message: finalOutput || `Pipeline ${pipeline.name} completed.`,
        });
        deliveryResults.push({
          ...delivery,
          scope: "final",
        });
        appendLog({
          level: delivery.status === "sent" ? "success" : "error",
          message:
            delivery.status === "sent"
              ? `Sent pipeline output via ${delivery.channel} to ${delivery.to}.`
              : `Skipped pipeline output via ${delivery.channel}: ${delivery.reason || "unknown reason"}.`,
        });
      }
    }

    await updateStoredPipeline(pipelineId, (current) => ({
      ...current,
      status: "done",
      updatedAt: new Date().toISOString(),
    }));

    const completedAt = new Date().toISOString();
    await upsertStoredPipelineRun(pipelineRunId, (current) => ({
      ...(current || {
        id: pipelineRunId,
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        outputDeliveryMode,
        startedAt,
        input: requestedInput || undefined,
        status: "running",
        finalOutput: "",
        steps: [],
        deliveries: [],
        logs: [],
      }),
      completedAt,
      status: "done",
      finalOutput,
      finalSessionKey,
      error: undefined,
      steps: stepResults,
      deliveries: deliveryResults,
      logs,
    }));

    return {
      runId: pipelineRunId,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      outputDeliveryMode,
      startedAt,
      completedAt,
      input: requestedInput || undefined,
      status: "done" as const,
      finalOutput,
      finalSessionKey,
      steps: stepResults,
      deliveries: deliveryResults,
      logs,
    };
  } catch (error) {
    await updateStoredPipeline(pipelineId, (current) => ({
      ...current,
      status: "failed",
      updatedAt: new Date().toISOString(),
      steps: current.steps.map((step) =>
        step.id === failedStepId ? { ...step, status: "failed" } : step,
      ),
    }));
    const message = error instanceof Error ? error.message : String(error);
    appendLog({
      level: "error",
      stepId: failedStepId || undefined,
      stepName: pipeline.steps.find((step) => step.id === failedStepId)?.name || undefined,
      message,
    });
    const completedAt = new Date().toISOString();
    await upsertStoredPipelineRun(pipelineRunId, (current) => ({
      ...(current || {
        id: pipelineRunId,
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        outputDeliveryMode,
        startedAt,
        input: requestedInput || undefined,
        status: "running",
        finalOutput: "",
        steps: [],
        deliveries: [],
        logs: [],
      }),
      completedAt,
      status: "failed",
      finalOutput,
      finalSessionKey,
      error: message,
      steps: stepResults,
      deliveries: deliveryResults,
      logs,
    }));
    return {
      runId: pipelineRunId,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      outputDeliveryMode,
      startedAt,
      completedAt,
      input: requestedInput || undefined,
      status: "failed" as const,
      finalOutput,
      finalSessionKey,
      error: message,
      steps: stepResults,
      deliveries: deliveryResults,
      logs,
    };
  }
}

async function configureChannelFromDashboard(req: IncomingMessage, body: JsonRecord) {
  const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
  const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
  const channelId = normalizeOptionalString(body.channelId);
  if (!channelId) {
    throw new Error("channelId required");
  }
  const template = getChannelSetupTemplate(channelId);
  if (!template) {
    throw new Error(`Unknown channel template: ${channelId}`);
  }
  if (template.setupMode !== "config") {
    throw new Error(`${template.label} is configured via the native OpenClaw UI.`);
  }

  const operation = pushChannelOperation({
    id: randomUUID(),
    kind: "configure",
    channelId,
    accountId: normalizeOptionalString(body.accountId),
    status: "running",
    command: `config.apply ${channelId}`,
    logs: [],
    startedAt: new Date().toISOString(),
  });

  try {
    const values = parseChannelFieldValues(body.values);
    const normalizedAccountId = normalizeAccountId(body.accountId);
    appendChannelOperationLog(operation, `Preparing config patch for ${template.label}.`);
    await mutateGatewayConfig(gatewayUrl, gatewayToken, (config) => {
      validateDashboardChannelCredentials({
        template,
        accountId: normalizedAccountId,
        values,
        config,
      });
      return buildChannelConfigPatch({
        template,
        accountId: normalizedAccountId,
        name: normalizeOptionalString(body.name),
        values,
        config,
      });
    });
    await syncManagedInboundAllowlists({
      gatewayUrl,
      gatewayToken,
    });
    finishChannelOperation(
      operation,
      "done",
      "Configuration applied. The gateway may still be restarting in the background.",
    );
  } catch (error) {
    finishChannelOperation(
      operation,
      "failed",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }

  return operation;
}

async function installChannelPluginFromDashboard(channelId: string) {
  const template = getChannelSetupTemplate(channelId);
  if (!template?.installPath) {
    throw new Error(`No install path registered for ${channelId}.`);
  }
  const operation = await runOpenClawCliOperation({
    kind: "install",
    channelId,
    args: ["plugins", "install", template.installPath, "--link"],
  });
  appendChannelOperationLog(
    operation,
    "Plugin installed. Restart the gateway if the channel does not appear immediately.",
  );
  return operation;
}

async function loginChannelFromDashboard(body: JsonRecord) {
  const channelId = normalizeOptionalString(body.channelId);
  if (!channelId) {
    throw new Error("channelId required");
  }
  const args = ["channels", "login", "--channel", channelId];
  const accountId = normalizeOptionalString(body.accountId);
  if (accountId) {
    args.push("--account", accountId);
  }
  if (body.verbose === true) {
    args.push("--verbose");
  }
  return await runOpenClawCliOperation({
    kind: "login",
    channelId,
    accountId,
    args,
  });
}

async function logoutChannelFromDashboard(body: JsonRecord) {
  const channelId = normalizeOptionalString(body.channelId);
  if (!channelId) {
    throw new Error("channelId required");
  }
  const args = ["channels", "logout", "--channel", channelId];
  const accountId = normalizeOptionalString(body.accountId);
  if (accountId) {
    args.push("--account", accountId);
  }
  return await runOpenClawCliOperation({
    kind: "logout",
    channelId,
    accountId,
    args,
  });
}

async function removeChannelFromDashboard(body: JsonRecord) {
  const channelId = normalizeOptionalString(body.channelId);
  if (!channelId) {
    throw new Error("channelId required");
  }
  const args = ["channels", "remove", "--channel", channelId];
  const accountId = normalizeOptionalString(body.accountId);
  if (accountId) {
    args.push("--account", accountId);
  }
  if (body.deleteConfig !== false) {
    args.push("--delete");
  }
  return await runOpenClawCliOperation({
    kind: "remove",
    channelId,
    accountId,
    args,
  });
}

async function saveChannelInboundBindingFromDashboard(req: IncomingMessage, body: JsonRecord) {
  const channelId = normalizeOptionalString(body.channelId);
  if (!channelId) {
    throw new Error("channelId required");
  }
  const accountId = normalizeAccountId(body.accountId);
  const desiredAgentId = normalizeOptionalString(body.agentId);
  if (desiredAgentId) {
    const store = await loadStore([], []);
    if (!store.agentBindings.some((binding) => binding.agentId === desiredAgentId)) {
      throw new Error(`Unknown agentId: ${desiredAgentId}`);
    }
  }
  await syncOpenClawInboundBinding({
    channelId,
    accountId,
    ...(desiredAgentId ? { agentId: desiredAgentId } : {}),
  });
  await syncManagedInboundAllowlists({
    gatewayUrl: readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL),
    gatewayToken: readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN),
  });
  return {
    channelId: normalizeChannelBindingId(channelId),
    accountId,
    ...(desiredAgentId ? { agentId: desiredAgentId } : {}),
  };
}

async function handleStoreMutation(
  req: IncomingMessage,
  resource: string,
  method: string,
  body: JsonRecord,
  id?: string,
) {
  if (!STORE_RESOURCES.has(resource)) {
    throw new Error(`Unknown store resource: ${resource}`);
  }
  const existing = await loadStore([], []);
  const collection = [...((existing as unknown as Record<string, unknown[]>)[resource] || [])];
  const now = new Date().toISOString();
  const shouldSyncInboundAllowlists =
    resource === "users" ||
    resource === "teams" ||
    resource === "grants" ||
    resource === "channels" ||
    resource === "agentBindings";
  const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
  const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);

  if (method === "POST") {
    const { recurrence: _ignoredRecurrence, ...sanitizedBody } = body;
    const entry =
      resource === "providerBridges"
        ? normalizeProviderBridge(
            {
              ...sanitizedBody,
              id: stringifyUnknown(body.id, randomUUID()),
              createdAt: stringifyUnknown(body.createdAt, now),
            },
            now,
          )
        : resource === "pipelines"
          ? {
              ...sanitizedBody,
              id: stringifyUnknown(body.id, randomUUID()),
              createdAt: stringifyUnknown(body.createdAt, now),
              updatedAt: now,
              nodePositions: normalizePipelineNodePositions(body.nodePositions),
              ...(normalizePipelineViewport(body.viewport) !== undefined
                ? { viewport: normalizePipelineViewport(body.viewport) }
                : {}),
            }
          : resource === "cronJobs"
            ? normalizeCustomCronJob(
                existing,
                {
                  ...sanitizedBody,
                  id: stringifyUnknown(body.id, randomUUID()),
                  createdAt: stringifyUnknown(body.createdAt, now),
                },
                now,
              )
            : resource === "channels"
              ? normalizeDashboardChannelRecord(
                  {
                    ...body,
                    id: stringifyUnknown(body.id, ""),
                    createdAt: stringifyUnknown(body.createdAt, now),
                    source: body.source === "detected" ? "detected" : "custom",
                  },
                  now,
                )
              : resource === "users"
                ? normalizeDashboardUserRecord(
                    {
                      ...sanitizedBody,
                      id: stringifyUnknown(body.id, randomUUID()),
                      createdAt: stringifyUnknown(body.createdAt, now),
                    },
                    now,
                  )
                : resource === "teams"
                  ? normalizeDashboardTeamRecord(
                      {
                        ...sanitizedBody,
                        id: stringifyUnknown(body.id, randomUUID()),
                        createdAt: stringifyUnknown(body.createdAt, now),
                      },
                      now,
                    )
                  : resource === "projects"
                    ? normalizeDashboardProjectRecord(
                        {
                          ...sanitizedBody,
                          id: stringifyUnknown(body.id, randomUUID()),
                          createdAt: stringifyUnknown(body.createdAt, now),
                        },
                        now,
                      )
                  : resource === "grants"
                    ? normalizeAccessGrantRecord(
                        {
                          ...sanitizedBody,
                          id: stringifyUnknown(body.id, randomUUID()),
                          createdAt: stringifyUnknown(body.createdAt, now),
                        },
                        now,
                      )
                    : {
                        ...sanitizedBody,
                        id: stringifyUnknown(body.id, randomUUID()),
                        createdAt: stringifyUnknown(body.createdAt, now),
                        updatedAt: now,
                      };
    if (resource === "channels") {
      const duplicateIndex = collection.findIndex(
        (candidate) => String((candidate as JsonRecord).id) === String((entry as JsonRecord).id),
      );
      if (duplicateIndex >= 0) {
        assertDashboardStoreMutationAllowed({
          req,
          store: existing,
          resource,
          action: "patch",
          entry,
          id: stringifyUnknown((entry as JsonRecord).id),
        });
        collection[duplicateIndex] = entry;
        (existing as unknown as Record<string, unknown[]>)[resource] = collection;
        syncUserTeamMemberships(existing);
        syncTeamScopes(existing);
        syncProjectScopes(existing);
        await saveStore(DEFAULT_STORE_PATH, existing);
        if (shouldSyncInboundAllowlists) {
          await syncManagedInboundAllowlists({ gatewayUrl, gatewayToken, store: existing });
        }
        return entry;
      }
    }
    assertDashboardStoreMutationAllowed({
      req,
      store: existing,
      resource,
      action: "create",
      entry,
    });
    collection.push(entry);
    (existing as unknown as Record<string, unknown[]>)[resource] = collection;
    syncUserTeamMemberships(existing);
    syncTeamScopes(existing);
    syncProjectScopes(existing);
    await saveStore(DEFAULT_STORE_PATH, existing);
    if (shouldSyncInboundAllowlists) {
      await syncManagedInboundAllowlists({ gatewayUrl, gatewayToken, store: existing });
    }
    return entry;
  }

  if (!id) {
    throw new Error(`Missing id for ${resource} mutation`);
  }

  const index = collection.findIndex((entry) => String((entry as JsonRecord).id) === id);
  if (index < 0) {
    throw new Error(`Unknown ${resource} id: ${id}`);
  }

  if (method === "PUT" || method === "PATCH") {
    const current = collection[index] as JsonRecord;
    const { recurrence: _ignoredRecurrence, ...sanitizedBody } = body;
    const next =
      resource === "providerBridges"
        ? normalizeProviderBridge(
            method === "PATCH"
              ? { ...current, ...sanitizedBody, id, createdAt: current.createdAt || now }
              : { ...sanitizedBody, id, createdAt: current.createdAt || now },
            now,
            current as Partial<ProviderBridge>,
          )
        : resource === "pipelines"
          ? (() => {
              const base =
                method === "PATCH"
                  ? { ...current, ...sanitizedBody, id, updatedAt: now }
                  : { ...sanitizedBody, id, createdAt: current.createdAt || now, updatedAt: now };
              const viewport = normalizePipelineViewport(base.viewport);
              return {
                ...base,
                nodePositions: normalizePipelineNodePositions(base.nodePositions),
                ...(viewport !== undefined ? { viewport } : {}),
              };
            })()
          : resource === "cronJobs"
            ? normalizeCustomCronJob(
                existing,
                method === "PATCH"
                  ? { ...current, ...sanitizedBody, id, createdAt: current.createdAt || now }
                  : { ...sanitizedBody, id, createdAt: current.createdAt || now },
                now,
                current,
              )
            : resource === "channels"
              ? normalizeDashboardChannelRecord(
                  method === "PATCH"
                    ? { ...current, ...sanitizedBody, id, createdAt: current.createdAt || now }
                    : { ...sanitizedBody, id, createdAt: current.createdAt || now },
                  now,
                  current as Partial<DashboardChannel>,
                )
              : resource === "users"
                ? normalizeDashboardUserRecord(
                    method === "PATCH"
                      ? { ...current, ...sanitizedBody, id, createdAt: current.createdAt || now }
                      : { ...sanitizedBody, id, createdAt: current.createdAt || now },
                    now,
                    current as Partial<DashboardUser>,
                  )
                : resource === "teams"
                  ? normalizeDashboardTeamRecord(
                      method === "PATCH"
                        ? { ...current, ...sanitizedBody, id, createdAt: current.createdAt || now }
                        : { ...sanitizedBody, id, createdAt: current.createdAt || now },
                      now,
                      current as Partial<DashboardTeam>,
                    )
                  : resource === "projects"
                    ? normalizeDashboardProjectRecord(
                        method === "PATCH"
                          ? { ...current, ...sanitizedBody, id, createdAt: current.createdAt || now }
                          : { ...sanitizedBody, id, createdAt: current.createdAt || now },
                        now,
                        current as Partial<DashboardProject>,
                      )
                  : resource === "grants"
                    ? normalizeAccessGrantRecord(
                        method === "PATCH"
                          ? {
                              ...current,
                              ...sanitizedBody,
                              id,
                              createdAt: current.createdAt || now,
                            }
                          : { ...sanitizedBody, id, createdAt: current.createdAt || now },
                        now,
                        current as Partial<AccessGrant>,
                      )
                    : method === "PATCH"
                      ? { ...current, ...sanitizedBody, id, updatedAt: now }
                      : {
                          ...sanitizedBody,
                          id,
                          createdAt: current.createdAt || now,
                          updatedAt: now,
                        };
    assertDashboardStoreMutationAllowed({
      req,
      store: existing,
      resource,
      action: "patch",
      entry: next,
      id,
    });
    collection[index] = next;
    (existing as unknown as Record<string, unknown[]>)[resource] = collection;
    syncUserTeamMemberships(existing);
    syncTeamScopes(existing);
    syncProjectScopes(existing);
    await saveStore(DEFAULT_STORE_PATH, existing);
    if (shouldSyncInboundAllowlists) {
      await syncManagedInboundAllowlists({ gatewayUrl, gatewayToken, store: existing });
    }
    return next;
  }

  if (method === "DELETE") {
    assertDashboardStoreMutationAllowed({
      req,
      store: existing,
      resource,
      action: "delete",
      entry: collection[index],
      id,
    });
    const [removed] = collection.splice(index, 1);
    (existing as unknown as Record<string, unknown[]>)[resource] = collection;
    syncUserTeamMemberships(existing);
    syncTeamScopes(existing);
    syncProjectScopes(existing);
    await saveStore(DEFAULT_STORE_PATH, existing);
    if (shouldSyncInboundAllowlists) {
      await syncManagedInboundAllowlists({ gatewayUrl, gatewayToken, store: existing });
    }
    return removed;
  }

  throw new Error(`Unsupported store method: ${method}`);
}

async function applyAgentSkillFilterRuntimeConfig(params: {
  gatewayUrl: string;
  gatewayToken: string;
  agentId: string;
  skillPolicy: "all" | "selected" | "none";
  skillIds: string[];
}) {
  const configGet = await gatewayBatch(params.gatewayUrl, params.gatewayToken, {
    config: { method: "config.get", params: {} },
  });
  const payload = (configGet.results.config as JsonRecord | undefined) || {};
  const baseHash = normalizeOptionalString(payload.hash);
  if (!baseHash) {
    throw new Error("Gateway config hash unavailable; retry after refreshing the dashboard.");
  }

  const config = isJsonRecord(payload.config) ? payload.config : {};
  const nextConfig = structuredClone(config);
  const agentsConfig = isJsonRecord(nextConfig.agents) ? nextConfig.agents : {};
  const currentList = Array.isArray(agentsConfig.list) ? [...agentsConfig.list] : [];
  const targetIndex = currentList.findIndex(
    (entry) => isJsonRecord(entry) && normalizeOptionalString(entry.id) === params.agentId,
  );
  if (targetIndex < 0) {
    throw new Error(`Agent ${params.agentId} not found in runtime config.`);
  }

  const targetEntry = isJsonRecord(currentList[targetIndex])
    ? { ...currentList[targetIndex] }
    : { id: params.agentId };

  if (params.skillPolicy === "all") {
    delete targetEntry.skills;
  } else if (params.skillPolicy === "none") {
    targetEntry.skills = [];
  } else {
    targetEntry.skills = params.skillIds;
  }

  currentList[targetIndex] = targetEntry;
  agentsConfig.list = currentList;
  nextConfig.agents = agentsConfig;

  const applied = await gatewayBatch(params.gatewayUrl, params.gatewayToken, {
    apply: {
      method: "config.apply",
      params: {
        raw: JSON.stringify(nextConfig, null, 2),
        baseHash,
      },
    },
  });
  await sleep(3000);
  await ensureGatewayAvailable(params.gatewayUrl);
  return applied.results.apply || null;
}

function cleanupDeletedAgentFromStore(store: ControlTowerStore, agentId: string) {
  store.agentBindings = store.agentBindings.filter((binding) => binding.agentId !== agentId);
  store.users = store.users.map((user) => ({
    ...user,
    agentIds: user.agentIds.filter((entry) => entry !== agentId),
  }));
  store.teams = store.teams.map((team) => ({
    ...team,
    agentIds: team.agentIds.filter((entry) => entry !== agentId),
  }));
  store.pipelines = store.pipelines.map((pipeline) => {
    const survivingSteps = pipeline.steps.filter((step) => step.agentId !== agentId);
    const survivingStepIds = new Set(survivingSteps.map((step) => step.id));
    return {
      ...pipeline,
      agentIds: pipeline.agentIds.filter((entry) => entry !== agentId),
      steps: survivingSteps.map((step) => ({
        ...step,
        nextStepIds: (step.nextStepIds || []).filter((nextStepId) =>
          survivingStepIds.has(nextStepId),
        ),
      })),
    };
  });
  store.cronJobs = store.cronJobs.filter((job) => job.agentId !== agentId);
  store.grants = store.grants.filter(
    (grant) => !(grant.resourceType === "agent" && grant.resourceId === agentId),
  );
  syncTeamScopes(store);
  syncProjectScopes(store);
}

async function createAgentInStoreAndGateway(req: IncomingMessage, body: JsonRecord) {
  const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
  const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
  const name = normalizeOptionalString(body.name);
  const workspace = normalizeOptionalString(body.workspace);

  if (!name || !workspace) {
    throw new Error("name and workspace are required");
  }

  const avatar = normalizeOptionalString(body.avatar);
  const emoji = normalizeOptionalString(body.emoji);
  const modelRef = normalizeOptionalString(body.modelRef);
  const thinkingLevel = normalizeOptionalString(body.thinkingLevel);
  const fastMode = typeof body.fastMode === "boolean" ? body.fastMode : undefined;
  const verboseLevel = normalizeOptionalString(body.verboseLevel);
  const reasoningLevel = normalizeOptionalString(body.reasoningLevel);
  const skillIds = splitListInput(body.skillIds);
  const store = await loadStore([], []);
  const outputRouteChannelIds = store.channels
    .filter((channel) => isOutputRouteChannelRecord(channel))
    .map((channel) => channel.id);
  const channelIds =
    body.channelIds !== undefined ? normalizeIdList(body.channelIds) : outputRouteChannelIds;
  const providerIds = body.providerIds !== undefined ? normalizeIdList(body.providerIds) : [];
  const skillPolicy = normalizeSkillPolicy(body.skillPolicy, skillIds);

  const created = await gatewayBatch(gatewayUrl, gatewayToken, {
    create: {
      method: "agents.create",
      params: {
        name,
        workspace,
        ...(avatar ? { avatar } : {}),
        ...(emoji ? { emoji } : {}),
      },
    },
  });

  const createPayload = (created.results.create as JsonRecord | undefined) || {};
  const agentId = normalizeOptionalString(createPayload.agentId);
  if (!agentId) {
    throw new Error("Gateway did not return an agentId");
  }

  let runtimeUpdate: unknown = null;
  if (modelRef) {
    const updated = await gatewayBatch(gatewayUrl, gatewayToken, {
      update: {
        method: "agents.update",
        params: {
          agentId,
          model: modelRef,
        },
      },
    });
    runtimeUpdate = updated.results.update || null;
  }

  let runtimeSkills: unknown = null;
  if (skillPolicy !== "all" || skillIds.length > 0) {
    runtimeSkills = await applyAgentSkillFilterRuntimeConfig({
      gatewayUrl,
      gatewayToken,
      agentId,
      skillPolicy,
      skillIds,
    });
  }
  const now = new Date().toISOString();
  const ownerId = normalizeOptionalString(body.ownerId) || store.users[0]?.id;
  const teamId = normalizeOptionalString(body.teamId) || store.teams[0]?.id;
  const accessTeamIds =
    body.accessTeamIds !== undefined ? normalizeIdList(body.accessTeamIds) : teamId ? [teamId] : [];
  const purpose = normalizeOptionalString(body.purpose) || `Pilotage de l'agent ${agentId}`;
  const tags = splitListInput(body.tags);
  const defaultOutputChannelIds =
    body.defaultOutputChannelIds !== undefined ? normalizeIdList(body.defaultOutputChannelIds) : [];
  const providerAccountIds = normalizeProviderAccountIds(body.providerAccountIds);
  const providerSkillPolicies = normalizeProviderSkillPolicies(body.providerSkillPolicies);
  const resumePolicy = normalizeResumePolicy(body.resumePolicy);
  const dispatchPolicy = normalizeDispatchPolicy(body.dispatchPolicy);

  const binding: AgentBinding = {
    id: agentId,
    agentId,
    ownerId,
    teamId,
    purpose,
    channelIds,
    defaultOutputChannelIds,
    providerIds,
    providerAccountIds: Object.fromEntries(
      Object.entries(providerAccountIds).filter(
        ([providerId, accountIds]) => providerIds.includes(providerId) && accountIds.length > 0,
      ),
    ),
    providerSkillPolicies,
    skillPolicy,
    skillIds,
    tags,
    preferredModelRef: modelRef,
    resumePolicy,
    dispatchPolicy,
    thinkingLevel,
    fastMode,
    verboseLevel,
    reasoningLevel,
    createdAt: now,
    updatedAt: now,
  };

  store.agentBindings = [
    ...store.agentBindings.filter((entry) => entry.agentId !== agentId),
    binding,
  ];
  syncAgentAccessTeamsInStore({
    store,
    agentId,
    ownerTeamId: teamId,
    accessTeamIds,
  });
  syncUserTeamMemberships(store);
  syncTeamScopes(store);
  syncProjectScopes(store);
  await saveStore(DEFAULT_STORE_PATH, store);
  await syncManagedInboundAllowlists({ gatewayUrl, gatewayToken, store });
  if (skillPolicy !== "all" || skillIds.length > 0) {
    await invalidateSkillSnapshotsForAgentIds([agentId]);
  }

  return {
    create: createPayload,
    update: runtimeUpdate,
    skills: runtimeSkills,
    binding,
  };
}

async function updateAgentInStoreAndGateway(
  req: IncomingMessage,
  agentId: string,
  body: JsonRecord,
) {
  const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
  const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
  const store = await loadStore([], []);
  const now = new Date().toISOString();

  const runtimePatch: JsonRecord = { agentId };
  const name = normalizeOptionalString(body.name);
  const workspace = normalizeOptionalString(body.workspace);
  const avatar = normalizeOptionalString(body.avatar);
  const emoji = normalizeOptionalString(body.emoji);
  const modelRef = normalizeOptionalString(body.modelRef);
  const thinkingLevel = normalizeOptionalString(body.thinkingLevel);
  const fastMode = typeof body.fastMode === "boolean" ? body.fastMode : undefined;
  const verboseLevel = normalizeOptionalString(body.verboseLevel);
  const reasoningLevel = normalizeOptionalString(body.reasoningLevel);
  const channelIds = body.channelIds !== undefined ? normalizeIdList(body.channelIds) : undefined;
  const defaultOutputChannelIds =
    body.defaultOutputChannelIds !== undefined
      ? normalizeIdList(body.defaultOutputChannelIds)
      : undefined;
  const providerIds =
    body.providerIds !== undefined ? normalizeIdList(body.providerIds) : undefined;
  const providerAccountIds =
    body.providerAccountIds !== undefined
      ? normalizeProviderAccountIds(body.providerAccountIds)
      : undefined;
  const providerSkillPolicies =
    body.providerSkillPolicies !== undefined
      ? normalizeProviderSkillPolicies(body.providerSkillPolicies)
      : undefined;
  const accessTeamIds =
    body.accessTeamIds !== undefined ? normalizeIdList(body.accessTeamIds) : undefined;
  const skillIds = body.skillIds !== undefined ? splitListInput(body.skillIds) : undefined;
  const skillPolicy =
    body.skillPolicy !== undefined || skillIds !== undefined
      ? normalizeSkillPolicy(body.skillPolicy, skillIds || [])
      : undefined;
  if (name) {
    runtimePatch.name = name;
  }
  if (workspace) {
    runtimePatch.workspace = workspace;
  }
  if (avatar) {
    runtimePatch.avatar = avatar;
  }
  if (emoji) {
    runtimePatch.emoji = emoji;
  }
  if (modelRef) {
    runtimePatch.model = modelRef;
  }

  let runtimeUpdate: unknown = null;
  if (Object.keys(runtimePatch).length > 1) {
    const updated = await gatewayBatch(gatewayUrl, gatewayToken, {
      update: {
        method: "agents.update",
        params: runtimePatch,
      },
    });
    runtimeUpdate = updated.results.update || null;
  }

  let runtimeSkills: unknown = null;
  if (skillPolicy !== undefined) {
    runtimeSkills = await applyAgentSkillFilterRuntimeConfig({
      gatewayUrl,
      gatewayToken,
      agentId,
      skillPolicy,
      skillIds: skillIds || [],
    });
  }

  const currentBinding =
    store.agentBindings.find((entry) => entry.agentId === agentId) ||
    ({
      id: agentId,
      agentId,
      ownerId: store.users[0]?.id,
      teamId: store.teams[0]?.id,
      purpose: `Pilotage de l'agent ${agentId}`,
      channelIds: store.channels
        .filter((channel) => isOutputRouteChannelRecord(channel))
        .map((channel) => channel.id),
      defaultOutputChannelIds: [],
      providerIds: [],
      providerAccountIds: {},
      providerSkillPolicies: {},
      skillPolicy: "all",
      skillIds: [],
      tags: [],
      resumePolicy: "manual",
      dispatchPolicy: "manual",
      thinkingLevel: undefined,
      fastMode: undefined,
      verboseLevel: undefined,
      reasoningLevel: undefined,
      createdAt: now,
      updatedAt: now,
    } satisfies AgentBinding);

  const nextBinding: AgentBinding = {
    ...currentBinding,
    ownerId: normalizeOptionalString(body.ownerId) || currentBinding.ownerId,
    teamId: normalizeOptionalString(body.teamId) || currentBinding.teamId,
    purpose: normalizeOptionalString(body.purpose) || currentBinding.purpose,
    channelIds: channelIds !== undefined ? channelIds : currentBinding.channelIds,
    defaultOutputChannelIds:
      defaultOutputChannelIds !== undefined
        ? defaultOutputChannelIds
        : currentBinding.defaultOutputChannelIds,
    providerIds: providerIds !== undefined ? providerIds : currentBinding.providerIds,
    providerAccountIds:
      providerAccountIds !== undefined
        ? Object.fromEntries(
            Object.entries(providerAccountIds).filter(([providerId, accountIds]) => {
              const effectiveProviderIds =
                providerIds !== undefined ? providerIds : currentBinding.providerIds;
              return effectiveProviderIds.includes(providerId) && accountIds.length > 0;
            }),
          )
        : currentBinding.providerAccountIds,
    providerSkillPolicies:
      providerSkillPolicies !== undefined
        ? providerSkillPolicies
        : currentBinding.providerSkillPolicies,
    skillPolicy: skillPolicy || currentBinding.skillPolicy,
    skillIds: skillIds !== undefined ? skillIds : currentBinding.skillIds,
    tags: body.tags !== undefined ? splitListInput(body.tags) : currentBinding.tags,
    preferredModelRef: body.modelRef !== undefined ? modelRef : currentBinding.preferredModelRef,
    resumePolicy:
      body.resumePolicy !== undefined
        ? normalizeResumePolicy(body.resumePolicy)
        : currentBinding.resumePolicy,
    dispatchPolicy:
      body.dispatchPolicy !== undefined
        ? normalizeDispatchPolicy(body.dispatchPolicy)
        : currentBinding.dispatchPolicy,
    thinkingLevel: body.thinkingLevel !== undefined ? thinkingLevel : currentBinding.thinkingLevel,
    fastMode: body.fastMode !== undefined ? fastMode : currentBinding.fastMode,
    verboseLevel: body.verboseLevel !== undefined ? verboseLevel : currentBinding.verboseLevel,
    reasoningLevel:
      body.reasoningLevel !== undefined ? reasoningLevel : currentBinding.reasoningLevel,
    updatedAt: now,
  };

  store.agentBindings = [
    ...store.agentBindings.filter((entry) => entry.agentId !== agentId),
    nextBinding,
  ];
  syncAgentAccessTeamsInStore({
    store,
    agentId,
    ownerTeamId: nextBinding.teamId,
    accessTeamIds:
      accessTeamIds ||
      store.teams
        .filter((team) => normalizeIdList(team.agentIds).includes(agentId))
        .map((team) => team.id),
  });
  syncUserTeamMemberships(store);
  syncTeamScopes(store);
  syncProjectScopes(store);
  await saveStore(DEFAULT_STORE_PATH, store);
  await syncManagedInboundAllowlists({ gatewayUrl, gatewayToken, store });
  if (skillPolicy !== undefined) {
    await invalidateSkillSnapshotsForAgentIds([agentId]);
  }

  return {
    update: runtimeUpdate,
    skills: runtimeSkills,
    binding: nextBinding,
  };
}

async function deleteAgentInStoreAndGateway(
  req: IncomingMessage,
  agentId: string,
  deleteFiles: boolean,
) {
  const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
  const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
  const deleted = await gatewayBatch(gatewayUrl, gatewayToken, {
    delete: {
      method: "agents.delete",
      params: {
        agentId,
        deleteFiles,
      },
    },
  });

  const store = await loadStore([], []);
  cleanupDeletedAgentFromStore(store, agentId);
  await saveStore(DEFAULT_STORE_PATH, store);
  await syncManagedInboundAllowlists({ gatewayUrl, gatewayToken, store });

  return {
    delete: deleted.results.delete || null,
  };
}

async function resolveCliproxyBridge() {
  const store = await loadStore([], []);
  const { bridge: syncedBridge, changed } = await syncCliproxyBridgeInStore(store);
  if (changed) {
    await saveStore(DEFAULT_STORE_PATH, store);
  }
  const bridge = syncedBridge || store.providerBridges[0];
  if (!bridge) {
    throw new Error("No provider control plane configured.");
  }
  return bridge;
}

async function saveCliproxySection(bridge: ProviderBridge, section: string, value: unknown) {
  const response = await fetchJsonWithDetail(
    `${buildCliproxyManagementBaseUrl(bridge)}/${section}`,
    {
      method: "PUT",
      headers: {
        ...buildCliproxyManagementHeaders(bridge),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    },
  );
  if (!response.ok) {
    throw new Error(response.text || `Provider section update failed (${response.status})`);
  }
}

async function startCliproxyOauthFlow(bridge: ProviderBridge, provider: string) {
  const allowedProviders = new Set([
    "anthropic",
    "codex",
    "gemini-cli",
    "antigravity",
    "qwen",
    "iflow",
  ]);
  if (!allowedProviders.has(provider)) {
    throw new Error(`Unsupported OAuth provider: ${provider}`);
  }
  const response = await fetchJsonWithDetail(
    `${buildCliproxyManagementBaseUrl(bridge)}/${provider}-auth-url?is_webui=true`,
    {
      headers: buildCliproxyManagementHeaders(bridge),
    },
  );
  if (!response.ok || !isJsonRecord(response.json)) {
    throw new Error(response.text || `OAuth start failed (${response.status})`);
  }
  const url = normalizeOptionalString((response.json as JsonRecord).url);
  const state = normalizeOptionalString((response.json as JsonRecord).state);
  if (!url || !state) {
    throw new Error("OAuth start returned no url/state.");
  }
  return { ok: true, provider, url, state };
}

function normalizeCliproxyOauthProvider(provider: string) {
  const aliases: Record<string, string> = {
    "gemini-cli": "gemini",
  };
  return aliases[provider] || provider;
}

async function pollCliproxyOauthFlow(bridge: ProviderBridge, state: string) {
  const response = await fetchJsonWithDetail(
    `${buildCliproxyManagementBaseUrl(bridge)}/get-auth-status?state=${encodeURIComponent(state)}`,
    {
      headers: buildCliproxyManagementHeaders(bridge),
    },
  );
  if (!response.ok || !isJsonRecord(response.json)) {
    throw new Error(response.text || `OAuth status failed (${response.status})`);
  }
  const payload = response.json as JsonRecord;
  const status = normalizeOptionalString(payload.status) || "wait";
  return {
    ok: true,
    provider: normalizeOptionalString(payload.provider),
    state,
    status: status === "ok" || status === "error" || status === "wait" ? status : ("wait" as const),
    error: normalizeOptionalString(payload.error),
  };
}

async function submitCliproxyOauthCallback(
  bridge: ProviderBridge,
  provider: string,
  redirectUrl: string,
) {
  const normalizedProvider = normalizeCliproxyOauthProvider(provider);
  const response = await fetchJsonWithDetail(
    `${buildCliproxyManagementBaseUrl(bridge)}/oauth-callback`,
    {
      method: "POST",
      headers: {
        ...buildCliproxyManagementHeaders(bridge),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: normalizedProvider,
        redirect_url: redirectUrl,
      }),
    },
  );
  if (!response.ok || !isJsonRecord(response.json)) {
    throw new Error(response.text || `OAuth callback failed (${response.status})`);
  }
  const payload = response.json as JsonRecord;
  const status = normalizeOptionalString(payload.status) || "ok";
  return {
    ok: true,
    provider,
    redirectUrl,
    status: status === "error" ? "error" : ("ok" as const),
    error: normalizeOptionalString(payload.error),
  };
}

async function handleCtApi(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments[0] !== "ct-api") {
    sendJson(res, 404, { ok: false, error: "Not found" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ct-api/dashboard") {
    try {
      const dashboard = await buildDashboardSnapshot(req);
      lastDashboardPayload = dashboard as JsonRecord;
      sendJson(res, 200, dashboard);
    } catch (error) {
      if (lastDashboardPayload) {
        const previousMeta = isJsonRecord(lastDashboardPayload.meta)
          ? lastDashboardPayload.meta
          : {};
        const errorMessage = error instanceof Error ? error.message : String(error);
        sendJson(res, 200, {
          ...lastDashboardPayload,
          meta: {
            ...previousMeta,
            generatedAt: new Date().toISOString(),
            stale: true,
            reconnecting: true,
            staleError: errorMessage,
          },
        });
        return;
      }
      throw error;
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/ct-api/cliproxy/status") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut consulter l'etat providers.",
    );
    const bridge = await resolveCliproxyBridge();
    const status = await loadCliproxyStatus(bridge);
    sendJson(res, 200, status);
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/cliproxy/oauth/start") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut connecter un compte provider.",
    );
    const bridge = await resolveCliproxyBridge();
    const body = await readBody(req);
    const provider = normalizeOptionalString(body.provider);
    if (!provider) {
      throw new Error("provider is required");
    }
    const result = await startCliproxyOauthFlow(bridge, provider);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/cliproxy/import-openclaw-auth") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut importer des comptes provider.",
    );
    await resolveCliproxyBridge();
    const result = await importProjectLocalOpenClawAuthProfiles();
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/ct-api/runtime/env") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut consulter les env vars runtime.",
    );
    const result = await loadRuntimeEnvStatus();
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ct-api/runtime/link") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut consulter la config runtime locale.",
    );
    const result = await loadRuntimeLinkStatus();
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ct-api/skills/catalog") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut consulter le catalogue skills.",
    );
    const result = await loadSkillsCatalogForDashboard(req);
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ct-api/skills/content") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut lire les skills geres.",
    );
    const libraryId = normalizeOptionalString(url.searchParams.get("libraryId"));
    const dirName = normalizeOptionalString(url.searchParams.get("dirName"));
    if (!libraryId || !dirName) {
      throw new Error("libraryId and dirName are required.");
    }
    const result = await loadDashboardSkillContent(req, libraryId, dirName);
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/skills/content") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut modifier les skills.",
    );
    const body = await readBody(req);
    const result = await saveDashboardSkillContent(req, isJsonRecord(body) ? body : {});
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/ct-api/skills/content") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut supprimer des skills.",
    );
    const libraryId = normalizeOptionalString(url.searchParams.get("libraryId"));
    const dirName = normalizeOptionalString(url.searchParams.get("dirName"));
    if (!libraryId || !dirName) {
      throw new Error("libraryId and dirName are required.");
    }
    await deleteDashboardSkillContent(req, libraryId, dirName);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/skills/import") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut importer des skills.",
    );
    const body = await readBody(req);
    const result = await importDashboardSkillContent(req, isJsonRecord(body) ? body : {});
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/runtime/env") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut modifier les env vars runtime.",
    );
    const body = await readBody(req);
    const result = await saveRuntimeEnvValues(isJsonRecord(body) ? body : {});
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/runtime/link") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut modifier la config runtime locale.",
    );
    const body = await readBody(req);
    const result = await saveRuntimeLinkValues(isJsonRecord(body) ? body : {});
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/runtime/backend/restart") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut redemarrer le backend local.",
    );
    const result = await restartRuntimeBackend();
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ct-api/cliproxy/oauth/status") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut consulter l'etat OAuth provider.",
    );
    const bridge = await resolveCliproxyBridge();
    const state = normalizeOptionalString(url.searchParams.get("state"));
    if (!state) {
      throw new Error("state is required");
    }
    const result = await pollCliproxyOauthFlow(bridge, state);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/cliproxy/oauth/callback") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut finaliser une connexion provider.",
    );
    const bridge = await resolveCliproxyBridge();
    const body = await readBody(req);
    const provider = normalizeOptionalString(body.provider);
    const redirectUrl =
      normalizeOptionalString(body.redirectUrl) || normalizeOptionalString(body.callbackUrl);
    if (!provider) {
      throw new Error("provider is required");
    }
    if (!redirectUrl) {
      throw new Error("redirectUrl is required");
    }
    const result = await submitCliproxyOauthCallback(bridge, provider, redirectUrl);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/cliproxy/section") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut modifier la config providers.",
    );
    const bridge = await resolveCliproxyBridge();
    const body = await readBody(req);
    const section = normalizeOptionalString(body.section);
    const allowedSections = new Set([
      "gemini-api-key",
      "codex-api-key",
      "claude-api-key",
      "openai-compatibility",
      "oauth-excluded-models",
      "quota-exceeded/switch-project",
      "quota-exceeded/switch-preview-model",
    ]);
    if (!section || !allowedSections.has(section)) {
      throw new Error("Unsupported provider section.");
    }
    await saveCliproxySection(bridge, section, body.value);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/ct-api/cliproxy/auth-files") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut supprimer un compte provider.",
    );
    const bridge = await resolveCliproxyBridge();
    const name = normalizeOptionalString(url.searchParams.get("name"));
    if (!name) {
      throw new Error("name is required");
    }
    const response = await fetchJsonWithDetail(
      `${buildCliproxyManagementBaseUrl(bridge)}/auth-files?name=${encodeURIComponent(name)}`,
      {
        method: "DELETE",
        headers: buildCliproxyManagementHeaders(bridge),
      },
    );
    if (!response.ok) {
      throw new Error(response.text || `OAuth account delete failed (${response.status})`);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ct-api/channels/catalog") {
    const catalog = await buildChannelCatalog(req);
    sendJson(res, 200, catalog);
    return;
  }

  if (req.method === "GET" && url.pathname === "/ct-api/media/local") {
    const requestedPath = normalizeOptionalString(url.searchParams.get("path"));
    if (!requestedPath) {
      sendJson(res, 400, { ok: false, error: "path required" });
      return;
    }
    const resolved = await resolveDashboardLocalMediaFile(requestedPath);
    if ("error" in resolved) {
      if (resolved.error === "too-large") {
        sendJson(res, 413, { ok: false, error: "media file too large" });
        return;
      }
      sendJson(res, resolved.error === "outside-root" ? 403 : 404, {
        ok: false,
        error:
          resolved.error === "outside-root"
            ? "media path outside allowed roots"
            : "media file not found",
      });
      return;
    }
    const mimeType =
      (await detectMime({
        filePath: resolved.realPath,
      })) || "application/octet-stream";
    res.statusCode = 200;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Length", String(resolved.stat.size));
    res.setHeader("Content-Type", mimeType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    fsSync
      .createReadStream(resolved.realPath)
      .on("error", () => {
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: "unable to read media file" });
          return;
        }
        res.destroy();
      })
      .pipe(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/channels/configure") {
    const body = await readBody(req);
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut configurer un transport runtime.",
    );
    const operation = await configureChannelFromDashboard(req, body);
    sendJson(res, 200, { ok: true, operation });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/channels/install") {
    const body = await readBody(req);
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut installer un transport runtime.",
    );
    const channelId = normalizeOptionalString(body.channelId);
    if (!channelId) {
      sendJson(res, 400, { ok: false, error: "channelId required" });
      return;
    }
    const operation = await installChannelPluginFromDashboard(channelId);
    sendJson(res, 200, { ok: true, operation });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/channels/login") {
    const body = await readBody(req);
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut connecter un compte channel.",
    );
    const operation = await loginChannelFromDashboard(body);
    sendJson(res, 200, { ok: true, operation });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/channels/logout") {
    const body = await readBody(req);
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut deconnecter un compte channel.",
    );
    const operation = await logoutChannelFromDashboard(body);
    sendJson(res, 200, { ok: true, operation });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/channels/remove") {
    const body = await readBody(req);
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut supprimer un transport runtime.",
    );
    const operation = await removeChannelFromDashboard(body);
    sendJson(res, 200, { ok: true, operation });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/channels/inbound-binding") {
    const body = await readBody(req);
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut choisir l'agent inbound d'un bot.",
    );
    const result = await saveChannelInboundBindingFromDashboard(req, body);
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "GET" && segments[1] === "channels" && segments[2] === "ops" && segments[3]) {
    const operation = channelOperations.get(decodeURIComponent(segments[3]));
    if (!operation) {
      sendJson(res, 404, { ok: false, error: "Unknown channel operation" });
      return;
    }
    sendJson(res, 200, { ok: true, operation });
    return;
  }

  if (
    req.method === "POST" &&
    segments[1] === "pipelines" &&
    segments[2] &&
    segments[3] === "run"
  ) {
    const body = await readBody(req);
    const result = await runPipelineFromDashboard(req, decodeURIComponent(segments[2]), body);
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ct-api/pipeline-runs") {
    const pipelineId = normalizeOptionalString(url.searchParams.get("pipelineId"));
    const requestedLimit = Number(url.searchParams.get("limit") || "40");
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(200, requestedLimit)) : 40;
    const store = await loadStore([], []);
    const actor = resolveDashboardActorContext(req, store);
    const runs = store.pipelineRuns
      .filter((run) => {
        if (pipelineId && run.pipelineId !== pipelineId) {
          return false;
        }
        const pipeline = store.pipelines.find((entry) => entry.id === run.pipelineId);
        return pipeline
          ? actor.canViewPipelineRecord(pipeline)
          : actor.currentUserCanManageAdminViews;
      })
      .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, limit)
      .map((run) => buildPipelineRunSummary(run));
    sendJson(res, 200, { ok: true, runs });
    return;
  }

  if (req.method === "GET" && segments[1] === "pipeline-runs" && segments[2]) {
    const runId = decodeURIComponent(segments[2]);
    const store = await loadStore([], []);
    const run = store.pipelineRuns.find((entry) => entry.id === runId);
    if (!run) {
      sendJson(res, 404, { ok: false, error: "Unknown pipeline run" });
      return;
    }
    const actor = resolveDashboardActorContext(req, store);
    const pipeline = store.pipelines.find((entry) => entry.id === run.pipelineId);
    if (!pipeline || !actor.canViewPipelineRecord(pipeline)) {
      sendJson(res, 403, {
        ok: false,
        error: "Ce run pipeline n'est pas visible pour le user courant.",
      });
      return;
    }
    sendJson(res, 200, { ok: true, run });
    return;
  }

  if (req.method === "GET" && segments[1] === "sessions" && segments[3] === "history") {
    const sessionKey = decodeURIComponent(segments[2] || "");
    const limit = Number(url.searchParams.get("limit") || "100");
    const store = await loadStore([], []);
    const actor = resolveDashboardActorContext(req, store);
    const snapshot = await buildDashboardSnapshot(req);
    const sessionSummary = snapshot.sessions.find(
      (entry) => isJsonRecord(entry) && normalizeOptionalString(entry.key) === sessionKey,
    );
    if (!sessionSummary || !actor.canViewSessionRecord(sessionSummary as JsonRecord)) {
      sendJson(res, 403, {
        ok: false,
        error: "Cette session n'est pas visible pour le user courant.",
      });
      return;
    }
    const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
    const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
    await ensureGatewayAvailable(gatewayUrl);
    const response = await gatewayBatch(gatewayUrl, gatewayToken, {
      history: { method: "chat.history", params: { sessionKey, limit } },
    });
    const payload = (response.results.history as JsonRecord | undefined) || {};
    sendJson(res, 200, {
      ok: true,
      sessionKey,
      sessionId: payload.sessionId || null,
      messages: normalizeHistoryMessages(Array.isArray(payload.messages) ? payload.messages : []),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/sessions") {
    const body = await readBody(req);
    const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
    const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
    const agentId = normalizeOptionalString(body.agentId);
    const label = normalizeOptionalString(body.label);
    const model = normalizeOptionalString(body.model);
    const message = normalizeOptionalString(body.message);
    const projectId = normalizeOptionalString(body.projectId);

    if (!agentId) {
      sendJson(res, 400, { ok: false, error: "agentId required" });
      return;
    }

    const store = await loadStore([], []);
    const actor = resolveDashboardActorContext(req, store);
    if (!actor.canOperateAgentRecord(agentId)) {
      sendJson(res, 403, {
        ok: false,
        error: "Le user courant n'a pas le droit d'ouvrir un chat sur cet agent.",
      });
      return;
    }
    const agentBinding = store.agentBindings.find((entry) => entry.agentId === agentId);
    const dashboardPrincipalId =
      actor.user?.id || normalizeOptionalString(agentBinding?.ownerId) || undefined;
    const requestedSessionKey = dashboardPrincipalId
      ? `agent:${agentId.toLowerCase()}:dashboard:direct:${dashboardPrincipalId.toLowerCase()}`
      : undefined;
    const inheritedModelRef = normalizeOptionalString(
      store.agentBindings.find((entry) => entry.agentId === agentId)?.preferredModelRef,
    );
    const safeModel = await resolveSafeChatModelRef(model || inheritedModelRef);

    await ensureGatewayAvailable(gatewayUrl);
    const created = await gatewayBatch(gatewayUrl, gatewayToken, {
      create: {
        method: "sessions.create",
        params: {
          agentId,
          ...(requestedSessionKey ? { key: requestedSessionKey } : {}),
          ...(label ? { label } : {}),
          ...(safeModel ? { model: safeModel } : {}),
        },
      },
    });

    const createPayload = (created.results.create as JsonRecord | undefined) || {};
    const sessionKey = normalizeOptionalString(createPayload.key);
    if (!sessionKey) {
      sendJson(res, 502, { ok: false, error: "Gateway did not return a session key." });
      return;
    }

    if (projectId) {
      await patchPersistedSessionEntry({
        stateDir: buildRuntimeEnvStatusSync().effective.stateDir,
        sessionKey,
        patch: {
          projectId,
          runtimeProjectId: projectId,
        },
      }).catch(() => undefined);
    }

    const patchPayload: JsonRecord = {};
    const thinkingLevel = normalizeOptionalString(body.thinkingLevel);
    if (thinkingLevel) {
      patchPayload.thinkingLevel = thinkingLevel;
    }
    if (body.thinkingLevel === null) {
      patchPayload.thinkingLevel = null;
    }
    if (typeof body.fastMode === "boolean") {
      patchPayload.fastMode = body.fastMode;
    }
    if (body.fastMode === null) {
      patchPayload.fastMode = null;
    }
    const verboseLevel = normalizeOptionalString(body.verboseLevel);
    if (verboseLevel) {
      patchPayload.verboseLevel = verboseLevel;
    }
    if (body.verboseLevel === null) {
      patchPayload.verboseLevel = null;
    }
    const reasoningLevel = normalizeOptionalString(body.reasoningLevel);
    if (reasoningLevel) {
      patchPayload.reasoningLevel = reasoningLevel;
    }
    if (body.reasoningLevel === null) {
      patchPayload.reasoningLevel = null;
    }

    let patchResult: unknown = null;
    if (Object.keys(patchPayload).length > 0) {
      const patched = await gatewayBatch(gatewayUrl, gatewayToken, {
        patch: {
          method: "sessions.patch",
          params: {
            key: sessionKey,
            ...patchPayload,
          },
        },
      });
      patchResult = patched.results.patch || null;
    }

    let sendResult: unknown = null;
    if (message) {
      const sent = await gatewayBatch(gatewayUrl, gatewayToken, {
        send: {
          method: "chat.send",
          params: {
            sessionKey,
            message,
            idempotencyKey: randomUUID(),
          },
        },
      });
      sendResult = sent.results.send || null;
    }

    sendJson(res, 200, {
      ok: true,
      result: {
        key: sessionKey,
        sessionId: createPayload.sessionId || null,
        create: createPayload,
        patch: patchResult,
        send: sendResult,
        effectiveModel: safeModel || null,
        projectId: projectId || null,
      },
    });
    return;
  }

  if (req.method === "POST" && segments[1] === "sessions" && segments[3] === "send") {
    const sessionKey = decodeURIComponent(segments[2] || "");
    const body = await readBody(req);
    const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
    const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
    const message = stringifyUnknown(body.message).trim();
    const deliver = body.deliver === true;
    const attachments = Array.isArray(body.attachments)
      ? body.attachments.filter((entry) => entry && typeof entry === "object")
      : undefined;
    await ensureGatewayAvailable(gatewayUrl);
    const snapshot = await buildDashboardSnapshot(req);
    const sessionSummary = Array.isArray(snapshot.sessions)
      ? snapshot.sessions.find(
          (entry) => isJsonRecord(entry) && normalizeOptionalString(entry.key) === sessionKey,
        )
      : null;
    if (!sessionSummary) {
      sendJson(res, 403, {
        ok: false,
        error: "Cette session n'est pas accessible pour le user courant.",
      });
      return;
    }
    const store = await loadStore([], []);
    const actor = resolveDashboardActorContext(req, store);
    if (!actor.canOperateSessionRecord(sessionSummary as JsonRecord)) {
      sendJson(res, 403, {
        ok: false,
        error: "Le user courant n'a pas le droit d'ecrire dans cette session.",
      });
      return;
    }
    const inboundPrincipal =
      sessionSummary && isJsonRecord(sessionSummary.inboundPrincipal)
        ? (sessionSummary.inboundPrincipal as SessionInboundPrincipal)
        : undefined;
    if (inboundPrincipal?.status === "ambiguous") {
      sendJson(res, 403, {
        ok: false,
        error:
          inboundPrincipal.reason ||
          "Cette conversation bot correspond a plusieurs users Elytras. Corrige les externalIdentities avant d'utiliser Parler a l'agent.",
      });
      return;
    }
    if (inboundPrincipal?.status === "unresolved") {
      sendJson(res, 403, {
        ok: false,
        error:
          inboundPrincipal.reason ||
          "Cette conversation bot n'est pas mappee a un user Elytras. Associe d'abord l'identite externe a un user.",
      });
      return;
    }
    if (inboundPrincipal?.status === "resolved" && !inboundPrincipal.canUseAgent) {
      sendJson(res, 403, {
        ok: false,
        error:
          inboundPrincipal.reason ||
          `${inboundPrincipal.userName || "Cet utilisateur"} n'a pas le droit d'utiliser cet agent depuis ce bot.`,
      });
      return;
    }
    const healedModel = await healSessionModelIfNeeded(gatewayUrl, gatewayToken, sessionKey);
    const response = await gatewayBatch(gatewayUrl, gatewayToken, {
      send: {
        method: "chat.send",
        params: {
          sessionKey,
          message,
          ...(deliver ? { deliver: true } : {}),
          ...(attachments?.length ? { attachments } : {}),
          idempotencyKey: randomUUID(),
        },
      },
    });
    sendJson(res, 200, {
      ok: true,
      result: response.results.send || {},
      healedModel: healedModel || null,
    });
    return;
  }

  if (req.method === "POST" && segments[1] === "sessions" && segments[3] === "relay") {
    const sessionKey = decodeURIComponent(segments[2] || "");
    const body = await readBody(req);
    const store = await loadStore([], []);
    const actor = resolveDashboardActorContext(req, store);
    const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
    const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
    const message = stringifyUnknown(body.message).trim();
    const attachments = Array.isArray(body.attachments)
      ? body.attachments.filter((entry) => entry && typeof entry === "object")
      : [];
    if (!message && attachments.length === 0) {
      sendJson(res, 400, { ok: false, error: "message or attachment required" });
      return;
    }
    const snapshot = await buildDashboardSnapshot(req);
    const sessionSummary = snapshot.sessions.find(
      (entry) => isJsonRecord(entry) && normalizeOptionalString(entry.key) === sessionKey,
    );
    if (!sessionSummary || !actor.canOperateSessionRecord(sessionSummary as JsonRecord)) {
      sendJson(res, 403, {
        ok: false,
        error: "Le user courant n'a pas le droit de relayer cette session.",
      });
      return;
    }
    await ensureGatewayAvailable(gatewayUrl);
    const relayRoute = resolveDashboardRelayRoute(snapshot, sessionKey);
    const mediaUrls = await persistDashboardRelayAttachments({
      sessionKey,
      attachments: attachments as Array<{
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
      }>,
    });
    const response = await gatewayBatch(gatewayUrl, gatewayToken, {
      relay: {
        method: "send",
        params: {
          sessionKey,
          channel: relayRoute.channel,
          to: relayRoute.to,
          message,
          ...(relayRoute.accountId ? { accountId: relayRoute.accountId } : {}),
          ...(relayRoute.threadId ? { threadId: relayRoute.threadId } : {}),
          ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
          idempotencyKey: randomUUID(),
        },
      },
    });
    sendJson(res, 200, {
      ok: true,
      result: response.results.relay || {},
    });
    return;
  }

  if (req.method === "POST" && segments[1] === "sessions" && segments[3] === "reset") {
    const sessionKey = decodeURIComponent(segments[2] || "");
    const snapshot = await buildDashboardSnapshot(req);
    const sessionSummary = snapshot.sessions.find(
      (entry) => isJsonRecord(entry) && normalizeOptionalString(entry.key) === sessionKey,
    );
    const store = await loadStore([], []);
    const actor = resolveDashboardActorContext(req, store);
    if (!sessionSummary || !actor.canOperateSessionRecord(sessionSummary as JsonRecord)) {
      sendJson(res, 403, {
        ok: false,
        error: "Le user courant n'a pas le droit de reset cette session.",
      });
      return;
    }
    const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
    const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
    await ensureGatewayAvailable(gatewayUrl);
    const response = await gatewayBatch(gatewayUrl, gatewayToken, {
      reset: { method: "sessions.reset", params: { key: sessionKey } },
    });
    sendJson(res, 200, { ok: true, result: response.results.reset || {} });
    return;
  }

  if (req.method === "POST" && segments[1] === "sessions" && segments[3] === "patch") {
    const sessionKey = decodeURIComponent(segments[2] || "");
    const body = await readBody(req);
    const snapshot = await buildDashboardSnapshot(req);
    const sessionSummary = snapshot.sessions.find(
      (entry) => isJsonRecord(entry) && normalizeOptionalString(entry.key) === sessionKey,
    );
    const store = await loadStore([], []);
    const actor = resolveDashboardActorContext(req, store);
    if (!sessionSummary || !actor.canOperateSessionRecord(sessionSummary as JsonRecord)) {
      sendJson(res, 403, {
        ok: false,
        error: "Le user courant n'a pas le droit de modifier cette session.",
      });
      return;
    }
    const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
    const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
    await ensureGatewayAvailable(gatewayUrl);
    const requestedModel = Object.prototype.hasOwnProperty.call(body, "model")
      ? await resolveSafeChatModelRef(body.model)
      : undefined;
    const response = await gatewayBatch(gatewayUrl, gatewayToken, {
      patch: {
        method: "sessions.patch",
        params: {
          key: sessionKey,
          ...body,
          ...(Object.prototype.hasOwnProperty.call(body, "model")
            ? { model: body.model === null ? null : requestedModel || null }
            : {}),
        },
      },
    });
    sendJson(res, 200, { ok: true, result: response.results.patch || {} });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/agents") {
    const body = await readBody(req);
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut creer un agent.",
    );
    const result = await createAgentInStoreAndGateway(req, body);
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ct-api/agents/memory-engine") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut consulter la config memoire runtime.",
    );
    const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
    const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
    const status = await loadMemoryEngineStatus(gatewayUrl, gatewayToken);
    sendJson(res, 200, status);
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/agents/memory-engine/install") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut verifier le plugin memoire Elytras.",
    );
    const installedPlugins = await runOpenClawCliJson<OpenClawPluginListJson>([
      "plugins",
      "list",
      "--json",
    ]);
    const alreadyInstalled = Boolean(
      installedPlugins.plugins?.some(
        (plugin) => normalizeOptionalString(plugin.id) === "elytrasless",
      ),
    );
    const bundledManifestPath = path.join(
      DEFAULT_BACKEND_ROOT,
      "extensions",
      "elytrasless",
      "openclaw.plugin.json",
    );
    const bundledInRepo = fsSync.existsSync(bundledManifestPath);
    const result = {
      pluginId: "elytrasless",
      packageName: "@elytras/elytrasless",
      alreadyInstalled,
      command: bundledInRepo
        ? "Plugin fourni par le repo Elytras (build/restart runtime si besoin)."
        : "Plugin elytrasless introuvable dans le repo local.",
      message: alreadyInstalled
        ? "elytrasless est deja visible dans le runtime local."
        : bundledInRepo
          ? "elytrasless est bien bundle dans ce repo. Si le runtime ne le voit pas encore, rebuild puis redemarre OpenClaw."
          : "Le code source elytrasless n'est pas present dans ce repo.",
    };
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/agents/memory-engine/config") {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut modifier la config memoire runtime.",
    );
    const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
    const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
    const body = await readBody(req);
    const mode =
      normalizeOptionalString(body.mode) === "legacy"
        ? "legacy"
        : normalizeOptionalString(body.mode) === "elytrasless"
          ? "elytrasless"
          : normalizeOptionalString(body.mode) === "lossless-claw"
            ? "lossless-claw"
            : undefined;
    if (!mode) {
      sendJson(res, 400, {
        ok: false,
        error: "mode must be legacy, elytrasless, or lossless-claw",
      });
      return;
    }
    const configPatch = isJsonRecord(body.config) ? body.config : {};
    const clearFields: string[] = [];
    const losslessConfigPatch: JsonRecord = {};
    const hasConfigField = (key: string) => Object.prototype.hasOwnProperty.call(configPatch, key);
    const assignStringField = (
      key: "dbPath" | "storePath" | "dataRoot" | "auditLogPath" | "summaryModel" | "expansionModel",
    ) => {
      if (!hasConfigField(key)) {
        return;
      }
      const value = normalizeOptionalString(configPatch[key]);
      if (value) {
        losslessConfigPatch[key] = value;
      } else {
        clearFields.push(key);
      }
    };
    const assignNumberField = (
      key: "maxInjectedChars" | "freshTailCount" | "contextThreshold" | "incrementalMaxDepth",
    ) => {
      if (!hasConfigField(key)) {
        return;
      }
      const value = normalizeOptionalNumber(configPatch[key]);
      if (value !== undefined) {
        losslessConfigPatch[key] = value;
      } else {
        clearFields.push(key);
      }
    };
    const assignBooleanField = (
      key:
        | "injectUserContext"
        | "injectTeamContext"
        | "injectProjectContext"
        | "skipStatelessSessions",
    ) => {
      if (!hasConfigField(key)) {
        return;
      }
      const value = configPatch[key];
      if (typeof value === "boolean") {
        losslessConfigPatch[key] = value;
      } else {
        clearFields.push(key);
      }
    };

    assignStringField("dbPath");
    assignStringField("storePath");
    assignStringField("dataRoot");
    assignStringField("auditLogPath");
    assignStringField("summaryModel");
    assignStringField("expansionModel");
    assignNumberField("maxInjectedChars");
    assignNumberField("freshTailCount");
    assignNumberField("contextThreshold");
    assignNumberField("incrementalMaxDepth");
    assignBooleanField("injectUserContext");
    assignBooleanField("injectTeamContext");
    assignBooleanField("injectProjectContext");

    if (hasConfigField("ignoreSessionPatterns")) {
      losslessConfigPatch.ignoreSessionPatterns = Array.isArray(configPatch.ignoreSessionPatterns)
        ? normalizeStringArray(configPatch.ignoreSessionPatterns)
        : splitLineList(configPatch.ignoreSessionPatterns);
    }
    if (hasConfigField("statelessSessionPatterns")) {
      losslessConfigPatch.statelessSessionPatterns = Array.isArray(
        configPatch.statelessSessionPatterns,
      )
        ? normalizeStringArray(configPatch.statelessSessionPatterns)
        : splitLineList(configPatch.statelessSessionPatterns);
    }
    assignBooleanField("skipStatelessSessions");

    if (mode === "elytrasless" || mode === "lossless-claw") {
      const installedPlugins = await runOpenClawCliJson<OpenClawPluginListJson>([
        "plugins",
        "list",
        "--json",
      ]);
      const pluginInstalled = Boolean(
        installedPlugins.plugins?.some((plugin) => normalizeOptionalString(plugin.id) === mode),
      );
      if (!pluginInstalled) {
        sendJson(res, 400, {
          ok: false,
          error: `${mode} n’est pas disponible dans le runtime local. Verifie le plugin avant de l’activer.`,
        });
        return;
      }
    }

    const applied = await mutateGatewayConfig(gatewayUrl, gatewayToken, (currentConfig) => {
      const currentPlugins = isJsonRecord(currentConfig.plugins) ? currentConfig.plugins : {};
      const currentEntries = isJsonRecord(currentPlugins.entries) ? currentPlugins.entries : {};
      const currentEntry =
        mode !== "legacy" && isJsonRecord(currentEntries[mode]) ? currentEntries[mode] : {};
      const fallbackPluginId =
        mode === "elytrasless" ? "lossless-claw" : mode === "lossless-claw" ? "elytrasless" : "";
      const fallbackEntry =
        fallbackPluginId && isJsonRecord(currentEntries[fallbackPluginId])
          ? currentEntries[fallbackPluginId]
          : {};
      const inheritedManagedConfig =
        mode === "legacy"
          ? {}
          : {
              ...toManagedMemoryConfigPatch(fallbackEntry.config),
              ...toManagedMemoryConfigPatch(currentEntry.config),
            };
      if (mode === "elytrasless") {
        const runtimeEnv = buildRuntimeEnvStatusSync();
        const defaultDataRoot =
          normalizeOptionalString(process.env.ELYTRAS_DATA_ROOT) ||
          normalizeOptionalString(BOOTSTRAP_PROJECT_ENV_VALUES.ELYTRAS_DATA_ROOT) ||
          path.join(runtimeEnv.effective.runtimeDir, "elytras");
        inheritedManagedConfig.storePath =
          normalizeOptionalString(String(inheritedManagedConfig.storePath || "")) ||
          normalizeOptionalString(process.env.CONTROL_TOWER_STORE_PATH) ||
          normalizeOptionalString(BOOTSTRAP_PROJECT_ENV_VALUES.CONTROL_TOWER_STORE_PATH) ||
          path.join(runtimeEnv.effective.runtimeDir, "control-tower-store.json");
        inheritedManagedConfig.dataRoot =
          normalizeOptionalString(String(inheritedManagedConfig.dataRoot || "")) || defaultDataRoot;
        inheritedManagedConfig.auditLogPath =
          normalizeOptionalString(String(inheritedManagedConfig.auditLogPath || "")) ||
          path.join(defaultDataRoot, ".elytrasless", "events.jsonl");
      }
      for (const field of clearFields) {
        delete inheritedManagedConfig[field];
      }
      const nextManagedConfig =
        mode === "legacy"
          ? {}
          : {
              ...inheritedManagedConfig,
              ...losslessConfigPatch,
            };
      const inheritedSubagent =
        mode === "legacy"
          ? null
          : toManagedMemorySubagentPatch(currentEntry.subagent) ||
            toManagedMemorySubagentPatch(fallbackEntry.subagent);
      let nextConfig = setPluginSlot(
        currentConfig,
        "contextEngine",
        mode === "legacy" ? undefined : mode,
      );
      if (mode === "legacy") {
        return nextConfig;
      }
      nextConfig = upsertPluginEntryConfig(nextConfig, mode, nextManagedConfig, {
        clearFields,
        enabled: true,
      });
      const resolvedExpansionModel = normalizeOptionalString(nextManagedConfig.expansionModel);
      if (hasConfigField("expansionModel")) {
        nextConfig = upsertPluginEntrySubagent(nextConfig, mode, {
          allowModelOverride: Boolean(resolvedExpansionModel),
          allowedModels: resolvedExpansionModel ? [resolvedExpansionModel] : [],
        });
      } else if (inheritedSubagent) {
        nextConfig = upsertPluginEntrySubagent(nextConfig, mode, inheritedSubagent);
      } else if (resolvedExpansionModel) {
        nextConfig = upsertPluginEntrySubagent(nextConfig, mode, {
          allowModelOverride: true,
          allowedModels: [resolvedExpansionModel],
        });
      }
      if (mode === "elytrasless") {
        nextConfig = removePluginEntry(nextConfig, "lossless-claw", {
          removeInstall: true,
        });
      }
      return nextConfig;
    });
    sendJson(res, 200, { ok: true, result: { mode, applied } });
    return;
  }

  if (segments[1] === "agents" && segments[2]) {
    const agentId = decodeURIComponent(segments[2]);

    if (req.method === "GET" && segments[3] === "memory-insight") {
      const store = await loadStore([], []);
      const actor = resolveDashboardActorContext(req, store);
      if (!actor.canViewAgentRecord(agentId)) {
        sendJson(res, 403, {
          ok: false,
          error: "Cet agent n'est pas visible pour le user courant.",
        });
        return;
      }
      const searchTerm = url.searchParams.get("q") || "";
      const result = await loadAgentMemoryInsight(req, agentId, searchTerm);
      sendJson(res, 200, { ok: true, result });
      return;
    }

    if (req.method === "PATCH") {
      const body = await readBody(req);
      assertDashboardAdminAccess(
        req,
        await loadStore([], []),
        "Seul l'admin Elytras peut modifier un agent.",
      );
      const result = await updateAgentInStoreAndGateway(req, agentId, body);
      sendJson(res, 200, { ok: true, result });
      return;
    }

    if (req.method === "DELETE") {
      assertDashboardAdminAccess(
        req,
        await loadStore([], []),
        "Seul l'admin Elytras peut supprimer un agent.",
      );
      const deleteFiles = url.searchParams.get("deleteFiles") !== "0";
      const result = await deleteAgentInStoreAndGateway(req, agentId, deleteFiles);
      sendJson(res, 200, { ok: true, result });
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/ct-api/files/content") {
    const agentId = url.searchParams.get("agentId") || "main";
    const name = url.searchParams.get("name") || "";
    const store = await loadStore([], []);
    const actor = resolveDashboardActorContext(req, store);
    if (!actor.canViewAgentRecord(agentId)) {
      sendJson(res, 403, {
        ok: false,
        error: "Ce fichier agent n'est pas visible pour le user courant.",
      });
      return;
    }
    const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
    const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
    try {
      const response = await gatewayBatch(gatewayUrl, gatewayToken, {
        file: { method: "agents.files.get", params: { agentId, name } },
      });
      sendJson(res, 200, { ok: true, result: response.results.file || {} });
    } catch (error) {
      const fallback = await readAgentMarkdownDirect(
        gatewayUrl,
        gatewayToken,
        agentId,
        name,
        buildRuntimeEnvStatusSync().effective.workspaceDir,
      );
      void error;
      sendJson(res, 200, { ok: true, result: fallback });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/ct-api/files/content") {
    const body = await readBody(req);
    const agentId = normalizeOptionalString(body.agentId) || "main";
    const name = normalizeOptionalString(body.name) || "";
    const content = typeof body.content === "string" ? body.content : "";
    if (!name) {
      sendJson(res, 400, { ok: false, error: "agent file name is required" });
      return;
    }
    const store = await loadStore([], []);
    const actor = resolveDashboardActorContext(req, store);
    if (!actor.canOperateAgentRecord(agentId)) {
      sendJson(res, 403, {
        ok: false,
        error: "Ce fichier agent n'est pas modifiable pour le user courant.",
      });
      return;
    }
    const gatewayUrl = readHeader(req, "x-ct-gateway-url", DEFAULT_GATEWAY_URL);
    const gatewayToken = readHeader(req, "x-ct-gateway-token", DEFAULT_GATEWAY_TOKEN);
    try {
      const response = await gatewayBatch(gatewayUrl, gatewayToken, {
        file: { method: "agents.files.set", params: { agentId, name, content } },
      });
      sendJson(res, 200, { ok: true, result: response.results.file || {} });
    } catch (error) {
      const fallback = await writeAgentMarkdownDirect(
        gatewayUrl,
        gatewayToken,
        agentId,
        name,
        content,
        buildRuntimeEnvStatusSync().effective.workspaceDir,
      );
      void error;
      sendJson(res, 200, { ok: true, result: fallback });
    }
    return;
  }

  if (
    req.method === "POST" &&
    segments[1] === "provider-bridges" &&
    segments[2] &&
    segments[3] === "discover"
  ) {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut gerer les provider bridges.",
    );
    const bridge = await discoverProviderBridgeInStore(decodeURIComponent(segments[2]));
    sendJson(res, 200, { ok: true, result: bridge });
    return;
  }

  if (
    req.method === "POST" &&
    segments[1] === "provider-bridges" &&
    segments[2] &&
    segments[3] === "import"
  ) {
    assertDashboardAdminAccess(
      req,
      await loadStore([], []),
      "Seul l'admin Elytras peut gerer les provider bridges.",
    );
    const result = await importProviderBridge(req, decodeURIComponent(segments[2]));
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (segments[1] === "store") {
    if (req.method === "GET" && segments.length === 2) {
      const snapshot = await buildDashboardSnapshot(req);
      sendJson(res, 200, {
        ok: true,
        store: {
          users: snapshot.users,
          teams: snapshot.teams,
          projects: snapshot.projects,
          channels: snapshot.channels,
          pipelines: snapshot.pipelines,
          cronJobs: snapshot.cronJobs.filter(
            (entry: JsonRecord) => entry.source === "control-tower",
          ),
          grants: snapshot.grants,
          agentBindings: snapshot.agentBindings,
          providerBridges: snapshot.providerBridges,
        },
      });
      return;
    }

    if (req.method === "GET" && segments.length >= 3) {
      const snapshot = await buildDashboardSnapshot(req);
      const resource = segments[2] || "";
      const resourceMap = {
        users: snapshot.users,
        teams: snapshot.teams,
        projects: snapshot.projects,
        channels: snapshot.channels,
        pipelines: snapshot.pipelines,
        cronJobs: snapshot.cronJobs.filter((entry: JsonRecord) => entry.source === "control-tower"),
        grants: snapshot.grants,
        agentBindings: snapshot.agentBindings,
        providerBridges: snapshot.providerBridges,
      } satisfies Record<string, JsonValue[]>;
      const collection = resourceMap[resource];
      if (!collection) {
        sendJson(res, 404, { ok: false, error: `Unknown store resource: ${resource}` });
        return;
      }
      const resourceId = segments[3];
      if (!resourceId) {
        sendJson(res, 200, { ok: true, resource, result: collection });
        return;
      }
      const entry =
        collection.find(
          (candidate) =>
            isJsonRecord(candidate) &&
            normalizeOptionalString(candidate.id) === decodeURIComponent(resourceId),
        ) || null;
      if (!entry) {
        sendJson(res, 404, { ok: false, error: `Unknown ${resource} id: ${resourceId}` });
        return;
      }
      sendJson(res, 200, { ok: true, resource, result: entry });
      return;
    }

    const resource = segments[2] || "";
    const resourceId = segments[3];
    const body = req.method === "GET" ? {} : await readBody(req);
    const result = await handleStoreMutation(req, resource, req.method || "GET", body, resourceId);
    sendJson(res, 200, { ok: true, resource, result });
    return;
  }

  sendJson(res, 404, { ok: false, error: "Unknown ct-api route" });
}

function createMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    if (!req.url?.startsWith("/ct-api")) {
      next();
      return;
    }

    try {
      await handleCtApi(req, res);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export function createCtApiMiddlewarePlugin() {
  return {
    name: "control-tower-ct-api",
    configureServer(server: { middlewares: { use: (fn: NextHandleFunction) => void } }) {
      server.middlewares.use(createMiddleware());
    },
    configurePreviewServer(server: { middlewares: { use: (fn: NextHandleFunction) => void } }) {
      server.middlewares.use(createMiddleware());
    },
  };
}
