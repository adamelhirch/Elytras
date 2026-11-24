import type {
  ChannelCatalogEntry,
  ChannelRouteConfig,
  ChannelRouteKind,
  DashboardChannel,
} from "../types";

const SYSTEM_CHANNEL_KINDS = new Set(["heartbeat", "internal", "webchat"]);
const DETECTED_SYSTEM_CHANNEL_TARGETS = new Set(["heartbeat", "session"]);

function isDetectedSystemChannelTarget(value?: string) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    DETECTED_SYSTEM_CHANNEL_TARGETS.has(normalized) ||
    normalized === "internal" ||
    normalized.startsWith("heartbeat:")
  );
}

function resolveChannelSurfaceType(channel: DashboardChannel) {
  if (
    channel.surfaceType === "transport" ||
    channel.surfaceType === "destination" ||
    channel.surfaceType === "system"
  ) {
    return channel.surfaceType;
  }
  if (isSystemChannelKind(channel.kind)) {
    return "system" as const;
  }
  if (
    channel.source === "detected" &&
    isDetectedSystemChannelTarget(channel.target || channel.deliveryTarget)
  ) {
    return "system" as const;
  }
  if (channel.deliveryTarget) {
    return "destination" as const;
  }
  if (channel.source === "detected" && channel.id.startsWith("detected-")) {
    return "destination" as const;
  }
  if (channel.accountId) {
    return "transport" as const;
  }
  return "system" as const;
}

export function getChannelRouteConfig(
  entry?: Pick<ChannelCatalogEntry, "template"> | null,
): ChannelRouteConfig | null {
  return entry?.template.routeConfig || null;
}

export function getChannelDefaultDestinationType(
  entry?: Pick<ChannelCatalogEntry, "template"> | null,
) {
  const routeConfig = getChannelRouteConfig(entry);
  if (!routeConfig?.enabled) {
    return "";
  }
  return routeConfig.destinationKinds[0]?.id || "";
}

export function resolveChannelRouteKind(
  entry: Pick<ChannelCatalogEntry, "template"> | undefined,
  destinationType?: string,
): ChannelRouteKind | null {
  const routeConfig = getChannelRouteConfig(entry);
  if (!routeConfig?.enabled) {
    return null;
  }
  if (destinationType) {
    const explicit = routeConfig.destinationKinds.find((kind) => kind.id === destinationType);
    if (explicit) {
      return explicit;
    }
  }
  return routeConfig.destinationKinds[0] || null;
}

export function normalizeChannelAccountId(accountId?: string) {
  return accountId?.trim() || "default";
}

export function isSystemChannelKind(kind?: string) {
  return kind ? SYSTEM_CHANNEL_KINDS.has(kind.trim().toLowerCase()) : false;
}

export function isOutputRouteChannel(channel: DashboardChannel) {
  return resolveChannelSurfaceType(channel) === "destination";
}

export function isManagedOutputRouteChannel(channel: DashboardChannel) {
  return channel.source === "custom" && resolveChannelSurfaceType(channel) === "destination";
}

export function isRuntimeTransportChannel(channel: DashboardChannel) {
  return resolveChannelSurfaceType(channel) === "transport";
}

export function isDetectedDestinationChannel(channel: DashboardChannel) {
  return channel.source === "detected" && resolveChannelSurfaceType(channel) === "destination";
}

export function isSystemChannelSurface(channel: DashboardChannel) {
  return resolveChannelSurfaceType(channel) === "system";
}

export function buildChannelTargetComparisonTokens(value?: string | null) {
  const normalized = value?.trim().toLowerCase() || "";
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

export function channelsShareResolvedTarget(left: DashboardChannel, right: DashboardChannel) {
  if (left.kind !== right.kind) {
    return false;
  }
  if (normalizeChannelAccountId(left.accountId) !== normalizeChannelAccountId(right.accountId)) {
    return false;
  }
  const leftTokens = new Set([
    ...buildChannelTargetComparisonTokens(left.deliveryTarget || left.target),
    ...buildChannelTargetComparisonTokens(left.target),
  ]);
  const rightTokens = new Set([
    ...buildChannelTargetComparisonTokens(right.deliveryTarget || right.target),
    ...buildChannelTargetComparisonTokens(right.target),
  ]);
  if (!leftTokens.size || !rightTokens.size) {
    return false;
  }
  return Array.from(leftTokens).some((token) => rightTokens.has(token));
}

export function buildChannelRouteSummary(
  channel: DashboardChannel,
  template?: Pick<ChannelCatalogEntry, "template">["template"] | null,
) {
  const accountPart = channel.accountId ? ` · ${channel.accountId}` : "";
  const routeKind = template
    ? resolveChannelRouteKind({ template }, channel.destinationType)
    : null;
  const targetPart = channel.deliveryTarget || channel.target || "n/a";
  const routeKindPart = routeKind ? ` · ${routeKind.label}` : "";
  return `${template?.label || channel.kind}${accountPart}${routeKindPart} -> ${targetPart}`;
}
