import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/session";
import { db, secrets } from "@elytras/db";
import { and, eq } from "drizzle-orm";
import { encrypt } from "@/lib/crypto";

/** GET /api/secrets — secrets du user connecté (sans valeur) */
export async function GET() {
  const session = await requireAuth();
  const list = await db
    .select({
      id: secrets.id,
      name: secrets.name,
      providerHint: secrets.providerHint,
      createdAt: secrets.createdAt,
    })
    .from(secrets)
    .where(
      and(eq(secrets.ownerId, session.userId), eq(secrets.ownerType, "user")),
    )
    .orderBy(secrets.createdAt);

  return NextResponse.json(list);
}

/** POST /api/secrets — stocker sa propre clé */
export async function POST(req: NextRequest) {
  const session = await requireAuth();

  const body = await req.json().catch(() => null);
  if (!body?.name || !body?.value) {
    return NextResponse.json({ error: "name et value requis" }, { status: 400 });
  }

  const encryptedValue = await encrypt(body.value as string);

  const [secret] = await db
    .insert(secrets)
    .values({
      ownerId: session.userId,
      ownerType: "user",
      name: body.name as string,
      encryptedValue,
      providerHint: (body.providerHint as string | undefined) ?? null,
    })
    .returning({
      id: secrets.id,
      name: secrets.name,
      providerHint: secrets.providerHint,
      createdAt: secrets.createdAt,
    });

  return NextResponse.json(secret, { status: 201 });
}

/** DELETE /api/secrets/[id] via query param pour rester RESTful sans route imbriquée */
export async function DELETE(req: NextRequest) {
  const session = await requireAuth();
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {return NextResponse.json({ error: "id requis" }, { status: 400 });}

  // Vérifier que le secret appartient bien au user
  await db
    .delete(secrets)
    .where(
      and(
        eq(secrets.id, id),
        eq(secrets.ownerId, session.userId),
        eq(secrets.ownerType, "user"),
      ),
    );

  return new Response(null, { status: 204 });
}
