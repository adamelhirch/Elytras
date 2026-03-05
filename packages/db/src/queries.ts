import { eq, inArray } from "drizzle-orm";
/**
 * Requêtes réutilisables — accès agents et skills via groupes
 */
import { db } from "./client";
import {
  agents,
  skills,
  users,
  groupMembers,
  groupAgentPermissions,
  groupSkillPermissions,
} from "./schema";

/** IDs des groupes dont userId est membre */
async function getGroupIdsForUser(userId: string): Promise<string[]> {
  const rows = await db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(eq(groupMembers.userId, userId));
  return rows.map((r) => r.groupId);
}

/**
 * Liste les agents accessibles pour un user :
 * - admin: tous les agents
 * - user: uniquement via permissions de groupe
 */
export async function listAgentsForUser(userId: string) {
  const [user] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (user?.role === "admin") {
    return db.select().from(agents).orderBy(agents.createdAt);
  }

  const groupIds = await getGroupIdsForUser(userId);
  if (groupIds.length === 0) {
    return [];
  }

  const perms = await db
    .select({ agentId: groupAgentPermissions.agentId })
    .from(groupAgentPermissions)
    .where(inArray(groupAgentPermissions.groupId, groupIds));

  const allowedAgentIds = [...new Set(perms.map((p) => p.agentId))];
  if (allowedAgentIds.length === 0) {
    return [];
  }

  return db
    .select()
    .from(agents)
    .where(inArray(agents.id, allowedAgentIds))
    .orderBy(agents.createdAt);
}

/** Agent accessible pour un user, sinon null */
export async function getAgentForUser(userId: string, agentId: string) {
  const list = await listAgentsForUser(userId);
  return list.find((agent) => agent.id === agentId) ?? null;
}

/**
 * Liste les skills accessibles pour un user :
 * - skills globaux (enabledGlobal = true)
 * - skills activés pour au moins un de ses groupes
 */
export async function listSkillsForUser(userId: string) {
  const groupIds = await getGroupIdsForUser(userId);

  let enabledByGroup: string[] = [];
  if (groupIds.length > 0) {
    const perms = await db
      .select({ skillId: groupSkillPermissions.skillId })
      .from(groupSkillPermissions)
      .where(inArray(groupSkillPermissions.groupId, groupIds));
    enabledByGroup = perms.map((p) => p.skillId);
  }

  const all = await db.select().from(skills).orderBy(skills.name);

  return all.filter((s) => s.enabledGlobal || enabledByGroup.includes(s.id));
}
