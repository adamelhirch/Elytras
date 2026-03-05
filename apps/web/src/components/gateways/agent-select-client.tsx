"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = {
  gatewayId: string;
  currentAgentId: string | null;
  agents: { id: string; name: string }[];
};

export function AgentSelectClient({ gatewayId, currentAgentId, agents }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [agentId, setAgentId] = useState(currentAgentId ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    setSaved(false);
    await fetch(`/api/gateways/${gatewayId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultAgentId: agentId || null }),
    });
    setSaving(false);
    setSaved(true);
    startTransition(() => router.refresh());
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={agentId}
        onChange={(e) => setAgentId(e.target.value)}
        className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
      >
        <option value="" className="bg-[#1a1d27]">Aucun agent par défaut</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id} className="bg-[#1a1d27]">{a.name}</option>
        ))}
      </select>
      <button
        onClick={save}
        disabled={saving || isPending}
        className="px-4 py-2 bg-white/10 hover:bg-white/20 text-sm text-white rounded-lg transition-colors disabled:opacity-50"
      >
        {saving ? "…" : "Sauvegarder"}
      </button>
      {saved && <span className="text-xs text-emerald-400">OK</span>}
    </div>
  );
}
