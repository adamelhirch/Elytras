import type {
  AgentMemoryInsightResponse,
  ChannelCatalogResponse,
  CliproxyImportOpenClawAuthResponse,
  CliproxyOauthCallbackResponse,
  ChannelOperationResponse,
  CliproxyOauthPollResponse,
  CliproxyOauthStartResponse,
  CliproxyStatusResponse,
  DashboardSnapshot,
  FileContentResponse,
  MemoryEngineStatus,
  PipelineRunDetailResponse,
  PipelineRunListResponse,
  PipelineRunResponse,
  ProviderBridge,
  RuntimeBackendRestartResponse,
  RuntimeLinkResponse,
  RuntimeLinkSavePayload,
  RuntimeEnvResponse,
  RuntimeEnvSavePayload,
  RuntimeEnvSaveResponse,
  SkillContentResponse,
  SkillImportPayload,
  SkillImportResponse,
  SkillSavePayload,
  SkillsCatalogResponse,
  SessionHistoryResponse,
} from "./types";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export type GatewayConfig = {
  baseUrl: string;
  token: string;
};

type DashboardRequestContext = {
  userId?: string;
  teamScopeId?: string;
};

const DASHBOARD_ROOT_USER_ID = "__elytras-root__";
const DASHBOARD_ALL_TEAMS_SCOPE_ID = "__all_teams__";

let dashboardRequestContext: Required<DashboardRequestContext> = {
  userId: DASHBOARD_ROOT_USER_ID,
  teamScopeId: DASHBOARD_ALL_TEAMS_SCOPE_ID,
};

function errorMessage(value: unknown, fallback: string) {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `${value}`;
  }
  return fallback;
}

function buildHeaders(config: GatewayConfig, options: RequestInit = {}): HeadersInit {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
    "x-ct-gateway-url": config.baseUrl,
    "x-ct-gateway-token": config.token,
    "x-ct-dashboard-user": dashboardRequestContext.userId,
    "x-ct-dashboard-team-scope": dashboardRequestContext.teamScopeId,
  };

  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

export function setDashboardRequestContext(context: DashboardRequestContext) {
  dashboardRequestContext = {
    userId: context.userId?.trim() || DASHBOARD_ROOT_USER_ID,
    teamScopeId: context.teamScopeId?.trim() || DASHBOARD_ALL_TEAMS_SCOPE_ID,
  };
}

async function request<T>(config: GatewayConfig, path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: buildHeaders(config, options),
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(
      errorMessage(data.error, errorMessage(data.message, `HTTP ${response.status}`)),
      response.status,
    );
  }

  return data as T;
}

export function fetchDashboardSnapshot(config: GatewayConfig) {
  return request<DashboardSnapshot>(config, "/ct-api/dashboard");
}

export function fetchRuntimeEnv(config: GatewayConfig) {
  return request<RuntimeEnvResponse>(config, "/ct-api/runtime/env");
}

export function fetchRuntimeLink(config: GatewayConfig) {
  return request<RuntimeLinkResponse>(config, "/ct-api/runtime/link");
}

export function saveRuntimeLink(config: GatewayConfig, payload: RuntimeLinkSavePayload) {
  return request<RuntimeLinkResponse>(config, "/ct-api/runtime/link", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function saveRuntimeEnv(config: GatewayConfig, payload: RuntimeEnvSavePayload) {
  return request<RuntimeEnvSaveResponse>(config, "/ct-api/runtime/env", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function restartRuntimeBackend(config: GatewayConfig) {
  return request<RuntimeBackendRestartResponse>(config, "/ct-api/runtime/backend/restart", {
    method: "POST",
  });
}

export function fetchCliproxyStatus(config: GatewayConfig) {
  return request<CliproxyStatusResponse>(config, "/ct-api/cliproxy/status");
}

export function startCliproxyOauth(config: GatewayConfig, provider: string) {
  return request<CliproxyOauthStartResponse>(config, "/ct-api/cliproxy/oauth/start", {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
}

export function importCliproxyOpenClawAuth(config: GatewayConfig) {
  return request<CliproxyImportOpenClawAuthResponse>(config, "/ct-api/cliproxy/import-openclaw-auth", {
    method: "POST",
  });
}

export function pollCliproxyOauth(config: GatewayConfig, state: string) {
  return request<CliproxyOauthPollResponse>(
    config,
    `/ct-api/cliproxy/oauth/status?state=${encodeURIComponent(state)}`,
  );
}

export function submitCliproxyOauthCallback(
  config: GatewayConfig,
  payload: { provider: string; redirectUrl: string },
) {
  return request<CliproxyOauthCallbackResponse>(config, "/ct-api/cliproxy/oauth/callback", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function saveCliproxySection(
  config: GatewayConfig,
  payload: {
    section:
      | "gemini-api-key"
      | "codex-api-key"
      | "claude-api-key"
      | "openai-compatibility"
      | "oauth-excluded-models"
      | "quota-exceeded/switch-project"
      | "quota-exceeded/switch-preview-model";
    value: unknown;
  },
) {
  return request<{ ok: boolean }>(config, "/ct-api/cliproxy/section", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteCliproxyAuthFile(config: GatewayConfig, name: string) {
  return request<{ ok: boolean }>(
    config,
    `/ct-api/cliproxy/auth-files?name=${encodeURIComponent(name)}`,
    {
      method: "DELETE",
    },
  );
}

export function fetchChannelCatalog(config: GatewayConfig) {
  return request<ChannelCatalogResponse>(config, "/ct-api/channels/catalog");
}

export function configureChannel(
  config: GatewayConfig,
  payload: {
    channelId: string;
    accountId?: string;
    ownerId?: string;
    name?: string;
    deliveryTarget?: string;
    values: Record<string, string | boolean | number>;
  },
) {
  return request<ChannelOperationResponse>(config, "/ct-api/channels/configure", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function installChannelPlugin(config: GatewayConfig, channelId: string) {
  return request<ChannelOperationResponse>(config, "/ct-api/channels/install", {
    method: "POST",
    body: JSON.stringify({ channelId }),
  });
}

export function loginChannel(
  config: GatewayConfig,
  payload: { channelId: string; accountId?: string; verbose?: boolean },
) {
  return request<ChannelOperationResponse>(config, "/ct-api/channels/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function logoutChannel(
  config: GatewayConfig,
  payload: { channelId: string; accountId?: string },
) {
  return request<ChannelOperationResponse>(config, "/ct-api/channels/logout", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function removeChannel(
  config: GatewayConfig,
  payload: { channelId: string; accountId?: string; deleteConfig?: boolean },
) {
  return request<ChannelOperationResponse>(config, "/ct-api/channels/remove", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function saveChannelInboundBinding(
  config: GatewayConfig,
  payload: { channelId: string; accountId?: string; agentId?: string },
) {
  return request<{
    ok: boolean;
    result: {
      channelId: string;
      accountId: string;
      agentId?: string;
    };
  }>(config, "/ct-api/channels/inbound-binding", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function fetchChannelOperation(config: GatewayConfig, id: string) {
  return request<ChannelOperationResponse>(
    config,
    `/ct-api/channels/ops/${encodeURIComponent(id)}`,
  );
}

export function createAgent(
  config: GatewayConfig,
  payload: {
    name: string;
    workspace: string;
    ownerId?: string;
    teamId?: string;
    accessTeamIds?: string[];
    purpose?: string;
    channelIds?: string[];
    defaultOutputChannelIds?: string[];
    providerIds?: string[];
    providerAccountIds?: Record<string, string[]>;
    providerSkillPolicies?: Record<
      string,
      { mode: "inherit" | "allow-all" | "deny-all" | "selected"; skillIds: string[] }
    >;
    skillPolicy?: "all" | "selected" | "none";
    skillIds?: string[];
    tags?: string[];
    avatar?: string;
    emoji?: string;
    modelRef?: string;
    resumePolicy?: "manual" | "prefer-recent" | "sticky";
    dispatchPolicy?: "manual" | "default-channels" | "broadcast";
    thinkingLevel?: string;
    fastMode?: boolean;
    verboseLevel?: string;
    reasoningLevel?: string;
  },
) {
  return request<{ ok: boolean; result: Record<string, unknown> }>(config, "/ct-api/agents", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateAgent(
  config: GatewayConfig,
  agentId: string,
  payload: {
    name?: string;
    workspace?: string;
    ownerId?: string;
    teamId?: string;
    accessTeamIds?: string[];
    purpose?: string;
    channelIds?: string[];
    defaultOutputChannelIds?: string[];
    providerIds?: string[];
    providerAccountIds?: Record<string, string[]>;
    providerSkillPolicies?: Record<
      string,
      { mode: "inherit" | "allow-all" | "deny-all" | "selected"; skillIds: string[] }
    >;
    skillPolicy?: "all" | "selected" | "none";
    skillIds?: string[];
    tags?: string[];
    emoji?: string;
    avatar?: string;
    modelRef?: string;
    resumePolicy?: "manual" | "prefer-recent" | "sticky";
    dispatchPolicy?: "manual" | "default-channels" | "broadcast";
    thinkingLevel?: string;
    fastMode?: boolean;
    verboseLevel?: string;
    reasoningLevel?: string;
  },
) {
  return request<{ ok: boolean; result: Record<string, unknown> }>(
    config,
    `/ct-api/agents/${encodeURIComponent(agentId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    },
  );
}

export function deleteAgent(config: GatewayConfig, agentId: string, deleteFiles = true) {
  const search = new URLSearchParams({ deleteFiles: deleteFiles ? "1" : "0" });
  return request<{ ok: boolean; result: Record<string, unknown> }>(
    config,
    `/ct-api/agents/${encodeURIComponent(agentId)}?${search.toString()}`,
    {
      method: "DELETE",
    },
  );
}

export function fetchMemoryEngineStatus(config: GatewayConfig) {
  return request<MemoryEngineStatus>(config, "/ct-api/agents/memory-engine");
}

export function installManagedMemoryPlugin(config: GatewayConfig) {
  return request<{
    ok: boolean;
    result: {
      pluginId: string;
      packageName: string;
      alreadyInstalled: boolean;
      command: string;
      message?: string;
      stdout?: string;
      stderr?: string;
    };
  }>(config, "/ct-api/agents/memory-engine/install", {
    method: "POST",
  });
}

export function saveMemoryEngineConfig(
  config: GatewayConfig,
  payload: {
    mode: "legacy" | "elytrasless" | "lossless-claw";
    config?: {
      dbPath?: string;
      summaryModel?: string;
      expansionModel?: string;
      freshTailCount?: number;
      contextThreshold?: number;
      incrementalMaxDepth?: number;
      ignoreSessionPatterns?: string[];
      statelessSessionPatterns?: string[];
      skipStatelessSessions?: boolean;
    };
  },
) {
  return request<{
    ok: boolean;
    result: {
      mode: "legacy" | "elytrasless" | "lossless-claw";
      applied: unknown;
    };
  }>(config, "/ct-api/agents/memory-engine/config", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function fetchAgentMemoryInsight(
  config: GatewayConfig,
  agentId: string,
  query?: string,
) {
  const search = new URLSearchParams();
  if (query?.trim()) {
    search.set("q", query.trim());
  }
  const suffix = search.toString() ? `?${search.toString()}` : "";
  return request<AgentMemoryInsightResponse>(
    config,
    `/ct-api/agents/${encodeURIComponent(agentId)}/memory-insight${suffix}`,
  );
}

export function fetchSessionHistory(config: GatewayConfig, sessionKey: string, limit = 120) {
  return request<SessionHistoryResponse>(
    config,
    `/ct-api/sessions/${encodeURIComponent(sessionKey)}/history?limit=${limit}`,
  );
}

export function sendSessionMessage(
  config: GatewayConfig,
  sessionKey: string,
  payload: {
    message: string;
    deliver?: boolean;
    attachments?: Array<{
      type?: string;
      mimeType?: string;
      fileName?: string;
      content: string;
    }>;
  },
) {
  return request<{ ok: boolean; result: Record<string, unknown> }>(
    config,
    `/ct-api/sessions/${encodeURIComponent(sessionKey)}/send`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export function relaySessionMessage(
  config: GatewayConfig,
  sessionKey: string,
  payload: {
    message: string;
    attachments?: Array<{
      type?: string;
      mimeType?: string;
      fileName?: string;
      content: string;
    }>;
  },
) {
  return request<{ ok: boolean; result: Record<string, unknown> }>(
    config,
    `/ct-api/sessions/${encodeURIComponent(sessionKey)}/relay`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export function createSession(
  config: GatewayConfig,
  payload: {
    agentId: string;
    label?: string;
    projectId?: string;
    model?: string;
    message?: string;
    thinkingLevel?: string | null;
    fastMode?: boolean | null;
    verboseLevel?: string | null;
    reasoningLevel?: string | null;
  },
) {
  return request<{
    ok: boolean;
    result: {
      key: string;
      sessionId?: string;
      create?: Record<string, unknown>;
      patch?: Record<string, unknown>;
      send?: Record<string, unknown>;
    };
  }>(config, "/ct-api/sessions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function resetSession(config: GatewayConfig, sessionKey: string) {
  return request<{ ok: boolean; result: Record<string, unknown> }>(
    config,
    `/ct-api/sessions/${encodeURIComponent(sessionKey)}/reset`,
    {
      method: "POST",
    },
  );
}

export function runPipeline(
  config: GatewayConfig,
  pipelineId: string,
  payload: { input?: string } = {},
) {
  return request<PipelineRunResponse>(
    config,
    `/ct-api/pipelines/${encodeURIComponent(pipelineId)}/run`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export function fetchPipelineRuns(
  config: GatewayConfig,
  options: { pipelineId?: string; limit?: number } = {},
) {
  const search = new URLSearchParams();
  if (options.pipelineId) {
    search.set("pipelineId", options.pipelineId);
  }
  if (typeof options.limit === "number") {
    search.set("limit", String(options.limit));
  }
  const query = search.toString();
  return request<PipelineRunListResponse>(
    config,
    `/ct-api/pipeline-runs${query ? `?${query}` : ""}`,
  );
}

export function fetchPipelineRunDetail(config: GatewayConfig, runId: string) {
  return request<PipelineRunDetailResponse>(
    config,
    `/ct-api/pipeline-runs/${encodeURIComponent(runId)}`,
  );
}

export function patchSession(
  config: GatewayConfig,
  sessionKey: string,
  patch: {
    label?: string | null;
    model?: string | null;
    thinkingLevel?: string | null;
    fastMode?: boolean | null;
    verboseLevel?: string | null;
    reasoningLevel?: string | null;
  },
) {
  return request<{ ok: boolean; result: Record<string, unknown> }>(
    config,
    `/ct-api/sessions/${encodeURIComponent(sessionKey)}/patch`,
    {
      method: "POST",
      body: JSON.stringify(patch),
    },
  );
}

export function fetchFileContent(config: GatewayConfig, agentId: string, name: string) {
  const search = new URLSearchParams({ agentId, name });
  return request<FileContentResponse>(config, `/ct-api/files/content?${search.toString()}`);
}

export function saveFileContent(
  config: GatewayConfig,
  payload: { agentId: string; name: string; content: string },
) {
  return request<FileContentResponse>(config, "/ct-api/files/content", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function fetchSkillsCatalog(config: GatewayConfig) {
  return request<SkillsCatalogResponse>(config, "/ct-api/skills/catalog");
}

export function fetchSkillContent(
  config: GatewayConfig,
  payload: { libraryId: string; dirName: string },
) {
  const search = new URLSearchParams(payload);
  return request<SkillContentResponse>(config, `/ct-api/skills/content?${search.toString()}`);
}

export function saveSkillContent(config: GatewayConfig, payload: SkillSavePayload) {
  return request<SkillContentResponse>(config, "/ct-api/skills/content", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteSkillContent(
  config: GatewayConfig,
  payload: { libraryId: string; dirName: string },
) {
  const search = new URLSearchParams(payload);
  return request<{ ok: boolean }>(config, `/ct-api/skills/content?${search.toString()}`, {
    method: "DELETE",
  });
}

export function importSkillContent(config: GatewayConfig, payload: SkillImportPayload) {
  return request<SkillImportResponse>(config, "/ct-api/skills/import", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createStoreResource<T extends Record<string, unknown>>(
  resource: string,
  config: GatewayConfig,
  payload: T,
) {
  return request<{ ok: boolean; resource: string; result: T }>(
    config,
    `/ct-api/store/${resource}`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export function updateStoreResource<T extends Record<string, unknown>>(
  resource: string,
  id: string,
  config: GatewayConfig,
  payload: Partial<T>,
) {
  return request<{ ok: boolean; resource: string; result: T }>(
    config,
    `/ct-api/store/${resource}/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    },
  );
}

export function deleteStoreResource(resource: string, id: string, config: GatewayConfig) {
  return request<{ ok: boolean; resource: string; result: Record<string, unknown> }>(
    config,
    `/ct-api/store/${resource}/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
    },
  );
}

export function discoverProviderBridge(config: GatewayConfig, id: string) {
  return request<{ ok: boolean; result: ProviderBridge }>(
    config,
    `/ct-api/provider-bridges/${encodeURIComponent(id)}/discover`,
    {
      method: "POST",
    },
  );
}

export function importProviderBridge(config: GatewayConfig, id: string) {
  return request<{
    ok: boolean;
    result: {
      bridge: ProviderBridge;
      providerId: string;
      gateway: Record<string, unknown>;
    };
  }>(config, `/ct-api/provider-bridges/${encodeURIComponent(id)}/import`, {
    method: "POST",
  });
}
