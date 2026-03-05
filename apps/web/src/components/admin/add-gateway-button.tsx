"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const CHANNEL_TYPES = [
  "whatsapp",
  "telegram",
  "slack",
  "discord",
  "signal",
  "imessage",
  "irc",
  "web",
  "other",
] as const;

type Props = {
  /** Mode user : userId fixé, on appelle /api/users/:userId/gateways */
  userId?: string;
  /** Mode admin : liste des users pour le select */
  users?: { id: string; email: string; displayName: string | null }[];
};

export function AddGatewayButton({ userId, users }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [channelType, setChannelType] = useState<string>("whatsapp");
  const [targetUserId, setTargetUserId] = useState(userId ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const url = userId
        ? `/api/users/${userId}/gateways`
        : "/api/admin/gateways";

      const body = userId
        ? { name, channelType }
        : { name, channelType, userId: targetUserId };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Erreur");
        return;
      }
      setOpen(false);
      setName("");
      setChannelType("whatsapp");
      setTargetUserId(userId ?? "");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium rounded-lg transition-colors"
      >
        + Ajouter un gateway
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#1a1d27] border border-white/10 rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h2 className="text-lg font-bold text-white mb-4">Nouveau gateway</h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}
              <div>
                <label className="block text-sm text-gray-400 mb-1">Nom</label>
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Mon WhatsApp pro"
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-brand-500"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Canal</label>
                <select
                  value={channelType}
                  onChange={(e) => setChannelType(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-brand-500"
                >
                  {CHANNEL_TYPES.map((t) => (
                    <option key={t} value={t} className="bg-[#1a1d27]">
                      {t}
                    </option>
                  ))}
                </select>
              </div>

              {/* Mode admin : select user */}
              {!userId && users && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Utilisateur</label>
                  <select
                    required
                    value={targetUserId}
                    onChange={(e) => setTargetUserId(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-brand-500"
                  >
                    <option value="" className="bg-[#1a1d27]">Choisir un utilisateur…</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id} className="bg-[#1a1d27]">
                        {u.displayName ? `${u.displayName} (${u.email})` : u.email}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="flex-1 px-4 py-2 border border-white/10 text-gray-300 text-sm rounded-lg hover:bg-white/5 transition-colors"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={loading || (!userId && !targetUserId)}
                  className="flex-1 px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  {loading ? "Création…" : "Créer"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
