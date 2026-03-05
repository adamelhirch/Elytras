import { NextRequest, NextResponse } from "next/server";
import { db, gateways, getAgentForUser } from "@elytras/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

/** PATCH /api/gateways/:id — modifier agent par défaut, nom, etc. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const session = await requireAuth();
  const { id } = await params;

  const [gw] = await db.select().from(gateways).where(eq(gateways.id, id)).limit(1);
  if (!gw) {return NextResponse.json({ error: "Introuvable" }, { status: 404 });}
  if (gw.userId !== session.userId && session.role !== "admin") {
    return NextResponse.json({ error: "Interdit" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if ("name" in body) {update.name = body.name;}
  if ("defaultAgentId" in body) {
    const defaultAgentId = body.defaultAgentId ?? null;
    if (defaultAgentId) {
      const allowed = await getAgentForUser(gw.userId, defaultAgentId);
      if (!allowed) {
        return NextResponse.json({ error: "defaultAgentId inaccessible" }, { status: 403 });
      }
    }
    update.defaultAgentId = defaultAgentId;
  }
  if ("status" in body) {update.status = body.status;}

  const [updated] = await db
    .update(gateways)
    .set(update)
    .where(eq(gateways.id, id))
    .returning();

  return NextResponse.json(updated);
}

/** DELETE /api/gateways/:id — supprimer un gateway */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const session = await requireAuth();
  const { id } = await params;

  const [gw] = await db.select().from(gateways).where(eq(gateways.id, id)).limit(1);
  if (!gw) {return NextResponse.json({ error: "Introuvable" }, { status: 404 });}
  if (gw.userId !== session.userId && session.role !== "admin") {
    return NextResponse.json({ error: "Interdit" }, { status: 403 });
  }

  await db.delete(gateways).where(eq(gateways.id, id));
  return new Response(null, { status: 204 });
}
