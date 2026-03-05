import { NextRequest, NextResponse } from "next/server";
import { listAgentsForUser } from "@elytras/db";
import { requireAuth } from "@/lib/auth/session";
import { GatewayRpcClient } from "@/lib/chat/gateway-rpc";
import {
  isSessionKeyOwnedByUser,
  parseAgentIdFromSessionKey,
} from "@/lib/chat/session-key";

function parseRequestedLabel(body: unknown): string | null | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const label = (body as { label?: unknown }).label;
  if (label === null) {
    return null;
  }
  if (typeof label === "string") {
    return label;
  }
  return undefined;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ sessionKey: string }> },
) {
  const session = await requireAuth();
  const params = await ctx.params;
  const sessionKey = decodeURIComponent(params.sessionKey);

  if (!isSessionKeyOwnedByUser(sessionKey, session.userId)) {
    return NextResponse.json({ error: "sessionKey interdit" }, { status: 403 });
  }

  const agentList = await listAgentsForUser(session.userId);
  const allowedAgentIds = new Set(agentList.map((a) => a.id));
  const parsedAgentId = parseAgentIdFromSessionKey(sessionKey);
  if (parsedAgentId && !allowedAgentIds.has(parsedAgentId)) {
    return NextResponse.json({ error: "agent interdit" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const requestedLabel = parseRequestedLabel(body);
  if (requestedLabel === undefined) {
    return NextResponse.json({ error: "label invalide" }, { status: 400 });
  }

  const gateway = await GatewayRpcClient.connect();
  try {
    const result = await gateway.request("sessions.patch", {
      key: sessionKey,
      label: requestedLabel,
    });
    return NextResponse.json(result);
  } finally {
    gateway.close();
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ sessionKey: string }> },
) {
  const session = await requireAuth();
  const params = await ctx.params;
  const sessionKey = decodeURIComponent(params.sessionKey);

  if (!isSessionKeyOwnedByUser(sessionKey, session.userId)) {
    return NextResponse.json({ error: "sessionKey interdit" }, { status: 403 });
  }

  const agentList = await listAgentsForUser(session.userId);
  const allowedAgentIds = new Set(agentList.map((a) => a.id));
  const parsedAgentId = parseAgentIdFromSessionKey(sessionKey);
  if (parsedAgentId && !allowedAgentIds.has(parsedAgentId)) {
    return NextResponse.json({ error: "agent interdit" }, { status: 403 });
  }

  const gateway = await GatewayRpcClient.connect();
  try {
    const result = await gateway.request("sessions.delete", {
      key: sessionKey,
      deleteTranscript: true,
    });
    return NextResponse.json(result);
  } finally {
    gateway.close();
  }
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: "PATCH, DELETE, OPTIONS",
    },
  });
}
