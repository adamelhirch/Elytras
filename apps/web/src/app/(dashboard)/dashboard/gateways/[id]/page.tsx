import { db, gateways, listAgentsForUser } from "@elytras/db";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/session";
import { GatewayConfigEditor } from "@/components/gateways/gateway-config-editor";
import { AgentSelectClient } from "@/components/gateways/agent-select-client";
import Link from "next/link";

type Params = { params: Promise<{ id: string }> };

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  slack: "Slack",
  discord: "Discord",
  signal: "Signal",
  imessage: "iMessage",
  irc: "IRC",
  web: "Web",
  other: "Autre",
};

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-500/20 text-emerald-400",
  inactive: "bg-white/10 text-gray-500",
  error: "bg-red-500/20 text-red-400",
  connecting: "bg-amber-500/20 text-amber-400",
};

export default async function GatewayDetailPage({ params }: Params) {
  const { id } = await params;
  const session = await requireAuth();

  const [gw] = await db.select().from(gateways).where(eq(gateways.id, id)).limit(1);
  if (!gw) {notFound();}

  // Vérifier l'accès : propriétaire ou admin
  if (gw.userId !== session.userId && session.role !== "admin") {notFound();}

  // Agents accessibles pour le select agent par défaut
  const ownerId = gw.userId;
  const agentList = (await listAgentsForUser(ownerId))
    .map((a) => ({ id: a.id, name: a.name }))
    .toSorted((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="p-8 max-w-2xl space-y-10">
      <div>
        <Link
          href="/dashboard/gateways"
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors mb-3 inline-block"
        >
          ← Mes gateways
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-white">{gw.name}</h1>
          <span
            className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[gw.status] ?? STATUS_STYLES.inactive}`}
          >
            {gw.status}
          </span>
        </div>
        <p className="text-gray-400 text-sm mt-1">
          {CHANNEL_LABELS[gw.channelType] ?? gw.channelType}
        </p>
      </div>

      {/* Configuration des credentials */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Configuration de connexion</h2>
        <p className="text-gray-500 text-sm mb-4">
          Renseignez les credentials pour connecter ce gateway à{" "}
          {CHANNEL_LABELS[gw.channelType] ?? gw.channelType}.
        </p>
        <GatewayConfigEditor
          gatewayId={gw.id}
          channelType={gw.channelType}
          hasConfig={!!gw.configEncrypted}
        />
      </div>

      {/* Agent par défaut */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Agent par défaut</h2>
        <p className="text-gray-500 text-sm mb-4">
          L&apos;agent qui répondra aux messages sur ce gateway si aucun routing spécifique n&apos;est configuré.
        </p>
        <AgentSelectClient
          gatewayId={gw.id}
          currentAgentId={gw.defaultAgentId}
          agents={agentList}
        />
      </div>
    </div>
  );
}
