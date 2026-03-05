"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Item = { id: string; name: string; sub?: string };
type Assigned = { permId: string } & Item;

export function GroupAssignPanel({
  groupId,
  type,
  assigned,
  available,
  label,
  icon,
}: {
  groupId: string;
  type: "agents" | "skills";
  assigned: Assigned[];
  available: Item[];
  label: string;
  icon: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selectedId, setSelectedId] = useState("");
  const [adding, setAdding] = useState(false);

  const bodyKey = type === "agents" ? "agentId" : "skillId";
  const qsKey = type === "agents" ? "agentId" : "skillId";

  async function add() {
    if (!selectedId) {return;}
    setAdding(true);
    await fetch(`/api/admin/groups/${groupId}/${type}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [bodyKey]: selectedId }),
    });
    setAdding(false);
    setSelectedId("");
    startTransition(() => router.refresh());
  }

  async function remove(itemId: string) {
    await fetch(`/api/admin/groups/${groupId}/${type}?${qsKey}=${itemId}`, { method: "DELETE" });
    startTransition(() => router.refresh());
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-white mb-3">{label}</h2>

      {assigned.length === 0 ? (
        <p className="text-gray-600 text-sm mb-4">Aucun {label.toLowerCase()} assigné.</p>
      ) : (
        <div className="space-y-2 mb-4">
          {assigned.map((item) => (
            <div key={item.permId} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 border border-white/10">
              <span className="text-base shrink-0">{icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white">{item.name}</div>
                {item.sub && <div className="text-xs text-gray-600 font-mono">{item.sub}</div>}
              </div>
              <button
                onClick={() => remove(item.id)}
                disabled={isPending}
                className="text-xs text-gray-600 hover:text-red-400 transition-colors shrink-0"
              >
                Retirer
              </button>
            </div>
          ))}
        </div>
      )}

      {available.length > 0 && (
        <div className="flex gap-2">
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-indigo-500 transition-colors"
          >
            <option value="">Assigner {label.toLowerCase().slice(0, -1)}…</option>
            {available.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
          <button
            onClick={add}
            disabled={!selectedId || adding}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
          >
            {adding ? "…" : "Assigner"}
          </button>
        </div>
      )}
    </div>
  );
}
