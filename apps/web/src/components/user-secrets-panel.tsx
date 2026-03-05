"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Secret = {
  id: string;
  name: string;
  providerHint: string | null;
  createdAt: Date;
};

const PROVIDER_HINTS = [
  { value: "", label: "Aucun" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google (Gemini)" },
  { value: "openai", label: "OpenAI" },
  { value: "azure_openai", label: "Azure OpenAI" },
  { value: "other", label: "Autre" },
];

type Props = {
  secrets: Secret[];
};

export function UserSecretsPanel({ secrets }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [providerHint, setProviderHint] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function addSecret() {
    if (!name.trim() || !value.trim()) {
      setError("Nom et valeur requis.");
      return;
    }
    setSaving(true);
    setError("");

    const res = await fetch("/api/secrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, value, providerHint: providerHint || null }),
    });

    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "Erreur.");
      return;
    }

    setName("");
    setValue("");
    setProviderHint("");
    startTransition(() => router.refresh());
  }

  async function remove(id: string) {
    if (!confirm("Supprimer ce secret ?")) {return;}
    await fetch(`/api/secrets?id=${id}`, { method: "DELETE" });
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-8">
      {/* Liste des secrets existants */}
      {secrets.length > 0 && (
        <div className="rounded-xl border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-white/5">
                <th className="text-left px-4 py-2 text-gray-400 font-medium text-xs">Nom</th>
                <th className="text-left px-4 py-2 text-gray-400 font-medium text-xs">Provider</th>
                <th className="text-left px-4 py-2 text-gray-400 font-medium text-xs">Ajouté le</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {secrets.map((s) => (
                <tr key={s.id} className="border-b border-white/5">
                  <td className="px-4 py-3 font-mono text-sm text-gray-200">{s.name}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {s.providerHint ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-xs">
                    {new Date(s.createdAt).toLocaleDateString("fr-FR")}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => remove(s.id)}
                      disabled={isPending}
                      className="text-xs text-gray-600 hover:text-red-400 transition-colors"
                    >
                      Supprimer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Formulaire d'ajout */}
      <div>
        <h2 className="text-base font-semibold text-white mb-4">Ajouter une clé</h2>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Nom *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ex: ANTHROPIC_API_KEY"
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Provider</label>
              <select
                value={providerHint}
                onChange={(e) => setProviderHint(e.target.value)}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-indigo-500 transition-colors"
              >
                {PROVIDER_HINTS.map((h) => (
                  <option key={h.value} value={h.value}>
                    {h.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Valeur *</label>
            <input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="sk-ant-api03-..."
              autoComplete="off"
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors font-mono"
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            onClick={addSecret}
            disabled={saving || !name.trim() || !value.trim()}
            className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {saving ? "Chiffrement…" : "Stocker la clé"}
          </button>

          <p className="text-xs text-gray-600">
            La valeur est chiffrée côté serveur (AES-256-GCM) avant stockage et n&apos;est
            jamais renvoyée en clair.
          </p>
        </div>
      </div>
    </div>
  );
}
