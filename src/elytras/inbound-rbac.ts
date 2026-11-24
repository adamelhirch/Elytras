import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { escapeRegExp, isRecord, safeParseJson } from "../utils.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";

const DEFAULT_CONTROL_TOWER_STORE_PATH =
  process.env.CONTROL_TOWER_STORE_PATH ||
  path.join(os.homedir(), ".openclaw", "elytras", "runtime", "control-tower-store.json");
const SYSTEM_CHANNEL_KINDS = new Set(["heartbeat", "internal", "webchat"]);

type ElytrasUserRole = "admin" | "operator" | "member" | "viewer";
type ElytrasUserStatus = "active" | "invited" | "disabled";
type ElytrasGrantPermission = "view" | "operate" | "admin";

type ElytrasUser = {
  id: string;
  name: string;
  role: ElytrasUserRole;
  status: ElytrasUserStatus;
  teamIds: string[];
  channelIds: string[];
  agentIds: string[];
  externalIdentities: string[];
};

type ElytrasTeam = {
  id: string;
  name: string;
  memberIds: string[];
  agentIds: string[];
  channelIds: string[];
};

type ElytrasChannelSurfaceType = "transport" | "destination" | "system";

type ElytrasChannel = {
  id: string;
  kind: string;
  target: string;
  accountId?: string;
  deliveryTarget?: string;
  surfaceType: ElytrasChannelSurfaceType;
  source: "detected" | "custom";
};

type ElytrasGrant = {
  subjectType: "user" | "team";
  subjectId: string;
  resourceType: string;
  resourceId: string;
  permission: ElytrasGrantPermission;
};

type ElytrasAgentBinding = {
  agentId: string;
  teamId?: string;
  channelIds: string[];
  defaultOutputChannelIds: string[];
};

type ElytrasStore = {
  users: ElytrasUser[];
  teams: ElytrasTeam[];
  channels: ElytrasChannel[];
  grants: ElytrasGrant[];
  agentBindings: ElytrasAgentBinding[];
};

type IdentityMatch = {
  user: ElytrasUser;
  matchedExternalId: string;
  matchedBy: "exact" | "pattern";
  score: number;
};

type ElytrasInboundAccessStatus = "disabled" | "allowed" | "blocked";

export type ElytrasInboundAccessDecision = {
  status: ElytrasInboundAccessStatus;
  reason:
    | "store_missing"
    | "store_invalid"
    | "non_external_channel"
    | "missing_sender_identity"
    | "unresolved_sender"
    | "ambiguous_sender"
    | "user_inactive"
    | "viewer_role"
    | "destination_unmatched"
    | "agent_not_authorized"
    | "destination_not_authorized"
    | "no_common_authorizing_team"
    | "access_denied"
    | "admin"
    | "grant"
    | "direct"
    | "team";
  channelId?: string;
  agentId?: string;
  userId?: string;
  userName?: string;
  matchedExternalId?: string;
  matchedChannelIds: string[];
  authorizingTeamIds: string[];
};

type StoreCacheEntry = {
  storePath: string;
  mtimeMs: number;
  size: number;
  store: ElytrasStore | null;
  error?: string;
};

let storeCache: StoreCacheEntry | null = null;

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeUserRole(value: unknown): ElytrasUserRole {
  switch (value) {
    case "admin":
    case "operator":
    case "viewer":
      return value;
    default:
      return "member";
  }
}

function normalizeUserStatus(value: unknown): ElytrasUserStatus {
  switch (value) {
    case "invited":
    case "disabled":
      return value;
    default:
      return "active";
  }
}

function normalizeGrantPermission(value: unknown): ElytrasGrantPermission {
  switch (value) {
    case "admin":
    case "operate":
      return value;
    default:
      return "view";
  }
}

function buildChannelStoreId(channelId: string, accountId?: string) {
  return `${channelId}/${normalizeAccountId(accountId)}`;
}

function buildCustomChannelRouteId(
  channelId: string,
  accountId: unknown,
  deliveryTarget: unknown,
  destinationType?: unknown,
) {
  const normalizedChannelId = normalizeOptionalString(channelId) || "channel";
  const normalizedAccountId = normalizeAccountId(normalizeOptionalString(accountId));
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

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isSystemChannelKind(value: unknown) {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized ? SYSTEM_CHANNEL_KINDS.has(normalized) : false;
}

function resolveChannelSurfaceType(raw: {
  id?: unknown;
  kind?: unknown;
  accountId?: unknown;
  deliveryTarget?: unknown;
  source?: unknown;
  surfaceType?: unknown;
}): ElytrasChannelSurfaceType {
  const explicit = normalizeOptionalString(raw.surfaceType)?.toLowerCase();
  if (explicit === "transport" || explicit === "destination" || explicit === "system") {
    return explicit;
  }
  if (isSystemChannelKind(raw.kind)) {
    return "system";
  }
  if (normalizeOptionalString(raw.deliveryTarget)) {
    return "destination";
  }
  const normalizedSource = normalizeOptionalString(raw.source) || "detected";
  const normalizedId = normalizeOptionalString(raw.id) || "";
  if (normalizedSource === "detected" && normalizedId.startsWith("detected-")) {
    return "destination";
  }
  if (normalizeOptionalString(raw.accountId)) {
    return "transport";
  }
  return "system";
}

function normalizeStore(raw: unknown): ElytrasStore {
  const record = isRecord(raw) ? raw : {};
  const users = Array.isArray(record.users)
    ? record.users
        .map((value) => normalizeUserRecord(value))
        .filter((value): value is ElytrasUser => value != null)
    : [];
  const teams = Array.isArray(record.teams)
    ? record.teams
        .map((value) => normalizeTeamRecord(value))
        .filter((value): value is ElytrasTeam => value != null)
    : [];
  const channels = Array.isArray(record.channels)
    ? record.channels
        .map((value) => normalizeChannelRecord(value))
        .filter((value): value is ElytrasChannel => value != null)
    : [];
  const grants = Array.isArray(record.grants)
    ? record.grants
        .map((value) => normalizeGrantRecord(value))
        .filter((value): value is ElytrasGrant => value != null)
    : [];
  const agentBindings = Array.isArray(record.agentBindings)
    ? record.agentBindings
        .map((value) => normalizeAgentBindingRecord(value))
        .filter((value): value is ElytrasAgentBinding => value != null)
    : [];
  return {
    users,
    teams,
    channels,
    grants,
    agentBindings,
  };
}

function normalizeUserRecord(value: unknown): ElytrasUser | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = normalizeOptionalString(value.id);
  if (!id) {
    return null;
  }
  return {
    id,
    name: normalizeOptionalString(value.name) || id,
    role: normalizeUserRole(value.role),
    status: normalizeUserStatus(value.status),
    teamIds: normalizeIdList(value.teamIds),
    channelIds: normalizeIdList(value.channelIds),
    agentIds: normalizeIdList(value.agentIds),
    externalIdentities: normalizeIdList(value.externalIdentities).map((entry) =>
      entry.toLowerCase(),
    ),
  };
}

function normalizeTeamRecord(value: unknown): ElytrasTeam | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = normalizeOptionalString(value.id);
  if (!id) {
    return null;
  }
  return {
    id,
    name: normalizeOptionalString(value.name) || id,
    memberIds: normalizeIdList(value.memberIds),
    agentIds: normalizeIdList(value.agentIds),
    channelIds: normalizeIdList(value.channelIds),
  };
}

function normalizeChannelRecord(value: unknown): ElytrasChannel | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = normalizeOptionalString(value.kind)?.toLowerCase() || "internal";
  const accountId = normalizeOptionalString(value.accountId);
  const deliveryTarget = normalizeOptionalString(value.deliveryTarget);
  const target =
    normalizeOptionalString(value.target) || deliveryTarget || normalizeAccountId(accountId);
  const source = value.source === "custom" ? "custom" : "detected";
  return {
    id:
      normalizeOptionalString(value.id) ||
      (deliveryTarget
        ? buildCustomChannelRouteId(kind, accountId, deliveryTarget, value.destinationType)
        : buildChannelStoreId(kind, accountId)),
    kind,
    target,
    ...(accountId ? { accountId } : {}),
    ...(deliveryTarget ? { deliveryTarget } : {}),
    surfaceType: resolveChannelSurfaceType({
      id: value.id,
      kind,
      accountId,
      deliveryTarget,
      source,
      surfaceType: value.surfaceType,
    }),
    source,
  };
}

function normalizeGrantRecord(value: unknown): ElytrasGrant | null {
  if (!isRecord(value)) {
    return null;
  }
  const subjectType =
    value.subjectType === "team" ? "team" : value.subjectType === "user" ? "user" : null;
  const subjectId = normalizeOptionalString(value.subjectId);
  const resourceType = normalizeOptionalString(value.resourceType);
  const resourceId = normalizeOptionalString(value.resourceId);
  if (!subjectType || !subjectId || !resourceType || !resourceId) {
    return null;
  }
  return {
    subjectType,
    subjectId,
    resourceType,
    resourceId,
    permission: normalizeGrantPermission(value.permission),
  };
}

function normalizeAgentBindingRecord(value: unknown): ElytrasAgentBinding | null {
  if (!isRecord(value)) {
    return null;
  }
  const agentId = normalizeOptionalString(value.agentId);
  if (!agentId) {
    return null;
  }
  return {
    agentId,
    teamId: normalizeOptionalString(value.teamId),
    channelIds: normalizeIdList(value.channelIds),
    defaultOutputChannelIds: normalizeIdList(value.defaultOutputChannelIds),
  };
}

async function loadStore(storePath = DEFAULT_CONTROL_TOWER_STORE_PATH): Promise<{
  store: ElytrasStore | null;
  error?: string;
}> {
  try {
    const stat = await fs.stat(storePath);
    if (
      storeCache &&
      storeCache.storePath === storePath &&
      storeCache.mtimeMs === stat.mtimeMs &&
      storeCache.size === stat.size
    ) {
      return { store: storeCache.store, ...(storeCache.error ? { error: storeCache.error } : {}) };
    }
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = safeParseJson<unknown>(raw);
    if (!isRecord(parsed)) {
      const error = "invalid_json";
      storeCache = {
        storePath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        store: null,
        error,
      };
      return { store: null, error };
    }
    const store = normalizeStore(parsed);
    storeCache = {
      storePath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      store,
    };
    return { store };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { store: null };
    }
    return {
      store: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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

function addSenderIdentityCandidates(
  bucket: Set<string>,
  channelId: string,
  rawValue: unknown,
  kind: "id" | "username" | "tag" | "label" | "e164",
) {
  const raw = normalizeOptionalString(rawValue)?.toLowerCase();
  if (!raw) {
    return;
  }
  addExternalIdentityCandidates(bucket, channelId, raw);
  if (kind === "username" || kind === "tag") {
    const stripped = raw.replace(/^@+/, "");
    if (stripped) {
      bucket.add(stripped);
      if (channelId) {
        bucket.add(`${channelId}:${stripped}`);
      }
    }
  }
  if (kind === "label" && channelId) {
    bucket.add(`${channelId}:${raw}`);
  }
}

function buildSenderIdentityCandidates(ctx: FinalizedMsgContext, channelId: string): string[] {
  const bucket = new Set<string>();
  addSenderIdentityCandidates(bucket, channelId, ctx.SenderId, "id");
  addSenderIdentityCandidates(bucket, channelId, ctx.SenderE164, "e164");
  addSenderIdentityCandidates(bucket, channelId, ctx.SenderUsername, "username");
  addSenderIdentityCandidates(bucket, channelId, ctx.SenderTag, "tag");
  addSenderIdentityCandidates(bucket, channelId, ctx.SenderName, "label");
  return Array.from(bucket);
}

function buildRouteComparisonTokens(value: unknown): string[] {
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

function addTelegramTopicRouteTokens(
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
  for (const token of buildRouteComparisonTokens(`${base}:topic:${normalizedThreadId}`)) {
    bucket.add(token);
  }
  for (const token of buildRouteComparisonTokens(`telegram:${base}:topic:${normalizedThreadId}`)) {
    bucket.add(token);
  }
}

function isManagedDestinationChannel(channel: ElytrasChannel) {
  return channel.surfaceType === "destination";
}

function resolveMatchedChannelIds(params: {
  ctx: FinalizedMsgContext;
  channelId: string;
  channels: ElytrasChannel[];
}): string[] {
  const accountCandidates = new Set<string>();
  const accountId = normalizeOptionalString(params.ctx.AccountId);
  if (accountId) {
    accountCandidates.add(normalizeAccountId(accountId));
  }

  const targetCandidates = new Set<string>();
  const threadId =
    typeof params.ctx.MessageThreadId === "number" || typeof params.ctx.MessageThreadId === "string"
      ? String(params.ctx.MessageThreadId).trim()
      : undefined;
  for (const rawValue of [params.ctx.OriginatingTo, params.ctx.To, params.ctx.NativeChannelId]) {
    for (const token of buildRouteComparisonTokens(rawValue)) {
      targetCandidates.add(token);
    }
    if (params.channelId === "telegram") {
      addTelegramTopicRouteTokens(targetCandidates, rawValue, threadId);
    }
  }

  return params.channels
    .filter((channel) => {
      if (!isManagedDestinationChannel(channel)) {
        return false;
      }
      if (
        (normalizeMessageChannel(channel.kind) ?? channel.kind.toLowerCase()) !== params.channelId
      ) {
        return false;
      }
      if (
        accountCandidates.size > 0 &&
        channel.accountId &&
        !accountCandidates.has(normalizeAccountId(channel.accountId))
      ) {
        return false;
      }
      const routeTokens = new Set([
        ...buildRouteComparisonTokens(channel.deliveryTarget),
        ...buildRouteComparisonTokens(channel.target),
      ]);
      if (!routeTokens.size || !targetCandidates.size) {
        return false;
      }
      return Array.from(routeTokens).some((token) => targetCandidates.has(token));
    })
    .map((channel) => channel.id);
}

function collectUserIdentityMatches(users: ElytrasUser[], candidateExternalIds: string[]) {
  const matches: IdentityMatch[] = [];
  for (const user of users) {
    for (const pattern of user.externalIdentities) {
      for (const candidate of candidateExternalIds) {
        const match = matchExternalIdentityPattern(pattern, candidate);
        if (!match.matched) {
          continue;
        }
        matches.push({
          user,
          matchedExternalId: candidate,
          matchedBy: match.kind,
          score: match.score,
        });
      }
    }
  }
  return matches;
}

function resolveUserTeamIds(user: ElytrasUser, teams: ElytrasTeam[]) {
  const ids = new Set(user.teamIds);
  for (const team of teams) {
    if (team.memberIds.includes(user.id)) {
      ids.add(team.id);
    }
  }
  return Array.from(ids);
}

function resolveTeamAccessibleAgentIds(
  teamIds: string[],
  teams: ElytrasTeam[],
  bindings: ElytrasAgentBinding[],
) {
  const ids = new Set<string>();
  for (const teamId of teamIds) {
    const team = teams.find((entry) => entry.id === teamId);
    for (const agentId of team?.agentIds || []) {
      ids.add(agentId);
    }
    for (const binding of bindings) {
      if (binding.teamId === teamId) {
        ids.add(binding.agentId);
      }
    }
  }
  return Array.from(ids);
}

function resolveTeamAccessibleChannelIds(
  teamIds: string[],
  teams: ElytrasTeam[],
  bindings: ElytrasAgentBinding[],
) {
  const ids = new Set<string>();
  for (const teamId of teamIds) {
    const team = teams.find((entry) => entry.id === teamId);
    const teamAgentIds = new Set(team?.agentIds || []);
    for (const channelId of team?.channelIds || []) {
      ids.add(channelId);
    }
    for (const binding of bindings) {
      if (binding.teamId !== teamId && !teamAgentIds.has(binding.agentId)) {
        continue;
      }
      for (const channelId of binding.channelIds) {
        ids.add(channelId);
      }
      for (const channelId of binding.defaultOutputChannelIds) {
        ids.add(channelId);
      }
    }
  }
  return Array.from(ids);
}

function permissionRank(permission: ElytrasGrantPermission): number {
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
  grants: ElytrasGrant[];
  userId: string;
  teamIds: string[];
  resourceType: string;
  resourceId: string;
  minimumPermission: ElytrasGrantPermission;
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

function teamHasScopedGrant(params: {
  teamId: string;
  grants: ElytrasGrant[];
  resourceType: string;
  resourceId: string;
  minimumPermission: ElytrasGrantPermission;
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
  teams: ElytrasTeam[];
  bindings: ElytrasAgentBinding[];
  grants: ElytrasGrant[];
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
  return resolveTeamAccessibleAgentIds([params.teamId], params.teams, params.bindings).includes(
    params.agentId,
  );
}

function resolveTeamAgentScopedChannelIds(params: {
  teamId: string;
  agentId: string;
  teams: ElytrasTeam[];
  bindings: ElytrasAgentBinding[];
}) {
  const ids = new Set<string>();
  const team = params.teams.find((entry) => entry.id === params.teamId);
  for (const channelId of team?.channelIds || []) {
    ids.add(channelId);
  }
  const teamAgentIds = new Set(team?.agentIds || []);
  for (const binding of params.bindings) {
    if (binding.agentId !== params.agentId) {
      continue;
    }
    if (binding.teamId !== params.teamId && !teamAgentIds.has(params.agentId)) {
      continue;
    }
    for (const channelId of binding.channelIds) {
      ids.add(channelId);
    }
    for (const channelId of binding.defaultOutputChannelIds) {
      ids.add(channelId);
    }
  }
  return Array.from(ids);
}

function resolveInboundAuthorizingTeamIds(params: {
  teamIds: string[];
  agentId: string;
  matchedChannelIds: string[];
  teams: ElytrasTeam[];
  bindings: ElytrasAgentBinding[];
  grants: ElytrasGrant[];
}) {
  const ids = new Set<string>();
  for (const teamId of params.teamIds) {
    const teamAllowsAgent = teamOwnsAgentAccess({
      teamId,
      agentId: params.agentId,
      teams: params.teams,
      bindings: params.bindings,
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
        bindings: params.bindings,
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

export function evaluateElytrasInboundAccess(params: {
  ctx: FinalizedMsgContext;
  cfg?: OpenClawConfig;
  store: ElytrasStore;
}): ElytrasInboundAccessDecision {
  const channelId = normalizeMessageChannel(
    params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,
  );
  if (
    !channelId ||
    SYSTEM_CHANNEL_KINDS.has(channelId) ||
    !isDeliverableMessageChannel(channelId)
  ) {
    return {
      status: "disabled",
      reason: "non_external_channel",
      channelId,
      agentId: resolveSessionAgentId({ sessionKey: params.ctx.SessionKey, config: params.cfg }),
      matchedChannelIds: [],
      authorizingTeamIds: [],
    };
  }

  const matchedChannelIds = resolveMatchedChannelIds({
    ctx: params.ctx,
    channelId,
    channels: params.store.channels,
  });
  const senderExternalIds = buildSenderIdentityCandidates(params.ctx, channelId);
  const agentId = resolveSessionAgentId({ sessionKey: params.ctx.SessionKey, config: params.cfg });

  if (senderExternalIds.length === 0) {
    return {
      status: "blocked",
      reason: "missing_sender_identity",
      channelId,
      agentId,
      matchedChannelIds,
      authorizingTeamIds: [],
    };
  }

  const matches = collectUserIdentityMatches(params.store.users, senderExternalIds);
  if (matches.length === 0) {
    return {
      status: "blocked",
      reason: "unresolved_sender",
      channelId,
      agentId,
      matchedChannelIds,
      authorizingTeamIds: [],
    };
  }

  matches.sort((left, right) => right.score - left.score);
  const bestScore = matches[0]?.score ?? 0;
  const bestMatches = matches.filter((entry) => entry.score === bestScore);
  const uniqueUserIds = Array.from(new Set(bestMatches.map((entry) => entry.user.id)));
  if (uniqueUserIds.length !== 1) {
    return {
      status: "blocked",
      reason: "ambiguous_sender",
      channelId,
      agentId,
      matchedChannelIds,
      authorizingTeamIds: [],
    };
  }

  const resolved = bestMatches[0]!;
  const user = resolved.user;
  const teamIds = resolveUserTeamIds(user, params.store.teams);
  const teamAccessibleAgentIds = resolveTeamAccessibleAgentIds(
    teamIds,
    params.store.teams,
    params.store.agentBindings,
  );
  const teamAccessibleChannelIds = resolveTeamAccessibleChannelIds(
    teamIds,
    params.store.teams,
    params.store.agentBindings,
  );
  const accessibleTeamAgentIds = new Set(teamAccessibleAgentIds);
  const accessibleTeamChannelIds = new Set(teamAccessibleChannelIds);

  if (user.status !== "active") {
    return {
      status: "blocked",
      reason: "user_inactive",
      channelId,
      agentId,
      userId: user.id,
      userName: user.name,
      matchedExternalId: resolved.matchedExternalId,
      matchedChannelIds,
      authorizingTeamIds: [],
    };
  }
  if (user.role === "viewer") {
    return {
      status: "blocked",
      reason: "viewer_role",
      channelId,
      agentId,
      userId: user.id,
      userName: user.name,
      matchedExternalId: resolved.matchedExternalId,
      matchedChannelIds,
      authorizingTeamIds: [],
    };
  }

  const hasAdminAccess =
    user.role === "admin" ||
    principalHasGrant({
      grants: params.store.grants,
      userId: user.id,
      teamIds,
      resourceType: "*",
      resourceId: "*",
      minimumPermission: "admin",
    });
  if (hasAdminAccess) {
    return {
      status: "allowed",
      reason: "admin",
      channelId,
      agentId,
      userId: user.id,
      userName: user.name,
      matchedExternalId: resolved.matchedExternalId,
      matchedChannelIds,
      authorizingTeamIds: [],
    };
  }

  if (matchedChannelIds.length === 0) {
    return {
      status: "blocked",
      reason: "destination_unmatched",
      channelId,
      agentId,
      userId: user.id,
      userName: user.name,
      matchedExternalId: resolved.matchedExternalId,
      matchedChannelIds,
      authorizingTeamIds: [],
    };
  }

  const hasExplicitAgentAccess = principalHasGrant({
    grants: params.store.grants,
    userId: user.id,
    teamIds,
    resourceType: "agent",
    resourceId: agentId,
    minimumPermission: "operate",
  });
  const hasExplicitChannelAccess = matchedChannelIds.some((channelEntryId) =>
    principalHasGrant({
      grants: params.store.grants,
      userId: user.id,
      teamIds,
      resourceType: "channel",
      resourceId: channelEntryId,
      minimumPermission: "operate",
    }),
  );
  if (hasExplicitAgentAccess && hasExplicitChannelAccess) {
    return {
      status: "allowed",
      reason: "grant",
      channelId,
      agentId,
      userId: user.id,
      userName: user.name,
      matchedExternalId: resolved.matchedExternalId,
      matchedChannelIds,
      authorizingTeamIds: [],
    };
  }

  const hasDirectAgentAccess = user.agentIds.includes(agentId);
  const hasDirectChannelAccess = matchedChannelIds.some((channelEntryId) =>
    user.channelIds.includes(channelEntryId),
  );
  if (hasDirectAgentAccess && hasDirectChannelAccess) {
    return {
      status: "allowed",
      reason: "direct",
      channelId,
      agentId,
      userId: user.id,
      userName: user.name,
      matchedExternalId: resolved.matchedExternalId,
      matchedChannelIds,
      authorizingTeamIds: [],
    };
  }

  const authorizingTeamIds = resolveInboundAuthorizingTeamIds({
    teamIds,
    agentId,
    matchedChannelIds,
    teams: params.store.teams,
    bindings: params.store.agentBindings,
    grants: params.store.grants,
  });
  if (authorizingTeamIds.length > 0) {
    return {
      status: "allowed",
      reason: "team",
      channelId,
      agentId,
      userId: user.id,
      userName: user.name,
      matchedExternalId: resolved.matchedExternalId,
      matchedChannelIds,
      authorizingTeamIds,
    };
  }

  const hasTeamAgentAccess =
    accessibleTeamAgentIds.has(agentId) ||
    params.store.agentBindings.some(
      (binding) => binding.agentId === agentId && teamIds.includes(binding.teamId || ""),
    );
  const hasTeamChannelAccess = matchedChannelIds.some((channelEntryId) =>
    accessibleTeamChannelIds.has(channelEntryId),
  );

  if (hasExplicitAgentAccess || hasDirectAgentAccess || hasTeamAgentAccess) {
    if (hasExplicitChannelAccess || hasDirectChannelAccess || hasTeamChannelAccess) {
      return {
        status: "blocked",
        reason: "no_common_authorizing_team",
        channelId,
        agentId,
        userId: user.id,
        userName: user.name,
        matchedExternalId: resolved.matchedExternalId,
        matchedChannelIds,
        authorizingTeamIds: [],
      };
    }
    return {
      status: "blocked",
      reason: "destination_not_authorized",
      channelId,
      agentId,
      userId: user.id,
      userName: user.name,
      matchedExternalId: resolved.matchedExternalId,
      matchedChannelIds,
      authorizingTeamIds: [],
    };
  }

  if (hasExplicitChannelAccess || hasDirectChannelAccess || hasTeamChannelAccess) {
    return {
      status: "blocked",
      reason: "agent_not_authorized",
      channelId,
      agentId,
      userId: user.id,
      userName: user.name,
      matchedExternalId: resolved.matchedExternalId,
      matchedChannelIds,
      authorizingTeamIds: [],
    };
  }

  return {
    status: "blocked",
    reason: "access_denied",
    channelId,
    agentId,
    userId: user.id,
    userName: user.name,
    matchedExternalId: resolved.matchedExternalId,
    matchedChannelIds,
    authorizingTeamIds: [],
  };
}

export async function resolveElytrasInboundAccess(params: {
  ctx: FinalizedMsgContext;
  cfg?: OpenClawConfig;
  storePath?: string;
}): Promise<ElytrasInboundAccessDecision> {
  const channelId = normalizeMessageChannel(
    params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,
  );
  if (
    !channelId ||
    SYSTEM_CHANNEL_KINDS.has(channelId) ||
    !isDeliverableMessageChannel(channelId)
  ) {
    return {
      status: "disabled",
      reason: "non_external_channel",
      channelId,
      agentId: resolveSessionAgentId({ sessionKey: params.ctx.SessionKey, config: params.cfg }),
      matchedChannelIds: [],
      authorizingTeamIds: [],
    };
  }

  const storePath = params.storePath || DEFAULT_CONTROL_TOWER_STORE_PATH;
  const loaded = await loadStore(storePath);
  if (!loaded.store) {
    if (!loaded.error) {
      return {
        status: "disabled",
        reason: "store_missing",
        channelId,
        agentId: resolveSessionAgentId({ sessionKey: params.ctx.SessionKey, config: params.cfg }),
        matchedChannelIds: [],
        authorizingTeamIds: [],
      };
    }
    logVerbose(`elytras inbound rbac: failed loading ${storePath}: ${loaded.error}`);
    return {
      status: "blocked",
      reason: "store_invalid",
      channelId,
      agentId: resolveSessionAgentId({ sessionKey: params.ctx.SessionKey, config: params.cfg }),
      matchedChannelIds: [],
      authorizingTeamIds: [],
    };
  }

  return evaluateElytrasInboundAccess({
    ctx: params.ctx,
    cfg: params.cfg,
    store: loaded.store,
  });
}
