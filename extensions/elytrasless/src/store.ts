import fs from "node:fs/promises";

export type ElytrasUser = {
  id: string;
  name: string;
  role: "admin" | "operator" | "member" | "viewer";
  status: "active" | "invited" | "disabled";
  teamIds: string[];
  externalIdentities: string[];
};

export type ElytrasTeam = {
  id: string;
  name: string;
  memberIds: string[];
  agentIds: string[];
};

export type ElytrasProject = {
  id: string;
  name: string;
  teamId: string;
  memberIds: string[];
  agentIds: string[];
};

export type ElytrasAgentBinding = {
  agentId: string;
  teamId?: string;
};

export type ElytrasStore = {
  users: ElytrasUser[];
  teams: ElytrasTeam[];
  projects: ElytrasProject[];
  agentBindings: ElytrasAgentBinding[];
};

export type ParsedSessionRef = {
  agentId: string;
  channel?: string;
  accountId?: string;
  peerKind?: string;
  peerId?: string;
};

export type ElytrasScopeResolution =
  | {
      status: "resolved";
      agentId: string;
      user: { id: string; name: string; role: ElytrasUser["role"]; status: ElytrasUser["status"] };
      team?: { id: string; name: string };
      project?: { id: string; name: string; teamId: string };
      matchedExternalIdentity: string;
      candidateExternalIds: string[];
    }
  | {
      status: "unresolved";
      reason:
        | "missing-agent"
        | "missing-identity"
        | "no-match"
        | "ambiguous-match"
        | "unauthorized-team";
      agentId?: string;
      candidateExternalIds: string[];
    };

const KNOWN_SESSION_PEER_KINDS = new Set(["direct", "dm", "group", "channel", "thread"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeUser(value: unknown): ElytrasUser | null {
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
    role:
      normalizeOptionalString(value.role) === "admin" ||
      normalizeOptionalString(value.role) === "operator" ||
      normalizeOptionalString(value.role) === "viewer"
        ? (normalizeOptionalString(value.role) as ElytrasUser["role"])
        : "member",
    status:
      normalizeOptionalString(value.status) === "invited" ||
      normalizeOptionalString(value.status) === "disabled"
        ? (normalizeOptionalString(value.status) as ElytrasUser["status"])
        : "active",
    teamIds: normalizeStringArray(value.teamIds),
    externalIdentities: normalizeStringArray(value.externalIdentities).map((entry) =>
      entry.toLowerCase(),
    ),
  };
}

function normalizeTeam(value: unknown): ElytrasTeam | null {
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
    memberIds: normalizeStringArray(value.memberIds),
    agentIds: normalizeStringArray(value.agentIds),
  };
}

function normalizeProject(value: unknown): ElytrasProject | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = normalizeOptionalString(value.id);
  const teamId = normalizeOptionalString(value.teamId);
  if (!id || !teamId) {
    return null;
  }
  return {
    id,
    name: normalizeOptionalString(value.name) || id,
    teamId,
    memberIds: normalizeStringArray(value.memberIds),
    agentIds: normalizeStringArray(value.agentIds).map((entry) => entry.toLowerCase()),
  };
}

function normalizeAgentBinding(value: unknown): ElytrasAgentBinding | null {
  if (!isRecord(value)) {
    return null;
  }
  const agentId = normalizeOptionalString(value.agentId);
  if (!agentId) {
    return null;
  }
  return {
    agentId: agentId.toLowerCase(),
    teamId: normalizeOptionalString(value.teamId),
  };
}

export function normalizeElytrasStore(value: unknown): ElytrasStore {
  const record = isRecord(value) ? value : {};
  return {
    users: Array.isArray(record.users)
      ? record.users
          .map((entry) => normalizeUser(entry))
          .filter((entry): entry is ElytrasUser => entry !== null)
      : [],
    teams: Array.isArray(record.teams)
      ? record.teams
          .map((entry) => normalizeTeam(entry))
          .filter((entry): entry is ElytrasTeam => entry !== null)
      : [],
    projects: Array.isArray(record.projects)
      ? record.projects
          .map((entry) => normalizeProject(entry))
          .filter((entry): entry is ElytrasProject => entry !== null)
      : [],
    agentBindings: Array.isArray(record.agentBindings)
      ? record.agentBindings
          .map((entry) => normalizeAgentBinding(entry))
          .filter((entry): entry is ElytrasAgentBinding => entry !== null)
      : [],
  };
}

export async function loadElytrasStore(storePath: string): Promise<ElytrasStore | null> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    return normalizeElytrasStore(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseSessionRef(sessionKey?: string): ParsedSessionRef | null {
  const trimmed = normalizeOptionalString(sessionKey);
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(":");
  if (parts.length < 3 || parts[0]?.toLowerCase() !== "agent") {
    return null;
  }
  const agentId = normalizeOptionalString(parts[1])?.toLowerCase();
  if (!agentId) {
    return null;
  }
  const rest = parts.slice(2);
  if (rest.length === 0) {
    return { agentId };
  }
  if (rest.length >= 2 && KNOWN_SESSION_PEER_KINDS.has(rest[0]?.toLowerCase() || "")) {
    return {
      agentId,
      peerKind: normalizeOptionalString(rest[0])?.toLowerCase(),
      peerId: normalizeOptionalString(rest.slice(1).join(":")),
    };
  }
  if (rest.length >= 3 && KNOWN_SESSION_PEER_KINDS.has(rest[1]?.toLowerCase() || "")) {
    return {
      agentId,
      channel: normalizeOptionalString(rest[0])?.toLowerCase(),
      peerKind: normalizeOptionalString(rest[1])?.toLowerCase(),
      peerId: normalizeOptionalString(rest.slice(2).join(":")),
    };
  }
  if (rest.length >= 4 && KNOWN_SESSION_PEER_KINDS.has(rest[2]?.toLowerCase() || "")) {
    return {
      agentId,
      channel: normalizeOptionalString(rest[0])?.toLowerCase(),
      accountId: normalizeOptionalString(rest[1])?.toLowerCase(),
      peerKind: normalizeOptionalString(rest[2])?.toLowerCase(),
      peerId: normalizeOptionalString(rest.slice(3).join(":")),
    };
  }
  return {
    agentId,
    channel: normalizeOptionalString(rest[0])?.toLowerCase(),
  };
}

function addIdentityCandidates(
  candidates: Set<string>,
  channel: string | undefined,
  rawId: string | undefined,
) {
  const senderId = normalizeOptionalString(rawId);
  if (!senderId) {
    return;
  }
  candidates.add(senderId.toLowerCase());
  const normalizedChannel = normalizeOptionalString(channel)?.toLowerCase();
  if (!normalizedChannel) {
    return;
  }
  candidates.add(`${normalizedChannel}:${senderId}`.toLowerCase());
  candidates.add(`${normalizedChannel}:user:${senderId}`.toLowerCase());
  candidates.add(`${normalizedChannel}:direct:${senderId}`.toLowerCase());
}

function resolveAuthorizedTeam(
  store: ElytrasStore,
  user: ElytrasUser,
  agentId: string,
): ElytrasTeam | undefined {
  const normalizedAgentId = agentId.toLowerCase();
  const explicitBinding = store.agentBindings.find(
    (binding) => binding.agentId === normalizedAgentId,
  );
  if (explicitBinding?.teamId && user.teamIds.includes(explicitBinding.teamId)) {
    return store.teams.find((team) => team.id === explicitBinding.teamId);
  }

  const matchingTeams = store.teams.filter(
    (team) =>
      user.teamIds.includes(team.id) &&
      team.agentIds.includes(normalizedAgentId) &&
      team.memberIds.includes(user.id),
  );
  return matchingTeams[0];
}

function resolveProjectMemoryScope(params: {
  store: ElytrasStore;
  user: ElytrasUser;
  team?: ElytrasTeam;
  agentId: string;
  projectId?: string;
}): ElytrasProject | undefined {
  const requestedProjectId = normalizeOptionalString(params.projectId);
  if (!requestedProjectId) {
    return undefined;
  }
  const normalizedAgentId = params.agentId.toLowerCase();
  return params.store.projects.find((project) => {
    if (project.id !== requestedProjectId) {
      return false;
    }
    if (params.team && project.teamId !== params.team.id) {
      return false;
    }
    if (!params.user.teamIds.includes(project.teamId)) {
      return false;
    }
    if (project.agentIds.length > 0 && !project.agentIds.includes(normalizedAgentId)) {
      return false;
    }
    if (project.memberIds.length > 0 && !project.memberIds.includes(params.user.id)) {
      return false;
    }
    return true;
  });
}

export function resolveScopeForSession(params: {
  store: ElytrasStore;
  sessionKey?: string;
  messageChannel?: string;
  senderId?: string;
  projectId?: string;
}): ElytrasScopeResolution {
  const parsed = parseSessionRef(params.sessionKey);
  const agentId = parsed?.agentId;
  if (!agentId) {
    return {
      status: "unresolved",
      reason: "missing-agent",
      candidateExternalIds: [],
    };
  }

  const candidateExternalIds = new Set<string>();
  addIdentityCandidates(
    candidateExternalIds,
    params.messageChannel ?? parsed?.channel,
    params.senderId,
  );
  if (parsed?.peerKind === "direct") {
    addIdentityCandidates(candidateExternalIds, parsed.channel, parsed.peerId);
  }

  const candidateList = [...candidateExternalIds];
  if (candidateList.length === 0) {
    return {
      status: "unresolved",
      reason: "missing-identity",
      agentId,
      candidateExternalIds: [],
    };
  }

  const matches = params.store.users.flatMap((user) => {
    const match = user.externalIdentities.find((identity) => candidateExternalIds.has(identity.toLowerCase()));
    if (match) {
      return [{ user, matchedExternalIdentity: match }];
    }
    if (
      candidateExternalIds.has(user.id.toLowerCase()) ||
      candidateExternalIds.has(`elytras:user:${user.id.toLowerCase()}`)
    ) {
      return [{ user, matchedExternalIdentity: `elytras:user:${user.id}` }];
    }
    return [];
  });

  if (matches.length === 0) {
    return {
      status: "unresolved",
      reason: "no-match",
      agentId,
      candidateExternalIds: candidateList,
    };
  }
  if (matches.length > 1) {
    return {
      status: "unresolved",
      reason: "ambiguous-match",
      agentId,
      candidateExternalIds: candidateList,
    };
  }

  const resolved = matches[0]!;
  const team = resolveAuthorizedTeam(params.store, resolved.user, agentId);
  if (!team) {
    return {
      status: "unresolved",
      reason: "unauthorized-team",
      agentId,
      candidateExternalIds: candidateList,
    };
  }
  const project = resolveProjectMemoryScope({
    store: params.store,
    user: resolved.user,
    team,
    agentId,
    projectId: params.projectId,
  });
  return {
    status: "resolved",
    agentId,
    user: {
      id: resolved.user.id,
      name: resolved.user.name,
      role: resolved.user.role,
      status: resolved.user.status,
    },
    team: {
      id: team.id,
      name: team.name,
    },
    ...(project
      ? {
          project: {
            id: project.id,
            name: project.name,
            teamId: project.teamId,
          },
        }
      : {}),
    matchedExternalIdentity: resolved.matchedExternalIdentity,
    candidateExternalIds: candidateList,
  };
}
