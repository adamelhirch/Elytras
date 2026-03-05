import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/session";
import { db, groupAgentPermissions } from "@elytras/db";
import { and, eq } from "drizzle-orm";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  await requireAdmin();
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body?.agentId) {return NextResponse.json({ error: "agentId requis" }, { status: 400 });}

  const existing = await db.select().from(groupAgentPermissions)
    .where(and(eq(groupAgentPermissions.groupId, id), eq(groupAgentPermissions.agentId, body.agentId))).limit(1);
  if (existing.length > 0) {return NextResponse.json(existing[0]);}

  const [perm] = await db.insert(groupAgentPermissions)
    .values({ groupId: id, agentId: body.agentId as string })
    .returning();
  return NextResponse.json(perm, { status: 201 });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  await requireAdmin();
  const { id } = await params;
  const agentId = req.nextUrl.searchParams.get("agentId");
  if (!agentId) {return NextResponse.json({ error: "agentId requis" }, { status: 400 });}

  await db.delete(groupAgentPermissions).where(and(eq(groupAgentPermissions.groupId, id), eq(groupAgentPermissions.agentId, agentId)));
  return new Response(null, { status: 204 });
}
