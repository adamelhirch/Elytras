/**
 * Données statiques sur les providers IA (pas de dépendance heavy).
 * Importable côté client React.
 */

export const KNOWN_PROVIDER_TYPES = [
  "anthropic",
  "google",
  "openai",
  "groq",
  "mistral",
  "xai",
  "cerebras",
  "minimax",
  "openrouter",
  "zai",
  "vercel-ai-gateway",
  "github-copilot",
  "google-gemini-cli",
  "google-antigravity",
  "openai-codex",
] as const;

export type KnownProviderType = (typeof KNOWN_PROVIDER_TYPES)[number];

export type ProviderModel = {
  id: string;
  name: string;
  contextWindow?: number;
};

export const PROVIDER_META: Record<
  string,
  { label: string; color: string; authType: "api_key" | "oauth" | "none"; hint?: string }
> = {
  anthropic: {
    label: "Anthropic (Claude)",
    color: "bg-orange-500/20 text-orange-400",
    authType: "api_key",
    hint: "Clé API disponible sur console.anthropic.com",
  },
  google: {
    label: "Google (Gemini — API key)",
    color: "bg-blue-500/20 text-blue-400",
    authType: "api_key",
    hint: "Clé API disponible sur aistudio.google.com",
  },
  openai: {
    label: "OpenAI (GPT)",
    color: "bg-emerald-500/20 text-emerald-400",
    authType: "api_key",
    hint: "Clé API disponible sur platform.openai.com",
  },
  groq: {
    label: "Groq",
    color: "bg-yellow-500/20 text-yellow-400",
    authType: "api_key",
    hint: "Clé API disponible sur console.groq.com",
  },
  mistral: {
    label: "Mistral AI",
    color: "bg-rose-500/20 text-rose-400",
    authType: "api_key",
    hint: "Clé API disponible sur console.mistral.ai",
  },
  xai: {
    label: "xAI (Grok)",
    color: "bg-gray-500/20 text-gray-300",
    authType: "api_key",
    hint: "Clé API disponible sur console.x.ai",
  },
  cerebras: {
    label: "Cerebras",
    color: "bg-amber-500/20 text-amber-400",
    authType: "api_key",
    hint: "Clé API disponible sur cloud.cerebras.ai",
  },
  minimax: {
    label: "MiniMax",
    color: "bg-purple-500/20 text-purple-400",
    authType: "api_key",
    hint: "Clé API MiniMax",
  },
  openrouter: {
    label: "OpenRouter",
    color: "bg-cyan-500/20 text-cyan-400",
    authType: "api_key",
    hint: "Clé API disponible sur openrouter.ai",
  },
  zai: {
    label: "Z.AI (GLM)",
    color: "bg-teal-500/20 text-teal-400",
    authType: "api_key",
    hint: "Clé API Z.AI",
  },
  "vercel-ai-gateway": {
    label: "Vercel AI Gateway",
    color: "bg-slate-500/20 text-slate-300",
    authType: "api_key",
    hint: "Token Vercel AI Gateway",
  },
  "github-copilot": {
    label: "GitHub Copilot",
    color: "bg-white/10 text-gray-300",
    authType: "oauth",
    hint: "Connexion OAuth via GitHub",
  },
  "google-gemini-cli": {
    label: "Google Gemini CLI (OAuth)",
    color: "bg-blue-500/20 text-blue-300",
    authType: "oauth",
    hint: "Accès OAuth gratuit Gemini via votre compte Google",
  },
  "google-antigravity": {
    label: "Google Antigravity (OAuth)",
    color: "bg-indigo-500/20 text-indigo-300",
    authType: "oauth",
    hint: "Accès OAuth Antigravity (daily sandbox Gemini)",
  },
  "openai-codex": {
    label: "OpenAI Codex (OAuth)",
    color: "bg-emerald-500/20 text-emerald-300",
    authType: "oauth",
    hint: "Connexion OAuth via ChatGPT",
  },
  // Legacy
  azure_openai: {
    label: "Azure OpenAI",
    color: "bg-sky-500/20 text-sky-400",
    authType: "api_key",
    hint: "Clé Azure OpenAI + endpoint complet dans l'URL de base",
  },
  ollama: {
    label: "Ollama (local)",
    color: "bg-violet-500/20 text-violet-400",
    authType: "none",
    hint: "Aucune clé requise — Ollama tourne localement",
  },
  github_copilot: {
    label: "GitHub Copilot (legacy)",
    color: "bg-white/10 text-gray-400",
    authType: "api_key",
    hint: "Token GitHub avec accès Copilot",
  },
  custom: {
    label: "Custom / Compatible OpenAI",
    color: "bg-white/10 text-gray-400",
    authType: "api_key",
    hint: "Provider compatible OpenAI (LM Studio, vLLM, etc.)",
  },
};
