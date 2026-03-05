import { NextRequest, NextResponse } from "next/server";
import { db, agents, agentFiles, getAgentForUser } from "@elytras/db";
import { eq } from "drizzle-orm";
import { requireAdmin, requireAuth } from "@/lib/auth/session";
import { validateProviderModelPair } from "@/lib/agents/provider-model-validation";

type Params = { params: Promise<{ id: string }> };

/** GET /api/agents/:id — détail + fichiers */
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await requireAuth();
  const { id } = await params;

  const agent = await getAgentForUser(session.userId, id);
  if (!agent) {return NextResponse.json({ error: "Not found" }, { status: 404 });}

  const files = await db
    .select()
    .from(agentFiles)
    .where(eq(agentFiles.agentId, id))
    .orderBy(agentFiles.createdAt);

  return NextResponse.json({ ...agent, files });
}

/** PATCH /api/agents/:id (admin only) */
export async function PATCH(req: NextRequest, { params }: Params) {
  await requireAdmin();
  const { id } = await params;

  const [agent] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  if (!agent) {return NextResponse.json({ error: "Not found" }, { status: 404 });}

  const body = await req.json().catch(() => ({}));

  const nextAiProviderId = "aiProviderId" in body ? (body.aiProviderId ?? null) : agent.aiProviderId;
  const nextModel = "model" in body ? (body.model ?? null) : agent.model;

  const providerModel = await validateProviderModelPair({
    aiProviderId: nextAiProviderId,
    model: nextModel,
  });
  if (!providerModel.ok) {
    return NextResponse.json({ error: providerModel.error }, { status: providerModel.status });
  }

  const allowed = ["name", "description", "avatarUrl", "systemPromptMd"] as const;
  const update: Record<string, unknown> = {
    aiProviderId: providerModel.aiProviderId,
    model: providerModel.model,
  };
  for (const key of allowed) {
    if (key in body) {update[key] = body[key];}
  }

  const [updated] = await db
    .update(agents)
    .set({ ...update, updatedAt: new Date() })
    .where(eq(agents.id, id))
    .returning();

  return NextResponse.json(updated);
}

/** DELETE /api/agents/:id (admin only) */
export async function DELETE(_req: NextRequest, { params }: Params) {
  await requireAdmin();
  const { id } = await params;

  const [agent] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  if (!agent) {return NextResponse.json({ error: "Not found" }, { status: 404 });}

  await db.delete(agents).where(eq(agents.id, id));
  return NextResponse.json({ ok: true });
}
