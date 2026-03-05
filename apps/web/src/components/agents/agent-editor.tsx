"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type AgentFile = {
  id: string;
  filename: string;
  content: string;
  role: string;
};

type AgentData = {
  id?: string;
  name?: string;
  description?: string | null;
  aiProviderId?: string | null;
  model?: string | null;
  systemPromptMd?: string | null;
  files?: AgentFile[];
};

type Provider = {
  id: string;
  name: string;
  providerType: string;
  isActive: boolean;
};

type ProviderModel = { id: string; name: string };

export function AgentEditor({
  agent,
  mode = "dashboard",
}: {
  agent?: AgentData;
  mode?: "admin" | "dashboard";
}) {
  const router = useRouter();
  const isEdit = Boolean(agent?.id);

  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [aiProviderId, setAiProviderId] = useState(agent?.aiProviderId ?? "");
  const [model, setModel] = useState(agent?.model ?? "");
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPromptMd ?? "");
  const [files, setFiles] = useState<Array<{ filename: string; content: string; role: string }>>(
    agent?.files?.map((f) => ({ filename: f.filename, content: f.content, role: f.role })) ?? [],
  );

  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [loadingModels, setLoadingModels] = useState(false);

  const [activeTab, setActiveTab] = useState<"config" | "prompt" | "files">("config");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoadingProviders(true);
    fetch("/api/admin/providers")
      .then((r) => r.json())
      .then((list: Provider[]) => {
        const active = (Array.isArray(list) ? list : []).filter((p) => p.isActive);
        setProviders(active);

        if (!agent?.aiProviderId && active.length > 0) {
          setAiProviderId(active[0].id);
        }
      })
      .catch(() => {
        setProviders([]);
      })
      .finally(() => setLoadingProviders(false));
  }, []);

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === aiProviderId) ?? null,
    [providers, aiProviderId],
  );

  useEffect(() => {
    if (!selectedProvider) {
      setModels([]);
      setModel("");
      return;
    }

    setLoadingModels(true);
    fetch(`/api/admin/providers/models?type=${encodeURIComponent(selectedProvider.providerType)}`)
      .then((r) => r.json())
      .then((data) => {
        const nextModels = (data?.models ?? []) as ProviderModel[];
        setModels(nextModels);

        if (model && !nextModels.some((m) => m.id === model)) {
          setModel("");
        }
      })
      .catch(() => {
        setModels([]);
      })
      .finally(() => setLoadingModels(false));
  }, [selectedProvider?.providerType, model]);

  async function handleSave() {
    setError(null);
    setLoading(true);
    try {
      const url = isEdit ? `/api/agents/${agent!.id}` : "/api/agents";
      const method = isEdit ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          aiProviderId: aiProviderId || null,
          model: model || null,
          systemPromptMd: systemPrompt || null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Erreur lors de la sauvegarde");
        return;
      }

      const saved = await res.json();
      const agentId = saved.id;

      if (!isEdit) {
        for (const file of files) {
          await fetch(`/api/agents/${agentId}/files`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(file),
          });
        }
      }

      const base = mode === "admin" ? "/admin/agents" : "/dashboard/agents";
      router.push(`${base}/${agentId}`);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    if (!isEdit || !confirm("Supprimer cet agent ?")) {return;}
    const res = await fetch(`/api/agents/${agent!.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Erreur lors de la suppression");
      return;
    }
    const base = mode === "admin" ? "/admin/agents" : "/dashboard/agents";
    router.push(base);
    router.refresh();
  }

  function addFile() {
    setFiles((prev) => [...prev, { filename: "context.md", content: "", role: "context" }]);
  }

  function removeFile(i: number) {
    setFiles((prev) => prev.filter((_, idx) => idx !== i));
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-2">
          {error}
        </div>
      )}

      <div className="flex gap-1 border-b border-white/10">
        {(["config", "prompt", "files"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? "border-brand-500 text-white"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            {tab === "config" ? "Configuration" : tab === "prompt" ? "System Prompt" : "Fichiers contexte"}
          </button>
        ))}
      </div>

      {activeTab === "config" && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Nom de l'agent *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Chef cuisto, Assistant RH, Odoo Bot…"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-brand-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Description</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Un assistant qui…"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-brand-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Provider IA</label>
            <select
              value={aiProviderId}
              onChange={(e) => {
                setAiProviderId(e.target.value);
                setModel("");
              }}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-brand-500 transition-colors"
              disabled={loadingProviders}
            >
              <option value="" className="bg-[#1a1d27]">Aucun</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id} className="bg-[#1a1d27]">
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Modèle IA</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-brand-500 transition-colors"
              disabled={!aiProviderId || loadingModels}
            >
              <option value="" className="bg-[#1a1d27]">Modèle par défaut</option>
              {models.map((m) => (
                <option key={m.id} value={m.id} className="bg-[#1a1d27]">
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {activeTab === "prompt" && (
        <div>
          <label className="block text-sm text-gray-400 mb-2">System prompt (Markdown)</label>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={`# Rôle\nTu es un assistant spécialisé dans…\n\n## Instructions\n- Réponds toujours en français\n- Sois concis et précis`}
            rows={20}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white font-mono text-sm focus:outline-none focus:border-brand-500 transition-colors resize-none"
          />
        </div>
      )}

      {activeTab === "files" && (
        <div className="space-y-4">
          <p className="text-gray-500 text-sm">
            Ajoutez des fichiers <code>.md</code> supplémentaires (données produit, procédures, FAQ…).
          </p>

          {files.map((file, i) => (
            <div key={i} className="rounded-xl border border-white/10 bg-white/3 p-4 space-y-3">
              <div className="flex gap-3">
                <input
                  value={file.filename}
                  onChange={(e) =>
                    setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, filename: e.target.value } : f)))
                  }
                  placeholder="catalogue.md"
                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-white text-sm font-mono focus:outline-none focus:border-brand-500"
                />
                <button
                  onClick={() => removeFile(i)}
                  className="px-3 py-1.5 text-red-400 hover:bg-red-400/10 rounded-lg text-sm transition-colors"
                >
                  Supprimer
                </button>
              </div>
              <textarea
                value={file.content}
                onChange={(e) =>
                  setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, content: e.target.value } : f)))
                }
                placeholder="Contenu du fichier…"
                rows={8}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white font-mono text-sm focus:outline-none focus:border-brand-500 resize-none"
              />
            </div>
          ))}

          <button
            onClick={addFile}
            className="w-full py-3 border border-dashed border-white/20 text-gray-500 hover:text-gray-300 hover:border-white/40 rounded-xl text-sm transition-colors"
          >
            + Ajouter un fichier
          </button>
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <button
          onClick={() => router.back()}
          className="px-6 py-2.5 border border-white/10 text-gray-300 text-sm rounded-lg hover:bg-white/5 transition-colors"
        >
          Annuler
        </button>
        {isEdit && mode === "admin" && (
          <button
            onClick={handleDelete}
            className="px-6 py-2.5 border border-red-500/30 text-red-400 text-sm rounded-lg hover:bg-red-500/10 transition-colors"
          >
            Supprimer
          </button>
        )}
        <button
          onClick={handleSave}
          disabled={loading || !name.trim()}
          className="px-6 py-2.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {loading ? "Sauvegarde…" : isEdit ? "Enregistrer" : "Créer l'agent"}
        </button>
      </div>
    </div>
  );
}
