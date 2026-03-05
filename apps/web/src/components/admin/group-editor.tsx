"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Group = { id: string; name: string; description: string | null };

export function GroupEditor({ group }: { group?: Group }) {
  const router = useRouter();
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (!name.trim()) { setError("Le nom est requis."); return; }
    setSaving(true); setError("");

    const url = group ? `/api/admin/groups/${group.id}` : "/api/admin/groups";
    const method = group ? "PATCH" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: description || null }),
    });
    setSaving(false);
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error ?? "Erreur."); return; }
    const saved = await res.json();
    router.push(`/admin/groups/${saved.id}`);
  }

  async function remove() {
    if (!group) {return;}
    if (!confirm(`Supprimer le groupe "${group.name}" ? Tous les accès seront perdus.`)) {return;}
    await fetch(`/api/admin/groups/${group.id}`, { method: "DELETE" });
    router.push("/admin/groups");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-gray-400 mb-1.5">Nom *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ex: Équipe commerciale"
            className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1.5">Description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="ex: Accès aux agents CRM et stock"
            className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors"
          />
        </div>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-3">
        <button onClick={save} disabled={saving} className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
          {saving ? "Sauvegarde…" : group ? "Mettre à jour" : "Créer le groupe"}
        </button>
        {group && (
          <button onClick={remove} className="px-4 py-2 text-red-400 hover:text-red-300 text-sm transition-colors">
            Supprimer
          </button>
        )}
      </div>
    </div>
  );
}
