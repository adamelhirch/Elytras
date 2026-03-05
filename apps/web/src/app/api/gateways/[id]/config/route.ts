import { NextRequest, NextResponse } from "next/server";
import { db, gateways } from "@elytras/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/session";
import { encrypt } from "@/lib/crypto";

type Params = { params: Promise<{ id: string }> };

/** PATCH /api/gateways/:id/config — enregistrer la configuration chiffrée d'un gateway */
export async function PATCH(req: NextRequest, { params }: Params) {
  const session = await requireAuth();
  const { id } = await params;

  const [gw] = await db.select().from(gateways).where(eq(gateways.id, id)).limit(1);
  if (!gw) {return NextResponse.json({ error: "Introuvable" }, { status: 404 });}

  if (gw.userId !== session.userId && session.role !== "admin") {
    return NextResponse.json({ error: "Interdit" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body?.config || typeof body.config !== "object") {
    return NextResponse.json({ error: "config (objet) requis" }, { status: 400 });
  }

  // Chiffrer la config JSON
  const configJson = JSON.stringify(body.config);
  const configEncrypted = await encrypt(configJson);

  await db
    .update(gateways)
    .set({ configEncrypted, updatedAt: new Date() })
    .where(eq(gateways.id, id));

  return NextResponse.json({ ok: true });
}
