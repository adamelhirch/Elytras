import { db, gateways, users } from "@elytras/db";
import { AddGatewayButton } from "@/components/admin/add-gateway-button";

export default async function AdminGatewaysPage() {
  const all = await db
    .select({
      id: gateways.id,
      name: gateways.name,
      channelType: gateways.channelType,
      status: gateways.status,
      userId: gateways.userId,
      createdAt: gateways.createdAt,
    })
    .from(gateways)
    .orderBy(gateways.createdAt);

  const allUsers = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .orderBy(users.email);

  const userMap = Object.fromEntries(allUsers.map((u) => [u.id, u]));

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Gateways</h1>
          <p className="text-gray-400 text-sm mt-1">
            Toutes les connexions canal de la plateforme
          </p>
        </div>
        <AddGatewayButton users={allUsers} />
      </div>

      <div className="rounded-xl border border-white/10 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/5">
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Nom</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Canal</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Utilisateur</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Statut</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Créé le</th>
            </tr>
          </thead>
          <tbody>
            {all.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center py-12 text-gray-600">
                  Aucun gateway configuré
                </td>
              </tr>
            )}
            {all.map((gw) => (
              <tr key={gw.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="px-4 py-3 text-white font-medium">{gw.name}</td>
                <td className="px-4 py-3">
                  <ChannelBadge type={gw.channelType} />
                </td>
                <td className="px-4 py-3 text-gray-400 text-xs">
                  {userMap[gw.userId]?.displayName ?? userMap[gw.userId]?.email ?? gw.userId}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={gw.status} />
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {new Date(gw.createdAt).toLocaleDateString("fr-FR")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ChannelBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    whatsapp: "bg-green-500/20 text-green-400",
    telegram: "bg-blue-500/20 text-blue-400",
    slack: "bg-purple-500/20 text-purple-400",
    discord: "bg-indigo-500/20 text-indigo-400",
    signal: "bg-yellow-500/20 text-yellow-400",
    imessage: "bg-sky-500/20 text-sky-400",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[type] ?? "bg-white/10 text-gray-400"}`}>
      {type}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: "bg-emerald-500/20 text-emerald-400",
    inactive: "bg-gray-500/20 text-gray-400",
    error: "bg-red-500/20 text-red-400",
    connecting: "bg-amber-500/20 text-amber-400",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[status] ?? "bg-white/10 text-gray-400"}`}>
      {status}
    </span>
  );
}
