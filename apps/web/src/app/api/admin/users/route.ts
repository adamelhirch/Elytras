import { NextRequest, NextResponse } from "next/server";
import { db, users } from "@elytras/db";
import bcrypt from "bcryptjs";
import { requireAdmin } from "@/lib/auth/session";

/** GET /api/admin/users */
export async function GET() {
  await requireAdmin();
  const list = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      active: users.active,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.createdAt);
  return NextResponse.json(list);
}

/** POST /api/admin/users — créer un user */
export async function POST(req: NextRequest) {
  await requireAdmin();
  const body = await req.json().catch(() => null);
  if (!body?.email || !body?.password) {
    return NextResponse.json({ error: "email et password requis" }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(body.password as string, 12);
  const [created] = await db
    .insert(users)
    .values({
      email: (body.email as string).toLowerCase().trim(),
      passwordHash,
      role: body.role === "admin" ? "admin" : "user",
      displayName: body.displayName ?? null,
    })
    .returning({
      id: users.id,
      email: users.email,
      role: users.role,
      displayName: users.displayName,
      createdAt: users.createdAt,
    });

  return NextResponse.json(created, { status: 201 });
}
