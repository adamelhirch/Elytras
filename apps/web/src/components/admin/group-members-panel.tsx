"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Member = { memberId: string; userId: string; email: string; displayName: string | null; role: string };
type User = { id: string; email: string; displayName: string | null };

export function GroupMembersPanel({
  groupId,
  members,
  availableUsers,
}: {
  groupId: string;
  members: Member[];
  availableUsers: User[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selectedUserId, setSelectedUserId] = useState("");
  const [adding, setAdding] = useState(false);

  async function addMember() {
    if (!selectedUserId) {return;}
    setAdding(true);
    await fetch(`/api/admin/groups/${groupId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: selectedUserId }),
    });
    setAdding(false);
    setSelectedUserId("");
    startTransition(() => router.refresh());
  }

  async function removeMember(userId: string) {
    await fetch(`/api/admin/groups/${groupId}/members?userId=${userId}`, { method: "DELETE" });
    startTransition(() => router.refresh());
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-white mb-3">Membres</h2>

      {members.length === 0 ? (
        <p className="text-gray-600 text-sm mb-4">Aucun membre.</p>
      ) : (
        <div className="rounded-xl border border-white/10 overflow-hidden mb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-white/5">
                <th className="text-left px-4 py-2 text-gray-400 font-medium text-xs">Utilisateur</th>
                <th className="text-left px-4 py-2 text-gray-400 font-medium text-xs">Rôle</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.memberId} className="border-b border-white/5">
                  <td className="px-4 py-2.5">
                    <div className="text-gray-200">{m.displayName ?? m.email}</div>
                    {m.displayName && <div className="text-xs text-gray-600">{m.email}</div>}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`px-2 py-0.5 rounded text-xs ${m.role === "admin" ? "bg-indigo-500/20 text-indigo-400" : "bg-white/10 text-gray-400"}`}>
                      {m.role}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => removeMember(m.userId)}
                      disabled={isPending}
                      className="text-xs text-gray-600 hover:text-red-400 transition-colors"
                    >
                      Retirer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {availableUsers.length > 0 && (
        <div className="flex gap-2">
          <select
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-indigo-500 transition-colors"
          >
            <option value="">Ajouter un membre…</option>
            {availableUsers.map((u) => (
              <option key={u.id} value={u.id}>{u.displayName ?? u.email}</option>
            ))}
          </select>
          <button
            onClick={addMember}
            disabled={!selectedUserId || adding}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
          >
            {adding ? "…" : "Ajouter"}
          </button>
        </div>
      )}
    </div>
  );
}
