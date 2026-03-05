import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/session";
import { db, secrets } from "@elytras/db";
import { encrypt } from "@/lib/crypto";

/** GET /api/admin/secrets — liste sans valeurs déchiffrées */
export async function GET() {
  await requireAdmin();
  const list = await db
    .select({
      id: secrets.id,
      ownerId: secrets.ownerId,
      ownerType: secrets.ownerType,
      name: secrets.name,
      providerHint: secrets.providerHint,
      createdAt: secrets.createdAt,
    })
    .from(secrets)
    .orderBy(secrets.createdAt);

  return NextResponse.json(list);
}

/** POST /api/admin/secrets — stocker un secret chiffré */
export async function POST(req: NextRequest) {
  await requireAdmin();

  const body = await req.json().catch(() => null);
  if (!body?.name || !body?.value || !body?.ownerId || !body?.ownerType) {
    return NextResponse.json(
      { error: "name, value, ownerId et ownerType requis" },
      { status: 400 },
    );
  }

  const encryptedValue = await encrypt(body.value as string);

  const [secret] = await db
    .insert(secrets)
    .values({
      ownerId: body.ownerId as string,
      ownerType: body.ownerType as "user" | "agent" | "gateway" | "skill",
      name: body.name as string,
      encryptedValue,
      providerHint: (body.providerHint as string | undefined) ?? null,
    })
    .returning({
      id: secrets.id,
      name: secrets.name,
      ownerType: secrets.ownerType,
      ownerId: secrets.ownerId,
      providerHint: secrets.providerHint,
      createdAt: secrets.createdAt,
    });

  return NextResponse.json(secret, { status: 201 });
}
