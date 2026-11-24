import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { PluginLogger } from "openclaw/plugin-sdk/core";
import type { ElytraslessConfig } from "./config.js";
import { buildElytrasMemoryScopes, formatElytrasMemoryScope } from "./memory-scope.js";
import { loadElytrasStore, parseSessionRef, resolveScopeForSession } from "./store.js";

type ContextEngineInfo = {
  id: string;
  name: string;
  version?: string;
  ownsCompaction?: boolean;
};

type BootstrapResult = {
  bootstrapped: boolean;
  importedMessages?: number;
  reason?: string;
};

type IngestResult = {
  ingested: boolean;
};

type IngestBatchResult = {
  ingestedCount: number;
};

type AssembleResult = {
  messages: AgentMessage[];
  estimatedTokens: number;
  systemPromptAddition?: string;
};

type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
};

type SubagentPreparation = {
  rollback: () => void | Promise<void>;
};

type BaseContextEngine = {
  info: ContextEngineInfo;
  bootstrap?: (input: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
  }) => Promise<BootstrapResult>;
  ingest: (input: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }) => Promise<IngestResult>;
  ingestBatch?: (input: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }) => Promise<IngestBatchResult>;
  afterTurn?: (input: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: Record<string, unknown>;
  }) => Promise<void>;
  assemble: (input: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    model?: string;
    runtimeContext?: Record<string, unknown>;
  }) => Promise<AssembleResult>;
  compact: (input: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
  }) => Promise<CompactResult>;
  prepareSubagentSpawn?: (input: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }) => Promise<SubagentPreparation | undefined>;
  onSubagentEnded?: (input: {
    childSessionKey: string;
    reason: "deleted" | "completed" | "swept" | "released";
  }) => Promise<void>;
  dispose?: () => Promise<void>;
};

type ElytraslessEngineParams = {
  baseEngine: BaseContextEngine;
  config: ElytraslessConfig;
  logger: PluginLogger;
};

function truncateForPrompt(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  const safe = Math.max(0, maxChars - 1);
  return `${trimmed.slice(0, safe)}…`;
}

async function readDocIfPresent(filePath: string, maxChars: number): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const trimmed = truncateForPrompt(raw, maxChars);
    return trimmed || null;
  } catch {
    return null;
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveStateRoot(config: ElytraslessConfig): string {
  const envOverride = normalizeOptionalString(process.env.OPENCLAW_STATE_DIR);
  if (envOverride) {
    return envOverride;
  }
  return path.join(path.dirname(config.storePath), "state");
}

function resolveCandidateStateRoots(config: ElytraslessConfig) {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (value: string | undefined) => {
    const normalized = normalizeOptionalString(value);
    if (!normalized) {
      return;
    }
    const resolved = path.resolve(normalized);
    if (seen.has(resolved)) {
      return;
    }
    seen.add(resolved);
    candidates.push(resolved);
  };

  pushCandidate(process.env.OPENCLAW_STATE_DIR);
  pushCandidate(resolveStateRoot(config));

  let cursor = path.resolve(path.dirname(config.storePath));
  while (true) {
    if (path.basename(cursor) === ".openclaw") {
      pushCandidate(cursor);
      pushCandidate(path.join(cursor, "state"));
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  return candidates;
}

function extractPeerIdFromRouteValue(rawValue: unknown, channelHint?: string): string | undefined {
  const raw = normalizeOptionalString(rawValue)?.toLowerCase();
  if (!raw) {
    return undefined;
  }
  let candidate = raw;
  const hintedChannel = normalizeOptionalString(channelHint)?.toLowerCase();
  if (hintedChannel && candidate.startsWith(`${hintedChannel}:`)) {
    candidate = candidate.slice(hintedChannel.length + 1);
  } else {
    const scopedMatch = candidate.match(/^([a-z0-9_-]+):(.*)$/);
    if (scopedMatch?.[2]) {
      candidate = scopedMatch[2];
    }
  }
  for (const prefix of ["user:", "direct:", "dm:", "chat:"]) {
    if (candidate.startsWith(prefix)) {
      candidate = candidate.slice(prefix.length);
    }
  }
  const topicIndex = candidate.indexOf(":topic:");
  if (topicIndex >= 0) {
    candidate = candidate.slice(0, topicIndex);
  }
  const threadIndex = candidate.indexOf(":thread:");
  if (threadIndex >= 0) {
    candidate = candidate.slice(0, threadIndex);
  }
  const trimmed = candidate.trim();
  return trimmed || undefined;
}

async function loadSessionRouteContext(params: {
  config: ElytraslessConfig;
  sessionKey?: string;
}): Promise<{ messageChannel?: string; senderId?: string; projectId?: string }> {
  const parsed = parseSessionRef(params.sessionKey);
  const agentId = parsed?.agentId;
  if (!agentId) {
    return {};
  }
  let rawStore = "{}";
  let foundStore = false;
  for (const root of resolveCandidateStateRoots(params.config)) {
    const sessionsPath = path.join(root, "agents", agentId, "sessions", "sessions.json");
    try {
      rawStore = await fs.readFile(sessionsPath, "utf8");
      foundStore = true;
      break;
    } catch {
      continue;
    }
  }
  if (!foundStore) {
    return {};
  }
  let parsedStore: unknown;
  try {
    parsedStore = JSON.parse(rawStore);
  } catch {
    return {};
  }
  if (!isRecord(parsedStore)) {
    return {};
  }
  const sessionEntry = params.sessionKey ? parsedStore[params.sessionKey.toLowerCase()] : undefined;
  if (!isRecord(sessionEntry)) {
    return {};
  }
  const origin = isRecord(sessionEntry.origin) ? sessionEntry.origin : {};
  const deliveryContext = isRecord(sessionEntry.deliveryContext)
    ? sessionEntry.deliveryContext
    : {};
  const messageChannel =
    normalizeOptionalString(sessionEntry.lastChannel)?.toLowerCase() ||
    normalizeOptionalString(deliveryContext.channel)?.toLowerCase() ||
    normalizeOptionalString(origin.provider)?.toLowerCase() ||
    normalizeOptionalString(origin.surface)?.toLowerCase() ||
    (parsed?.channel && parsed.channel !== "main" ? parsed.channel : undefined);
  const chatType =
    normalizeOptionalString(origin.chatType)?.toLowerCase() ||
    normalizeOptionalString(sessionEntry.chatType)?.toLowerCase();
  const senderId =
    extractPeerIdFromRouteValue(origin.from, messageChannel) ||
    (chatType === "direct"
      ? extractPeerIdFromRouteValue(sessionEntry.lastTo, messageChannel) ||
        extractPeerIdFromRouteValue(origin.to, messageChannel) ||
        extractPeerIdFromRouteValue(deliveryContext.to, messageChannel)
      : undefined);
  const projectId =
    normalizeOptionalString(sessionEntry.projectId) ||
    normalizeOptionalString(sessionEntry.project?.id) ||
    normalizeOptionalString(sessionEntry.runtimeProjectId) ||
    normalizeOptionalString(origin.projectId) ||
    normalizeOptionalString(deliveryContext.projectId);
  return {
    messageChannel,
    senderId,
    projectId,
  };
}

async function buildTenantContextPrompt(params: {
  config: ElytraslessConfig;
  sessionKey?: string;
  messageChannel?: string;
  senderId?: string;
  projectId?: string;
}): Promise<string | undefined> {
  const store = await loadElytrasStore(params.config.storePath);
  if (!store) {
    return undefined;
  }
  const sessionRouteContext =
    params.messageChannel && params.senderId
      ? {}
      : await loadSessionRouteContext({
          config: params.config,
          sessionKey: params.sessionKey,
        });
  const scope = resolveScopeForSession({
    store,
    sessionKey: params.sessionKey,
    messageChannel: params.messageChannel || sessionRouteContext.messageChannel,
    senderId: params.senderId || sessionRouteContext.senderId,
    projectId: params.projectId || sessionRouteContext.projectId,
  });
  if (scope.status !== "resolved") {
    const lines = [
      "[ELYTRAS TENANCY CONTEXT]",
      "Treat this block as operator-managed runtime context.",
      `Resolution: ${scope.status}`,
      `Reason: ${scope.reason}`,
      scope.agentId ? `Agent: ${scope.agentId}` : "Agent: unresolved",
      scope.candidateExternalIds.length > 0
        ? `Candidate external identities: ${scope.candidateExternalIds.join(", ")}`
        : "Candidate external identities: none",
      "Caller trust level: untrusted",
      "Do not expose owner-only memory, hidden workspace context, or privileged capabilities.",
      "If the request could touch sensitive state, keep the reply minimal and ask for operator remapping or review.",
    ];
    return lines.join("\n");
  }

  const memoryScopes = buildElytrasMemoryScopes({
    resolution: scope,
    sessionKey: params.sessionKey,
    channel: params.messageChannel || sessionRouteContext.messageChannel,
  });

  const lines = [
    "[ELYTRAS TENANCY CONTEXT]",
    "Treat this block as operator-managed runtime context.",
    "Resolution: resolved",
    `Agent: ${scope.agentId}`,
    `User: ${scope.user.name} (${scope.user.id})`,
    `User role: ${scope.user.role}`,
    `User status: ${scope.user.status}`,
    scope.team ? `Team: ${scope.team.name} (${scope.team.id})` : "Team: unresolved",
    scope.project ? `Project: ${scope.project.name} (${scope.project.id})` : "Project: none",
    `Matched external identity: ${scope.matchedExternalIdentity}`,
    `Memory scopes: ${memoryScopes.map((entry) => formatElytrasMemoryScope(entry)).join(" | ")}`,
    "Operate within this resolved Elytras scope unless an operator explicitly changes it.",
  ];

  if (params.config.injectUserContext) {
    const userDoc = await readDocIfPresent(
      path.join(params.config.dataRoot, "users", scope.user.id, "USER.md"),
      params.config.maxInjectedChars,
    );
    if (userDoc) {
      lines.push("", "[USER.md]", userDoc);
    }
  }

  if (params.config.injectTeamContext && scope.team) {
    const teamDoc = await readDocIfPresent(
      path.join(params.config.dataRoot, "teams", scope.team.id, "TEAM.md"),
      params.config.maxInjectedChars,
    );
    if (teamDoc) {
      lines.push("", "[TEAM.md]", teamDoc);
    }
  }

  if (params.config.injectProjectContext && scope.project) {
    const projectDoc = await readDocIfPresent(
      path.join(params.config.dataRoot, "projects", scope.project.id, "PROJECT.md"),
      params.config.maxInjectedChars,
    );
    if (projectDoc) {
      lines.push("", "[PROJECT.md]", projectDoc);
    }
  }

  return lines.join("\n");
}

async function appendAuditEvent(params: {
  config: ElytraslessConfig;
  payload: Record<string, unknown>;
}) {
  await fs.mkdir(path.dirname(params.config.auditLogPath), { recursive: true });
  await fs.appendFile(
    params.config.auditLogPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...params.payload,
    })}\n`,
    "utf8",
  );
}

export function createElytraslessContextEngine(params: ElytraslessEngineParams) {
  const { baseEngine } = params;
  return {
    info: {
      id: "elytrasless",
      name: "Elytrasless",
      version: baseEngine.info.version,
      ownsCompaction: baseEngine.info.ownsCompaction,
    },
    async bootstrap(input: { sessionId: string; sessionKey?: string; sessionFile: string }) {
      await fs.mkdir(path.dirname(params.config.auditLogPath), { recursive: true });
      if (baseEngine.bootstrap) {
        return await baseEngine.bootstrap(input);
      }
      return { bootstrapped: true, importedMessages: 0 };
    },
    async ingest(input: {
      sessionId: string;
      sessionKey?: string;
      message: AgentMessage;
      isHeartbeat?: boolean;
    }) {
      return await baseEngine.ingest(input);
    },
    async ingestBatch(input: {
      sessionId: string;
      sessionKey?: string;
      messages: AgentMessage[];
      isHeartbeat?: boolean;
    }) {
      if (baseEngine.ingestBatch) {
        return await baseEngine.ingestBatch(input);
      }
      let ingestedCount = 0;
      for (const message of input.messages) {
        const result = await baseEngine.ingest({
          sessionId: input.sessionId,
          sessionKey: input.sessionKey,
          message,
          isHeartbeat: input.isHeartbeat,
        });
        if (result.ingested) {
          ingestedCount += 1;
        }
      }
      return { ingestedCount };
    },
    async assemble(input: {
      sessionId: string;
      sessionKey?: string;
      messages: AgentMessage[];
      tokenBudget?: number;
      model?: string;
      runtimeContext?: Record<string, unknown>;
    }) {
      const baseResult = await baseEngine.assemble(input);
      const systemPromptAddition = await buildTenantContextPrompt({
        config: params.config,
        sessionKey: input.sessionKey,
        projectId:
          typeof input.runtimeContext?.projectId === "string"
            ? input.runtimeContext.projectId
            : undefined,
      });
      const mergedSystemPromptAddition = [baseResult.systemPromptAddition, systemPromptAddition]
        .filter((entry): entry is string => Boolean(entry?.trim()))
        .join("\n\n");
      return mergedSystemPromptAddition
        ? {
            ...baseResult,
            systemPromptAddition: mergedSystemPromptAddition,
          }
        : baseResult;
    },
    async afterTurn(input: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
      messages: AgentMessage[];
      prePromptMessageCount: number;
      autoCompactionSummary?: string;
      isHeartbeat?: boolean;
      tokenBudget?: number;
      runtimeContext?: Record<string, unknown>;
    }) {
      if (baseEngine.afterTurn) {
        await baseEngine.afterTurn(input);
      }
      try {
        const store = await loadElytrasStore(params.config.storePath);
        const sessionRouteContext =
          input.runtimeContext?.messageChannel && input.runtimeContext?.senderId
            ? {}
            : await loadSessionRouteContext({
                config: params.config,
                sessionKey: input.sessionKey,
              });
        const scope = store
          ? resolveScopeForSession({
              store,
              sessionKey: input.sessionKey,
              messageChannel:
                typeof input.runtimeContext?.messageChannel === "string"
                  ? input.runtimeContext.messageChannel
                  : sessionRouteContext.messageChannel,
              senderId:
                typeof input.runtimeContext?.senderId === "string"
                  ? input.runtimeContext.senderId
                  : sessionRouteContext.senderId,
              projectId:
                typeof input.runtimeContext?.projectId === "string"
                  ? input.runtimeContext.projectId
                  : sessionRouteContext.projectId,
            })
          : {
              status: "unresolved" as const,
              reason: "no-match" as const,
              candidateExternalIds: [],
            };
        const memoryScopes =
          scope.status === "resolved"
            ? buildElytrasMemoryScopes({
                resolution: scope,
                sessionKey: input.sessionKey,
                channel:
                  typeof input.runtimeContext?.messageChannel === "string"
                    ? input.runtimeContext.messageChannel
                    : sessionRouteContext.messageChannel,
              })
            : [];
        await appendAuditEvent({
          config: params.config,
          payload: {
            event: "afterTurn",
            sessionId: input.sessionId,
            sessionKey: input.sessionKey,
            sessionFile: input.sessionFile,
            messageCount: input.messages.length,
            prePromptMessageCount: input.prePromptMessageCount,
            tokenBudget: input.tokenBudget,
            scope,
            memoryScopes,
          },
        });
      } catch (error) {
        params.logger.warn(`elytrasless afterTurn failed: ${String(error)}`);
      }
    },
    async compact(input: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
      tokenBudget?: number;
      force?: boolean;
      currentTokenCount?: number;
      compactionTarget?: "budget" | "threshold";
      customInstructions?: string;
      runtimeContext?: Record<string, unknown>;
    }) {
      return await baseEngine.compact(input);
    },
    async prepareSubagentSpawn(input: {
      parentSessionKey: string;
      childSessionKey: string;
      ttlMs?: number;
    }) {
      return await baseEngine.prepareSubagentSpawn?.(input);
    },
    async onSubagentEnded(input: {
      childSessionKey: string;
      reason: "deleted" | "completed" | "swept" | "released";
    }) {
      await baseEngine.onSubagentEnded?.(input);
    },
    async dispose() {
      await baseEngine.dispose?.();
    },
  };
}
