import { db, agentFiles, groups, groupAgentPermissions, getAgentForUser } from "@elytras/db";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

export default async function AgentDetailPage({ params }: Params) {
  const { id } = await params;
  const session = await requireAuth();

  if (id === "new") {
    if (session.role === "admin") {
      redirect("/admin/agents/new");
    }
    notFound();
  }

  const agent = await getAgentForUser(session.userId, id);
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
    <div className="p-8 max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">{agent.name}</h1>
        {agent.description && (
          <p className="text-gray-400 text-sm">{agent.description}</p>
        )}
      </div>

      {agent.model && (
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-widest mb-2">Modèle</h2>
          <div className="font-mono text-sm text-gray-300 bg-white/5 border border-white/10 rounded-lg px-4 py-3">
            {agent.model}
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-widest mb-2">Fichiers de contexte</h2>
          <div className="space-y-2">
            {files.map((f) => (
              <div key={f.id} className="flex items-center gap-2 text-sm text-gray-300 bg-white/5 border border-white/10 rounded-lg px-4 py-2">
                <span className="font-mono text-gray-500 text-xs">{f.filename}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-widest mb-2">Accès</h2>
        {agent.userId === null ? (
          <p className="text-sm text-gray-400">Agent global — visibilité contrôlée par les permissions de groupe.</p>
        ) : agentGroups.length === 0 ? (
          <p className="text-sm text-gray-500">Cet agent n&apos;est assigné à aucun groupe.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {agentGroups.map((g) => (
              <span
                key={g.groupId}
                className="px-3 py-1 rounded-lg text-sm bg-indigo-500/20 text-indigo-400 border border-indigo-500/30"
              >
                {g.groupName}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
