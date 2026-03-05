import { db, groups, groupMembers, groupAgentPermissions, groupSkillPermissions, users, agents, skills } from "@elytras/db";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { GroupEditor } from "@/components/admin/group-editor";
import { GroupMembersPanel } from "@/components/admin/group-members-panel";
import { GroupAssignPanel } from "@/components/admin/group-assign-panel";

type Props = { params: Promise<{ id: string }> };

export default async function AdminGroupDetailPage({ params }: Props) {
  const { id } = await params;

  const [group] = await db.select().from(groups).where(eq(groups.id, id));
  if (!group) {notFound();}

  const members = await db
    .select({ memberId: groupMembers.id, userId: users.id, email: users.email, displayName: users.displayName, role: users.role })
    .from(groupMembers)
    .innerJoin(users, eq(groupMembers.userId, users.id))
    .where(eq(groupMembers.groupId, id));

  const groupAgents = await db
    .select({ permId: groupAgentPermissions.id, agentId: agents.id, name: agents.name, model: agents.model })
    .from(groupAgentPermissions)
    .innerJoin(agents, eq(groupAgentPermissions.agentId, agents.id))
    .where(eq(groupAgentPermissions.groupId, id));

  const groupSkills = await db
    .select({ permId: groupSkillPermissions.id, skillId: skills.id, name: skills.name, description: skills.description })
    .from(groupSkillPermissions)
    .innerJoin(skills, eq(groupSkillPermissions.skillId, skills.id))
    .where(eq(groupSkillPermissions.groupId, id));

  const allUsers = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users).orderBy(users.email);

  const allAgents = await db
    .select({ id: agents.id, name: agents.name, model: agents.model })
    .from(agents).orderBy(agents.name);

  const allSkills = await db
    .select({ id: skills.id, name: skills.name, description: skills.description })
    .from(skills).orderBy(skills.name);

  const memberUserIds = new Set(members.map((m) => m.userId));
  const assignedAgentIds = new Set(groupAgents.map((a) => a.agentId));
  const assignedSkillIds = new Set(groupSkills.map((s) => s.skillId));

  return (
    <div className="p-8 max-w-4xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">{group.name}</h1>
        <p className="text-gray-400 text-sm">Gérez les membres, agents et skills de ce groupe.</p>
      </div>

      <GroupEditor group={group} />

      <GroupMembersPanel
        groupId={id}
        members={members.map((m) => ({ memberId: m.memberId, userId: m.userId, email: m.email, displayName: m.displayName, role: m.role }))}
        availableUsers={allUsers.filter((u) => !memberUserIds.has(u.id))}
      />

      <GroupAssignPanel
        groupId={id}
        type="agents"
        assigned={groupAgents.map((a) => ({ permId: a.permId, id: a.agentId, name: a.name, sub: a.model ?? undefined }))}
        available={allAgents.filter((a) => !assignedAgentIds.has(a.id)).map((a) => ({ id: a.id, name: a.name, sub: a.model ?? undefined }))}
        label="Agents"
        icon="✦"
      />

      <GroupAssignPanel
        groupId={id}
        type="skills"
        assigned={groupSkills.map((s) => ({ permId: s.permId, id: s.skillId, name: s.name, sub: s.description ?? undefined }))}
        available={allSkills.filter((s) => !assignedSkillIds.has(s.id)).map((s) => ({ id: s.id, name: s.name, sub: s.description ?? undefined }))}
        label="Skills"
        icon="⚡"
      />
    </div>
  );
}
