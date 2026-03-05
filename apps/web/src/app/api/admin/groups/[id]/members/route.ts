import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/session";
import { db, groupMembers } from "@elytras/db";
import { and, eq } from "drizzle-orm";

type Ctx = { params: Promise<{ id: string }> };

// POST — ajouter un user au groupe
export async function POST(req: NextRequest, { params }: Ctx) {
  await requireAdmin();
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body?.userId) {return NextResponse.json({ error: "userId requis" }, { status: 400 });}

  // Éviter les doublons
  const existing = await db.select().from(groupMembers)
    .where(and(eq(groupMembers.groupId, id), eq(groupMembers.userId, body.userId))).limit(1);
  if (existing.length > 0) {return NextResponse.json(existing[0]);}

  const [member] = await db.insert(groupMembers)
    .values({ groupId: id, userId: body.userId as string })
    .returning();
  return NextResponse.json(member, { status: 201 });
}

// DELETE — retirer un user du groupe (?userId=...)
export async function DELETE(req: NextRequest, { params }: Ctx) {
  await requireAdmin();
  const { id } = await params;
  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) {return NextResponse.json({ error: "userId requis" }, { status: 400 });}

  await db.delete(groupMembers).where(and(eq(groupMembers.groupId, id), eq(groupMembers.userId, userId)));
  return new Response(null, { status: 204 });
}
