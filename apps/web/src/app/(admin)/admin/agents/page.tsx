import { db, agents, groupAgentPermissions } from "@elytras/db";
import { sql } from "drizzle-orm";
import Link from "next/link";

export default async function AdminAgentsPage() {
  const list = await db
    .select({
      id: agents.id,
      name: agents.name,
      description: agents.description,
      model: agents.model,
      userId: agents.userId,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .orderBy(agents.createdAt);

  // Nombre de groupes par agent
  const groupCounts = await db
    .select({ agentId: groupAgentPermissions.agentId, count: sql<number>`count(*)::int` })
    .from(groupAgentPermissions)
    .groupBy(groupAgentPermissions.agentId);
  const countMap = Object.fromEntries(groupCounts.map((r) => [r.agentId, r.count]));

  const globalAgents = list.filter((a) => a.userId === null);
  const userAgents = list.filter((a) => a.userId !== null);

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Agents</h1>
          <p className="text-gray-400 text-sm mt-1">
            {globalAgents.length} agent(s) global(aux), {userAgents.length} agent(s) utilisateur(s)
          </p>
        </div>
        <Link
          href="/admin/agents/new"
          className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium rounded-lg transition-colors"
        >
          + Nouvel agent global
        </Link>
      </div>

      <div className="rounded-xl border border-white/10 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/5">
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Nom</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Modèle</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Portée</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Groupes</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Créé le</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center py-12 text-gray-600">
                  Aucun agent configuré
                </td>
              </tr>
            )}
            {list.map((agent) => {
              const gc = countMap[agent.id] ?? 0;
              return (
                <tr key={agent.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/agents/${agent.id}`}
                      className="text-white hover:text-brand-400 font-medium transition-colors"
                    >
                      {agent.name}
                    </Link>
                    {agent.description && (
                      <div className="text-gray-600 text-xs mt-0.5 truncate max-w-xs">
                        {agent.description}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs font-mono">
                    {agent.model ?? <span className="text-gray-600">défaut</span>}
                  </td>
                  <td className="px-4 py-3">
                    {agent.userId === null ? (
                      <span className="px-2 py-0.5 rounded text-xs bg-brand-500/20 text-brand-400">global</span>
                    ) : (
                      <span className="px-2 py-0.5 rounded text-xs bg-white/5 text-gray-600">utilisateur</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {agent.userId === null ? (
                      <span className="text-gray-600 text-xs">—</span>
                    ) : gc === 0 ? (
                      <Link href="/admin/groups" className="text-xs text-amber-500 hover:underline">
                        Aucun groupe
                      </Link>
                    ) : (
                      <Link href="/admin/groups" className="text-xs text-indigo-400 hover:underline">
                        {gc} groupe(s)
                      </Link>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {new Date(agent.createdAt).toLocaleDateString("fr-FR")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
