import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/session";
import { db, groups, groupMembers, groupAgentPermissions, groupSkillPermissions, users, agents, skills } from "@elytras/db";
import { eq } from "drizzle-orm";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  await requireAdmin();
  const { id } = await params;

  const [group] = await db.select().from(groups).where(eq(groups.id, id));
  if (!group) {return NextResponse.json({ error: "Introuvable" }, { status: 404 });}

  const members = await db
    .select({ id: groupMembers.id, userId: users.id, email: users.email, displayName: users.displayName, role: users.role })
    .from(groupMembers)
    .innerJoin(users, eq(groupMembers.userId, users.id))
    .where(eq(groupMembers.groupId, id));

  const agentPerms = await db
    .select({ id: groupAgentPermissions.id, agentId: agents.id, agentName: agents.name, agentModel: agents.model })
    .from(groupAgentPermissions)
    .innerJoin(agents, eq(groupAgentPermissions.agentId, agents.id))
    .where(eq(groupAgentPermissions.groupId, id));

  const skillPerms = await db
    .select({ id: groupSkillPermissions.id, skillId: skills.id, skillName: skills.name, skillDescription: skills.description })
    .from(groupSkillPermissions)
    .innerJoin(skills, eq(groupSkillPermissions.skillId, skills.id))
    .where(eq(groupSkillPermissions.groupId, id));

  return NextResponse.json({ ...group, members, agents: agentPerms, skills: skillPerms });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  await requireAdmin();
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) {return NextResponse.json({ error: "Body requis" }, { status: 400 });}

  const updates: Partial<typeof groups.$inferInsert> = {};
  if (body.name !== undefined) {updates.name = body.name;}
  if (body.description !== undefined) {updates.description = body.description;}
  updates.updatedAt = new Date();

  const [updated] = await db.update(groups).set(updates).where(eq(groups.id, id)).returning();
  if (!updated) {return NextResponse.json({ error: "Introuvable" }, { status: 404 });}
  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  await requireAdmin();
  const { id } = await params;
  await db.delete(groups).where(eq(groups.id, id));
  return new Response(null, { status: 204 });
}
