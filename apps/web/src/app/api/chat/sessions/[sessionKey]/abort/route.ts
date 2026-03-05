import { NextRequest, NextResponse } from "next/server";
import { listAgentsForUser } from "@elytras/db";
import { requireAuth } from "@/lib/auth/session";
import { GatewayRpcClient } from "@/lib/chat/gateway-rpc";
import {
  isSessionKeyOwnedByUser,
  parseAgentIdFromSessionKey,
} from "@/lib/chat/session-key";

export async function POST(
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

  const body = (await req.json().catch(() => null)) as { runId?: string } | null;

  const gateway = await GatewayRpcClient.connect();
  try {
    const result = await gateway.request("chat.abort", {
      sessionKey,
      runId: body?.runId,
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
      Allow: "POST, OPTIONS",
    },
  });
}
