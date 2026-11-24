export type DashboardViewId =
  | "mission-control"
  | "agents"
  | "chat"
  | "files"
  | "memory"
  | "runtime"
  | "workspaces"
  | "skills"
  | "providers"
  | "channels"
  | "pipelines"
  | "cron"
  | "users"
  | "access";

export type OverviewStats = {
  agentCount: number;
  runningAgents: number;
  sessionCount: number;
  runningSessions: number;
  pipelineCount: number;
  activePipelines: number;
  cronCount: number;
  activeCronJobs: number;
  fileCount: number;
  memorySurfaceCount: number;
};

export type GatewayMeta = {
  generatedAt: string;
  gatewayHttpUrl: string;
  gatewayWsUrl: string;
  gatewayTokenMasked: string;
  configPath: string | null;
  stateDir: string | null;
  workspaceRoot: string;
  storePath: string;
  uptimeMs: number | null;
  authMode: string | null;
};

export type RuntimeEnvField = {
  key: string;
  value: string;
  secret?: boolean;
  redacted?: boolean;
};

export type RuntimeEnvStatus = {
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

export type RuntimeEnvResponse = {
  ok: boolean;
  result: RuntimeEnvStatus;
};

export type RuntimeEnvSaveResponse = {
  ok: boolean;
  result: RuntimeEnvStatus;
};

export type RuntimeEnvSavePayload = {
  inlineFields: RuntimeEnvField[];
  varsFields: RuntimeEnvField[];
  shellEnvEnabled: boolean;
  shellEnvTimeoutMs: string;
};

export type RuntimeBackendRestartResponse = {
  ok: boolean;
  result: {
    healthy: boolean;
    gatewayUrl: string;
    gatewayToken: string;
  };
};

export type RuntimeLinkValues = {
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

export type RuntimeLinkChecks = {
  backendEntrypointExists: boolean;
  cliResolvable: boolean;
  envFileExists: boolean;
  configExists: boolean;
  stateDirExists: boolean;
  workspaceDirExists: boolean;
  usingIsolatedRuntime: boolean;
  linkedOpenClawConfigExists: boolean;
};

export type RuntimeLinkStatus = {
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

export type RuntimeLinkResponse = {
  ok: boolean;
  result: RuntimeLinkStatus;
};

export type RuntimeLinkSavePayload = RuntimeLinkValues;

export type WorkspaceState = {
  bootstrapSeededAt?: string;
  setupCompletedAt?: string;
  version?: number;
};

export type WorkspaceSummary = {
  agentId: string;
  path: string;
  fileCount: number;
  memoryFileCount: number;
  state: WorkspaceState;
};

export type AgentBinding = {
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

export type DashboardAgent = {
  id: string;
  name?: string;
  identity?: {
    name?: string;
    theme?: string;
    emoji?: string;
    avatar?: string;
    avatarUrl?: string;
  };
  ownerId?: string;
  teamId?: string;
  purpose?: string;
  tags?: string[];
  skillIds?: string[];
  channelIds?: string[];
  defaultOutputChannelIds?: string[];
  providerIds?: string[];
  providerAccountIds?: Record<string, string[]>;
  providerSkillPolicies?: Record<
    string,
    {
      mode: "inherit" | "allow-all" | "deny-all" | "selected";
      skillIds: string[];
    }
  >;
  preferredModelRef?: string;
  effectiveModelRef?: string;
  resumePolicy?: "manual" | "prefer-recent" | "sticky";
  dispatchPolicy?: "manual" | "default-channels" | "broadcast";
  workspace?: WorkspaceSummary;
  sessionCount: number;
  currentStatus: "running" | "active" | "idle";
  currentActivity: string;
};

export type DashboardSession = {
  key: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  channel?: string;
  subject?: string;
  chatType?: string;
  updatedAt: number | null;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  reasoningLevel?: string;
  totalTokens?: number;
  estimatedCostUsd?: number;
  status?: string;
  runtimeMs?: number;
  parentSessionKey?: string;
  childSessions?: string[];
  modelProvider?: string;
  model?: string;
  providerOverride?: string | null;
  modelOverride?: string | null;
  contextTokens?: number;
  lastTo?: string;
  agentId: string;
  activityStatus: string;
  sessionKind?: "chat" | "pipeline" | "heartbeat" | "internal" | "webchat";
  sessionKindLabel?: string;
  sessionKindDescription?: string;
  pipelineId?: string;
  pipelineRunId?: string;
  pipelineStepId?: string;
  projectId?: string;
  projectName?: string;
  inboundPrincipal?: SessionInboundPrincipal;
};

export type FileRecord = {
  agentId: string;
  workspace: string;
  name: string;
  path: string;
  missing: boolean;
  size: number;
  updatedAtMs: number;
  extension: string;
  type: "memory" | "workspace";
};

export type MemoryRecord = FileRecord;

export type ProviderSummary = {
  provider: string;
  count: number;
  models: string[];
};

export type RuntimeModelRecord = {
  ref: string;
  provider: string;
  modelId: string;
  label: string;
  contextWindow?: number;
  maxTokens?: number;
};

export type RuntimeDefaults = {
  agentPrimaryModelRef?: string;
  agentFallbackModelRefs: string[];
};

export type ProviderBridgeModel = {
  id: string;
  name: string;
  api?: "openai-responses" | "openai-chat" | "openai-codex-responses";
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
};

export type ProviderBridge = {
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

export type ProviderAuthProfileStatus = {
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

export type ProviderOAuthStatus = {
  provider: string;
  status: string;
  profiles: ProviderAuthProfileStatus[];
  expiresAt?: number;
  remainingMs?: number;
};

export type ProviderUsageStatus = {
  provider: string;
  displayName: string;
  plan?: string;
  error?: string;
  windows: Array<{
    label: string;
    usedPercent: number;
    resetAt?: number;
  }>;
};

export type CliproxyAuthFile = {
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

export type CliproxyApiKeyEntry = {
  apiKeyMasked?: string;
  baseUrl?: string;
  proxyUrl?: string;
  headers?: Record<string, string>;
  excludedModels?: string[];
};

export type CliproxyOpenAiCompatibilityEntry = {
  name: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  models?: Array<Record<string, unknown>>;
  apiKeyEntries?: CliproxyApiKeyEntry[];
};

export type CliproxySectionEditors = {
  geminiApiKeys: Array<Record<string, unknown>>;
  codexApiKeys: Array<Record<string, unknown>>;
  claudeApiKeys: Array<Record<string, unknown>>;
  openAiCompatibility: Array<Record<string, unknown>>;
  oauthExcludedModels: Record<string, string[]>;
};

export type CliproxyStatusResponse = {
  ok: boolean;
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

export type CliproxyOauthStartResponse = {
  ok: boolean;
  provider: string;
  url: string;
  state: string;
};

export type CliproxyOauthPollResponse = {
  ok: boolean;
  provider?: string;
  state: string;
  status: "wait" | "ok" | "error";
  error?: string;
};

export type CliproxyOauthCallbackResponse = {
  ok: boolean;
  provider: string;
  redirectUrl: string;
  status: "ok" | "error";
  error?: string;
};

export type CliproxyImportOpenClawAuthResponse = {
  ok: boolean;
  imported: number;
  providers: string[];
  restarted: boolean;
};

export type SkillSummary = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  disableModelInvocation: boolean;
};

export type SkillManagerScope = "shared" | "agent";

export type SkillLibraryKind = "managed" | "personal" | "workspace" | "overlay" | "runtime";

export type SkillLibrary = {
  id: string;
  scope: SkillManagerScope;
  kind: SkillLibraryKind;
  label: string;
  description: string;
  rootPath: string;
  source: string;
  agentId?: string;
  agentLabel?: string;
};

export type SkillManagerEntry = {
  id: string;
  libraryId: string;
  scope: SkillManagerScope;
  kind: SkillLibrary["kind"];
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

export type SkillsCatalog = {
  libraries: SkillLibrary[];
  skills: SkillManagerEntry[];
  precedence: string[];
};

export type SkillsCatalogResponse = {
  ok: boolean;
  result: SkillsCatalog;
};

export type SkillContentResponse = {
  ok: boolean;
  result: {
    skill: SkillManagerEntry;
    content: string;
  };
};

export type SkillSavePayload = {
  libraryId: string;
  dirName: string;
  previousDirName?: string;
  content: string;
};

export type SkillImportSourceType = "git" | "zip-url" | "zip-upload" | "skill-md";

export type SkillImportPayload = {
  libraryId: string;
  sourceType: SkillImportSourceType;
  overwrite?: boolean;
  repoUrl?: string;
  ref?: string;
  sourcePath?: string;
  archiveUrl?: string;
  archiveBase64?: string;
  fileName?: string;
  dirName?: string;
  content?: string;
};

export type SkillImportResult = {
  libraryId: string;
  imported: SkillManagerEntry[];
  warnings: string[];
};

export type SkillImportResponse = {
  ok: boolean;
  result: SkillImportResult;
};

export type DashboardUser = {
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

export type DashboardProject = {
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

export type SessionInboundPrincipal = {
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

export type DashboardTeam = {
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

export type DashboardChannel = {
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

export type ChannelSetupFieldOption = {
  value: string;
  label: string;
};

export type ChannelRouteKind = {
  id: string;
  label: string;
  description: string;
  example?: string;
};

export type ChannelRouteConfig = {
  enabled: boolean;
  targetLabel: string;
  summary: string;
  placeholder: string;
  hint: string;
  destinationKinds: ChannelRouteKind[];
};

export type ChannelSetupField = {
  key: string;
  label: string;
  type: "text" | "password" | "url" | "path" | "number" | "checkbox" | "select" | "textarea";
  description?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string | boolean | number;
  options?: ChannelSetupFieldOption[];
};

export type ChannelSetupTemplate = {
  id: string;
  label: string;
  summary: string;
  docsUrl: string;
  installPath?: string;
  accountScope: "scoped" | "top-level-only" | "accounts-only";
  setupMode: "config" | "native-ui";
  loginMode: "none" | "cli-login";
  supportsLogout: boolean;
  supportsRemove: boolean;
  steps: string[];
  fields: ChannelSetupField[];
  routeConfig: ChannelRouteConfig;
  tags: string[];
};

export type ChannelRuntimeAccount = {
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

export type ChannelCatalogEntry = {
  id: string;
  installed: boolean;
  configured: boolean;
  defaultAccountId?: string;
  template: ChannelSetupTemplate;
  accounts: ChannelRuntimeAccount[];
};

export type ChannelCatalogResponse = {
  ok: boolean;
  degraded?: boolean;
  warning?: string;
  generatedAt: string;
  entries: ChannelCatalogEntry[];
};

export type ChannelOperation = {
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

export type ChannelOperationResponse = {
  ok: boolean;
  operation: ChannelOperation;
};

export type PipelineStep = {
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

export type PipelineRecord = {
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

export type CronJobRecord = {
  id: string;
  name: string;
  description?: string;
  ownerId?: string;
  agentId?: string;
  pipelineId?: string;
  targetType?: "pipeline" | "request";
  schedule?: string;
  input?: string;
  enabled?: boolean;
  outputTargets?: string[];
  source: "openclaw" | "control-tower";
  activityStatus: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  createdAt?: string;
  updatedAt?: string;
  state?: {
    nextRunAtMs?: number;
    runningAtMs?: number;
    lastRunAtMs?: number;
    lastRunStatus?: string;
    lastError?: string;
    lastDurationMs?: number;
  };
  status?: "queued" | "running" | "paused" | "failed" | "done";
};

export type AccessGrant = {
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

export type DashboardSnapshot = {
  ok: boolean;
  meta: GatewayMeta;
  overview: OverviewStats;
  agents: DashboardAgent[];
  sessions: DashboardSession[];
  files: FileRecord[];
  memories: MemoryRecord[];
  workspaces: WorkspaceSummary[];
  cronJobs: CronJobRecord[];
  pipelines: PipelineRecord[];
  users: DashboardUser[];
  teams: DashboardTeam[];
  projects: DashboardProject[];
  channels: DashboardChannel[];
  grants: AccessGrant[];
  agentBindings: AgentBinding[];
  providers: ProviderSummary[];
  runtimeModels: RuntimeModelRecord[];
  runtimeDefaults: RuntimeDefaults;
  providerBridges: ProviderBridge[];
  skills: SkillSummary[];
};

export type SessionMessage = {
  id: string;
  role: string;
  text: string;
  provider?: string;
  model?: string;
  timestamp: number | null;
  usage?: Record<string, unknown>;
  attachments?: Array<{
    kind: "image" | "audio" | "video" | "file";
    mimeType?: string;
    fileName?: string;
    dataUrl?: string;
    href?: string;
    source?: string;
  }>;
};

export type SessionHistoryResponse = {
  ok: boolean;
  sessionKey: string;
  sessionId: string | null;
  messages: SessionMessage[];
};

export type PipelineRunStepResult = {
  stepId: string;
  stepName: string;
  agentId?: string;
  sessionKey: string;
  runId: string;
  status: string;
  output: string;
};

export type PipelineRunDeliveryResult = {
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

export type PipelineRunLogEntry = {
  timestamp: string;
  level: "info" | "error" | "success";
  stepId?: string;
  stepName?: string;
  message: string;
};

export type PipelineRunResponse = {
  ok: boolean;
  result: {
    runId: string;
    pipelineId: string;
    pipelineName: string;
    outputDeliveryMode: "final-only" | "step-only" | "step-and-final";
    startedAt: string;
    completedAt?: string;
    input?: string;
    status: "done" | "failed";
    finalOutput: string;
    finalSessionKey?: string;
    error?: string;
    steps: PipelineRunStepResult[];
    deliveries: PipelineRunDeliveryResult[];
    logs: PipelineRunLogEntry[];
  };
};

export type PipelineRunSummary = {
  id: string;
  pipelineId: string;
  pipelineName: string;
  outputDeliveryMode: "final-only" | "step-only" | "step-and-final";
  startedAt: string;
  completedAt?: string;
  input?: string;
  status: "running" | "done" | "failed";
  finalSessionKey?: string;
  error?: string;
  stepCount: number;
  sessionCount: number;
  sentDeliveryCount: number;
  totalDeliveryCount: number;
};

export type PipelineRunRecord = {
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

export type PipelineRunListResponse = {
  ok: boolean;
  runs: PipelineRunSummary[];
};

export type PipelineRunDetailResponse = {
  ok: boolean;
  run: PipelineRunRecord;
};

export type FileContentResponse = {
  ok: boolean;
  result: {
    agentId: string;
    workspace: string;
    file: {
      name: string;
      path: string;
      missing: boolean;
      size?: number;
      updatedAtMs?: number;
      content?: string;
    };
  };
};

export type ManagedMemoryEngineConfig = {
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

export type MemoryEngineStatus = {
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

export type AgentMemoryConversation = {
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

export type AgentMemorySummary = {
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

export type AgentMemoryMatch = {
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

export type AgentMemoryInsight = {
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

export type AgentMemoryInsightResponse = {
  ok: boolean;
  result: AgentMemoryInsight;
};
