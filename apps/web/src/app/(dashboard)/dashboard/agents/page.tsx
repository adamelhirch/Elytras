import { listAgentsForUser } from "@elytras/db";
import { requireAuth } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function AgentsPage() {
  const session = await requireAuth();

  if (session.role === "admin") {
    redirect("/admin/agents");
  }

  const list = await listAgentsForUser(session.userId);

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Agents</h1>
        <p className="text-gray-400 text-sm mt-1">Vos assistants IA disponibles</p>
      </div>

      {list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 p-12 text-center">
          <p className="text-gray-500">Aucun agent configuré.</p>
          <p className="text-gray-600 text-sm mt-1">
            Créez un agent pour lui donner un nom, un rôle et un modèle IA.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {list.map((agent) => (
            <Link
              key={agent.id}
              href={`/dashboard/agents/${agent.id}`}
              className="block rounded-xl border border-white/10 bg-white/5 p-5 hover:bg-white/10 transition-colors"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="font-semibold text-white truncate">{agent.name}</div>
                {agent.userId === null && (
                  <span className="px-1.5 py-0.5 rounded text-xs bg-brand-500/20 text-brand-400 shrink-0 ml-2">
                    global
                  </span>
                )}
              </div>
              {agent.description && (
                <p className="text-gray-500 text-xs line-clamp-2">{agent.description}</p>
              )}
              {agent.model && (
                <div className="mt-3 text-xs font-mono text-gray-600 truncate">{agent.model}</div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
