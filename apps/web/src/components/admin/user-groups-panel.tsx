"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type AssignedGroup = { memberId: string; groupId: string; groupName: string };
type AvailableGroup = { id: string; name: string };

export function UserGroupsPanel({
  userId,
  assignedGroups,
  availableGroups,
}: {
  userId: string;
  assignedGroups: AssignedGroup[];
  availableGroups: AvailableGroup[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [adding, setAdding] = useState(false);

  async function addToGroup() {
    if (!selectedGroupId) {return;}
    setAdding(true);
    await fetch(`/api/admin/groups/${selectedGroupId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    setAdding(false);
    setSelectedGroupId("");
    startTransition(() => router.refresh());
  }

  async function removeFromGroup(groupId: string) {
    await fetch(`/api/admin/groups/${groupId}/members?userId=${userId}`, {
      method: "DELETE",
    });
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-4">
      {assignedGroups.length === 0 ? (
        <p className="text-gray-600 text-sm">Cet utilisateur n&apos;appartient à aucun groupe.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {assignedGroups.map((g) => (
            <div
              key={g.memberId}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500/15 border border-indigo-500/30"
            >
              <Link
                href={`/admin/groups/${g.groupId}`}
                className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                {g.groupName}
              </Link>
              <button
                onClick={() => removeFromGroup(g.groupId)}
                disabled={isPending}
                className="text-indigo-600 hover:text-red-400 transition-colors ml-1 text-xs"
                title="Retirer du groupe"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {availableGroups.length > 0 && (
        <div className="flex gap-2">
          <select
            value={selectedGroupId}
            onChange={(e) => setSelectedGroupId(e.target.value)}
            className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-indigo-500 transition-colors"
          >
            <option value="" className="bg-[#1a1d27]">Ajouter à un groupe…</option>
            {availableGroups.map((g) => (
              <option key={g.id} value={g.id} className="bg-[#1a1d27]">{g.name}</option>
            ))}
          </select>
          <button
            onClick={addToGroup}
            disabled={!selectedGroupId || adding || isPending}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
          >
            {adding ? "…" : "Ajouter"}
          </button>
        </div>
      )}

      {availableGroups.length === 0 && assignedGroups.length > 0 && (
        <p className="text-gray-600 text-xs">Cet utilisateur est dans tous les groupes.</p>
      )}
    </div>
  );
}
