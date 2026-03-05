"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Perm = {
  id: string;
  userId: string;
  allowed: boolean;
  userEmail: string;
  userName: string | null;
};

type User = { id: string; email: string; displayName: string | null };

type Props = {
  agentId: string;
  perms: Perm[];
  allUsers: User[];
};

export function AgentPermissionsPanel({ agentId, perms, allUsers }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selectedUserId, setSelectedUserId] = useState("");
  const [adding, setAdding] = useState(false);

  const permittedUserIds = new Set(perms.map((p) => p.userId));
  const availableUsers = allUsers.filter((u) => !permittedUserIds.has(u.id));

  async function grantUser() {
    if (!selectedUserId) {return;}
    setAdding(true);
    await fetch(`/api/admin/agents/${agentId}/permissions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: selectedUserId, allowed: true }),
    });
    setAdding(false);
    setSelectedUserId("");
    startTransition(() => router.refresh());
  }

  async function togglePerm(perm: Perm) {
    await fetch(`/api/admin/agents/${agentId}/permissions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: perm.userId, allowed: !perm.allowed }),
    });
    startTransition(() => router.refresh());
  }

  async function removePerm(perm: Perm) {
    await fetch(
      `/api/admin/agents/${agentId}/permissions?userId=${perm.userId}`,
      { method: "DELETE" },
    );
    startTransition(() => router.refresh());
  }

  return (
    <div>
      {perms.length === 0 ? (
        <p className="text-gray-600 text-sm mb-4">Aucune permission explicite.</p>
      ) : (
        <div className="rounded-xl border border-white/10 overflow-hidden mb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-white/5">
                <th className="text-left px-4 py-2 text-gray-400 font-medium text-xs">Utilisateur</th>
                <th className="text-left px-4 py-2 text-gray-400 font-medium text-xs">Accès</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {perms.map((perm) => (
                <tr key={perm.id} className="border-b border-white/5">
                  <td className="px-4 py-2.5 text-gray-300">
                    <div>{perm.userName ?? perm.userEmail}</div>
                    {perm.userName && (
                      <div className="text-xs text-gray-600">{perm.userEmail}</div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => togglePerm(perm)}
                      disabled={isPending}
                      className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                        perm.allowed
                          ? "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30"
                          : "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                      }`}
                    >
                      {perm.allowed ? "autorisé" : "bloqué"}
                    </button>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => removePerm(perm)}
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
        <div className="flex items-center gap-2">
          <select
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-indigo-500 transition-colors"
          >
            <option value="">Ajouter un utilisateur…</option>
            {availableUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName ?? u.email}
              </option>
            ))}
          </select>
          <button
            onClick={grantUser}
            disabled={!selectedUserId || adding}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
          >
            {adding ? "…" : "Autoriser"}
          </button>
        </div>
      )}
    </div>
  );
}
