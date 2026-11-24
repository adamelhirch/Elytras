import type { ElytrasScopeResolution } from "./store.js";

export type ElytrasMemoryScopeType = "agent" | "user-agent" | "project-agent" | "shared";

export type ElytrasMemoryScope = {
  scopeType: ElytrasMemoryScopeType;
  agentId: string;
  userId?: string;
  teamId?: string;
  projectId?: string;
  sessionKey?: string;
  channel?: string;
  externalIdentity?: string;
};

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function buildElytrasMemoryScopes(params: {
  resolution: ElytrasScopeResolution;
  sessionKey?: string;
  channel?: string;
}): ElytrasMemoryScope[] {
  if (params.resolution.status !== "resolved") {
    return [];
  }

  const sessionKey = normalizeOptionalString(params.sessionKey);
  const channel = normalizeOptionalString(params.channel)?.toLowerCase();
  const externalIdentity = normalizeOptionalString(params.resolution.matchedExternalIdentity);
  const base = {
    agentId: params.resolution.agentId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(channel ? { channel } : {}),
    ...(externalIdentity ? { externalIdentity } : {}),
  };

  const scopes: ElytrasMemoryScope[] = [
    {
      scopeType: "agent",
      ...base,
    },
    {
      scopeType: "user-agent",
      ...base,
      userId: params.resolution.user.id,
    },
  ];

  if (params.resolution.project?.id) {
    scopes.push({
      scopeType: "project-agent",
      ...base,
      teamId: params.resolution.project.teamId,
      projectId: params.resolution.project.id,
    });
  }

  return scopes;
}

export function formatElytrasMemoryScope(scope: ElytrasMemoryScope): string {
  const parts = [`${scope.scopeType}`];
  parts.push(`agent=${scope.agentId}`);
  if (scope.userId) {
    parts.push(`user=${scope.userId}`);
  }
  if (scope.teamId) {
    parts.push(`team=${scope.teamId}`);
  }
  if (scope.projectId) {
    parts.push(`project=${scope.projectId}`);
  }
  if (scope.channel) {
    parts.push(`channel=${scope.channel}`);
  }
  return parts.join(" · ");
}
