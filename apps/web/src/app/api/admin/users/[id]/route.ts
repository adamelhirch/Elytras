import { NextRequest, NextResponse } from "next/server";
import { db, users } from "@elytras/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

/** PATCH /api/admin/users/:id — activer/désactiver, changer le rôle */
export async function PATCH(req: NextRequest, { params }: Params) {
  await requireAdmin();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const allowed = ["active", "role", "displayName"] as const;
  const update: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) {update[key] = body[key];}
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Aucun champ valide" }, { status: 400 });
  }

  const [updated] = await db
    .update(users)
    .set({ ...update, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning({
      id: users.id,
      email: users.email,
      role: users.role,
      displayName: users.displayName,
      active: users.active,
    });

  if (!updated) {return NextResponse.json({ error: "Not found" }, { status: 404 });}
  return NextResponse.json(updated);
}

/** DELETE /api/admin/users/:id */
export async function DELETE(_req: NextRequest, { params }: Params) {
  await requireAdmin();
  const { id } = await params;
  await db.delete(users).where(eq(users.id, id));
  return NextResponse.json({ ok: true });
}
