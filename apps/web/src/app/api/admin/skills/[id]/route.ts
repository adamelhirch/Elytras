import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/session";
import { db, skills, skillIntegrations } from "@elytras/db";
import { eq } from "drizzle-orm";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/admin/skills/[id] — détail d'un skill avec permissions et intégrations */
export async function GET(_req: NextRequest, { params }: Ctx) {
  await requireAdmin();
  const { id } = await params;

  const [skill] = await db.select().from(skills).where(eq(skills.id, id));
  if (!skill) return NextResponse.json({ error: "Introuvable" }, { status: 404 });

  const integrations = await db
    .select()
    .from(skillIntegrations)
    .where(eq(skillIntegrations.skillId, id));

  return NextResponse.json({ ...skill, integrations });
}

/** PATCH /api/admin/skills/[id] — modifier un skill */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  await requireAdmin();
  const { id } = await params;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Body requis" }, { status: 400 });

  const updates: Partial<typeof skills.$inferInsert> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.skillMdContent !== undefined) updates.skillMdContent = body.skillMdContent;
  if (body.enabledGlobal !== undefined) updates.enabledGlobal = body.enabledGlobal;
  updates.updatedAt = new Date();

  const [updated] = await db
    .update(skills)
    .set(updates)
    .where(eq(skills.id, id))
    .returning();

  if (!updated) return NextResponse.json({ error: "Introuvable" }, { status: 404 });
  return NextResponse.json(updated);
}

/** DELETE /api/admin/skills/[id] — supprimer un skill */
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  await requireAdmin();
  const { id } = await params;

  await db.delete(skills).where(eq(skills.id, id));
  return new Response(null, { status: 204 });
}
