import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/session";
import { db, aiProviders } from "@elytras/db";
import { encrypt } from "@/lib/crypto";

/** GET /api/admin/providers — liste tous les providers IA */
export async function GET() {
  await requireAdmin();
  const list = await db
    .select({
      id: aiProviders.id,
      name: aiProviders.name,
      providerType: aiProviders.providerType,
      userId: aiProviders.userId,
      modelAllowlist: aiProviders.modelAllowlist,
      isActive: aiProviders.isActive,
      createdAt: aiProviders.createdAt,
    })
    .from(aiProviders)
    .orderBy(aiProviders.createdAt);

  return NextResponse.json(list);
}

/** POST /api/admin/providers — créer un provider */
export async function POST(req: NextRequest) {
  await requireAdmin();

  const body = await req.json().catch(() => null);
  if (!body?.name || !body?.providerType) {
    return NextResponse.json({ error: "name et providerType requis" }, { status: 400 });
  }

  // Chiffrer la clé API si fournie
  let credentialEncrypted: string | null = null;
  if (body.apiKey) {
    credentialEncrypted = await encrypt(body.apiKey as string);
  }

  const [provider] = await db
    .insert(aiProviders)
    .values({
      name: body.name as string,
      providerType: body.providerType as typeof aiProviders.$inferInsert["providerType"],
      userId: body.userId ?? null,
      baseUrl: body.baseUrl ?? null,
      credentialEncrypted,
      modelAllowlist: Array.isArray(body.modelAllowlist) ? body.modelAllowlist : null,
      isActive: body.isActive !== false,
    })
    .returning({ id: aiProviders.id, name: aiProviders.name, providerType: aiProviders.providerType, isActive: aiProviders.isActive, createdAt: aiProviders.createdAt });

  return NextResponse.json(provider, { status: 201 });
}
