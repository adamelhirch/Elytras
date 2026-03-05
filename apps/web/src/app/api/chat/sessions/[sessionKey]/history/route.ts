import { NextRequest, NextResponse } from "next/server";
import { listAgentsForUser } from "@elytras/db";
import { requireAuth } from "@/lib/auth/session";
import { GatewayRpcClient } from "@/lib/chat/gateway-rpc";
import {
  isSessionKeyOwnedByUser,
  parseAgentIdFromSessionKey,
} from "@/lib/chat/session-key";

export async function GET(
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

  const limitRaw = req.nextUrl.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : 200;

  const gateway = await GatewayRpcClient.connect();
  try {
    const result = await gateway.request<{
      messages?: unknown[];
      sessionId?: string;
      thinkingLevel?: string;
      verboseLevel?: string;
    }>("chat.history", {
      sessionKey,
      limit: Number.isFinite(limit) ? Math.max(1, limit) : 200,
    });

    return NextResponse.json({
      sessionKey,
      sessionId: result.sessionId,
      thinkingLevel: result.thinkingLevel,
      verboseLevel: result.verboseLevel,
      messages: Array.isArray(result.messages) ? result.messages : [],
    });
  } finally {
    gateway.close();
  }
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: "GET, OPTIONS",
    },
  });
}
