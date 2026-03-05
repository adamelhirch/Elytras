"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { PROVIDER_META, KNOWN_PROVIDER_TYPES } from "@elytras/db/meta";

type ProviderType = (typeof KNOWN_PROVIDER_TYPES)[number] | "azure_openai" | "ollama" | "github_copilot" | "custom";

// Mapping providerType DB → pi-ai providerId OAuth
const OAUTH_PROVIDER_ID: Partial<Record<string, string>> = {
  "anthropic":           "anthropic",
  "github-copilot":      "github-copilot",
  "google-gemini-cli":   "google-gemini-cli",
  "google-antigravity":  "google-antigravity",
  "openai-codex":        "openai-codex",
};

const PROVIDER_OPTIONS: ProviderType[] = [
  "anthropic",
  "google",
  "google-gemini-cli",
  "google-antigravity",
  "openai",
  "openai-codex",
  "github-copilot",
  "groq",
  "mistral",
  "xai",
  "cerebras",
  "minimax",
  "openrouter",
  "zai",
  "vercel-ai-gateway",
  "azure_openai",
  "ollama",
  "custom",
];

type Provider = {
  id: string;
  name: string;
  providerType: string;
  modelAllowlist: string[];
  isActive: boolean;
  hasCredential: boolean;
};

type ProviderModel = { id: string; name: string; contextWindow?: number };

// ── Modal OAuth générique ─────────────────────────────────────────────────────

type OAuthFlow = "paste_url" | "paste_code" | "device_code";

type OAuthStartResult = {
  flow: OAuthFlow;
  authUrl: string;
  redirectUri?: string;
  instructions: string;
  userCode?: string;         // device_code only
  pollIntervalMs?: number;   // device_code only
};

type OAuthStep =
  | { kind: "idle" }
  | { kind: "loading"; message?: string }
  | { kind: "started"; data: OAuthStartResult }
  | { kind: "polling"; data: OAuthStartResult }
  | { kind: "success"; email: string | null };

function OAuthModal({
  providerType,
  dbProviderId,
  onClose,
  onSuccess,
}: {
  providerType: string;
  dbProviderId?: string;
  onClose: () => void;
  onSuccess: (id: string, email: string | null) => void;
}) {
  const piId = OAUTH_PROVIDER_ID[providerType];
  const meta = PROVIDER_META[providerType] ?? PROVIDER_META.custom;

  const [step, setStep] = useState<OAuthStep>({ kind: "idle" });
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  useEffect(() => () => stopPolling(), []);

  async function start() {
    setStep({ kind: "loading", message: "Démarrage du flow OAuth…" });
    setError("");
    const res = await fetch("/api/admin/providers/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerPiId: piId, providerType, dbProviderId }),
    });
    const data = await res.json();
    if (!res.ok) { setError(data.error ?? "Erreur"); setStep({ kind: "idle" }); return; }

    const startData = data as OAuthStartResult;

    if (startData.flow === "device_code") {
      setStep({ kind: "polling", data: startData });
      const interval = startData.pollIntervalMs ?? 5000;
      pollRef.current = setInterval(async () => {
        const pr = await fetch("/api/admin/providers/oauth/poll");
        const pd = await pr.json();
        if (pd.status === "success") {
          stopPolling();
          setStep({ kind: "success", email: null });
          onSuccess(pd.id, null);
        } else if (pd.status === "error" || pd.status === "expired") {
          stopPolling();
          setError(pd.error ?? "Device code expiré. Réessayez.");
          setStep({ kind: "idle" });
        }
      }, interval);
    } else {
      setStep({ kind: "started", data: startData });
    }
  }

  async function exchange() {
    if (!input.trim()) { setError("Collez le code ou l'URL de callback."); return; }
    setStep({ kind: "loading", message: "Échange du code…" });
    setError("");
    const res = await fetch("/api/admin/providers/oauth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: input.trim(), dbProviderId }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Échange échoué");
      setStep((s) => s.kind === "loading" && "data" in (s as object) ? s : { kind: "started", data: (step as { kind: "loading"; data: OAuthStartResult }).data });
      return;
    }
    setStep({ kind: "success", email: data.email });
    onSuccess(data.id, data.email);
  }

  const isStarted = step.kind === "started";
  const data = isStarted ? step.data : null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#1a1d27] border border-white/10 rounded-2xl w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-white font-semibold">Connexion OAuth — {meta.label}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors text-xl leading-none">×</button>
        </div>

        <div className="p-6 space-y-5">

          {/* Idle */}
          {step.kind === "idle" && (
            <>
              <p className="text-sm text-gray-400">{meta.hint}</p>
              {(providerType === "google-gemini-cli" || providerType === "google-antigravity") && (
                <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-4 py-3 text-xs text-blue-400">
                  Nécessite <code className="font-mono">ELYTRAS_GEMINI_OAUTH_CLIENT_ID</code> dans les variables d&apos;environnement.
                </div>
              )}
              <button
                onClick={start}
                className="w-full px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Démarrer la connexion
              </button>
            </>
          )}

          {/* Loading */}
          {step.kind === "loading" && (
            <div className="flex flex-col items-center gap-3 py-6">
              <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-400">{step.message ?? "Chargement…"}</p>
            </div>
          )}

          {/* Device code (GitHub Copilot) */}
          {step.kind === "polling" && (
            <div className="space-y-4">
              <p className="text-sm text-gray-300 font-medium">Étape 1 — Ouvrez cette URL :</p>
              <div className="bg-black/30 border border-white/10 rounded-lg p-3">
                <a href={step.data.authUrl} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300 break-all font-mono">
                  {step.data.authUrl}
                </a>
              </div>
              {step.data.userCode && (
                <div className="text-center">
                  <p className="text-xs text-gray-400 mb-1">Entrez ce code :</p>
                  <div className="text-2xl font-mono font-bold tracking-widest text-white bg-white/10 rounded-lg py-3">
                    {step.data.userCode}
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2 text-gray-500 text-xs">
                <div className="w-3 h-3 border border-gray-500 border-t-transparent rounded-full animate-spin shrink-0" />
                En attente de confirmation…
              </div>
            </div>
          )}

          {/* Paste URL or code */}
          {isStarted && data && (
            <div className="space-y-4">
              <div className="space-y-2">
                <p className="text-sm text-gray-300 font-medium">Étape 1 — Ouvrez cette URL :</p>
                <div className="bg-black/30 border border-white/10 rounded-lg p-3 flex items-start gap-2">
                  <a href={data.authUrl} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:text-blue-300 break-all font-mono flex-1">
                    {data.authUrl}
                  </a>
                  <button onClick={() => navigator.clipboard.writeText(data.authUrl)}
                    className="text-gray-600 hover:text-gray-400 transition-colors text-xs shrink-0">
                    Copier
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm text-gray-300 font-medium">
                  Étape 2 — {data.flow === "paste_url"
                    ? `Copiez l'URL de la page de callback (${data.redirectUri}) :`
                    : "Collez le code d'autorisation :"}
                </p>
                {data.redirectUri && data.flow === "paste_url" && (
                  <p className="text-xs text-gray-600">
                    La page {data.redirectUri.split("/")[2]} peut afficher une erreur — c&apos;est normal. Copiez l&apos;URL complète depuis la barre d&apos;adresse.
                  </p>
                )}
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={data.flow === "paste_url" ? `${data.redirectUri}?code=...` : "code#state"}
                  rows={3}
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-xs text-white placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors font-mono resize-none"
                />
              </div>

              <button
                onClick={exchange}
                disabled={!input.trim()}
                className="w-full px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Valider et connecter
              </button>
            </div>
          )}

          {/* Success */}
          {step.kind === "success" && (
            <div className="flex flex-col items-center gap-4 py-4">
              <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center">
                <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="text-center">
                <p className="text-white font-medium">Connecté avec succès !</p>
                {step.email && <p className="text-sm text-gray-400 mt-1">{step.email}</p>}
              </div>
              <button onClick={onClose}
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors">
                Fermer
              </button>
            </div>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      </div>
    </div>
  );
}

// ── ModelSelector ─────────────────────────────────────────────────────────────

function ModelSelector({ providerType, selected, onChange }: {
  providerType: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setModels([]);
    setLoading(true);
    fetch(`/api/admin/providers/models?type=${encodeURIComponent(providerType)}`)
      .then((r) => r.json())
      .then((d) => setModels(d.models ?? []))
      .catch(() => setModels([]))
      .finally(() => setLoading(false));
  }, [providerType]);

  if (loading) {return (
    <div className="flex items-center gap-2 py-4 text-gray-500 text-sm">
      <div className="w-4 h-4 border border-gray-600 border-t-transparent rounded-full animate-spin" />
      Chargement des modèles…
    </div>
  );}

  if (models.length === 0) {return (
    <p className="text-xs text-gray-600 py-2">
      Aucun modèle connu pour ce provider — les modèles seront auto-découverts au runtime.
    </p>
  );}

  const allSelected = selected.length === 0;

  function toggle(id: string) {
    if (allSelected) {
      onChange(models.map((m) => m.id).filter((x) => x !== id));
    } else if (selected.includes(id)) {
      const next = selected.filter((x) => x !== id);
      onChange(next.length === models.length ? [] : next);
    } else {
      const next = [...selected, id];
      onChange(next.length === models.length ? [] : next);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400">
          {allSelected ? "Tous les modèles" : `${selected.length} / ${models.length} sélectionné(s)`}
        </span>
        <button type="button" onClick={() => onChange([])}
          className={`text-xs transition-colors ${allSelected ? "text-indigo-400 font-medium" : "text-gray-500 hover:text-gray-300"}`}>
          Tout sélectionner
        </button>
      </div>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-white/10 divide-y divide-white/5">
        {models.map((m) => {
          const checked = allSelected || selected.includes(m.id);
          return (
            <label key={m.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-white/5 transition-colors">
              <input type="checkbox" checked={checked} onChange={() => toggle(m.id)}
                className="w-3.5 h-3.5 rounded accent-indigo-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-sm text-white truncate block">{m.name}</span>
                <span className="text-xs text-gray-600 font-mono truncate block">{m.id}</span>
              </div>
              {m.contextWindow && (
                <span className="text-xs text-gray-600 shrink-0 tabular-nums">
                  {(m.contextWindow / 1000).toFixed(0)}k
                </span>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ── ProviderEditor ────────────────────────────────────────────────────────────

export function ProviderEditor({ provider }: { provider?: Provider }) {
  const router = useRouter();
  const [name, setName] = useState(provider?.name ?? "");
  const [providerType, setProviderType] = useState<ProviderType>(
    (provider?.providerType as ProviderType) ?? "anthropic",
  );
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelAllowlist, setModelAllowlist] = useState<string[]>(provider?.modelAllowlist ?? []);
  const [isActive, setIsActive] = useState(provider?.isActive ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showOAuthModal, setShowOAuthModal] = useState(false);
  const [oauthConnected, setOauthConnected] = useState<{ email: string | null } | null>(null);

  const meta = PROVIDER_META[providerType] ?? PROVIDER_META.custom;
  const isApiKey = meta.authType === "api_key" && providerType !== "google";
  const isOllama = providerType === "ollama";
  const needsBaseUrl = providerType === "azure_openai" || providerType === "ollama" || providerType === "custom";

  // Pour google (API key), on garde le champ API key en plus du bouton OAuth
  const showApiKeyField = isApiKey && !isOllama;
  const showOAuthButton = meta.authType === "oauth" || providerType === "google";

  function handleOAuthSuccess(id: string, email: string | null) {
    setOauthConnected({ email });
    if (!provider) {router.push(`/admin/providers/${id}`);}
    router.refresh();
  }

  async function save() {
    if (!name.trim()) { setError("Le nom est requis."); return; }
    if (!provider && isApiKey && !apiKey.trim() && !isOllama && !oauthConnected) {
      setError("La clé API est requise pour ce provider.");
      return;
    }
    setSaving(true);
    setError("");

    const body: Record<string, unknown> = {
      name, providerType,
      modelAllowlist: modelAllowlist.length ? modelAllowlist : null,
      isActive,
    };
    if (apiKey.trim()) {body.apiKey = apiKey.trim();}
    if (baseUrl.trim()) {body.baseUrl = baseUrl.trim();}

    const url = provider ? `/api/admin/providers/${provider.id}` : "/api/admin/providers";
    const res = await fetch(url, {
      method: provider ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error ?? "Erreur."); return; }
    const saved = await res.json();
    router.push(`/admin/providers/${saved.id}`);
    router.refresh();
  }

  async function remove() {
    if (!provider || !confirm(`Supprimer "${provider.name}" ?`)) {return;}
    await fetch(`/api/admin/providers/${provider.id}`, { method: "DELETE" });
    router.push("/admin/providers");
    router.refresh();
  }

  return (
    <>
      {showOAuthModal && (
        <OAuthModal
          providerType={providerType}
          dbProviderId={provider?.id}
          onClose={() => setShowOAuthModal(false)}
          onSuccess={handleOAuthSuccess}
        />
      )}

      <div className="space-y-5">
        {/* Nom + Type */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Nom *</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="ex: Anthropic principal"
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Type</label>
            <select value={providerType} onChange={(e) => setProviderType(e.target.value as ProviderType)}
              disabled={!!provider}
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-indigo-500 transition-colors disabled:opacity-50">
              {PROVIDER_OPTIONS.map((value) => {
                const m = PROVIDER_META[value] ?? PROVIDER_META.custom;
                return <option key={value} value={value} className="bg-[#1a1d27]">{m.label}</option>;
              })}
            </select>
          </div>
        </div>

        {/* Badge */}
        <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium ${meta.color}`}>
          {meta.label}
          <span className="text-xs opacity-60">
            {meta.authType === "none" ? "· local" : meta.authType === "oauth" ? "· OAuth" : "· API key"}
          </span>
        </div>

        {/* Base URL */}
        {needsBaseUrl && (
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">URL de base</label>
            <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={providerType === "ollama" ? "http://localhost:11434" : providerType === "azure_openai" ? "https://<resource>.openai.azure.com" : "http://localhost:8080/v1"}
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors font-mono" />
          </div>
        )}

        {/* OAuth button */}
        {showOAuthButton && (
          <div className="border border-white/10 rounded-xl p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm text-white font-medium">
                  {providerType === "google" ? "OAuth (recommandé)" : "Connexion OAuth"}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">{meta.hint}</p>
              </div>
              {oauthConnected ? (
                <div className="flex items-center gap-2 text-emerald-400 text-xs shrink-0">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  {oauthConnected.email ?? "Connecté"}
                </div>
              ) : (
                <div className="flex items-center gap-2 shrink-0">
                  {provider?.hasCredential && (
                    <span className="text-xs text-gray-500">Credential existant</span>
                  )}
                  <button type="button" onClick={() => setShowOAuthModal(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg transition-colors">
                    {provider?.hasCredential ? "Reconnecter" : "Connecter"}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* API Key (pour google, affiché en option alternative) */}
        {(showApiKeyField || providerType === "google") && (
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">
              {providerType === "google" ? "Clé API Gemini (alternative à OAuth)" : "Clé API"}
              {provider?.hasCredential && (
                <span className="ml-2 text-gray-600">(laisser vide pour conserver l&apos;actuelle)</span>
              )}
            </label>
            {meta.hint && providerType !== "google" && (
              <p className="text-xs text-gray-600 mb-1.5">{meta.hint}</p>
            )}
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder={providerType === "google" ? "AIza..." : "Votre clé API"}
              autoComplete="off"
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors font-mono" />
          </div>
        )}

        {/* Modèles */}
        <div>
          <label className="block text-xs text-gray-400 mb-2">Modèles autorisés</label>
          <ModelSelector providerType={providerType} selected={modelAllowlist} onChange={setModelAllowlist} />
        </div>

        {/* Actif */}
        <div className="flex items-center gap-3">
          <button type="button" role="switch" aria-checked={isActive} onClick={() => setIsActive((v) => !v)}
            className={`relative w-10 h-5 rounded-full transition-colors ${isActive ? "bg-emerald-500" : "bg-white/20"}`}>
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${isActive ? "translate-x-5" : ""}`} />
          </button>
          <span className="text-sm text-gray-300">Provider actif</span>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex items-center gap-3 pt-2">
          <button onClick={save} disabled={saving}
            className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
            {saving ? "Sauvegarde…" : provider ? "Mettre à jour" : "Créer le provider"}
          </button>
          {provider && (
            <button onClick={remove} className="px-4 py-2 text-red-400 hover:text-red-300 text-sm transition-colors">
              Supprimer
            </button>
          )}
        </div>
      </div>
    </>
  );
}
