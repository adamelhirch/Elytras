import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/session";
import { db, aiProviders } from "@elytras/db";
import { eq } from "drizzle-orm";
import { encrypt } from "@/lib/crypto";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/admin/providers/[id] — sans credential */
export async function GET(_req: NextRequest, { params }: Ctx) {
  await requireAdmin();
  const { id } = await params;

  const [p] = await db
    .select({
      id: aiProviders.id,
      name: aiProviders.name,
      providerType: aiProviders.providerType,
      userId: aiProviders.userId,
      modelAllowlist: aiProviders.modelAllowlist,
      isActive: aiProviders.isActive,
      hasCredential: aiProviders.credentialEncrypted,
      createdAt: aiProviders.createdAt,
    })
    .from(aiProviders)
    .where(eq(aiProviders.id, id));

  if (!p) {return NextResponse.json({ error: "Introuvable" }, { status: 404 });}

  return NextResponse.json({ ...p, hasCredential: !!p.hasCredential });
}

/** PATCH /api/admin/providers/[id] */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  await requireAdmin();
  const { id } = await params;

  const body = await req.json().catch(() => null);
  if (!body) {return NextResponse.json({ error: "Body requis" }, { status: 400 });}

  const updates: Partial<typeof aiProviders.$inferInsert> = {};
  if (body.name !== undefined) {updates.name = body.name;}
  if (body.isActive !== undefined) {updates.isActive = body.isActive;}
  if (body.baseUrl !== undefined) {updates.baseUrl = body.baseUrl || null;}
  if (body.modelAllowlist !== undefined)
    {updates.modelAllowlist = Array.isArray(body.modelAllowlist) ? body.modelAllowlist : null;}
  if (body.apiKey) {updates.credentialEncrypted = await encrypt(body.apiKey as string);}
  updates.updatedAt = new Date();

  const [updated] = await db
    .update(aiProviders)
    .set(updates)
    .where(eq(aiProviders.id, id))
    .returning({ id: aiProviders.id, name: aiProviders.name, isActive: aiProviders.isActive });

  if (!updated) {return NextResponse.json({ error: "Introuvable" }, { status: 404 });}
  return NextResponse.json(updated);
}

/** DELETE /api/admin/providers/[id] */
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  await requireAdmin();
  const { id } = await params;
  await db.delete(aiProviders).where(eq(aiProviders.id, id));
  return new Response(null, { status: 204 });
}
