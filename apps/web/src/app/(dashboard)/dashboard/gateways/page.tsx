import { db, gateways, listAgentsForUser } from "@elytras/db";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth/session";
import { AddGatewayButton } from "@/components/admin/add-gateway-button";
import { GatewayActions } from "@/components/gateways/gateway-actions";
import Link from "next/link";

export default async function UserGatewaysPage() {
  const session = await getSession();
  const list = await db
    .select()
    .from(gateways)
    .where(eq(gateways.userId, session!.userId))
    .orderBy(gateways.createdAt);

  // Agents accessibles pour le select "agent par défaut"
  const agentList = (await listAgentsForUser(session!.userId))
    .map((a) => ({ id: a.id, name: a.name }))
    .toSorted((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Mes gateways</h1>
          <p className="text-gray-400 text-sm mt-1">Vos connexions aux messageries</p>
        </div>
        <AddGatewayButton userId={session!.userId} />
      </div>

      {list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 p-12 text-center">
          <p className="text-gray-500">Aucune connexion configurée.</p>
          <p className="text-gray-600 text-sm mt-1">
            Ajoutez un gateway pour connecter WhatsApp, Telegram, Discord…
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {list.map((gw) => (
            <div key={gw.id} className="rounded-xl border border-white/10 bg-white/5 p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <Link
                    href={`/dashboard/gateways/${gw.id}`}
                    className="font-semibold text-white hover:text-indigo-400 transition-colors"
                  >
                    {gw.name}
                  </Link>
                  <div className="text-xs text-gray-500 mt-0.5 capitalize">{gw.channelType}</div>
                </div>
                <div className="flex items-center gap-1.5">
                  <div
                    className={`w-2 h-2 rounded-full ${
                      {
                        active: "bg-emerald-500",
                        inactive: "bg-gray-500",
                        error: "bg-red-500",
                        connecting: "bg-amber-500",
                      }[gw.status] ?? "bg-gray-500"
                    }`}
                  />
                  <span className="text-xs text-gray-400 capitalize">{gw.status}</span>
                </div>
              </div>
              {!gw.configEncrypted && (
                <div className="text-xs text-amber-400 mb-2">
                  ⚠ Connexion non configurée —{" "}
                  <Link href={`/dashboard/gateways/${gw.id}`} className="underline">
                    Configurer
                  </Link>
                </div>
              )}
              <GatewayActions gatewayId={gw.id} agents={agentList} defaultAgentId={gw.defaultAgentId} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
