import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/session";
import { db, skillIntegrations } from "@elytras/db";
import { eq } from "drizzle-orm";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/admin/skills/[id]/integrations */
export async function GET(_req: NextRequest, { params }: Ctx) {
  await requireAdmin();
  const { id } = await params;
  const list = await db
    .select()
    .from(skillIntegrations)
    .where(eq(skillIntegrations.skillId, id));
  return NextResponse.json(list);
}

/** POST /api/admin/skills/[id]/integrations — ajouter une intégration */
export async function POST(req: NextRequest, { params }: Ctx) {
  await requireAdmin();
  const { id } = await params;

  const body = await req.json().catch(() => null);
  if (!body?.serviceType) {
    return NextResponse.json({ error: "serviceType requis" }, { status: 400 });
  }

  const [integration] = await db
    .insert(skillIntegrations)
    .values({
      skillId: id,
      serviceType: body.serviceType as string,
      endpoint: (body.endpoint as string | undefined) ?? null,
      // Note: en prod, chiffrer authConfig avant stockage
      authConfigEncrypted: body.authConfig
        ? JSON.stringify(body.authConfig)
        : null,
    })
    .returning();

  return NextResponse.json(integration, { status: 201 });
}
