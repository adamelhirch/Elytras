"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = {
  initialProfileMd: string | null;
  email: string;
};

export function UserProfileEditor({ initialProfileMd, email }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [profileMd, setProfileMd] = useState(initialProfileMd ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  async function saveProfile() {
    setSaving(true);
    setSaved(false);
    setError("");
    const res = await fetch("/api/me/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileMd: profileMd.trim() ? profileMd : null,
      }),
    });
    setSaving(false);

    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      setError(payload.error ?? "Erreur de sauvegarde.");
      return;
    }

    const payload = (await res.json().catch(() => ({}))) as { profileMd?: string | null };
    setProfileMd(payload.profileMd ?? "");
    setSaved(true);
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="text-lg font-semibold text-white">Profil utilisateur (`USER.md`)</h2>
        <p className="text-sm text-gray-400 mt-2">
          Ce profil est propre à <span className="font-mono text-gray-300">{email}</span> et
          s&apos;applique à tous les agents utilisés par ce compte.
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Exemple: objectifs, préférences, contraintes, stack préférée, ton rédactionnel.
        </p>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/5 p-5">
        <label className="block text-xs text-gray-400 mb-2">Contenu Markdown</label>
        <textarea
          value={profileMd}
          onChange={(e) => setProfileMd(e.target.value)}
          placeholder={"# USER.md\n\n- Mes objectifs\n- Mes préférences\n- Mes contraintes"}
          rows={18}
          className="w-full px-3 py-2 rounded-lg bg-[#0f1117] border border-white/10 text-sm text-gray-100 font-mono outline-none focus:border-indigo-500 transition-colors resize-y"
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={saveProfile}
            disabled={saving || isPending}
            className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm text-white font-medium transition-colors"
          >
            {saving ? "Sauvegarde…" : "Sauvegarder"}
          </button>
          <button
            type="button"
            onClick={() => {
              setProfileMd(initialProfileMd ?? "");
              setSaved(false);
              setError("");
            }}
            disabled={saving || isPending}
            className="px-4 py-2 rounded-lg border border-white/10 text-sm text-gray-300 hover:bg-white/10 transition-colors disabled:opacity-50"
          >
            Annuler
          </button>
          {saved && <span className="text-sm text-emerald-400">Profil sauvegardé.</span>}
          {error && <span className="text-sm text-red-400">{error}</span>}
        </div>
      </div>
    </div>
  );
}
