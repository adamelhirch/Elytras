import { NextRequest, NextResponse } from "next/server";
import { listAgentsForUser } from "@elytras/db";
import { db, agents } from "@elytras/db";
import { requireAdmin, requireAuth } from "@/lib/auth/session";
import { validateProviderModelPair } from "@/lib/agents/provider-model-validation";

/** GET /api/agents — agents accessibles pour le user */
export async function GET() {
  const session = await requireAuth();
  const list = await listAgentsForUser(session.userId);
  return NextResponse.json(list);
}

/** POST /api/agents — créer un agent (admin only) */
export async function POST(req: NextRequest) {
  await requireAdmin();
  const body = await req.json().catch(() => null);
  if (!body?.name) {
    return NextResponse.json({ error: "name requis" }, { status: 400 });
  }

  const providerModel = await validateProviderModelPair({
    aiProviderId: body.aiProviderId,
    model: body.model,
  });
  if (!providerModel.ok) {
    return NextResponse.json({ error: providerModel.error }, { status: providerModel.status });
  }

  const [created] = await db
    .insert(agents)
    .values({
      userId: null,
      name: body.name,
      description: body.description ?? null,
      avatarUrl: body.avatarUrl ?? null,
      aiProviderId: providerModel.aiProviderId,
      model: providerModel.model,
      systemPromptMd: body.systemPromptMd ?? null,
    })
    .returning();

  return NextResponse.json(created, { status: 201 });
}
