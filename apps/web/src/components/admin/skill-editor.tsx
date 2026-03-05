"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Skill = {
  id: string;
  name: string;
  description: string | null;
  skillMdContent: string;
  enabledGlobal: boolean;
};

type Props = {
  skill?: Skill;
};

export function SkillEditor({ skill }: Props) {
  const router = useRouter();
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [content, setContent] = useState(
    skill?.skillMdContent ??
      `# Skill : Mon Skill\n\n## Description\nDécrivez ce que ce skill permet de faire.\n\n## Instructions\nComment l'agent doit utiliser ce skill.\n`,
  );
  const [enabledGlobal, setEnabledGlobal] = useState(skill?.enabledGlobal ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (!name.trim()) {
      setError("Le nom est requis.");
      return;
    }
    setSaving(true);
    setError("");

    const url = skill ? `/api/admin/skills/${skill.id}` : "/api/admin/skills";
    const method = skill ? "PATCH" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, skillMdContent: content, enabledGlobal }),
    });

    setSaving(false);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Erreur lors de la sauvegarde.");
      return;
    }

    const saved = await res.json();
    router.push(`/admin/skills/${saved.id}`);
    router.refresh();
  }

  async function remove() {
    if (!skill) {return;}
    if (!confirm(`Supprimer le skill "${skill.name}" ? Cette action est irréversible.`)) {return;}

    await fetch(`/api/admin/skills/${skill.id}`, { method: "DELETE" });
    router.push("/admin/skills");
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-gray-400 mb-1.5">Nom du skill *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ex: odoo-stock"
            className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1.5">Description courte</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="ex: Consulter le stock Odoo"
            className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors"
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs text-gray-400">Contenu SKILL.md *</label>
          <span className="text-xs text-gray-600">{content.length} caractères</span>
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={16}
          className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-gray-100 font-mono placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors resize-y leading-relaxed"
          placeholder="# Skill : ..."
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={enabledGlobal}
          onClick={() => setEnabledGlobal((v) => !v)}
          className={`relative w-10 h-5 rounded-full transition-colors ${
            enabledGlobal ? "bg-emerald-500" : "bg-white/20"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
              enabledGlobal ? "translate-x-5" : ""
            }`}
          />
        </button>
        <span className="text-sm text-gray-300">
          Activé globalement{" "}
          <span className="text-gray-600 text-xs">
            (tous les utilisateurs y ont accès)
          </span>
        </span>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? "Sauvegarde…" : skill ? "Mettre à jour" : "Créer le skill"}
        </button>
        {skill && (
          <button
            onClick={remove}
            className="px-4 py-2 text-red-400 hover:text-red-300 text-sm transition-colors"
          >
            Supprimer
          </button>
        )}
      </div>
    </div>
  );
}
