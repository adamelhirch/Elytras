import { db, agents, agentFiles, groups, groupAgentPermissions } from "@elytras/db";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { AgentEditor } from "@/components/agents/agent-editor";

type Params = { params: Promise<{ id: string }> };

export default async function AdminAgentDetailPage({ params }: Params) {
  const { id } = await params;

  const [agent] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  if (!agent) {notFound();}

  const files = await db
    .select()
    .from(agentFiles)
    .where(eq(agentFiles.agentId, id))
    .orderBy(agentFiles.createdAt);

  const agentGroups = await db
    .select({ groupId: groups.id, groupName: groups.name })
    .from(groupAgentPermissions)
    .innerJoin(groups, eq(groupAgentPermissions.groupId, groups.id))
    .where(eq(groupAgentPermissions.agentId, id));

  return (
    <div className="p-8 max-w-4xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">{agent.name}</h1>
        <p className="text-gray-400 text-sm">Modifier la configuration de cet agent.</p>
      </div>

      <AgentEditor
        mode="admin"
        agent={{
          id: agent.id,
          name: agent.name,
          description: agent.description,
          aiProviderId: agent.aiProviderId,
          model: agent.model,
          systemPromptMd: agent.systemPromptMd,
          files,
        }}
      />

      <div>
        <h2 className="text-lg font-semibold text-white mb-3">Accès via groupes</h2>
        {agentGroups.length === 0 ? (
          <p className="text-sm text-gray-500">Cet agent n&apos;est assigné à aucun groupe.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {agentGroups.map((g) => (
              <a
                key={g.groupId}
                href={`/admin/groups/${g.groupId}`}
                className="px-3 py-1 rounded-lg text-sm bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 hover:bg-indigo-500/30 transition-colors"
              >
                {g.groupName}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
