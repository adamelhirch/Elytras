import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/session";
import { db, groupSkillPermissions } from "@elytras/db";
import { and, eq } from "drizzle-orm";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  await requireAdmin();
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body?.skillId) return NextResponse.json({ error: "skillId requis" }, { status: 400 });

  const existing = await db.select().from(groupSkillPermissions)
    .where(and(eq(groupSkillPermissions.groupId, id), eq(groupSkillPermissions.skillId, body.skillId))).limit(1);
  if (existing.length > 0) return NextResponse.json(existing[0]);

  const [perm] = await db.insert(groupSkillPermissions)
    .values({ groupId: id, skillId: body.skillId as string })
    .returning();
  return NextResponse.json(perm, { status: 201 });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  await requireAdmin();
  const { id } = await params;
  const skillId = req.nextUrl.searchParams.get("skillId");
  if (!skillId) return NextResponse.json({ error: "skillId requis" }, { status: 400 });

  await db.delete(groupSkillPermissions).where(and(eq(groupSkillPermissions.groupId, id), eq(groupSkillPermissions.skillId, skillId)));
  return new Response(null, { status: 204 });
}
