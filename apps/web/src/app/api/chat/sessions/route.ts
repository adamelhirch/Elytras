import { NextRequest, NextResponse } from "next/server";
import { listAgentsForUser } from "@elytras/db";
import { requireAuth } from "@/lib/auth/session";
import { GatewayRpcClient } from "@/lib/chat/gateway-rpc";
import {
  buildNewSessionBaseKey,
  isSessionKeyOwnedByUser,
  parseAgentIdFromSessionKey,
} from "@/lib/chat/session-key";

type SessionsListResponse = {
  sessions?: Array<{
    key: string;
    updatedAt?: number;
    label?: string;
    displayName?: string;
    derivedTitle?: string;
    lastMessagePreview?: string;
    model?: string;
    modelProvider?: string;
  }>;
};

export async function GET(req: NextRequest) {
  const session = await requireAuth();
  const agentList = await listAgentsForUser(session.userId);
  const allowedAgentIds = new Set(agentList.map((a) => a.id));

  const agentId = req.nextUrl.searchParams.get("agentId")?.trim() || undefined;
  const limitRaw = req.nextUrl.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : 100;

  if (agentId && !allowedAgentIds.has(agentId)) {
    return NextResponse.json({ error: "agent interdit" }, { status: 403 });
  }

  const gateway = await GatewayRpcClient.connect();
  try {
    const result = await gateway.request<SessionsListResponse>("sessions.list", {
      limit: Number.isFinite(limit) ? Math.max(1, limit) : 100,
      includeGlobal: false,
      includeUnknown: false,
      includeDerivedTitles: true,
      includeLastMessage: true,
      agentId,
    });

    const sessions = (result.sessions ?? []).filter((item) => {
      if (!isSessionKeyOwnedByUser(item.key, session.userId)) {
        return false;
      }
      const parsedAgentId = parseAgentIdFromSessionKey(item.key);
      if (!parsedAgentId) {
        return true;
      }
      return allowedAgentIds.has(parsedAgentId);
    });

    return NextResponse.json({ sessions });
  } finally {
    gateway.close();
  }
}

export async function POST(req: NextRequest) {
  const session = await requireAuth();
  const agentList = await listAgentsForUser(session.userId);
  const allowedAgentIds = new Set(agentList.map((a) => a.id));

  const body = (await req.json().catch(() => null)) as
    | {
        agentId?: string;
        sessionKey?: string;
        label?: string | null;
      }
    | null;

  const requestedAgentId = body?.agentId?.trim() || undefined;
  const requestedSessionKey = body?.sessionKey?.trim() || undefined;
  const requestedLabel = body?.label;

  if (requestedAgentId && !allowedAgentIds.has(requestedAgentId)) {
    return NextResponse.json({ error: "agent interdit" }, { status: 403 });
  }

  if (requestedSessionKey && !isSessionKeyOwnedByUser(requestedSessionKey, session.userId)) {
    return NextResponse.json({ error: "sessionKey interdit" }, { status: 403 });
  }

  const requestedSessionAgentId = requestedSessionKey
    ? parseAgentIdFromSessionKey(requestedSessionKey)
    : null;
  const hasAgentMismatch =
    requestedAgentId &&
    requestedSessionAgentId &&
    requestedSessionAgentId !== requestedAgentId;

  const baseSessionKey =
    requestedSessionKey && !hasAgentMismatch
      ? requestedSessionKey
      :
    buildNewSessionBaseKey(session.userId, requestedAgentId ?? "main");

  const gateway = await GatewayRpcClient.connect();
  try {
    let resolved: { key: string };
    try {
      resolved = await gateway.request<{ key: string }>("sessions.resolve", {
        key: baseSessionKey,
        agentId: requestedAgentId,
      });
    } catch (error) {
      const reset = await gateway
        .request<{ key?: string }>("sessions.reset", {
          key: baseSessionKey,
          reason: "new",
        })
        .catch(() => {
          throw error;
        });
      resolved = { key: reset.key ?? baseSessionKey };
    }

    if (!isSessionKeyOwnedByUser(resolved.key, session.userId)) {
      return NextResponse.json({ error: "session résolue hors namespace user" }, { status: 403 });
    }

    const parsedAgentId = parseAgentIdFromSessionKey(resolved.key);
    if (parsedAgentId && !allowedAgentIds.has(parsedAgentId)) {
      return NextResponse.json({ error: "session liée à un agent interdit" }, { status: 403 });
    }

    if (requestedLabel !== undefined) {
      await gateway.request("sessions.patch", {
        key: resolved.key,
        label: requestedLabel,
      });
    }

    return NextResponse.json({ sessionKey: resolved.key });
  } finally {
    gateway.close();
  }
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: "GET, POST, OPTIONS",
    },
  });
}
