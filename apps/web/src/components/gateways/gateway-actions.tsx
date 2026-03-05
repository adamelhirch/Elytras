"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Agent = { id: string; name: string };

export function GatewayActions({
  gatewayId,
  agents,
  defaultAgentId,
}: {
  gatewayId: string;
  agents: Agent[];
  defaultAgentId: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [agentId, setAgentId] = useState(defaultAgentId ?? "");
  const [saving, setSaving] = useState(false);

  async function saveAgent() {
    setSaving(true);
    await fetch(`/api/gateways/${gatewayId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultAgentId: agentId || null }),
    });
    setSaving(false);
    startTransition(() => router.refresh());
  }

  async function remove() {
    if (!confirm("Supprimer ce gateway ?")) {return;}
    await fetch(`/api/gateways/${gatewayId}`, { method: "DELETE" });
    startTransition(() => router.refresh());
  }

  return (
    <div className="flex items-center gap-2 mt-2">
      <select
        value={agentId}
        onChange={(e) => setAgentId(e.target.value)}
        className="flex-1 px-2 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-white focus:outline-none focus:border-brand-500"
      >
        <option value="" className="bg-[#1a1d27]">Agent par défaut…</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id} className="bg-[#1a1d27]">{a.name}</option>
        ))}
      </select>
      <button
        onClick={saveAgent}
        disabled={saving || isPending}
        className="px-2.5 py-1.5 bg-white/10 hover:bg-white/20 text-xs text-white rounded-lg transition-colors disabled:opacity-50"
      >
        {saving ? "…" : "OK"}
      </button>
      <button
        onClick={remove}
        disabled={isPending}
        className="px-2.5 py-1.5 text-xs text-gray-600 hover:text-red-400 transition-colors"
      >
        Supprimer
      </button>
    </div>
  );
}
