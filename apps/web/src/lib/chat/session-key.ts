import { randomUUID } from "node:crypto";

const AGENT_PREFIX = "agent:";

export function buildUserSessionNamespace(userId: string): string {
  return `elytras-${userId}`;
}

export function buildNewSessionBaseKey(userId: string, agentId: string): string {
  const base = `${buildUserSessionNamespace(userId)}-${agentId}-${randomUUID()}`;
  return `${AGENT_PREFIX}${agentId}:${base}`;
}

export function stripAgentPrefix(sessionKey: string): string {
  if (!sessionKey.startsWith(AGENT_PREFIX)) {
    return sessionKey;
  }
  const parts = sessionKey.split(":");
  if (parts.length < 3) {
    return sessionKey;
  }
  return parts.slice(2).join(":");
}

export function parseAgentIdFromSessionKey(sessionKey: string): string | null {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match?.[1] ?? null;
}

export function isSessionKeyOwnedByUser(sessionKey: string, userId: string): boolean {
  const base = stripAgentPrefix(sessionKey);
  const namespace = buildUserSessionNamespace(userId);
  return base === namespace || base.startsWith(`${namespace}-`);
}
