import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/session";
import { listAgentsForUser } from "@elytras/db";

/**
 * GET /api/chat/agents — agents accessibles pour le user connecté
 */
export async function GET() {
  const session = await requireAuth();
  const list = await listAgentsForUser(session.userId);
  return NextResponse.json(
    list.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      model: a.model,
      avatarUrl: a.avatarUrl,
    })),
  );
}
