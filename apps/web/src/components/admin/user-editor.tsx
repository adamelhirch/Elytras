"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function UserEditor({
  userId,
  displayName,
  role,
  active,
}: {
  userId: string;
  displayName: string | null;
  role: string;
  active: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(displayName ?? "");
  const [currentRole, setCurrentRole] = useState(role);
  const [isActive, setIsActive] = useState(active);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setSaving(true);
    setSaved(false);
    setError("");
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: name.trim() || null,
        role: currentRole,
        active: isActive,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "Erreur.");
      return;
    }
    setSaved(true);
    startTransition(() => router.refresh());
  }

  async function deleteUser() {
    if (!confirm("Supprimer définitivement cet utilisateur ?")) {return;}
    await fetch(`/api/admin/users/${userId}`, { method: "DELETE" });
    router.push("/admin/users");
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-gray-400 mb-1.5">Nom affiché</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Prénom Nom"
            className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1.5">Rôle</label>
          <select
            value={currentRole}
            onChange={(e) => setCurrentRole(e.target.value)}
            className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-indigo-500 transition-colors"
          >
            <option value="user" className="bg-[#1a1d27]">user</option>
            <option value="admin" className="bg-[#1a1d27]">admin</option>
          </select>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={isActive}
          onClick={() => setIsActive((v) => !v)}
          className={`relative w-10 h-5 rounded-full transition-colors ${isActive ? "bg-emerald-500" : "bg-white/20"}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${isActive ? "translate-x-5" : ""}`}
          />
        </button>
        <span className="text-sm text-gray-300">Compte actif</span>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {saved && <p className="text-sm text-emerald-400">Sauvegardé.</p>}

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving || isPending}
          className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? "Sauvegarde…" : "Mettre à jour"}
        </button>
        <button
          onClick={deleteUser}
          className="px-4 py-2 text-red-400 hover:text-red-300 text-sm transition-colors"
        >
          Supprimer l&apos;utilisateur
        </button>
      </div>
    </div>
  );
}
