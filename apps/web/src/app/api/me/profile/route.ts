import { NextRequest, NextResponse } from "next/server";
import { db, users } from "@elytras/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/session";

const MAX_PROFILE_CHARS = 20_000;

function normalizeProfile(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length > MAX_PROFILE_CHARS) {
    throw new Error(`Le profil dépasse ${MAX_PROFILE_CHARS} caractères.`);
  }
  return normalized;
}

/** GET /api/me/profile — profil USER.md du user courant */
export async function GET() {
  const session = await requireAuth();
  const [row] = await db
    .select({ profileMd: users.profileMd })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: "Utilisateur introuvable" }, { status: 404 });
  }

  return NextResponse.json({ profileMd: row.profileMd ?? null });
}

/** PATCH /api/me/profile — met à jour USER.md du user courant */
export async function PATCH(req: NextRequest) {
  const session = await requireAuth();
  const body = await req.json().catch(() => ({}));

  if (!("profileMd" in body)) {
    return NextResponse.json({ error: "Champ profileMd requis" }, { status: 400 });
  }

  let normalized: string | null | undefined;
  try {
    normalized = normalizeProfile((body as { profileMd?: unknown }).profileMd);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
  if (normalized === undefined) {
    return NextResponse.json({ error: "profileMd doit être une string ou null" }, { status: 400 });
  }

  const [updated] = await db
    .update(users)
    .set({
      profileMd: normalized,
      updatedAt: new Date(),
    })
    .where(eq(users.id, session.userId))
    .returning({ profileMd: users.profileMd });

  if (!updated) {
    return NextResponse.json({ error: "Utilisateur introuvable" }, { status: 404 });
  }

  return NextResponse.json({ profileMd: updated.profileMd ?? null });
}
