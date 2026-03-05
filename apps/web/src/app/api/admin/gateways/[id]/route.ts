import { NextRequest, NextResponse } from "next/server";
import { db, gateways, getAgentForUser } from "@elytras/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

/** GET /api/admin/gateways/:id */
export async function GET(_req: NextRequest, { params }: Params) {
  await requireAdmin();
  const { id } = await params;
  const [gw] = await db.select().from(gateways).where(eq(gateways.id, id)).limit(1);
  if (!gw) {return NextResponse.json({ error: "Not found" }, { status: 404 });}
  return NextResponse.json(gw);
}

/** PATCH /api/admin/gateways/:id — met à jour le status ou l'agent par défaut */
export async function PATCH(req: NextRequest, { params }: Params) {
  await requireAdmin();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const [gw] = await db.select().from(gateways).where(eq(gateways.id, id)).limit(1);
  if (!gw) {return NextResponse.json({ error: "Not found" }, { status: 404 });}

  const allowed = ["status", "defaultAgentId", "name"] as const;
  const update: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) {update[key] = body[key];}
  }

  if ("defaultAgentId" in body) {
    const defaultAgentId = body.defaultAgentId ?? null;
    if (defaultAgentId) {
      const canAccess = await getAgentForUser(gw.userId, defaultAgentId);
      if (!canAccess) {
        return NextResponse.json({ error: "defaultAgentId inaccessible pour le propriétaire" }, { status: 403 });
      }
    }
    update.defaultAgentId = defaultAgentId;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Aucun champ valide" }, { status: 400 });
  }

  const [updated] = await db
    .update(gateways)
    .set({ ...update, updatedAt: new Date() })
    .where(eq(gateways.id, id))
    .returning();

  if (!updated) {return NextResponse.json({ error: "Not found" }, { status: 404 });}
  return NextResponse.json(updated);
}

/** DELETE /api/admin/gateways/:id */
export async function DELETE(_req: NextRequest, { params }: Params) {
  await requireAdmin();
  const { id } = await params;
  await db.delete(gateways).where(eq(gateways.id, id));
  return NextResponse.json({ ok: true });
}
