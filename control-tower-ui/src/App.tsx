import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import "@xyflow/react/dist/style.css";
import {
  MarkerType,
  type Connection,
  type Edge,
} from "@xyflow/react";
import {
  exportSessionTranscriptJson,
  exportSessionTranscriptMarkdown,
} from "./chat/export";
import { PipelineFlowCanvas } from "./pipelines/PipelineFlowCanvas";
import { ChannelRouteMultiSelector } from "./channels/ChannelRouteMultiSelector";
import {
  buildChannelRouteSummary,
  channelsShareResolvedTarget,
  getChannelDefaultDestinationType,
  getChannelRouteConfig,
  isDetectedDestinationChannel,
  isManagedOutputRouteChannel,
  isRuntimeTransportChannel,
  isSystemChannelSurface,
  normalizeChannelAccountId,
  resolveChannelRouteKind,
} from "./channels/routes";
import {
  CRON_WEEKDAY_OPTIONS,
  buildCronScheduleExpression,
  describeCronScheduleHuman,
  parseCronScheduleBuilder,
  switchCronScheduleMode,
  type CronEveryUnit,
  type CronScheduleMode,
} from "./cron/schedule";
import {
  buildPipelineAutoLayoutPositions,
  defaultPipelineNodePosition,
  describeDraftStepNextTitles,
  formatRoutingModeLabel,
  getDraftStepConnectionDescriptors,
  getDraftStepIncomingDescriptors,
  getEffectiveDraftStepNextStepIds,
  getPipelineDraftStepTitle,
} from "./pipelines/flow";
import type {
  PipelineConnectionDescriptor,
  PipelineDraftStep,
  PipelineEditorMode,
  PipelineForm,
  PipelineIncomingDescriptor,
  PipelineOutputDeliveryMode,
} from "./pipelines/types";
import {
  ApiError,
  configureChannel,
  createSession,
  createAgent,
  createStoreResource,
  deleteSkillContent,
  deleteCliproxyAuthFile,
  deleteAgent,
  deleteStoreResource,
  discoverProviderBridge,
  fetchChannelCatalog,
  fetchChannelOperation,
  fetchAgentMemoryInsight,
  fetchCliproxyStatus,
  fetchDashboardSnapshot,
  fetchFileContent,
  fetchMemoryEngineStatus,
  fetchPipelineRunDetail,
  fetchPipelineRuns,
  fetchRuntimeEnv,
  fetchRuntimeLink,
  fetchSkillContent,
  fetchSkillsCatalog,
  fetchSessionHistory,
  importSkillContent,
  importCliproxyOpenClawAuth,
  importProviderBridge,
  installManagedMemoryPlugin,
  installChannelPlugin,
  loginChannel,
  logoutChannel,
  patchSession,
  pollCliproxyOauth,
  relaySessionMessage,
  resetSession,
  restartRuntimeBackend,
  removeChannel,
  runPipeline,
  saveChannelInboundBinding,
  saveFileContent,
  saveCliproxySection,
  saveMemoryEngineConfig,
  saveRuntimeEnv,
  saveRuntimeLink,
  setDashboardRequestContext,
  saveSkillContent,
  sendSessionMessage,
  submitCliproxyOauthCallback,
  startCliproxyOauth,
  updateAgent,
  updateStoreResource,
  type GatewayConfig,
} from "./api";
import type {
  AccessGrant,
  AgentMemoryInsight,
  AgentBinding,
  ChannelCatalogEntry,
  ChannelCatalogResponse,
  ChannelOperation,
  CliproxyAuthFile,
  CliproxyStatusResponse,
  CronJobRecord,
  DashboardAgent,
  DashboardChannel,
  DashboardProject,
  DashboardSession,
  DashboardSnapshot,
  DashboardUser,
  DashboardViewId,
  FileRecord,
  MemoryEngineStatus,
  PipelineRecord,
  PipelineRunRecord,
  PipelineRunSummary,
  ProviderBridge,
  SkillSummary,
  SkillManagerEntry,
  SkillImportSourceType,
  SkillManagerScope,
  SkillsCatalog,
  RuntimeEnvField,
  RuntimeLinkStatus,
  RuntimeLinkValues,
  RuntimeModelRecord,
  RuntimeEnvStatus,
  SessionInboundPrincipal,
  SessionHistoryResponse,
  SessionMessage,
} from "./types";

const BASE_URL_STORAGE_KEY = "openclawControlTower.baseUrl";
const TOKEN_STORAGE_KEY = "openclawControlTower.token";
const DASHBOARD_USER_STORAGE_KEY = "openclawControlTower.dashboardUserId";
const DASHBOARD_TEAM_SCOPE_STORAGE_KEY = "openclawControlTower.dashboardTeamScopeId";
const DASHBOARD_PROJECT_STORAGE_KEY = "openclawControlTower.dashboardProjectId";
const DASHBOARD_ROOT_USER_ID = "__elytras-root__";
const DASHBOARD_ALL_TEAMS_SCOPE_ID = "__all_teams__";
const DASHBOARD_NO_PROJECT_ID = "__no_project__";
const DEFAULT_BASE_URL = import.meta.env.VITE_OPENCLAW_BASE_URL || "http://127.0.0.1:18789";
const DEFAULT_TOKEN = import.meta.env.VITE_OPENCLAW_GATEWAY_TOKEN || "openclaw-local-token";
const OPENCLAW_DOCS_URL = "https://docs.openclaw.ai";
const PROVIDERS_DOCS_URL = "https://docs.openclaw.ai/providers";
const CLIPROXY_PROVIDER_ID = "cliproxyapi";
const OPENCLAW_REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";
const AGENT_BOOTSTRAP_FILES = [
  "AGENTS.md",
  "ELYTRAS.md",
  "ACCESS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
  "memory.md",
] as const;
const AGENT_BOOTSTRAP_FILE_RANK = new Map(
  AGENT_BOOTSTRAP_FILES.map((name, index) => [name, index]),
);
const AGENT_STUDIO_PINNED_FILES = [
  "AGENTS.md",
  "ELYTRAS.md",
  "ACCESS.md",
  "MEMORY.md",
  "SOUL.md",
  "TOOLS.md",
  "HEARTBEAT.md",
] as const;
const AGENT_STUDIO_SECONDARY_FILES = AGENT_BOOTSTRAP_FILES.filter(
  (name) => !AGENT_STUDIO_PINNED_FILES.some((entry) => entry === name),
);
const AGENT_BOOTSTRAP_SEED_FILES = [
  ...AGENT_BOOTSTRAP_FILES.filter((name) => name !== "memory.md"),
  "memory/notes.md",
];
const LOSSLESS_CLAW_RECOMMENDED_PRESET = {
  freshTailCount: "32",
  contextThreshold: "0.75",
  incrementalMaxDepth: "-1",
  ignoreSessionPatterns: "agent:*:cron:**",
  statelessSessionPatterns: "agent:*:subagent:**",
  skipStatelessSessions: true,
} as const;
const ELYTRAS_MANAGED_INBOUND_CHANNEL_IDS = new Set(["discord", "telegram"]);

type ChatWorkspaceMode = "elytras" | "inbox" | "system";

type RuntimeEnvDraftRow = {
  id: string;
  key: string;
  value: string;
  secret: boolean;
  redacted: boolean;
};

type RuntimeLinkDraft = RuntimeLinkValues;

type SkillEditorState = {
  mode: "idle" | "new" | "existing";
  libraryId: string;
  previousDirName: string;
  dirName: string;
  content: string;
};

type SkillEditorBaseline = {
  dirName: string;
  content: string;
};

type AgentScopedSkillOption = SkillSummary & {
  libraryId?: string;
  kind?: SkillManagerEntry["kind"];
  agentId?: string;
  agentLabel?: string;
  updatedAtMs?: number;
};

type SkillImportDraft = {
  sourceType: SkillImportSourceType;
  overwrite: boolean;
  repoUrl: string;
  ref: string;
  sourcePath: string;
  archiveUrl: string;
  archiveBase64: string;
  fileName: string;
  dirName: string;
  content: string;
};

function createRuntimeEnvDraftId() {
  return globalThis.crypto?.randomUUID?.() || `env-${Math.random().toString(36).slice(2, 10)}`;
}

function createRuntimeLinkDraft(values?: Partial<RuntimeLinkDraft>): RuntimeLinkDraft {
  return {
    backendRoot: values?.backendRoot || "",
    cliBin: values?.cliBin || "",
    runtimeDir: values?.runtimeDir || "",
    stateDir: values?.stateDir || "",
    workspaceDir: values?.workspaceDir || "",
    configPath: values?.configPath || "",
    gatewayPort: values?.gatewayPort || "",
    gatewayToken: values?.gatewayToken || "",
    gatewayUrl: values?.gatewayUrl || "",
    dashboardGatewayToken: values?.dashboardGatewayToken || "",
  };
}

function createEmptySkillEditorState(): SkillEditorState {
  return {
    mode: "idle",
    libraryId: "",
    previousDirName: "",
    dirName: "",
    content: "",
  };
}

function createEmptySkillEditorBaseline(): SkillEditorBaseline {
  return {
    dirName: "",
    content: "",
  };
}

function createEmptySkillImportDraft(): SkillImportDraft {
  return {
    sourceType: "git",
    overwrite: false,
    repoUrl: "",
    ref: "",
    sourcePath: "",
    archiveUrl: "",
    archiveBase64: "",
    fileName: "",
    dirName: "",
    content: "",
  };
}

function createSkillEntryKey(libraryId: string, dirName: string) {
  return `${libraryId}:${dirName}`;
}

function buildSkillTemplate(dirName: string) {
  const normalizedName = dirName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "custom_skill";
  return `---
name: ${normalizedName}
description: Skill custom a decrire
---

# ${normalizedName}

## But

- Decrire quand utiliser ce skill

## Procedure

- Dire quels outils ou commandes utiliser
- Ajouter les garde-fous utiles
`;
}

function createSkillDraftDirName(existingSkills: SkillManagerEntry[]) {
  const existing = new Set(existingSkills.map((entry) => entry.dirName));
  const base = "new-skill";
  if (!existing.has(base)) {
    return base;
  }
  let index = 2;
  while (existing.has(`${base}-${index}`)) {
    index += 1;
  }
  return `${base}-${index}`;
}

function readFileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Impossible de lire le fichier."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Format de fichier inattendu."));
        return;
      }
      const [, payload = ""] = reader.result.split(",", 2);
      if (!payload) {
        reject(new Error("Le fichier selectionne est vide."));
        return;
      }
      resolve(payload);
    };
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Impossible de lire le fichier texte."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Format de texte inattendu."));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsText(file);
  });
}

function createChatComposerAttachmentId() {
  return globalThis.crypto?.randomUUID?.() || `chat-attachment-${Math.random().toString(36).slice(2, 10)}`;
}

function revokeChatComposerAttachment(attachment: Pick<ChatComposerAttachment, "previewUrl">) {
  if (!attachment.previewUrl) {
    return;
  }
  URL.revokeObjectURL(attachment.previewUrl);
}

function isInlineTextImportFile(file: File) {
  if (CHAT_INLINE_TEXT_MIME_PREFIXES.some((prefix) => file.type.startsWith(prefix))) {
    return true;
  }
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  return CHAT_INLINE_TEXT_EXTENSIONS.has(extension);
}

function inferChatComposerAttachmentKind(file: File): ChatComposerAttachment["kind"] {
  if (file.type.startsWith("image/")) {
    return "image";
  }
  if (file.type.startsWith("audio/")) {
    return "audio";
  }
  if (file.type.startsWith("video/")) {
    return "video";
  }
  return "file";
}

function formatImportedTextBlock(fileName: string, content: string) {
  const trimmed = content.trim();
  const clipped =
    trimmed.length > CHAT_INLINE_TEXT_IMPORT_MAX_CHARS
      ? `${trimmed.slice(0, CHAT_INLINE_TEXT_IMPORT_MAX_CHARS)}\n\n...[fichier tronque pour rester lisible]`
      : trimmed;
  const extension = fileName.split(".").pop()?.toLowerCase() || "";
  const codeFence = extension && extension.length <= 10 ? extension : "txt";
  return [
    `Fichier importe: ${fileName}`,
    `\`\`\`${codeFence}`,
    clipped || "[fichier texte vide]",
    "```",
  ].join("\n");
}

function getSkillOptionPrecedence(skill: AgentScopedSkillOption) {
  if (skill.kind === "workspace" || skill.source === "openclaw-workspace") {
    return 50;
  }
  if (skill.kind === "overlay" || skill.source === "agents-skills-project") {
    return 40;
  }
  if (skill.kind === "personal" || skill.source === "agents-skills-personal") {
    return 30;
  }
  if (skill.kind === "managed" || skill.source === "openclaw-managed") {
    return 20;
  }
  if (skill.kind === "runtime" || skill.source === "openclaw-bundled") {
    return 10;
  }
  return 0;
}

function looksSensitiveRuntimeEnvKey(key: string) {
  return /(TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SESSION|COOKIE|AUTH)/i.test(
    key,
  );
}

function createRuntimeEnvDraftRows(fields: RuntimeEnvField[] = []): RuntimeEnvDraftRow[] {
  return fields.map((field) => ({
    id: createRuntimeEnvDraftId(),
    key: field.key,
    value: field.redacted ? "" : field.value,
    secret: Boolean(field.secret),
    redacted: Boolean(field.redacted),
  }));
}

function serializeRuntimeEnvDraftRows(rows: RuntimeEnvDraftRow[]): RuntimeEnvField[] {
  return rows
    .map((row) => ({
      key: row.key.trim(),
      value: row.redacted && !row.value ? OPENCLAW_REDACTED_SENTINEL : row.value,
      secret: row.secret,
      redacted: row.redacted,
    }))
    .filter((row) => row.key && row.value);
}

type AgentMarkdownGuide = {
  label: string;
  description: string;
  emphasis: string;
  sections?: string[];
  checklist?: string[];
  starterLabel?: string;
};

type AgentMarkdownTemplateContext = {
  agentId?: string;
  purpose?: string;
  skillIds?: string[];
  modelLabel?: string;
  workspace?: string;
  ownerTeamName?: string;
  accessTeamNames?: string[];
  allowedUserNames?: string[];
  allowedExternalIdentities?: string[];
  inboundTransportLabels?: string[];
  inboundDestinationLabels?: string[];
  outputRouteLabels?: string[];
  providerIds?: string[];
};

const AGENT_MARKDOWN_GUIDES: Record<string, AgentMarkdownGuide> = {
  "AGENTS.md": {
    label: "Mission",
    description: "Cadre principal de l’agent: role, limites, ton et procedure.",
    emphasis: "Lu tres tot dans le prompt runtime.",
    sections: ["Mission", "Startup", "Guardrails", "Cadence de travail"],
    checklist: [
      "Nommer clairement le role reel de l’agent",
      "Dire quels fichiers Elytras lire au debut de session",
      "Dire comment arbitrer en cas de conflit",
      "Lister ce qui demande confirmation operateur",
    ],
    starterLabel: "Poser la mission et les garde-fous",
  },
  "ELYTRAS.md": {
    label: "Cadre Elytras",
    description: "Contrat shared Elytras: identite, teams, RBAC et comportement inbound.",
    emphasis: "A lire tot pour comprendre le control plane Elytras.",
    sections: ["Elytras", "Identity & RBAC", "Safe behavior"],
    checklist: [
      "Rappeler que USER.md represente l’owner, pas le caller courant",
      "Dire comment lire les autorisations team-first",
      "Forcer le least privilege sur les sessions unresolved / blocked",
    ],
    starterLabel: "Expliquer la couche Elytras",
  },
  "ACCESS.md": {
    label: "Snapshot d'acces",
    description: "Vue agent-specifique des teams, users, bots, skills et outputs autorises.",
    emphasis: "Document genere a garder aligne avec Agent Studio.",
    sections: ["Ownership", "Humans", "Inbound", "Runtime scope"],
    checklist: [
      "Nommer la team proprietaire et les teams autorisees",
      "Lister les users / identites externes attendues",
      "Montrer les transports inbound, outputs et skills autorises",
    ],
    starterLabel: "Publier le scope runtime de l’agent",
  },
  "MEMORY.md": {
    label: "Memoire longue",
    description: "Source canonique des faits stables, preferences et decisions durables.",
    emphasis: "Indexe par le moteur memoire runtime pour le recall.",
    sections: ["Faits stables", "Preferences", "Decisions", "Threads ouverts"],
    checklist: [
      "Garder uniquement les informations durables",
      "Eviter le bruit sessionnel deja present dans les chats",
      "Mettre ici ce que le moteur memoire doit retrouver vite",
    ],
    starterLabel: "Fixer les faits durables",
  },
  "SOUL.md": {
    label: "Persona",
    description: "Style, posture, principes de communication et temperament.",
    emphasis: "Structure la voix de l’agent.",
    sections: ["Persona", "Style", "Energie"],
    checklist: [
      "Dire le ton sans refaire la mission",
      "Definir la densite et la franchise attendues",
      "Cadrer ce qu’il faut eviter en communication",
    ],
    starterLabel: "Designer la voix de l’agent",
  },
  "TOOLS.md": {
    label: "Outillage",
    description: "Comment l’agent doit utiliser ses outils, verifier et citer.",
    emphasis: "Utile pour les workflows techniques.",
    sections: ["Outils favoris", "Verifications", "Traces utiles"],
    checklist: [
      "Dire quels outils utiliser en premier",
      "Imposer les checks avant conclusion",
      "Citer les surfaces de logs ou fichiers critiques",
    ],
    starterLabel: "Caler la discipline d’execution",
  },
  "IDENTITY.md": {
    label: "Identite",
    description: "Nom, contexte, presentation courte et details de surface.",
    emphasis: "Reste proche du profil public de l’agent.",
    sections: ["Presentation", "Contexte", "Repères"],
    checklist: [
      "Rester factuel et public",
      "Ne pas dupliquer les guardrails de AGENTS.md",
    ],
    starterLabel: "Fixer le profil public",
  },
  "USER.md": {
    label: "Operateur",
    description: "Contexte sur l’owner / operateur de l’agent, pas sur le caller inbound courant.",
    emphasis: "Ne doit pas etre confondu avec l’utilisateur actif d’une session bot.",
    sections: ["Owner profile", "Attentes", "Conventions"],
    checklist: [
      "Documenter clairement qu'il s'agit de l'owner / operateur",
      "Documenter les preferences de collaboration",
      "Rappeler les formats ou habitudes utiles",
    ],
    starterLabel: "Documenter la relation operateur",
  },
  "HEARTBEAT.md": {
    label: "Heartbeat",
    description: "Taches de fond, checks periodiques et gardes operationnelles.",
    emphasis: "Pilote les heartbeats et routines.",
    sections: ["Checks", "Escalade", "Silence utile"],
    checklist: [
      "Lister les verifications recurrentes",
      "Dire quand remonter un signal",
      "Dire quand rester silencieux",
    ],
    starterLabel: "Definir les routines de fond",
  },
  "BOOTSTRAP.md": {
    label: "Bootstrap",
    description: "Instructions de tout debut de vie du workspace agent.",
    emphasis: "Visible surtout tant que le setup n’est pas complete.",
    sections: ["Initialisation", "Premiers checks", "Sortie du bootstrap"],
    checklist: [
      "Dire quoi verifier au premier run",
      "Imposer la lecture de ELYTRAS.md et ACCESS.md",
      "Pointer les fichiers a remplir en priorite",
      "Definir le moment ou ce bootstrap n’est plus utile",
    ],
    starterLabel: "Cadrer les premiers pas",
  },
  "memory.md": {
    label: "Memoire legacy",
    description: "Surface memoire historique encore utile selon certains setups.",
    emphasis: "A garder coherent avec MEMORY.md si present.",
    sections: ["Faits", "Preferences", "Decisions"],
    checklist: [
      "Eviter les contradictions avec MEMORY.md",
      "Ne garder que les informations encore consultees",
    ],
    starterLabel: "Consolider la memoire historique",
  },
  "memory/*.md": {
    label: "Notes indexees",
    description: "Journal de decisions, notes projets, TODOs stables et references.",
    emphasis: "Indexe par le moteur memoire avec MEMORY.md.",
    sections: ["Contexte", "Notes"],
    checklist: [
      "Un fichier par theme ou journal clair",
      "Des titres stables et faciles a retrouver",
      "Des notes denses plutot que des fragments vagues",
    ],
    starterLabel: "Ouvrir un journal indexable",
  },
};

const AGENT_QUICK_TEMPLATES = [
  {
    name: "memory/notes.md",
    label: "Notes",
    description: "Notes libres et observations persistantes.",
  },
  {
    name: "memory/decisions.md",
    label: "Decisions",
    description: "Arbitrages, dates et raisons.",
  },
  {
    name: "memory/todos.md",
    label: "Todos",
    description: "Actions en attente et suivi operateur.",
  },
] as const;

const NAV_ITEMS: Array<{ id: DashboardViewId; label: string; hint: string }> = [
  { id: "mission-control", label: "Mission Control", hint: "Temps reel + kanban" },
  { id: "agents", label: "Agents", hint: "Flotte + responsabilites" },
  { id: "chat", label: "Chat", hint: "Sessions + reprise" },
  { id: "files", label: "Files", hint: "Artifacts et workspace" },
  { id: "memory", label: "Memory", hint: "AGENTS.md et surface memoire" },
  { id: "runtime", label: "Runtime", hint: "Env vars + backend local" },
  { id: "workspaces", label: "Workspaces", hint: "Isolation par agent" },
  { id: "skills", label: "Skills", hint: "Catalogue actif" },
  { id: "providers", label: "Providers", hint: "Modeles et couverture" },
  { id: "channels", label: "Channels", hint: "Sorties et cibles" },
  { id: "pipelines", label: "Pipelines", hint: "Builder operateur" },
  { id: "cron", label: "Cron Jobs", hint: "Programmation et lanes" },
  { id: "users", label: "Users", hint: "Proprietaires et roles" },
  { id: "access", label: "Teams & Access", hint: "RBAC et grants" },
];

type KanbanLane = {
  id: string;
  label: string;
  cards: Array<{
    id: string;
    kind: "pipeline" | "cron";
    title: string;
    status: string;
    detail: string;
    meta: string;
    accent?: string;
  }>;
};

type ProviderBridgeEditor = {
  name: string;
  runtimeBaseUrl: string;
  consoleUrl: string;
  apiKey: string;
  managementKey: string;
  apiMode: "openai-responses" | "openai-chat" | "openai-codex-responses";
  authMode: "" | "api-key" | "token" | "oauth";
  authHeader: boolean;
  headersText: string;
  activeModelIds: string[];
  primaryModelId: string;
  applyAsDefaultModel: boolean;
};

type ChannelSetupDraft = {
  channelId: string;
  accountId: string;
  name: string;
  values: Record<string, string | boolean | number>;
};

type ChannelRouteDraft = {
  id: string;
  name: string;
  ownerId: string;
  destinationType: string;
  deliveryTarget: string;
};

type CliproxyOauthDraft = {
  provider: string;
  label: string;
  state: string;
  url: string;
  redirectUrl: string;
  submitStatus: "idle" | "submitting" | "submitted";
  submitError: string;
};

function readLocalStorage(key: string, fallback: string) {
  if (typeof window === "undefined") {
    return fallback;
  }
  return window.localStorage.getItem(key) || fallback;
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function formatDateTime(value?: string | number | null) {
  if (!value) {
    return "n/a";
  }
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return "n/a";
  }
  return date.toLocaleString("fr-FR");
}

function clampPercent(value?: number | null) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function remainingPercentFromUsed(value?: number | null) {
  return Math.max(0, 100 - clampPercent(value));
}

function normalizeQuotaWindowLabel(value?: string | null) {
  return (value || "").trim().toLowerCase();
}

function findQuotaWindow(
  windows: Array<{ label: string; usedPercent: number; resetAt?: number }>,
  kind: "5h" | "weekly",
) {
  const patterns =
    kind === "5h"
      ? ["5h", "5 h", "5-hour", "5 hour", "5hr"]
      : ["weekly", "hebdo", "week", "7d", "7 d"];
  return windows.find((window) => {
    const normalized = normalizeQuotaWindowLabel(window.label);
    return patterns.some((pattern) => normalized.includes(pattern));
  });
}

function formatRuntimeProviderLabel(providerId?: string | null) {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) {
    return "inherit";
  }
  if (normalized === CLIPROXY_PROVIDER_ID) {
    return "runtime unifie";
  }
  return normalized;
}

function formatBytes(value?: number | null) {
  if (typeof value !== "number" || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function buildChannelSetupDraft(
  entry: ChannelCatalogEntry | undefined,
  selectedAccountId?: string,
  options?: { hydrateFromExisting?: boolean },
): ChannelSetupDraft {
  const values: Record<string, string | boolean | number> = {};
  const resolvedAccountId =
    selectedAccountId || entry?.defaultAccountId || entry?.accounts[0]?.accountId || "default";
  const resolvedAccount =
    options?.hydrateFromExisting === false
      ? null
      : entry?.accounts.find(
          (account) =>
            normalizeChannelAccountId(account.accountId) ===
            normalizeChannelAccountId(resolvedAccountId),
        ) || null;
  for (const field of entry?.template.fields || []) {
    if (field.key === "dmPolicy" && resolvedAccount?.dmPolicy) {
      values[field.key] = resolvedAccount.dmPolicy;
    } else if (field.key === "allowFrom" && resolvedAccount?.allowFrom.length) {
      values[field.key] = resolvedAccount.allowFrom.join("\n");
    } else if (field.defaultValue !== undefined) {
      values[field.key] = field.defaultValue;
    } else if (field.type === "checkbox") {
      values[field.key] = false;
    } else {
      values[field.key] = "";
    }
  }
  return {
    channelId: entry?.id || "",
    accountId: entry?.template.accountScope === "top-level-only" ? "default" : resolvedAccountId,
    name: resolvedAccount?.name || "",
    values,
  };
}

function suggestNewChannelAccountId(entry: ChannelCatalogEntry | undefined) {
  const existing = new Set(
    (entry?.accounts || []).map((account) => normalizeChannelAccountId(account.accountId)),
  );
  if (!existing.has("default")) {
    return "default";
  }
  let index = 2;
  while (existing.has(`bot-${index}`)) {
    index += 1;
  }
  return `bot-${index}`;
}

function createChannelRouteDraft(
  ownerId: string,
  entry?: Pick<ChannelCatalogEntry, "template"> | null,
  route?: DashboardChannel,
): ChannelRouteDraft {
  return {
    id: route?.id || "",
    name: route?.name || "",
    ownerId: route?.ownerId || ownerId,
    destinationType: route?.destinationType || getChannelDefaultDestinationType(entry),
    deliveryTarget: route?.deliveryTarget || "",
  };
}

function normalizeDetectedDestinationTarget(
  entry: Pick<ChannelCatalogEntry, "id"> | null | undefined,
  target: string,
) {
  const normalizedTarget = target.trim();
  if (!normalizedTarget || !entry) {
    return normalizedTarget;
  }
  if (entry.id === "telegram") {
    const lower = normalizedTarget.toLowerCase();
    if (lower.includes(":topic:")) {
      let candidate = normalizedTarget;
      while (candidate.toLowerCase().startsWith("telegram:telegram:")) {
        candidate = candidate.slice("telegram:".length);
      }
      if (candidate.toLowerCase().startsWith("group:")) {
        return `telegram:${candidate}`;
      }
      return candidate;
    }
    let candidate = normalizedTarget;
    while (
      candidate.toLowerCase().startsWith("telegram:") ||
      candidate.toLowerCase().startsWith("tg:")
    ) {
      if (candidate.toLowerCase().startsWith("telegram:")) {
        candidate = candidate.slice("telegram:".length);
      } else {
        candidate = candidate.slice("tg:".length);
      }
    }
    if (candidate.toLowerCase().startsWith("group:")) {
      return candidate.slice("group:".length);
    }
    if (
      candidate.toLowerCase().startsWith("user:") ||
      candidate.toLowerCase().startsWith("chat:")
    ) {
      return candidate.slice(candidate.indexOf(":") + 1);
    }
    return candidate;
  }
  if (entry.id === "discord") {
    let candidate = normalizedTarget;
    while (candidate.toLowerCase().startsWith("discord:")) {
      candidate = candidate.slice("discord:".length);
    }
    return candidate;
  }
  return normalizedTarget;
}

function describeDetectedDestinationLabel(
  entry: Pick<ChannelCatalogEntry, "id" | "template"> | null | undefined,
  channel: DashboardChannel,
) {
  const normalizedTarget = normalizeDetectedDestinationTarget(entry, channel.target);
  const routeKind = inferRouteDestinationTypeFromDetectedTarget(entry, channel.target);
  const routeKindLabel =
    entry && routeKind
      ? resolveChannelRouteKind(entry, routeKind)?.label || routeKind
      : routeKind || "peer";
  return normalizedTarget ? `${routeKindLabel} ${normalizedTarget}` : channel.name;
}

function inferRouteDestinationTypeFromDetectedTarget(
  entry: Pick<ChannelCatalogEntry, "id" | "template"> | null | undefined,
  target: string,
) {
  const normalizedTarget = target.trim().toLowerCase();
  if (!entry) {
    return "";
  }
  if (entry.id === "discord") {
    if (normalizedTarget.startsWith("thread:")) {
      return "thread";
    }
    if (normalizedTarget.startsWith("user:")) {
      return "dm";
    }
    if (normalizedTarget.startsWith("channel:")) {
      return "channel";
    }
  }
  if (entry.id === "telegram") {
    if (normalizedTarget.includes(":topic:")) {
      return "topic";
    }
    if (normalizedTarget.startsWith("telegram:group:") || normalizedTarget.startsWith("-")) {
      return "group";
    }
    if (normalizedTarget.startsWith("telegram:") || /^\d+$/.test(normalizedTarget)) {
      return "user";
    }
  }
  const routeConfig = getChannelRouteConfig(entry);
  const prefixedKind = routeConfig?.destinationKinds.find((kind) =>
    normalizedTarget.startsWith(`${kind.id.toLowerCase()}:`),
  );
  if (prefixedKind) {
    return prefixedKind.id;
  }
  const embeddedKind = routeConfig?.destinationKinds.find((kind) =>
    normalizedTarget.includes(`:${kind.id.toLowerCase()}:`),
  );
  return embeddedKind?.id || getChannelDefaultDestinationType(entry);
}

function normalizePipelineOutputDeliveryMode(
  value?: string | null,
): PipelineOutputDeliveryMode {
  if (value === "final-only" || value === "step-only" || value === "step-and-final") {
    return value;
  }
  return "final-only";
}

function pipelineStepOutputsEnabled(mode: PipelineOutputDeliveryMode) {
  return mode === "step-only" || mode === "step-and-final";
}

function pipelineFinalOutputsEnabled(mode: PipelineOutputDeliveryMode) {
  return mode === "final-only" || mode === "step-and-final";
}

function formatPipelineOutputDeliveryMode(mode?: string | null) {
  const normalized = normalizePipelineOutputDeliveryMode(mode);
  if (normalized === "step-only") {
    return "sorties d'etape uniquement";
  }
  if (normalized === "step-and-final") {
    return "sorties d'etape + finale";
  }
  return "sortie finale uniquement";
}

function describePipelineOutputDeliveryMode(mode?: string | null) {
  const normalized = normalizePipelineOutputDeliveryMode(mode);
  if (normalized === "step-only") {
    return "Seuls les noeuds avec des destinations explicites envoient un message. Les outputs pipeline sont ignores.";
  }
  if (normalized === "step-and-final") {
    return "Les noeuds envoient leurs sorties explicites et le pipeline envoie aussi sa sortie finale.";
  }
  return "Seule la sortie finale du pipeline est envoyee. Les sorties d'etape restent journalisees mais non delivrees.";
}

function describeSessionSurface(session: DashboardSession) {
  if (session.sessionKindDescription) {
    return session.sessionKindDescription;
  }
  if (session.sessionKind === "pipeline") {
    return "Session creee par un run pipeline pour executer une etape precise.";
  }
  if (session.sessionKind === "heartbeat") {
    return "Pulse systeme utilise pour verifier qu’un transport ou une integration est vivant.";
  }
  if (session.sessionKind === "internal") {
    return "Session interne du runtime OpenClaw reservee au control plane et au debug.";
  }
  if (session.sessionKind === "webchat") {
    return "Session native WebChat d’OpenClaw, utile pour la reprise UI.";
  }
  return "Conversation operateur standard.";
}

function formatTransportLabel(value?: string | null) {
  const raw = value?.trim();
  if (!raw) {
    return "n/a";
  }
  return raw
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
    .join(" ");
}

function describeSessionSurfaceLabel(session?: DashboardSession | null) {
  if (!session) {
    return "n/a";
  }
  if (session.channel) {
    return `Inbox ${formatTransportLabel(session.channel)}`;
  }
  if (session.sessionKind === "pipeline") {
    return "Run pipeline";
  }
  if (session.sessionKind === "heartbeat") {
    return "Heartbeat";
  }
  if (session.sessionKind === "internal") {
    return "Session interne";
  }
  if (session.sessionKind === "webchat") {
    return "Chat Elytras";
  }
  return session.sessionKindLabel || session.sessionKind || "Chat";
}

function resolveChatWorkspaceMode(session?: DashboardSession | null): ChatWorkspaceMode {
  return getSessionWorkspaceMode(session);
}

function getSessionChannelBadge(session?: DashboardSession | null) {
  if (!session) {
    return "n/a";
  }
  if (session.channel) {
    return session.chatType ? `${session.channel} · ${session.chatType}` : session.channel;
  }
  if (session.sessionKind === "webchat") {
    return "dashboard webchat";
  }
  return session.sessionKindLabel || session.sessionKind || "session";
}

function describeChatWorkspace(mode: ChatWorkspaceMode) {
  if (mode === "inbox") {
    return "Conversations inbound provenant des bots Discord, Telegram et autres channels relies.";
  }
  if (mode === "system") {
    return "Heartbeats, sessions internes et surfaces techniques separees des conversations.";
  }
  return "Conversations operateur lancees depuis Elytras / dashboard.";
}

function getSessionWorkspaceMode(session?: DashboardSession | null): ChatWorkspaceMode {
  if (!session) {
    return "elytras";
  }
  if (session.sessionKind === "heartbeat" || session.sessionKind === "internal") {
    return "system";
  }
  if (session.sessionKind === "webchat") {
    return "elytras";
  }
  if (session.sessionKind === "chat") {
    return session.channel ? "inbox" : "elytras";
  }
  return "system";
}

function describeInboundPrincipalState(principal?: SessionInboundPrincipal) {
  if (!principal || principal.status === "n/a") {
    return "";
  }
  if (principal.status === "resolved") {
    if (principal.canUseAgent) {
      return "mapped and allowed";
    }
    return principal.canUseChannel ? "mapped, agent blocked" : "mapped, destination blocked";
  }
  if (principal.status === "ambiguous") {
    return "ambiguous";
  }
  return "unresolved";
}

function inboundPrincipalTone(principal?: SessionInboundPrincipal) {
  if (!principal || principal.status === "n/a") {
    return "paused";
  }
  if (principal.status === "resolved") {
    return principal.canUseAgent ? "active" : "attention";
  }
  if (principal.status === "ambiguous") {
    return "failed";
  }
  return "attention";
}

function describeInboundPrincipalAccess(principal?: SessionInboundPrincipal) {
  if (!principal || principal.status === "n/a") {
    return "";
  }
  if (principal.status === "resolved") {
    return principal.canUseAgent
      ? "Cet utilisateur peut parler a l'agent."
      : principal.canUseChannel
        ? "Cet expediteur est mappe mais n'a pas le droit de parler a l'agent."
        : "Cet expediteur est mappe mais n'a pas acces a la destination de cette conversation.";
  }
  if (principal.status === "ambiguous") {
    return principal.resolutionSurface === "sender"
      ? "Plusieurs utilisateurs Elytras correspondent a cet expediteur."
      : "Plusieurs utilisateurs Elytras correspondent a cette conversation.";
  }
  return principal.resolutionSurface === "sender"
    ? "Aucun utilisateur Elytras n'est mappe a cet expediteur, donc parler a l'agent est bloque."
    : "Aucun utilisateur Elytras n'est mappe a cette conversation, donc parler a l'agent est bloque.";
}

function summarizeInboundPrincipal(principal?: SessionInboundPrincipal) {
  if (!principal || principal.status === "n/a") {
    return "";
  }
  if (principal.status === "resolved" && principal.canUseAgent) {
    const userLabel = principal.userName || principal.userId || "User mappe";
    const accessLabel = formatInboundAccessSource(principal.accessSource);
    return accessLabel !== "aucune"
      ? `${userLabel} autorise via ${accessLabel}.`
      : `${userLabel} autorise.`;
  }
  return principal.reason || describeInboundPrincipalAccess(principal);
}

function formatInboundAccessSource(accessSource?: string) {
  switch (accessSource) {
    case "admin":
      return "admin";
    case "grant":
      return "grant";
    case "direct":
      return "affectation directe";
    case "team":
      return "equipe";
    default:
      return "aucune";
  }
}

function formatInboundResolutionSurface(surface?: SessionInboundPrincipal["resolutionSurface"]) {
  switch (surface) {
    case "sender":
      return "expediteur";
    case "destination":
      return "destination";
    default:
      return "n/a";
  }
}

function shouldShowInboundPrincipal(session?: DashboardSession | null) {
  return (
    getSessionWorkspaceMode(session) === "inbox" &&
    Boolean(session?.inboundPrincipal && session.inboundPrincipal.status !== "n/a")
  );
}

function sessionKindPillStatus(kind?: DashboardSession["sessionKind"]) {
  if (kind === "pipeline") {
    return "running";
  }
  if (kind === "chat") {
    return "active";
  }
  return "paused";
}

function formatRunDuration(startedAt?: string, completedAt?: string) {
  if (!startedAt) {
    return "n/a";
  }
  const startedMs = new Date(startedAt).valueOf();
  const completedMs = completedAt ? new Date(completedAt).valueOf() : Date.now();
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) {
    return completedAt ? "n/a" : "en cours";
  }
  return completedAt ? formatDurationMs(completedMs - startedMs) : `${formatDurationMs(completedMs - startedMs)} · en cours`;
}

function summarizeText(value: string | undefined, maxLength = 220) {
  const normalized = value?.trim() || "";
  if (!normalized) {
    return "Aucun detail.";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPipelineSessionLike(session: DashboardSession, pipelines: PipelineRecord[]) {
  if (
    session.sessionKind === "pipeline" ||
    session.pipelineId ||
    session.pipelineRunId ||
    session.pipelineStepId
  ) {
    return true;
  }
  const title = (
    session.displayName ||
    session.derivedTitle ||
    session.label ||
    ""
  ).trim();
  if (!title) {
    return false;
  }
  if (/^.+\s·\s.+\s·\s[a-f0-9]{8}$/i.test(title)) {
    return true;
  }
  return pipelines.some((pipeline) =>
    pipeline.steps.some((step) => {
      const pattern = new RegExp(
        `^${escapeRegExp(pipeline.name)}\\s*·\\s*${escapeRegExp(step.name)}(?:\\s*·\\s*[a-f0-9]{8})?$`,
        "i",
      );
      return pattern.test(title);
    }),
  );
}

function formatChannelRuntimeState(entry: ChannelCatalogEntry | undefined) {
  if (!entry) {
    return "n/a";
  }
  if (!entry.installed) {
    return "plugin non charge";
  }
  if (entry.accounts.some((account) => account.connected)) {
    return "connecte";
  }
  if (entry.accounts.some((account) => account.linked)) {
    return "lie";
  }
  if (entry.configured) {
    return "configure";
  }
  return "non configure";
}

function channelAccountLabel(entry: ChannelCatalogEntry, accountId: string) {
  const account = entry.accounts.find((candidate) => candidate.accountId === accountId);
  if (!account) {
    return accountId || "default";
  }
  return account.name ? `${account.name} (${account.accountId})` : account.accountId;
}

function findChannelRuntimeAccount(
  entry: ChannelCatalogEntry | undefined,
  accountId?: string,
) {
  const normalizedAccountId = normalizeChannelAccountId(accountId);
  return entry?.accounts.find(
    (candidate) => normalizeChannelAccountId(candidate.accountId) === normalizedAccountId,
  );
}

function summarizeLabels(labels: string[], limit = 3, fallback = "n/a") {
  if (!labels.length) {
    return fallback;
  }
  if (labels.length <= limit) {
    return labels.join(", ");
  }
  return `${labels.slice(0, limit).join(", ")} +${labels.length - limit}`;
}

function makeRuntimeTransportKey(channel: DashboardChannel) {
  return `${channel.kind}:${normalizeChannelAccountId(channel.accountId)}`;
}

function isElytrasManagedInboundChannel(channelId?: string | null) {
  return Boolean(channelId && ELYTRAS_MANAGED_INBOUND_CHANNEL_IDS.has(channelId));
}

function formatCurrency(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(value);
}

function formatDurationMs(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "n/a";
  }
  const totalMinutes = Math.floor(value / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}j ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function cliproxyProviderLabel(providerId: string) {
  const labels: Record<string, string> = {
    anthropic: "Anthropic OAuth",
    antigravity: "Google Antigravity OAuth",
    claude: "Claude API keys",
    codex: "Codex OAuth",
    "gemini-cli": "Gemini CLI OAuth",
    gemini: "Gemini API keys",
    iflow: "iFlow OAuth",
    openai: "OpenAI",
    qwen: "Qwen OAuth",
  };
  return labels[providerId] || providerId;
}

type CliproxyManagedProviderSummary = {
  id: string;
  label: string;
  oauthAccounts: CliproxyAuthFile[];
  apiKeyPoolCount: number;
  upstreamCount: number;
  excludedModelCount: number;
  oauthCapable: boolean;
};

function summarizeCliproxyManagedProviders(status: CliproxyStatusResponse | null) {
  const providerMap = new Map<string, CliproxyManagedProviderSummary>();
  const ensure = (providerId: string) => {
    const normalizedId = providerId.trim();
    const existing = providerMap.get(normalizedId);
    if (existing) {
      return existing;
    }
    const created: CliproxyManagedProviderSummary = {
      id: normalizedId,
      label: cliproxyProviderLabel(normalizedId),
      oauthAccounts: [],
      apiKeyPoolCount: 0,
      upstreamCount: 0,
      excludedModelCount: 0,
      oauthCapable: ["anthropic", "antigravity", "codex", "gemini-cli", "iflow", "qwen"].includes(
        normalizedId,
      ),
    };
    providerMap.set(normalizedId, created);
    return created;
  };

  for (const account of status?.authFiles || []) {
    ensure(account.provider).oauthAccounts.push(account);
  }

  if ((status?.geminiApiKeys.length || 0) > 0) {
    ensure("gemini").apiKeyPoolCount = status?.geminiApiKeys.length || 0;
  }
  if ((status?.codexApiKeys.length || 0) > 0) {
    ensure("codex").apiKeyPoolCount = status?.codexApiKeys.length || 0;
  }
  if ((status?.claudeApiKeys.length || 0) > 0) {
    ensure("claude").apiKeyPoolCount = status?.claudeApiKeys.length || 0;
  }

  for (const [providerId, excludedModels] of Object.entries(status?.oauthExcludedModels || {})) {
    ensure(providerId).excludedModelCount = excludedModels.length;
  }

  for (const entry of status?.openAiCompatibility || []) {
    const providerId =
      (typeof entry.name === "string" && entry.name.trim()) ||
      (typeof entry.baseUrl === "string" && entry.baseUrl.trim()) ||
      "openai-compatible";
    ensure(providerId).upstreamCount += 1;
  }

  return Array.from(providerMap.values()).toSorted((left, right) =>
    left.label.localeCompare(right.label, "en", { sensitivity: "base" }) ||
    left.id.localeCompare(right.id),
  );
}

function splitList(value: string) {
  return value
    .split(/[,|\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function areStringListsEqual(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => entry === right[index]);
}

function resolveFileContentResponseContent(
  response: { result?: { content?: string; file?: { content?: string } } },
) {
  const fileContent = response.result?.file?.content;
  if (typeof fileContent === "string") {
    return fileContent;
  }
  return typeof response.result?.content === "string" ? response.result.content : "";
}

function serializeBridgeHeaders(headers: Record<string, string>) {
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function parseJsonEditor<T>(value: string, fallback: T): T {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  return JSON.parse(trimmed) as T;
}

function createBridgeEditor(): ProviderBridgeEditor {
  return {
    name: "Provider runtime",
    runtimeBaseUrl: "http://127.0.0.1:8317/v1",
    consoleUrl: "http://127.0.0.1:8317",
    apiKey: "",
    managementKey: "",
    apiMode: "openai-responses",
    authMode: "api-key",
    authHeader: true,
    headersText: "",
    activeModelIds: [],
    primaryModelId: "",
    applyAsDefaultModel: false,
  };
}

function bridgeToEditor(bridge: ProviderBridge): ProviderBridgeEditor {
  return {
    name: bridge.name,
    runtimeBaseUrl: bridge.runtimeBaseUrl,
    consoleUrl: bridge.consoleUrl || "",
    apiKey: bridge.apiKey || "",
    managementKey: bridge.managementKey || "",
    apiMode: bridge.apiMode,
    authMode: bridge.authMode || "",
    authHeader: bridge.authHeader,
    headersText: serializeBridgeHeaders(bridge.headers),
    activeModelIds: bridge.activeModelIds,
    primaryModelId: bridge.primaryModelId || bridge.activeModelIds[0] || "",
    applyAsDefaultModel: bridge.applyAsDefaultModel,
  };
}

function bridgeEditorPayload(editor: ProviderBridgeEditor) {
  return {
    name: editor.name,
    runtimeBaseUrl: editor.runtimeBaseUrl,
    consoleUrl: editor.consoleUrl,
    apiKey: editor.apiKey,
    managementKey: editor.managementKey,
    apiMode: editor.apiMode,
    authMode: editor.authMode || undefined,
    authHeader: editor.authHeader,
    headersText: editor.headersText,
    activeModelIds: editor.activeModelIds,
    primaryModelId: editor.primaryModelId || undefined,
    applyAsDefaultModel: editor.applyAsDefaultModel,
  };
}

function buildKanbanLanes(snapshot: DashboardSnapshot): KanbanLane[] {
  const lanes: KanbanLane[] = [
    { id: "running", label: "Running", cards: [] },
    { id: "queued", label: "Queued", cards: [] },
    { id: "attention", label: "Attention", cards: [] },
    { id: "paused", label: "Paused", cards: [] },
    { id: "done", label: "Done", cards: [] },
  ];

  const laneForStatus = (status: string) => {
    if (status === "running") {
      return "running";
    }
    if (status === "failed") {
      return "attention";
    }
    if (status === "paused") {
      return "paused";
    }
    if (status === "done") {
      return "done";
    }
    return "queued";
  };

  for (const pipeline of snapshot.pipelines) {
    const lane = lanes.find((entry) => entry.id === laneForStatus(pipeline.status));
    lane?.cards.push({
      id: pipeline.id,
      kind: "pipeline",
      title: pipeline.name,
      status: pipeline.status,
      detail: pipeline.description || "Pipeline multi-etapes.",
      meta: `${pipeline.steps.length} etapes · ${pipeline.agentIds.join(", ") || "sans agent"}`,
      accent: "pipeline",
    });
  }

  for (const job of snapshot.cronJobs) {
    const lane = lanes.find((entry) => entry.id === laneForStatus(job.activityStatus));
    lane?.cards.push({
      id: job.id,
      kind: "cron",
      title: job.name,
      status: job.activityStatus,
      detail:
        job.description ||
        (job.source === "openclaw"
          ? "Job natif expose par OpenClaw."
          : "Job de pilotage persiste dans le dashboard."),
      meta:
        job.source === "openclaw"
          ? `source: OpenClaw · prochain run ${formatDateTime(job.state?.nextRunAtMs)}`
          : `${describeCronJobTarget(job)} · schedule ${describeCronJobSchedule(job)} · owner ${job.ownerId || "n/a"}`,
      accent: job.source,
    });
  }

  return lanes;
}

function statusTone(status: string) {
  if (status === "running" || status === "active" || status === "done") {
    return "success";
  }
  if (status === "failed" || status === "attention") {
    return "danger";
  }
  if (status === "paused") {
    return "muted";
  }
  return "warning";
}

function getCronJobTargetType(job: CronJobRecord) {
  if (job.targetType) {
    return job.targetType;
  }
  return job.pipelineId ? "pipeline" : "request";
}

function describeCronJobTarget(job: CronJobRecord) {
  return getCronJobTargetType(job) === "pipeline"
    ? `pipeline ${job.pipelineId || "n/a"}`
    : `request ${job.agentId || "n/a"}`;
}

function describeCronJobSchedule(job: CronJobRecord) {
  const schedule = job.schedule?.trim();
  return schedule ? describeCronScheduleHuman(schedule) : "sans recurrence";
}

function describeCronScheduleMode(mode: CronScheduleMode) {
  switch (mode) {
    case "none":
      return "Lancement manuel uniquement";
    case "every":
      return "Rythme simple, sans ecrire de cron";
    case "daily":
      return "Tous les jours a une heure fixe";
    case "weekdays":
      return "Du lundi au vendredi";
    case "weekly":
      return "Une fois par semaine";
    case "monthly":
      return "Une fois par mois";
    case "custom":
      return "Expression libre pour les cas avances";
    default:
      return "";
  }
}

type ExecutionSettings = {
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  reasoningLevel?: string;
};

type ExecutionSettingsPatch = {
  thinkingLevel?: string | null;
  fastMode?: boolean | null;
  verboseLevel?: string | null;
  reasoningLevel?: string | null;
};

type ChatDraft = {
  agentId: string;
  label: string;
  projectId: string;
  modelRef: string;
  message: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  reasoningLevel?: string;
};

type ChatComposerAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  kind: "image" | "audio" | "video" | "file";
  base64: string;
  size: number;
  previewUrl: string;
};

type PipelineCanvasColumn = {
  index: number;
  stepIds: string[];
};

type PipelineCanvasEdge = {
  key: string;
  branchLabel: string;
  routingMode: PipelineDraftStep["routingMode"];
  startX: number;
  startY: number;
  endX: number;
  endY: number;
};

type PipelineCanvasLayout = {
  width: number;
  height: number;
  edges: PipelineCanvasEdge[];
};

type PipelineCanvasEditorPosition = {
  left: number;
  top: number;
  width: number;
};

type AgentEditor = {
  agentId: string;
  name: string;
  workspace: string;
  ownerId: string;
  teamId: string;
  accessTeamIds: string[];
  inboundTransportKeys: string[];
  purpose: string;
  channelIds: string[];
  defaultOutputChannelIds: string[];
  providerIds: string[];
  skillPolicy: "all" | "selected" | "none";
  skillIds: string[];
  tags: string;
  emoji: string;
  avatar: string;
  modelRef: string;
  resumePolicy: "manual" | "prefer-recent" | "sticky";
  dispatchPolicy: "manual" | "default-channels" | "broadcast";
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  reasoningLevel?: string;
};

type MemoryEngineForm = {
  dbPath: string;
  summaryModel: string;
  expansionModel: string;
  freshTailCount: string;
  contextThreshold: string;
  incrementalMaxDepth: string;
  ignoreSessionPatterns: string;
  statelessSessionPatterns: string;
  skipStatelessSessions: boolean;
};

type InboundUserDraft = {
  name: string;
  email: string;
  role: "admin" | "operator" | "member" | "viewer";
  status: "active" | "invited" | "disabled";
  teamIds: string[];
};

type ProjectEditor = {
  name: string;
  description: string;
  teamId: string;
  memberIds: string[];
  agentIds: string[];
  notes: string;
};

const THINK_LEVELS = ["", "off", "minimal", "low", "medium", "high", "xhigh"] as const;
const BINARY_THINK_LEVELS = ["", "off", "on"] as const;
const FAST_LEVELS = [
  { value: "", label: "inherit" },
  { value: "on", label: "on" },
  { value: "off", label: "off" },
] as const;
const VERBOSE_LEVELS = [
  { value: "", label: "inherit" },
  { value: "off", label: "off (explicit)" },
  { value: "on", label: "on" },
  { value: "full", label: "full" },
] as const;
const REASONING_LEVELS = ["", "off", "on", "stream"] as const;
const CHAT_INLINE_TEXT_IMPORT_MAX_CHARS = 24_000;
const CHAT_INLINE_TEXT_MIME_PREFIXES = ["text/"];
const CHAT_INLINE_TEXT_EXTENSIONS = new Set([
  "md",
  "mdx",
  "txt",
  "json",
  "csv",
  "tsv",
  "xml",
  "yaml",
  "yml",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "sh",
  "html",
  "css",
]);

function normalizeProviderId(provider?: string | null) {
  if (!provider) {
    return "";
  }
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  return normalized;
}

function modelProviderFromRef(modelRef?: string) {
  if (!modelRef) {
    return undefined;
  }
  const separator = modelRef.indexOf("/");
  return separator > 0 ? modelRef.slice(0, separator) : modelRef;
}

function isBinaryThinkingProvider(provider?: string | null) {
  return normalizeProviderId(provider) === "zai";
}

function resolveThinkLevelOptions(provider?: string | null) {
  return isBinaryThinkingProvider(provider) ? BINARY_THINK_LEVELS : THINK_LEVELS;
}

function withCurrentOption(options: readonly string[], current: string) {
  if (!current) {
    return [...options];
  }
  if (options.includes(current)) {
    return [...options];
  }
  return [...options, current];
}

function resolveThinkLevelDisplay(value: string, isBinary: boolean) {
  if (!isBinary) {
    return value;
  }
  if (!value || value === "off") {
    return value;
  }
  return "on";
}

function resolveThinkLevelPatchValue(value: string, isBinary: boolean): string | null {
  if (!value) {
    return null;
  }
  if (!isBinary) {
    return value;
  }
  return value === "on" ? "low" : value;
}

function formatFastMode(value?: boolean) {
  if (value === true) {
    return "on";
  }
  if (value === false) {
    return "off";
  }
  return "inherit";
}

function formatExecutionSummary(profile: ExecutionSettings, provider?: string | null) {
  const binaryThinking = isBinaryThinkingProvider(provider);
  return [
    `thinking ${resolveThinkLevelDisplay(profile.thinkingLevel || "", binaryThinking) || "inherit"}`,
    `fast ${formatFastMode(profile.fastMode)}`,
    `verbose ${profile.verboseLevel || "inherit"}`,
    `reasoning ${profile.reasoningLevel || "inherit"}`,
  ].join(" · ");
}

function createChatDraft(agentId = ""): ChatDraft {
  return {
    agentId,
    label: "",
    projectId: DASHBOARD_NO_PROJECT_ID,
    modelRef: "",
    message: "",
    thinkingLevel: undefined,
    fastMode: undefined,
    verboseLevel: undefined,
    reasoningLevel: undefined,
  };
}

function createProjectEditor(teamId = ""): ProjectEditor {
  return {
    name: "",
    description: "",
    teamId,
    memberIds: [],
    agentIds: [],
    notes: "",
  };
}

function createDraftId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function createPipelineDraftStep(agentId = "main"): PipelineDraftStep {
  return {
    id: createDraftId("step"),
    name: "",
    agentId,
    prompt: "",
    outputTargets: [],
    skillIds: [],
    nextStepIds: [],
    routingMode: "linear",
    condition: "",
    modelRef: "",
    thinkingLevel: undefined,
    fastMode: undefined,
    verboseLevel: undefined,
    reasoningLevel: undefined,
  };
}

function createPipelineForm(agentId = "main"): PipelineForm {
  return {
    name: "",
    description: "",
    ownerId: "",
    teamId: "",
    status: "draft",
    outputTargets: "",
    outputDeliveryMode: normalizePipelineOutputDeliveryMode("final-only"),
    steps: [createPipelineDraftStep(agentId)],
  };
}

function pipelineStepToDraft(step: PipelineRecord["steps"][number]): PipelineDraftStep {
  return {
    id: step.id,
    name: step.name,
    agentId: step.agentId,
    prompt: step.prompt || "",
    outputTargets: splitList(step.output || ""),
    skillIds: [...step.skills],
    nextStepIds: [...(step.nextStepIds || [])],
    routingMode: step.routingMode || "linear",
    condition: step.condition || "",
    modelRef: step.modelRef || "",
    thinkingLevel: step.thinkingLevel,
    fastMode: step.fastMode,
    verboseLevel: step.verboseLevel,
    reasoningLevel: step.reasoningLevel,
  };
}

function pipelineToForm(pipeline: PipelineRecord): PipelineForm {
  return {
    name: pipeline.name,
    description: pipeline.description,
    ownerId: pipeline.ownerId,
    teamId: pipeline.teamId || "",
    status: pipeline.status,
    outputTargets: pipeline.outputTargets.join(","),
    outputDeliveryMode: normalizePipelineOutputDeliveryMode(pipeline.outputDeliveryMode),
    steps: pipeline.steps.length
      ? pipeline.steps.map((step) => pipelineStepToDraft(step))
      : [createPipelineDraftStep(pipeline.agentIds[0] || "main")],
  };
}

function clonePipelineNodePositions(
  value: PipelineRecord["nodePositions"],
): Record<string, { x: number; y: number }> {
  if (!value) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, position]) =>
        Boolean(position) &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y),
    ),
  );
}

function clonePipelineViewport(
  value: PipelineRecord["viewport"],
): { x: number; y: number; zoom: number } | null {
  if (
    !value ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    !Number.isFinite(value.zoom)
  ) {
    return null;
  }
  return { x: value.x, y: value.y, zoom: value.zoom };
}

function buildDefaultChatLabel(agentId: string) {
  const time = new Date().toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Chat ${agentId} ${time}`;
}

function slugifyClient(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function deriveInboundIdentitySeed(identity: string) {
  const normalized = identity.trim();
  if (!normalized) {
    return { name: "", email: "" };
  }
  const parts = normalized.split(":").filter(Boolean);
  const provider = parts[0] || "";
  const handle = parts[parts.length - 1] || normalized;
  const providerLabel = provider
    ? provider.charAt(0).toUpperCase() + provider.slice(1).replace(/[^a-z0-9]+/gi, " ")
    : "";
  const name = providerLabel ? `${providerLabel} ${handle}`.trim().slice(0, 80) : normalized;
  const slug = slugifyClient(provider ? `${provider}-${handle}` : normalized);
  return {
    name,
    email: slug ? `${slug}@local` : "",
  };
}

function createInboundUserDraft(
  identity = "",
  defaultTeamIds: string[] = [],
): InboundUserDraft {
  const seed = deriveInboundIdentitySeed(identity);
  return {
    name: seed.name,
    email: seed.email,
    role: "member",
    status: "active",
    teamIds: [...defaultTeamIds],
  };
}

function createAgentEditor(
  workspaceRoot: string,
  channelIds: string[] = [],
  providerIds: string[] = [],
): AgentEditor {
  return {
    agentId: "",
    name: "",
    workspace: workspaceRoot ? `${workspaceRoot}/new-agent` : "",
    ownerId: "",
    teamId: "",
    accessTeamIds: [],
    inboundTransportKeys: [],
    purpose: "",
    channelIds,
    defaultOutputChannelIds: [],
    providerIds,
    skillPolicy: "all",
    skillIds: [],
    tags: "",
    emoji: "",
    avatar: "",
    modelRef: "",
    resumePolicy: "manual",
    dispatchPolicy: "manual",
    thinkingLevel: undefined,
    fastMode: undefined,
    verboseLevel: undefined,
    reasoningLevel: undefined,
  };
}

function splitMultilineList(value: string) {
  return value
    .split(/\r?\n/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function matchExternalIdentityPatternLocal(pattern: string, candidate: string) {
  if (pattern === candidate) {
    return { matched: true, kind: "exact" as const, score: 10_000 + pattern.length };
  }
  if (!pattern.includes("*")) {
    return { matched: false, kind: "pattern" as const, score: 0 };
  }
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`, "i");
  if (!regex.test(candidate)) {
    return { matched: false, kind: "pattern" as const, score: 0 };
  }
  return {
    matched: true,
    kind: "pattern" as const,
    score: 1_000 + pattern.replace(/\*/g, "").length,
  };
}

function createMemoryEngineForm(
  status?: MemoryEngineStatus | null,
  defaultModelRef?: string,
): MemoryEngineForm {
  const config = status?.managedPlugin.config;
  return {
    dbPath: config?.dbPath || status?.defaultDbPath || "",
    summaryModel: config?.summaryModel || defaultModelRef || "",
    expansionModel: config?.expansionModel || defaultModelRef || "",
    freshTailCount:
      config?.freshTailCount !== undefined
        ? String(config.freshTailCount)
        : LOSSLESS_CLAW_RECOMMENDED_PRESET.freshTailCount,
    contextThreshold:
      config?.contextThreshold !== undefined
        ? String(config.contextThreshold)
        : LOSSLESS_CLAW_RECOMMENDED_PRESET.contextThreshold,
    incrementalMaxDepth:
      config?.incrementalMaxDepth !== undefined
        ? String(config.incrementalMaxDepth)
        : LOSSLESS_CLAW_RECOMMENDED_PRESET.incrementalMaxDepth,
    ignoreSessionPatterns:
      config?.ignoreSessionPatterns?.length
        ? config.ignoreSessionPatterns.join("\n")
        : LOSSLESS_CLAW_RECOMMENDED_PRESET.ignoreSessionPatterns,
    statelessSessionPatterns:
      config?.statelessSessionPatterns?.length
        ? config.statelessSessionPatterns.join("\n")
        : LOSSLESS_CLAW_RECOMMENDED_PRESET.statelessSessionPatterns,
    skipStatelessSessions:
      config?.skipStatelessSessions !== undefined
        ? config.skipStatelessSessions
        : LOSSLESS_CLAW_RECOMMENDED_PRESET.skipStatelessSessions,
  };
}

const RESUME_POLICIES = [
  { value: "manual", label: "manual" },
  { value: "prefer-recent", label: "prefer-recent" },
  { value: "sticky", label: "sticky" },
] as const;

const DISPATCH_POLICIES = [
  { value: "manual", label: "manual" },
  { value: "default-channels", label: "default-channels" },
  { value: "broadcast", label: "broadcast" },
] as const;

function isAgentMarkdownFile(name: string, extension: string) {
  return extension === "md" || AGENT_BOOTSTRAP_FILE_RANK.has(name as (typeof AGENT_BOOTSTRAP_FILES)[number]);
}

function rankAgentMarkdownFile(name: string) {
  return AGENT_BOOTSTRAP_FILE_RANK.get(name as (typeof AGENT_BOOTSTRAP_FILES)[number]) ?? 999;
}

function resolveAgentMarkdownGuide(name: string): AgentMarkdownGuide {
  if (name.startsWith("memory/")) {
    return AGENT_MARKDOWN_GUIDES["memory/*.md"];
  }
  return (
    AGENT_MARKDOWN_GUIDES[name] || {
      label: "Markdown libre",
      description: "Fichier libre du workspace agent.",
      emphasis: "Disponible dans le workspace natif OpenClaw.",
    }
  );
}

function describeAgentMarkdownStudioState(
  file: FileRecord | null,
  dirty: boolean,
  loaded: boolean,
  starter: string,
  content?: string,
) {
  if (!file) {
    return { status: "paused", label: "absent" };
  }
  if (dirty) {
    return { status: "warning", label: "a sauver" };
  }
  const normalizedStarter = starter.trim();
  const normalizedContent = (content || "").trim();
  const shouldComplete =
    (loaded && normalizedContent.length > 0 && normalizedContent === normalizedStarter) ||
    (!loaded && file.size > 0 && file.size < 180) ||
    (loaded && normalizedContent.length > 0 && normalizedContent.length < 180);
  if (shouldComplete) {
    return { status: "warning", label: "a cadrer" };
  }
  if (file.type === "memory") {
    return { status: "active", label: "memoire" };
  }
  return { status: "done", label: "workspace" };
}

function buildAgentMarkdownTemplate(
  name: string,
  agentName: string,
  context?: AgentMarkdownTemplateContext,
) {
  function toMarkdownBullets(values: string[] | undefined, fallback: string) {
    const normalized = Array.from(
      new Set((values || []).map((entry) => entry.trim()).filter(Boolean)),
    ).toSorted((left, right) => left.localeCompare(right));
    if (!normalized.length) {
      return `- ${fallback}`;
    }
    return normalized.map((entry) => `- ${entry}`).join("\n");
  }

  const label = agentName || "Agent";
  const purpose = context?.purpose?.trim() || "Definir clairement la mission principale de cet agent.";
  const skillSummary =
    context?.skillIds && context.skillIds.length
      ? context.skillIds.join(", ")
      : "Lister ici les skills et methodes de travail a privilegier.";
  const modelSummary = context?.modelLabel?.trim() || "Definir le modele de reference si besoin.";
  const ownerTeamName = context?.ownerTeamName?.trim() || "A definir";
  switch (name) {
    case "AGENTS.md":
      return `# AGENTS.md

## Mission

- Agent: ${label}
- Role: ${purpose}
- Agent ID: ${context?.agentId || slugifyClient(label) || "agent-id"}
- Owner team: ${ownerTeamName}

## Startup routine

- Read \`ELYTRAS.md\` first to understand Elytras identity, governance, and memory rules.
- Read \`ACCESS.md\` next for this agent's live scope: teams, allowed humans, inbound bots, outputs, and skills.
- Read \`USER.md\` only as the owner/operator baseline. Do not assume it describes the current inbound caller.
- Read \`PROJECT.md\` only when Elytras resolves a live project-memory context for the session.
- Read \`SOUL.md\` and \`TOOLS.md\` before acting.
- In direct owner sessions, load \`MEMORY.md\` and the relevant \`memory/*.md\` files.
- In inbound or multi-user contexts, apply least privilege and do not expose private owner context unless Elytras has clearly resolved the caller and the active team/project scope.

## Priorites

- Protect scope before being helpful.
- Translate vague requests into precise, executable work.
- Keep the agent aligned with its team, allowed humans, and real runtime surface.

## Skills de travail

- ${skillSummary}
- Indiquer ici les skills vraiment centrales pour ce role

## Guardrails

- Never treat a bot handle, username, or display name as sufficient identity proof on its own.
- Never use a skill outside the scope documented in \`ACCESS.md\` or enforced by runtime.
- Never leak owner-only memory, notes, or preferences to unresolved or blocked inbound users.
- Ask for confirmation before destructive actions, privileged writes, or ambiguous external side effects.

## Cadence de travail

- Comment preparer une reponse
- Quels fichiers lire avant d’agir: \`ELYTRAS.md\`, \`ACCESS.md\`, \`SOUL.md\`, \`TOOLS.md\`
- Modele de reference: ${modelSummary}
`;
    case "ELYTRAS.md":
      return `# ELYTRAS.md

## Elytras overlay

- Elytras is the control plane layered on top of OpenClaw.
- It manages users, teams, projects, agent bindings, inbound bots, destinations, providers, skills, and grants.
- This file is generic guidance. \`ACCESS.md\` is the agent-specific snapshot.

## Identity model

- \`USER.md\` describes the owner / operator baseline, not automatically the current caller.
- A current caller may come from dashboard chat, webchat, Telegram, Discord, or another channel.
- In inbound contexts, trust Elytras session metadata and resolved identities over nicknames or channel labels.
- If a runtime block named \`[ELYTRAS TENANCY CONTEXT]\` is present in the system prompt, treat it as the most authoritative caller context.
- If that runtime block says \`Resolution: resolved\`, answer identity, role, team, and project questions directly from it.
- On a freshly started session, make the first real assistant reply a short Elytras runtime summary instead of a generic greeting when the runtime block is present.
- That startup summary should state what Elytras resolved for the current caller: user, role, team, project if any, matched external identity, and active channel when available.
- Do not say you need to re-check, re-resolve, or ask the operator again if the runtime block is already present and resolved.
- If that runtime block says \`Resolution: unresolved\`, \`ambiguous\`, or blocked, say that explicitly and do not pretend the caller is resolved.
- If the caller is unresolved, ambiguous, or blocked, default to least privilege.

## Authorization model

- Access is team-first: teams authorize agents, bots, destinations, and operational scope.
- Direct grants can widen access for a specific user or team.
- Agent-specific scope lives in \`ACCESS.md\`.
- If runtime/session metadata disagrees with local files, prefer runtime/session metadata.

## Memory model

- Team is governance only. Do not use team membership alone as conversational memory.
- Shared memory lives on a user/project scope when Elytras resolves a project for the session.
- If no project is resolved, fall back to agent memory and user-agent memory only.
- If runtime/session metadata disagrees with local files, prefer runtime/session metadata.

## Safe behavior

- Do not reveal private owner memory or hidden workspace context to unresolved or blocked callers.
- Do not assume that being in the right Discord server or Telegram bot thread is enough; the mapped user must still be authorized.
- When access is unclear, answer minimally, avoid sensitive actions, and ask for remapping or operator review.
- Prefer generic help over privileged reads if Elytras has not clearly authorized the current user.

## Memory discipline

- \`MEMORY.md\` and \`memory/*.md\` may contain owner-specific or private context.
- Use them freely in direct owner/operator sessions.
- In shared or inbound contexts, only use the minimum memory needed.
- Use \`PROJECT.md\` and project-scoped memory only when Elytras resolved the active project for the current session.
- Never leak private owner details outside the resolved user/team/project scope.
`;
    case "ACCESS.md":
      return `# ACCESS.md

Generated from Elytras Agent Studio. Refresh this file when ownership, teams, bots, outputs, or skill scope changes.

- This is a static snapshot. If runtime injects \`[ELYTRAS TENANCY CONTEXT]\` for the current session, that runtime block wins.

## Ownership

- Agent ID: ${context?.agentId || slugifyClient(label) || "agent-id"}
- Owner team: ${ownerTeamName}
- Shared teams:
${toMarkdownBullets(context?.accessTeamNames, "No additional team has been granted yet.")}
- Workspace: ${context?.workspace || "n/a"}

## Governance

- Team membership governs who may talk to this agent and which destinations/bots are in scope.
- Project selection does not grant access on its own; it only scopes shared memory for already authorized users.
- If Elytras injects a project into the runtime context, treat it as memory scope, not as proof of authorization.

## Allowed humans

- Authorized users:
${toMarkdownBullets(context?.allowedUserNames, "No mapped user is currently documented for this agent.")}
- Known external identities:
${toMarkdownBullets(context?.allowedExternalIdentities, "No external identity is currently mapped.")}

## Inbound surfaces

- Bound inbound transports:
${toMarkdownBullets(context?.inboundTransportLabels, "No inbound transport is currently bound.")}
- Known routed destinations:
${toMarkdownBullets(context?.inboundDestinationLabels, "No inbound destination is currently detected.")}

## Runtime scope

- Allowed outputs:
${toMarkdownBullets(context?.outputRouteLabels, "No output destination is currently configured.")}
- Providers:
${toMarkdownBullets(context?.providerIds, "cliproxyapi")}
- Model: ${modelSummary}
- Allowed skills:
${toMarkdownBullets(context?.skillIds, "No skill is currently allowed.")}

## Enforcement reminders

- \`USER.md\` is owner context, not proof of who is currently talking.
- If the current session user is not clearly one of the authorized identities above, treat the session as untrusted until Elytras resolves it.
- If Elytras resolves a project, use it to scope memory retrieval and note-taking, not to widen access.
- Do not expose private owner memory or execute privileged skills for blocked or unresolved callers.
`;
    case "MEMORY.md":
      return `# MEMORY.md

## Faits stables

- Informations durables a retenir
- Mission stable: ${purpose}

## Preferences

- Preferences operateur
- Contraintes de ton ou de format

## Decisions

- Decisions long terme qui doivent survivre aux sessions

## Threads ouverts

- Elements encore actifs a suivre
`;
    case "SOUL.md":
      return `# SOUL.md

## Persona

- Voix generale de ${label}
- Niveau de franchise, chaleur, precision

## Style

- Comment structurer les reponses
- Ce qu’il faut eviter

## Energie

- Vitesse, densite, posture
`;
    case "TOOLS.md":
      return `# TOOLS.md

## Outils favoris

- Outils a privilegier pour ce role
- Skills / procedures a garder visibles: ${skillSummary}

## Verifications

- Checks a faire avant de conclure
- Verifier \`ACCESS.md\` avant toute action sensible ou exposee a un user inbound

## Traces utiles

- Logs, fichiers ou surfaces a inspecter en priorite
- Elytras: \`ELYTRAS.md\`, \`ACCESS.md\`, session metadata, inbound RBAC preview
`;
    case "IDENTITY.md":
      return `# IDENTITY.md

## Presentation

- Nom public: ${label}
- Agent ID runtime: ${context?.agentId || slugifyClient(label) || "agent-id"}
- Resume en une phrase

## Contexte

- Ce que cet agent represente
- Son territoire principal

## Reperes

- Tags utiles
- Signaux d’identite a garder stables
`;
    case "USER.md":
      return `# USER.md

## Owner / operator profile

- This file describes the human who owns or operates ${label}.
- It is not automatically the active inbound caller on Telegram / Discord / webchat.

## Attentes

- Niveau d’autonomie attendu
- Niveau de detail prefere

## Conventions

- Formats favoris
- Escalades et confirmations
- Collaboration habits that are safe to apply in direct owner sessions
`;
    case "HEARTBEAT.md":
      return `# HEARTBEAT.md

- Verifier s’il y a des sessions ou pipelines en erreur
- Verifier les signaux operateurs importants
- Rester silencieux si rien ne merite d’etre remonte
`;
    case "BOOTSTRAP.md":
      return `# BOOTSTRAP.md

## Initialisation

- Verifier que les fichiers natifs existent
- Lire \`AGENTS.md\`, \`ELYTRAS.md\`, \`ACCESS.md\`, \`SOUL.md\` et \`TOOLS.md\`
- Confirmer le modele, les bots inbound et les outputs utiles
- Workspace cible: ${context?.workspace || "a definir"}

## Premiers checks

- Si la session est un direct owner/operator, charger \`USER.md\`, \`MEMORY.md\` et les \`memory/*.md\` utiles
- Si la session vient d’un bot ou d’un contexte multi-user, ne pas supposer que \`USER.md\` decrit le caller courant
- Si un bloc runtime \`[ELYTRAS TENANCY CONTEXT]\` est present, le traiter comme la source de verite pour le caller courant
- Si ce bloc est \`resolved\`, repondre directement depuis lui aux questions d’identite, role, team et projet
- Ne jamais dire qu’il faut "reverifier le runtime" si ce bloc est deja present et \`resolved\`
- Ne jamais inventer une verification supplementaire que l’agent ne peut pas faire lui-meme
- Si ce bloc runtime contient un projet Elytras, charger \`PROJECT.md\` puis utiliser la memoire partagee user/project correspondante
- Si aucun projet n’est resolu, rester sur memoire agent + user/agent
- Ouvrir \`memory/notes.md\` si un journal durable est utile
- Refuser toute extrapolation hors du scope Elytras documente

## Premiere reponse de session

- Sur une session fraichement creee, la premiere vraie reponse de l’agent ne doit pas etre un simple "salut" ou une formule vide
- Si le bloc runtime \`[ELYTRAS TENANCY CONTEXT]\` est present, commencer par un resume court de ce qu’Elytras a resolu pour ce tour
- Inclure, quand disponible: resolution, user Elytras, role, team, projet actif, identite externe matchee et channel courant
- Si le runtime est \`resolved\`, presenter ces informations comme deterministes
- Si le runtime est \`unresolved\`, \`ambiguous\` ou bloque, le dire explicitement dans cette premiere reponse
- Apres ce resume, seulement ensuite proposer l’action suivante ou demander quoi faire

## Sortie du bootstrap

- Considerer ce fichier comme secondaire une fois le setup stabilise
- Garder \`ACCESS.md\` aligne avec Agent Studio et Elytras
`;
    case "memory.md":
      return `# memory.md

## Faits

- Informations encore utiles au runtime

## Preferences

- Preferences operateur a conserver

## Decisions

- Decisions durables a garder en vue
`;
    case "memory/notes.md":
      return `# Notes\n\n## Contexte\n\n- Agent: ${label}\n\n## Notes\n\n`;
    case "memory/decisions.md":
      return `# Decisions\n\n## Journal\n\n- ${new Date().toISOString().slice(0, 10)} - Decision a documenter.\n`;
    case "memory/todos.md":
      return `# Todos\n\n- [ ] Premiere action durable pour ${label}\n`;
    default:
      return `# ${name}\n\n`;
  }
}

const RECENT_SESSION_REUSE_WINDOW_MS = 6 * 60 * 60 * 1000;

function MetricCard(props: { label: string; value: string; detail: string }) {
  return (
    <article className="metric-card">
      <span className="eyebrow">{props.label}</span>
      <strong>{props.value}</strong>
      <p>{props.detail}</p>
    </article>
  );
}

function StatusPill(props: { status: string; children?: string }) {
  return (
    <span className={`status-pill ${statusTone(props.status)}`}>
      {props.children || props.status}
    </span>
  );
}

function EmptyState(props: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <strong>{props.title}</strong>
      <p>{props.body}</p>
    </div>
  );
}

function MessageBubble(props: { message: SessionMessage }) {
  return (
    <article className={`message-bubble ${props.message.role}`}>
      <div className="message-meta">
        <strong>{props.message.role}</strong>
        <span>{formatDateTime(props.message.timestamp)}</span>
      </div>
      {props.message.text ? <p className="message-text">{props.message.text}</p> : null}
      {props.message.attachments?.length ? (
        <div className="message-attachment-strip">
          {props.message.attachments.map((attachment, index) => (
            attachment.href ? (
              <a
                key={`${props.message.id}:attachment:${index}`}
                className={`message-attachment-card ${attachment.kind}`}
                href={attachment.href}
                target="_blank"
                rel="noreferrer"
              >
                {attachment.kind === "image" ? (
                  <img
                    src={attachment.dataUrl || attachment.href}
                    alt={attachment.fileName || `attachment-${index + 1}`}
                  />
                ) : attachment.kind === "audio" ? (
                  <audio
                    className="message-attachment-audio"
                    controls
                    preload="none"
                    src={attachment.dataUrl || attachment.href}
                  />
                ) : attachment.kind === "video" ? (
                  <video
                    className="message-attachment-video"
                    controls
                    preload="metadata"
                    src={attachment.dataUrl || attachment.href}
                  />
                ) : (
                  <div className="message-attachment-placeholder">{attachment.kind}</div>
                )}
                <small className="muted-line">
                  {attachment.fileName || `${attachment.kind}-${index + 1}`} ·{" "}
                  {attachment.mimeType || attachment.kind}
                </small>
              </a>
            ) : (
              <div
                key={`${props.message.id}:attachment:${index}`}
                className={`message-attachment-card ${attachment.kind}`}
              >
                <div className="message-attachment-placeholder">{attachment.kind}</div>
                <small className="muted-line">
                  {attachment.fileName || `${attachment.kind}-${index + 1}`} ·{" "}
                  {attachment.source || attachment.mimeType || attachment.kind}
                </small>
              </div>
            )
          ))}
        </div>
      ) : null}
      {!props.message.text && !props.message.attachments?.length ? (
        <p className="message-text">(message vide)</p>
      ) : null}
      {(props.message.provider || props.message.model) && (
        <small className="muted-line">
          {props.message.provider || "provider"} · {props.message.model || "model"}
        </small>
      )}
    </article>
  );
}

function ResourceToolbar(props: { title: string; detail: string; children?: React.ReactNode }) {
  return (
    <header className="resource-toolbar">
      <div className="stack compact">
        <span className="eyebrow">{props.title}</span>
        <h3>{props.detail}</h3>
      </div>
      <div className="button-row">{props.children}</div>
    </header>
  );
}

type EntitySelectorOption = {
  id: string;
  label: string;
  description?: string;
  meta?: string;
  disabled?: boolean;
};

type ExternalIdentityDraft = {
  key: string;
  provider: string;
  scope: string;
  value: string;
};

type UserEditorForm = {
  name: string;
  email: string;
  title: string;
  phone: string;
  location: string;
  notes: string;
  role: DashboardUser["role"];
  status: DashboardUser["status"];
  teamIds: string[];
  externalIdentities: ExternalIdentityDraft[];
};

const EXTERNAL_IDENTITY_SCOPE_OPTIONS = [
  { id: "user", label: "User" },
  { id: "group", label: "Groupe" },
  { id: "channel", label: "Channel" },
  { id: "thread", label: "Thread" },
  { id: "direct", label: "Direct" },
  { id: "session", label: "Session" },
] as const;

const EXTERNAL_IDENTITY_PROVIDER_PRESETS = [
  "discord",
  "elytras",
  "imessage",
  "matrix",
  "msteams",
  "signal",
  "slack",
  "telegram",
  "voice-call",
  "webchat",
  "whatsapp",
  "zalo",
  "zalouser",
] as const;

let externalIdentityDraftCounter = 0;

function nextExternalIdentityDraftKey() {
  externalIdentityDraftCounter += 1;
  return `identity-${externalIdentityDraftCounter}`;
}

function normalizeExternalIdentityProvider(provider: string) {
  return provider.trim().toLowerCase();
}

function normalizeExternalIdentityScope(scope: string) {
  return scope.trim().toLowerCase();
}

function humanizeExternalIdentityProvider(provider: string) {
  switch (provider) {
    case "discord":
      return "Discord";
    case "elytras":
      return "Elytras";
    case "imessage":
      return "iMessage";
    case "matrix":
      return "Matrix";
    case "msteams":
      return "MS Teams";
    case "signal":
      return "Signal";
    case "slack":
      return "Slack";
    case "telegram":
      return "Telegram";
    case "voice-call":
      return "Voice Call";
    case "webchat":
      return "Webchat";
    case "whatsapp":
      return "WhatsApp";
    case "zalo":
      return "Zalo";
    case "zalouser":
      return "Zalo User";
    default:
      return provider
        ? provider
            .split(/[^a-z0-9]+/i)
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(" ")
        : "Channel";
  }
}

function parseExternalIdentityDraft(identity: string) {
  const normalized = identity.trim().toLowerCase();
  if (!normalized) {
    return {
      provider: "telegram",
      scope: "user",
      value: "",
    };
  }
  const parts = normalized.split(":").filter(Boolean);
  const provider = normalizeExternalIdentityProvider(parts[0] || "telegram");
  const scopeCandidate = normalizeExternalIdentityScope(parts[1] || "");
  if (
    parts.length >= 3 &&
    EXTERNAL_IDENTITY_SCOPE_OPTIONS.some((option) => option.id === scopeCandidate)
  ) {
    return {
      provider,
      scope: scopeCandidate,
      value: parts.slice(2).join(":"),
    };
  }
  return {
    provider,
    scope: "user",
    value: parts.slice(1).join(":"),
  };
}

function createExternalIdentityDraft(identity = ""): ExternalIdentityDraft {
  const parsed = parseExternalIdentityDraft(identity);
  return {
    key: nextExternalIdentityDraftKey(),
    ...parsed,
  };
}

function buildExternalIdentityValue(draft: Pick<ExternalIdentityDraft, "provider" | "scope" | "value">) {
  const provider = normalizeExternalIdentityProvider(draft.provider);
  const scope = normalizeExternalIdentityScope(draft.scope);
  const value = draft.value.trim().toLowerCase();
  if (!provider || !scope || !value) {
    return "";
  }
  return `${provider}:${scope}:${value}`;
}

function sanitizeExternalIdentityDrafts(
  drafts: Pick<ExternalIdentityDraft, "provider" | "scope" | "value">[],
) {
  return Array.from(new Set(drafts.map((draft) => buildExternalIdentityValue(draft)).filter(Boolean)))
    .toSorted((left, right) => left.localeCompare(right));
}

function createUserEditorForm(): UserEditorForm {
  return {
    name: "",
    email: "",
    title: "",
    phone: "",
    location: "",
    notes: "",
    role: "member",
    status: "active",
    teamIds: [],
    externalIdentities: [],
  };
}

function describeProjectMemoryMode(memberCount: number) {
  return memberCount > 1 ? "partagee" : "personnelle";
}

function ExternalIdentityEditor(props: {
  drafts: ExternalIdentityDraft[];
  providerOptions: EntitySelectorOption[];
  onChange: (nextDrafts: ExternalIdentityDraft[]) => void;
}) {
  return (
    <div className="selection-panel external-identity-editor">
      <div className="info-row compact">
        <strong>Identites externes</strong>
        <StatusPill status="active">{props.drafts.length} entree(s)</StatusPill>
      </div>
      <small className="muted-line">
        Chaque ligne relie un user Elytras a une identite reelle sur Telegram, Discord, Slack et
        les autres channels inbound.
      </small>
      {props.drafts.length ? (
        <div className="external-identity-list">
          {props.drafts.map((draft) => {
            const preview = buildExternalIdentityValue(draft);
            return (
              <div key={draft.key} className="external-identity-card">
                <div className="external-identity-grid">
                  <label>
                    Channel
                    <select
                      className="select"
                      value={draft.provider}
                      onChange={(event) =>
                        props.onChange(
                          props.drafts.map((entry) =>
                            entry.key === draft.key
                              ? {
                                  ...entry,
                                  provider: event.target.value,
                                }
                              : entry,
                          ),
                        )
                      }
                    >
                      {props.providerOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Type
                    <select
                      className="select"
                      value={draft.scope}
                      onChange={(event) =>
                        props.onChange(
                          props.drafts.map((entry) =>
                            entry.key === draft.key
                              ? {
                                  ...entry,
                                  scope: event.target.value,
                                }
                              : entry,
                          ),
                        )
                      }
                    >
                      {EXTERNAL_IDENTITY_SCOPE_OPTIONS.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field-span-2">
                    Identifiant externe
                    <input
                      className="input"
                      value={draft.value}
                      onChange={(event) =>
                        props.onChange(
                          props.drafts.map((entry) =>
                            entry.key === draft.key
                              ? {
                                  ...entry,
                                  value: event.target.value,
                                }
                              : entry,
                          ),
                        )
                      }
                      placeholder="5309671037, 1061608021572206642, U123456..."
                    />
                  </label>
                </div>
                <div className="external-identity-meta">
                  <span className="selection-chip">{preview || "Entree incomplete"}</span>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      props.onChange(props.drafts.filter((entry) => entry.key !== draft.key))
                    }
                  >
                    Retirer
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title="Aucune identite"
          body="Ajoute au moins une identite si ce user doit parler a un agent via un bot ou etre resolu dans l'inbox."
        />
      )}
      <div className="button-row">
        <button
          type="button"
          className="ghost-button"
          onClick={() => props.onChange([...props.drafts, createExternalIdentityDraft()])}
        >
          Ajouter une identite
        </button>
      </div>
    </div>
  );
}

function toggleSelectedId(currentIds: string[], id: string) {
  return currentIds.includes(id)
    ? currentIds.filter((entry) => entry !== id)
    : [...currentIds, id].toSorted((left, right) => left.localeCompare(right));
}

function EntityMultiSelector(props: {
  title: string;
  detail: string;
  selectedIds: string[];
  options: EntitySelectorOption[];
  onChange: (nextIds: string[]) => void;
  emptyTitle: string;
  emptyBody: string;
  searchPlaceholder?: string;
  lockedIds?: string[];
}) {
  const [query, setQuery] = useState("");
  const selectedIdSet = useMemo(() => new Set(props.selectedIds), [props.selectedIds]);
  const lockedIdSet = useMemo(() => new Set(props.lockedIds || []), [props.lockedIds]);
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return props.options;
    }
    return props.options.filter((option) =>
      [option.label, option.description, option.meta, option.id]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [props.options, query]);
  const selectedOptions = useMemo(
    () => props.options.filter((option) => selectedIdSet.has(option.id)),
    [props.options, selectedIdSet],
  );

  return (
    <div className="selection-panel">
      <div className="info-row compact">
        <strong>{props.title}</strong>
        <StatusPill status="active">{props.selectedIds.length} selectionne(s)</StatusPill>
      </div>
      <small className="muted-line">{props.detail}</small>
      {selectedOptions.length ? (
        <div className="selection-chip-row">
          {selectedOptions.map((option) => (
            <span
              key={option.id}
              className={`selection-chip ${lockedIdSet.has(option.id) ? "locked" : ""}`}
            >
              {option.label}
              {lockedIdSet.has(option.id) ? " · proprio" : ""}
            </span>
          ))}
        </div>
      ) : null}
      {props.options.length > 6 ? (
        <label className="selection-search">
          <span className="muted-line">Recherche</span>
          <input
            className="input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={props.searchPlaceholder || "Rechercher une entree..."}
          />
        </label>
      ) : null}
      {props.options.length ? (
        filteredOptions.length ? (
        <div className="selection-grid compact-selection-grid">
          {filteredOptions.map((option) => {
            const selected = selectedIdSet.has(option.id);
            const locked = lockedIdSet.has(option.id) && selected;
            return (
              <button
                key={option.id}
                type="button"
                className={`runtime-model-card selector-card ${selected ? "selected" : ""} ${
                  locked ? "locked" : ""
                }`}
                onClick={() => {
                  if (locked) {
                    return;
                  }
                  props.onChange(toggleSelectedId(props.selectedIds, option.id));
                }}
                disabled={option.disabled || locked}
              >
                <div className="info-row compact">
                  <strong>{option.label}</strong>
                  <StatusPill status={selected ? "active" : "paused"}>
                    {locked ? "proprio" : selected ? "actif" : "off"}
                  </StatusPill>
                </div>
                {option.description ? (
                  <small className="selector-card-description">{option.description}</small>
                ) : null}
                <small className="muted-line selector-card-meta">
                  {option.meta || option.id}
                </small>
              </button>
            );
          })}
        </div>
        ) : (
          <EmptyState
            title="Aucun resultat"
            body="Aucune entree ne correspond a cette recherche pour le moment."
          />
        )
      ) : (
        <EmptyState title={props.emptyTitle} body={props.emptyBody} />
      )}
    </div>
  );
}

function describeRuntimeModel(model?: RuntimeModelRecord) {
  if (!model) {
    return "Capacites non renseignees.";
  }
  const details = [];
  if (model.contextWindow) {
    details.push(`ctx ${model.contextWindow}`);
  }
  if (model.maxTokens) {
    details.push(`max ${model.maxTokens}`);
  }
  return details.join(" · ") || "Capacites non renseignees.";
}

function RuntimeModelPicker(props: {
  label: string;
  selectedModelRef?: string;
  effectiveModelRef?: string;
  inheritLabel: string;
  inheritDescription: string;
  models: RuntimeModelRecord[];
  allowedProviders?: string[];
  onChange: (modelRef: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const scopedModels = useMemo(() => {
    if (!props.allowedProviders?.length) {
      return props.models;
    }
    return props.models.filter((model) => props.allowedProviders?.includes(model.provider));
  }, [props.allowedProviders, props.models]);

  const selectedModel = useMemo(
    () => props.models.find((model) => model.ref === props.selectedModelRef),
    [props.models, props.selectedModelRef],
  );
  const effectiveModel = useMemo(
    () => props.models.find((model) => model.ref === props.effectiveModelRef),
    [props.effectiveModelRef, props.models],
  );
  const filteredModels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return [...scopedModels]
      .filter((model) => {
        if (!normalizedQuery) {
          return true;
        }
        const haystack = `${model.modelId} ${model.ref}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .toSorted((left, right) => {
        const leftScore =
          (left.ref === props.selectedModelRef ? 4 : 0) +
          (left.ref === props.effectiveModelRef ? 2 : 0);
        const rightScore =
          (right.ref === props.selectedModelRef ? 4 : 0) +
          (right.ref === props.effectiveModelRef ? 2 : 0);
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }
        return left.modelId.localeCompare(right.modelId);
      });
  }, [props.effectiveModelRef, props.selectedModelRef, query, scopedModels]);

  const visibleModels = showAll || query.trim() ? filteredModels : filteredModels.slice(0, 8);
  const hiddenCount = filteredModels.length - visibleModels.length;

  function chooseModel(modelRef: string) {
    props.onChange(modelRef);
  }

  return (
    <div className="runtime-model-picker">
      <div className="runtime-model-summary">
        <article className="callout">
          <strong>{props.label}</strong>
          <p>{selectedModel ? selectedModel.modelId : props.inheritLabel}</p>
          <small className="muted-line">
            {selectedModel ? "Override explicite" : props.inheritDescription}
          </small>
        </article>
        <article className="callout">
          <strong>Modele effectif</strong>
          <p>{effectiveModel ? effectiveModel.modelId : "Aucun modele effectif"}</p>
          <small className="muted-line">{describeRuntimeModel(effectiveModel)}</small>
        </article>
      </div>

      <div className="runtime-model-toolbar">
        <div className="runtime-model-filter-stack">
          <div className="runtime-model-filter-header">
            <strong>Catalogue de modeles</strong>
            <small className="muted-line">Modeles disponibles dans le runtime providers.</small>
          </div>
        </div>
        <label className="runtime-model-search">
          Recherche
          <input
            className="input"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setShowAll(false);
            }}
            placeholder="gpt-5, codex, gemini..."
          />
        </label>
      </div>

      <div className="runtime-model-meta-row">
        <span className="inline-tag">{filteredModels.length} modele(s)</span>
        {selectedModel ? <span className="inline-tag">selection {selectedModel.modelId}</span> : null}
        {effectiveModel && effectiveModel.ref !== selectedModel?.ref ? (
          <span className="inline-tag">effectif {effectiveModel.modelId}</span>
        ) : null}
      </div>

      <div className="runtime-model-list">
        <button
          type="button"
          className={`runtime-model-card inherit ${!props.selectedModelRef ? "selected" : ""}`}
          onClick={() => chooseModel("")}
        >
          <div className="info-row compact">
            <strong>{props.inheritLabel}</strong>
            <StatusPill status={!props.selectedModelRef ? "active" : "paused"}>
              {!props.selectedModelRef ? "inherit" : "available"}
            </StatusPill>
          </div>
          <div className="runtime-model-card-meta">
            <span className="inline-tag">agent/runtime</span>
          </div>
          <small className="muted-line">{props.inheritDescription}</small>
        </button>

        {visibleModels.map((model) => {
          const selected = model.ref === props.selectedModelRef;
          const effective = model.ref === props.effectiveModelRef;
          return (
            <button
              key={model.ref}
              type="button"
              className={`runtime-model-card ${selected ? "selected" : ""} ${effective ? "effective" : ""}`}
              onClick={() => chooseModel(model.ref)}
            >
              <div className="info-row compact">
                <strong>{model.modelId}</strong>
                <StatusPill status={selected ? "active" : effective ? "running" : "paused"}>
                  {selected ? "assigne" : effective ? "effectif" : "choisir"}
                </StatusPill>
              </div>
              <div className="runtime-model-card-meta">
                {typeof model.contextWindow === "number" ? (
                  <span className="inline-tag">ctx {model.contextWindow}</span>
                ) : null}
              </div>
              <small className="muted-line">{describeRuntimeModel(model)}</small>
            </button>
          );
        })}
      </div>

      {filteredModels.length === 0 ? (
        <EmptyState
          title="Aucun modele"
          body="Aucun modele ne correspond a la recherche courante."
        />
      ) : hiddenCount > 0 ? (
        <div className="button-row">
          <button type="button" className="ghost-button" onClick={() => setShowAll(true)}>
            Voir {hiddenCount} modeles de plus
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ExecutionSettingsPicker(props: {
  title: string;
  description: string;
  providerHint?: string | null;
  profile: ExecutionSettings;
  effectiveProfile?: ExecutionSettings;
  effectiveLabel?: string;
  onChange: (patch: ExecutionSettingsPatch) => void;
}) {
  const binaryThinking = isBinaryThinkingProvider(props.providerHint);
  const thinkingValue = resolveThinkLevelDisplay(props.profile.thinkingLevel || "", binaryThinking);
  const effectiveProfile = props.effectiveProfile || props.profile;

  return (
    <div className="execution-settings-picker">
      <div className="execution-settings-summary">
        <article className="callout">
          <strong>{props.title}</strong>
          <p>{formatExecutionSummary(props.profile, props.providerHint)}</p>
          <small className="muted-line">{props.description}</small>
        </article>
        <article className="callout">
          <strong>{props.effectiveLabel || "Valeur effective"}</strong>
          <p>{formatExecutionSummary(effectiveProfile, props.providerHint)}</p>
          <small className="muted-line">
            Runtime {formatRuntimeProviderLabel(props.providerHint)}
          </small>
        </article>
      </div>

      <div className="execution-settings-grid">
        <label>
          Thinking
          <select
            className="select"
            value={thinkingValue}
            onChange={(event) =>
              props.onChange({
                thinkingLevel: resolveThinkLevelPatchValue(event.target.value, binaryThinking),
              })
            }
          >
            {withCurrentOption(resolveThinkLevelOptions(props.providerHint), thinkingValue).map(
              (level) => (
                <option key={level || "inherit"} value={level}>
                  {level || "inherit"}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          Fast
          <select
            className="select"
            value={
              props.profile.fastMode === true ? "on" : props.profile.fastMode === false ? "off" : ""
            }
            onChange={(event) =>
              props.onChange({
                fastMode: event.target.value === "" ? null : event.target.value === "on",
              })
            }
          >
            {FAST_LEVELS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Verbose
          <select
            className="select"
            value={props.profile.verboseLevel || ""}
            onChange={(event) =>
              props.onChange({
                verboseLevel: event.target.value || null,
              })
            }
          >
            {VERBOSE_LEVELS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reasoning
          <select
            className="select"
            value={props.profile.reasoningLevel || ""}
            onChange={(event) =>
              props.onChange({
                reasoningLevel: event.target.value || null,
              })
            }
          >
            {REASONING_LEVELS.map((level) => (
              <option key={level || "inherit"} value={level}>
                {level || "inherit"}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

export function App() {
  const historyRef = useRef<SessionHistoryResponse | null>(null);
  const messagesColumnRef = useRef<HTMLDivElement | null>(null);
  const chatImportInputRef = useRef<HTMLInputElement | null>(null);
  const chatComposerAttachmentsRef = useRef<ChatComposerAttachment[]>([]);
  const pipelineStepRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const pipelineCanvasFlowRef = useRef<HTMLDivElement | null>(null);
  const pipelineCanvasTrackRef = useRef<HTMLDivElement | null>(null);
  const pendingHistoryScrollRef = useRef<{
    mode: "reset" | "preserve";
    top: number;
    nearBottom: boolean;
  } | null>(null);
  const [view, setView] = useState<DashboardViewId>("mission-control");
  const [config, setConfig] = useState<GatewayConfig>({
    baseUrl: readLocalStorage(BASE_URL_STORAGE_KEY, DEFAULT_BASE_URL),
    token: readLocalStorage(TOKEN_STORAGE_KEY, DEFAULT_TOKEN),
  });
  const [selectedDashboardUserId, setSelectedDashboardUserId] = useState(
    readLocalStorage(DASHBOARD_USER_STORAGE_KEY, DASHBOARD_ROOT_USER_ID),
  );
  const [selectedDashboardTeamScopeId, setSelectedDashboardTeamScopeId] = useState(
    readLocalStorage(DASHBOARD_TEAM_SCOPE_STORAGE_KEY, DASHBOARD_ALL_TEAMS_SCOPE_ID),
  );
  const [selectedDashboardProjectId, setSelectedDashboardProjectId] = useState(
    readLocalStorage(DASHBOARD_PROJECT_STORAGE_KEY, DASHBOARD_NO_PROJECT_ID),
  );
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [selectedSessionKey, setSelectedSessionKey] = useState("");
  const [inboundMappingUserId, setInboundMappingUserId] = useState("");
  const [inboundMappingIdentity, setInboundMappingIdentity] = useState("");
  const [inboundNewUserDraft, setInboundNewUserDraft] = useState<InboundUserDraft>(() =>
    createInboundUserDraft(),
  );
  const pendingSelectedSessionKeyRef = useRef("");
  const dashboardContextKeyRef = useRef(
    `${selectedDashboardUserId}:${selectedDashboardTeamScopeId}:${selectedDashboardProjectId}`,
  );
  const [history, setHistory] = useState<SessionHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [chatDraft, setChatDraft] = useState<ChatDraft>(() => createChatDraft());
  const [chatCreating, setChatCreating] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const [sessionAgentFilter, setSessionAgentFilter] = useState("all");
  const [chatWorkspaceMode, setChatWorkspaceMode] = useState<ChatWorkspaceMode>("elytras");
  const [inboxChannelFilter, setInboxChannelFilter] = useState("all");
  const [systemSessionFilter, setSystemSessionFilter] = useState<
    "all" | "heartbeat" | "internal"
  >("all");
  const [agentEditorMode, setAgentEditorMode] = useState<"create" | "edit">("create");
  const [agentEditor, setAgentEditor] = useState<AgentEditor>(() => createAgentEditor(""));
  const [agentSaving, setAgentSaving] = useState(false);
  const [agentDeleteBusy, setAgentDeleteBusy] = useState("");
  const [composer, setComposer] = useState("");
  const [chatComposerAttachments, setChatComposerAttachments] = useState<ChatComposerAttachment[]>([]);
  const [selectedFileKey, setSelectedFileKey] = useState("");
  const [selectedMemoryKey, setSelectedMemoryKey] = useState("");
  const [selectedAgentFileKey, setSelectedAgentFileKey] = useState("");
  const [agentStudioFileFilter, setAgentStudioFileFilter] = useState<"all" | "memory" | "workspace">("all");
  const [agentStudioFileSearch, setAgentStudioFileSearch] = useState("");
  const [agentStudioSection, setAgentStudioSection] = useState<
    "profile" | "runtime" | "memory" | "routing" | "files"
  >("profile");
  const [fileContent, setFileContent] = useState<Record<string, string>>({});
  const [fileBaselineContent, setFileBaselineContent] = useState<Record<string, string>>({});
  const [agentFileSaveBusy, setAgentFileSaveBusy] = useState("");
  const [agentMarkdownDraftName, setAgentMarkdownDraftName] = useState("");
  const [agentMarkdownDraftContent, setAgentMarkdownDraftContent] = useState("");
  const [fileSearch, setFileSearch] = useState("");
  const [fileAgentFilter, setFileAgentFilter] = useState("all");
  const [fileTypeFilter, setFileTypeFilter] = useState("all");
  const [memoryAgentFilter, setMemoryAgentFilter] = useState("all");
  const [pipelineForm, setPipelineForm] = useState<PipelineForm>(() => createPipelineForm());
  const [pipelineEditorMode, setPipelineEditorMode] = useState<PipelineEditorMode>("create");
  const [editingPipelineId, setEditingPipelineId] = useState("");
  const [selectedPipelineStepId, setSelectedPipelineStepId] = useState("");
  const [pipelineCanvasLayout, setPipelineCanvasLayout] = useState<PipelineCanvasLayout>({
    width: 0,
    height: 0,
    edges: [],
  });
  const [pipelineCanvasEditorPosition, setPipelineCanvasEditorPosition] =
    useState<PipelineCanvasEditorPosition | null>(null);
  const [cronForm, setCronForm] = useState({
    name: "",
    description: "",
    ownerId: "",
    targetType: "pipeline" as "pipeline" | "request",
    agentId: "",
    pipelineId: "",
    schedule: "",
    input: "",
  });
  const [channelCatalog, setChannelCatalog] = useState<ChannelCatalogResponse | null>(null);
  const [channelCatalogLoading, setChannelCatalogLoading] = useState(false);
  const [selectedChannelTemplateId, setSelectedChannelTemplateId] = useState("");
  const [selectedChannelAccountId, setSelectedChannelAccountId] = useState("");
  const [channelDraftIsNewAccount, setChannelDraftIsNewAccount] = useState(false);
  const [selectedChannelRouteId, setSelectedChannelRouteId] = useState("");
  const [channelDraft, setChannelDraft] = useState<ChannelSetupDraft>({
    channelId: "",
    accountId: "default",
    name: "",
    values: {},
  });
  const [channelRouteDraft, setChannelRouteDraft] = useState<ChannelRouteDraft>({
    id: "",
    name: "",
    ownerId: "",
    destinationType: "",
    deliveryTarget: "",
  });
  const [channelOperationId, setChannelOperationId] = useState("");
  const [channelOperation, setChannelOperation] = useState<ChannelOperation | null>(null);
  const [channelActionBusy, setChannelActionBusy] = useState("");
  const [pipelineRunBusyId, setPipelineRunBusyId] = useState("");
  const [pipelineRunInput, setPipelineRunInput] = useState("");
  const [pipelineRunSummaries, setPipelineRunSummaries] = useState<PipelineRunSummary[]>([]);
  const [selectedPipelineRunId, setSelectedPipelineRunId] = useState("");
  const [selectedPipelineRunDetail, setSelectedPipelineRunDetail] =
    useState<PipelineRunRecord | null>(null);
  const [pipelineRunHistoryLoading, setPipelineRunHistoryLoading] = useState(false);
  const [pipelineStepHistories, setPipelineStepHistories] = useState<
    Record<string, SessionHistoryResponse>
  >({});
  const [pipelineStepHistoryLoading, setPipelineStepHistoryLoading] = useState<
    Record<string, boolean>
  >({});
  const [pipelineStepHistoryErrors, setPipelineStepHistoryErrors] = useState<
    Record<string, string>
  >({});
  const [pipelineStepModalOpen, setPipelineStepModalOpen] = useState(false);
  const [pipelineNodePositions, setPipelineNodePositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [pipelineViewport, setPipelineViewport] = useState<{
    x: number;
    y: number;
    zoom: number;
  } | null>(null);
  const [userForm, setUserForm] = useState<UserEditorForm>(() => createUserEditorForm());
  const [userEditorMode, setUserEditorMode] = useState<"create" | "edit">("create");
  const [editingUserId, setEditingUserId] = useState("");
  const [teamForm, setTeamForm] = useState({
    name: "",
    color: "#234b40",
    description: "",
    contactEmail: "",
    website: "",
    notes: "",
    memberIds: [] as string[],
    agentIds: [] as string[],
    channelIds: [] as string[],
  });
  const [teamEditorMode, setTeamEditorMode] = useState<"create" | "edit">("create");
  const [editingTeamId, setEditingTeamId] = useState("");
  const [projectForm, setProjectForm] = useState<ProjectEditor>(() => createProjectEditor());
  const [projectEditorMode, setProjectEditorMode] = useState<"create" | "edit">("create");
  const [editingProjectId, setEditingProjectId] = useState("");
  const [grantForm, setGrantForm] = useState({
    subjectType: "user",
    subjectId: "",
    resourceType: "agent",
    resourceId: "*",
    permission: "view",
  });
  const [bridgeForm, setBridgeForm] = useState<ProviderBridgeEditor>(() => createBridgeEditor());
  const [selectedBridgeId, setSelectedBridgeId] = useState("");
  const [bridgeEditor, setBridgeEditor] = useState<ProviderBridgeEditor>(() =>
    createBridgeEditor(),
  );
  const [bridgeEditorDirty, setBridgeEditorDirty] = useState(false);
  const [bridgeAction, setBridgeAction] = useState("");
  const [cliproxyStatus, setCliproxyStatus] = useState<CliproxyStatusResponse | null>(null);
  const [cliproxyLoading, setCliproxyLoading] = useState(false);
  const [cliproxyError, setCliproxyError] = useState("");
  const [cliproxyRefreshToken, setCliproxyRefreshToken] = useState(0);
  const [cliproxyOauthBusy, setCliproxyOauthBusy] = useState("");
  const [cliproxyOauthDraft, setCliproxyOauthDraft] = useState<CliproxyOauthDraft | null>(null);
  const [cliproxySectionBusy, setCliproxySectionBusy] = useState("");
  const [providerWorkspaceTab, setProviderWorkspaceTab] = useState<
    "overview" | "connect" | "accounts" | "models" | "settings"
  >("overview");
  const [providerModelQuery, setProviderModelQuery] = useState("");
  const [providerAccountQuery, setProviderAccountQuery] = useState("");
  const [cliproxyEditors, setCliproxyEditors] = useState({
    geminiApiKeys: "[]",
    codexApiKeys: "[]",
    claudeApiKeys: "[]",
    openAiCompatibility: "[]",
    oauthExcludedModels: "{}",
  });
  const [memoryEngineStatus, setMemoryEngineStatus] = useState<MemoryEngineStatus | null>(null);
  const [memoryEngineLoading, setMemoryEngineLoading] = useState(false);
  const [memoryEngineBusy, setMemoryEngineBusy] = useState("");
  const [memoryEngineRefreshToken, setMemoryEngineRefreshToken] = useState(0);
  const [memoryEngineForm, setMemoryEngineForm] = useState<MemoryEngineForm>(() =>
    createMemoryEngineForm(),
  );
  const [runtimeLinkStatus, setRuntimeLinkStatus] = useState<RuntimeLinkStatus | null>(null);
  const [runtimeLinkDraft, setRuntimeLinkDraft] = useState<RuntimeLinkDraft>(() =>
    createRuntimeLinkDraft(),
  );
  const [runtimeLinkLoading, setRuntimeLinkLoading] = useState(false);
  const [runtimeLinkSaving, setRuntimeLinkSaving] = useState(false);
  const [runtimeLinkError, setRuntimeLinkError] = useState("");
  const [runtimeLinkRefreshToken, setRuntimeLinkRefreshToken] = useState(0);
  const [runtimeEnvStatus, setRuntimeEnvStatus] = useState<RuntimeEnvStatus | null>(null);
  const [runtimeEnvLoading, setRuntimeEnvLoading] = useState(false);
  const [runtimeEnvSaving, setRuntimeEnvSaving] = useState(false);
  const [runtimeEnvRestarting, setRuntimeEnvRestarting] = useState(false);
  const [runtimeEnvError, setRuntimeEnvError] = useState("");
  const [runtimeEnvInlineRows, setRuntimeEnvInlineRows] = useState<RuntimeEnvDraftRow[]>([]);
  const [runtimeEnvVarsRows, setRuntimeEnvVarsRows] = useState<RuntimeEnvDraftRow[]>([]);
  const [runtimeShellEnvEnabled, setRuntimeShellEnvEnabled] = useState(false);
  const [runtimeShellEnvTimeoutMs, setRuntimeShellEnvTimeoutMs] = useState("");
  const [runtimeEnvRefreshToken, setRuntimeEnvRefreshToken] = useState(0);
  const [skillsCatalog, setSkillsCatalog] = useState<SkillsCatalog | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState("");
  const [skillsRefreshToken, setSkillsRefreshToken] = useState(0);
  const [skillManagerScope, setSkillManagerScope] = useState<SkillManagerScope>("shared");
  const [selectedSkillAgentId, setSelectedSkillAgentId] = useState("");
  const [selectedSkillLibraryId, setSelectedSkillLibraryId] = useState("");
  const [selectedSkillEntryKey, setSelectedSkillEntryKey] = useState("");
  const [pendingSkillEntryKey, setPendingSkillEntryKey] = useState("");
  const [skillEditor, setSkillEditor] = useState<SkillEditorState>(() =>
    createEmptySkillEditorState(),
  );
  const [skillEditorBaseline, setSkillEditorBaseline] = useState<SkillEditorBaseline>(() =>
    createEmptySkillEditorBaseline(),
  );
  const [skillContentLoading, setSkillContentLoading] = useState(false);
  const [skillContentError, setSkillContentError] = useState("");
  const [skillEditorBusy, setSkillEditorBusy] = useState("");
  const [skillImportDraft, setSkillImportDraft] = useState<SkillImportDraft>(() =>
    createEmptySkillImportDraft(),
  );
  const [skillImportBusy, setSkillImportBusy] = useState(false);
  const [skillImportError, setSkillImportError] = useState("");
  const [skillImportWarnings, setSkillImportWarnings] = useState<string[]>([]);
  const [agentMemoryInsight, setAgentMemoryInsight] = useState<AgentMemoryInsight | null>(null);
  const [agentMemoryLoading, setAgentMemoryLoading] = useState(false);
  const [agentMemoryError, setAgentMemoryError] = useState("");
  const [agentMemorySearchDraft, setAgentMemorySearchDraft] = useState("");
  const [agentMemorySearchQuery, setAgentMemorySearchQuery] = useState("");
  const [agentMemoryRefreshToken, setAgentMemoryRefreshToken] = useState(0);
  const workspaceRoot = snapshot?.meta.workspaceRoot || "";
  const cliproxyOauthFlowIdRef = useRef(0);
  const skillLibraries = skillsCatalog?.libraries || [];
  const sharedSkillLibraries = useMemo(
    () => skillLibraries.filter((library) => library.scope === "shared"),
    [skillLibraries],
  );
  const agentSkillLibraries = useMemo(
    () => skillLibraries.filter((library) => library.scope === "agent"),
    [skillLibraries],
  );
  const skillAgentOptions = useMemo(() => {
    const seen = new Set<string>();
    return agentSkillLibraries
      .filter((library) => {
        if (!library.agentId || seen.has(library.agentId)) {
          return false;
        }
        seen.add(library.agentId);
        return true;
      })
      .map((library) => ({
        agentId: library.agentId as string,
        label: library.agentLabel || library.agentId || "agent",
      }));
  }, [agentSkillLibraries]);
  const activeSkillLibraries = useMemo(() => {
    if (skillManagerScope === "shared") {
      return sharedSkillLibraries;
    }
    return agentSkillLibraries.filter((library) => library.agentId === selectedSkillAgentId);
  }, [agentSkillLibraries, selectedSkillAgentId, sharedSkillLibraries, skillManagerScope]);
  const activeSkillLibrary = useMemo(
    () =>
      activeSkillLibraries.find((library) => library.id === selectedSkillLibraryId) ||
      activeSkillLibraries[0] ||
      null,
    [activeSkillLibraries, selectedSkillLibraryId],
  );
  const visibleSkills = useMemo(
    () =>
      activeSkillLibrary
        ? (skillsCatalog?.skills || [])
            .filter((entry) => entry.libraryId === activeSkillLibrary.id)
            .toSorted((left, right) => left.name.localeCompare(right.name))
        : [],
    [activeSkillLibrary, skillsCatalog?.skills],
  );
  const selectedSkillEntry = useMemo(
    () => visibleSkills.find((entry) => entry.id === selectedSkillEntryKey) || null,
    [selectedSkillEntryKey, visibleSkills],
  );
  const skillEditorDirty =
    skillEditor.mode !== "idle" &&
    (skillEditor.dirName.trim() !== skillEditorBaseline.dirName ||
      skillEditor.content !== skillEditorBaseline.content);

  function resetSkillEditor() {
    setSkillEditor(createEmptySkillEditorState());
    setSkillEditorBaseline(createEmptySkillEditorBaseline());
    setSkillContentError("");
  }

  function startNewSkillDraft() {
    if (!activeSkillLibrary) {
      return;
    }
    const nextDirName = createSkillDraftDirName(visibleSkills);
    setSelectedSkillEntryKey("");
    setSkillContentError("");
    setSkillEditor({
      mode: "new",
      libraryId: activeSkillLibrary.id,
      previousDirName: "",
      dirName: nextDirName,
      content: buildSkillTemplate(nextDirName),
    });
    setSkillEditorBaseline(createEmptySkillEditorBaseline());
  }

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    setDashboardRequestContext({
      userId: selectedDashboardUserId,
      teamScopeId: selectedDashboardTeamScopeId,
    });
    window.localStorage.setItem(BASE_URL_STORAGE_KEY, config.baseUrl);
    window.localStorage.setItem(TOKEN_STORAGE_KEY, config.token);
    window.localStorage.setItem(DASHBOARD_USER_STORAGE_KEY, selectedDashboardUserId);
    window.localStorage.setItem(DASHBOARD_TEAM_SCOPE_STORAGE_KEY, selectedDashboardTeamScopeId);
    window.localStorage.setItem(DASHBOARD_PROJECT_STORAGE_KEY, selectedDashboardProjectId);
  }, [
    config.baseUrl,
    config.token,
    selectedDashboardProjectId,
    selectedDashboardTeamScopeId,
    selectedDashboardUserId,
  ]);

  useEffect(() => {
    const nextContextKey = `${selectedDashboardUserId}:${selectedDashboardTeamScopeId}:${selectedDashboardProjectId}`;
    if (dashboardContextKeyRef.current === nextContextKey) {
      return;
    }
    dashboardContextKeyRef.current = nextContextKey;

    // Drop actor-scoped selections immediately when the dashboard context changes so we do not
    // momentarily render or refetch resources from the previous user's scope.
    pendingSelectedSessionKeyRef.current = "";
    setSelectedSessionKey("");
    setHistory(null);
    setSelectedFileKey("");
    setSelectedMemoryKey("");
    setSelectedAgentFileKey("");
    setPipelineRunSummaries([]);
    setSelectedPipelineRunId("");
    setSelectedPipelineRunDetail(null);
    setPipelineStepHistories({});
    setPipelineStepHistoryLoading({});
    setPipelineStepHistoryErrors({});
    setChannelOperationId("");
    setChannelOperation(null);
  }, [selectedDashboardProjectId, selectedDashboardTeamScopeId, selectedDashboardUserId]);

  useEffect(() => {
    if (!flash) {
      return;
    }
    const timeout = window.setTimeout(() => setFlash(""), 2500);
    return () => window.clearTimeout(timeout);
  }, [flash]);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    chatComposerAttachmentsRef.current = chatComposerAttachments;
  }, [chatComposerAttachments]);

  useEffect(() => {
    return () => {
      for (const attachment of chatComposerAttachmentsRef.current) {
        revokeChatComposerAttachment(attachment);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadDashboard(silent = false) {
      if (!silent) {
        setLoading(true);
      }
      setError("");
      try {
        const next = await fetchDashboardSnapshot(config);
        if (cancelled) {
          return;
        }
        setSnapshot(next);
      } catch (loadError) {
        if (!cancelled) {
          const message = loadError instanceof Error ? loadError.message : String(loadError);
          if (!(silent && bridgeAction.startsWith("import:")) && view !== "channels") {
            setError(message);
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadDashboard(false);
    const interval = window.setInterval(() => {
      void loadDashboard(true);
    }, 2500);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    bridgeAction,
    config,
    selectedDashboardTeamScopeId,
    selectedDashboardUserId,
    selectedFileKey,
    selectedMemoryKey,
    selectedSessionKey,
  ]);

  useEffect(() => {
    if (view !== "providers") {
      return;
    }
    let cancelled = false;

    async function loadCliproxy(silent = false) {
      if (!silent) {
        setCliproxyLoading(true);
      }
      setCliproxyError("");
      try {
        const next = await fetchCliproxyStatus(config);
        if (cancelled) {
          return;
        }
        setCliproxyStatus(next);
        setCliproxyEditors({
          geminiApiKeys: prettyJson(next.geminiApiKeys),
          codexApiKeys: prettyJson(next.codexApiKeys),
          claudeApiKeys: prettyJson(next.claudeApiKeys),
          openAiCompatibility: prettyJson(next.openAiCompatibility),
          oauthExcludedModels: prettyJson(next.oauthExcludedModels),
        });
      } catch (loadError) {
        if (!cancelled) {
          setCliproxyError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) {
          setCliproxyLoading(false);
        }
      }
    }

    void loadCliproxy(false);
    return () => {
      cancelled = true;
    };
  }, [cliproxyRefreshToken, config, view]);

  useEffect(() => {
    if (view !== "runtime") {
      return;
    }
    let cancelled = false;

    async function loadRuntimeLinkState() {
      setRuntimeLinkLoading(true);
      setRuntimeLinkError("");
      try {
        const next = await fetchRuntimeLink(config);
        if (cancelled) {
          return;
        }
        setRuntimeLinkStatus(next.result);
        setRuntimeLinkDraft(createRuntimeLinkDraft(next.result.values));
      } catch (loadError) {
        if (!cancelled) {
          setRuntimeLinkError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) {
          setRuntimeLinkLoading(false);
        }
      }
    }

    void loadRuntimeLinkState();
    return () => {
      cancelled = true;
    };
  }, [config, runtimeLinkRefreshToken, view]);

  useEffect(() => {
    if (view !== "runtime") {
      return;
    }
    let cancelled = false;

    async function loadRuntimeEnvState() {
      setRuntimeEnvLoading(true);
      setRuntimeEnvError("");
      try {
        const next = await fetchRuntimeEnv(config);
        if (cancelled) {
          return;
        }
        setRuntimeEnvStatus(next.result);
        setRuntimeEnvInlineRows(createRuntimeEnvDraftRows(next.result.openClawEnv.inlineFields));
        setRuntimeEnvVarsRows(createRuntimeEnvDraftRows(next.result.openClawEnv.varsFields));
        setRuntimeShellEnvEnabled(next.result.openClawEnv.shellEnvEnabled);
        setRuntimeShellEnvTimeoutMs(next.result.openClawEnv.shellEnvTimeoutMs);
      } catch (loadError) {
        if (!cancelled) {
          setRuntimeEnvError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) {
          setRuntimeEnvLoading(false);
        }
      }
    }

    void loadRuntimeEnvState();
    return () => {
      cancelled = true;
    };
  }, [config, runtimeEnvRefreshToken, view]);

  const canLoadAdminOnlySkillCatalog =
    selectedDashboardUserId === DASHBOARD_ROOT_USER_ID ||
    (snapshot?.users || []).some(
      (user) =>
        user.id === selectedDashboardUserId &&
        user.role === "admin" &&
        user.status === "active",
    );

  useEffect(() => {
    const shouldLoadSkillsCatalog =
      canLoadAdminOnlySkillCatalog &&
      (view === "skills" || view === "agents" || view === "pipelines" || view === "chat");
    if (!shouldLoadSkillsCatalog) {
      setSkillsLoading(false);
      setSkillsError("");
      setSkillsCatalog(null);
      return;
    }
    let cancelled = false;

    async function loadSkillsState() {
      setSkillsLoading(true);
      setSkillsError("");
      try {
        const next = await fetchSkillsCatalog(config);
        if (cancelled) {
          return;
        }
        setSkillsCatalog(next.result);
      } catch (loadError) {
        if (!cancelled) {
          setSkillsError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) {
          setSkillsLoading(false);
        }
      }
    }

    void loadSkillsState();
    return () => {
      cancelled = true;
    };
  }, [canLoadAdminOnlySkillCatalog, config, skillsRefreshToken, view]);

  useEffect(() => {
    if (skillManagerScope !== "agent") {
      return;
    }
    if (!skillAgentOptions.length) {
      if (selectedSkillAgentId) {
        setSelectedSkillAgentId("");
      }
      return;
    }
    if (!selectedSkillAgentId || !skillAgentOptions.some((entry) => entry.agentId === selectedSkillAgentId)) {
      setSelectedSkillAgentId(skillAgentOptions[0]?.agentId || "");
    }
  }, [selectedSkillAgentId, skillAgentOptions, skillManagerScope]);

  useEffect(() => {
    if (!activeSkillLibraries.length) {
      if (selectedSkillLibraryId) {
        setSelectedSkillLibraryId("");
      }
      return;
    }
    if (!activeSkillLibraries.some((library) => library.id === selectedSkillLibraryId)) {
      const libraryWithSkills = activeSkillLibraries.find((library) =>
        (skillsCatalog?.skills || []).some((entry) => entry.libraryId === library.id),
      );
      setSelectedSkillLibraryId(libraryWithSkills?.id || activeSkillLibraries[0]?.id || "");
    }
  }, [activeSkillLibraries, selectedSkillLibraryId, skillsCatalog?.skills]);

  useEffect(() => {
    if (!activeSkillLibrary) {
      resetSkillEditor();
      if (selectedSkillEntryKey) {
        setSelectedSkillEntryKey("");
      }
      return;
    }
    if (skillEditor.libraryId && skillEditor.libraryId !== activeSkillLibrary.id) {
      resetSkillEditor();
    }
  }, [activeSkillLibrary, skillEditor.libraryId, selectedSkillEntryKey]);

  useEffect(() => {
    if (!activeSkillLibrary) {
      return;
    }
    if (pendingSkillEntryKey) {
      return;
    }
    if (skillEditor.mode === "new" && skillEditor.libraryId === activeSkillLibrary.id) {
      return;
    }
    if (!visibleSkills.length) {
      if (selectedSkillEntryKey) {
        setSelectedSkillEntryKey("");
      }
      return;
    }
    if (!visibleSkills.some((entry) => entry.id === selectedSkillEntryKey)) {
      setSelectedSkillEntryKey(visibleSkills[0]?.id || "");
    }
  }, [
    activeSkillLibrary,
    pendingSkillEntryKey,
    selectedSkillEntryKey,
    skillEditor.libraryId,
    skillEditor.mode,
    visibleSkills,
  ]);

  useEffect(() => {
    if (!pendingSkillEntryKey) {
      return;
    }
    if (!visibleSkills.some((entry) => entry.id === pendingSkillEntryKey)) {
      return;
    }
    setSelectedSkillEntryKey(pendingSkillEntryKey);
    setPendingSkillEntryKey("");
  }, [pendingSkillEntryKey, visibleSkills]);

  useEffect(() => {
    if (view !== "skills" || !selectedSkillEntry) {
      return;
    }
    if (
      skillEditor.mode === "new" &&
      skillEditor.libraryId === selectedSkillEntry.libraryId &&
      !selectedSkillEntryKey
    ) {
      return;
    }
    let cancelled = false;

    async function loadSelectedSkillContent() {
      setSkillContentLoading(true);
      setSkillContentError("");
      try {
        const next = await fetchSkillContent(config, {
          libraryId: selectedSkillEntry.libraryId,
          dirName: selectedSkillEntry.dirName,
        });
        if (cancelled) {
          return;
        }
        setSkillEditor({
          mode: "existing",
          libraryId: next.result.skill.libraryId,
          previousDirName: next.result.skill.dirName,
          dirName: next.result.skill.dirName,
          content: next.result.content,
        });
        setSkillEditorBaseline({
          dirName: next.result.skill.dirName,
          content: next.result.content,
        });
      } catch (loadError) {
        if (!cancelled) {
          setSkillContentError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) {
          setSkillContentLoading(false);
        }
      }
    }

    void loadSelectedSkillContent();
    return () => {
      cancelled = true;
    };
  }, [
    config,
    selectedSkillEntry?.dirName,
    selectedSkillEntry?.libraryId,
    skillEditor.libraryId,
    skillEditor.mode,
    view,
  ]);

  useEffect(() => {
    const shouldLoadMemoryEngine = view === "memory" || view === "agents";
    if (!shouldLoadMemoryEngine) {
      return;
    }
    let cancelled = false;

    async function loadMemoryEngine(silent = false) {
      if (!silent) {
        setMemoryEngineLoading(true);
      }
      try {
        const next = await fetchMemoryEngineStatus(config);
        if (cancelled) {
          return;
        }
        setMemoryEngineStatus(next);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) {
          setMemoryEngineLoading(false);
        }
      }
    }

    void loadMemoryEngine(false);
    return () => {
      cancelled = true;
    };
  }, [agentStudioSection, config, memoryEngineRefreshToken, view]);

  useEffect(() => {
    if (agentEditorMode !== "edit") {
      setAgentMemoryInsight(null);
      setAgentMemoryError("");
      setAgentMemorySearchDraft("");
      setAgentMemorySearchQuery("");
      return;
    }
    setAgentMemoryInsight(null);
    setAgentMemoryError("");
    setAgentMemorySearchDraft("");
    setAgentMemorySearchQuery("");
  }, [agentEditor.agentId, agentEditorMode]);

  useEffect(() => {
    const shouldLoadAgentMemory =
      view === "agents" &&
      agentStudioSection === "memory" &&
      agentEditorMode === "edit" &&
      Boolean(agentEditor.agentId);
    if (!shouldLoadAgentMemory) {
      return;
    }
    let cancelled = false;

    async function loadAgentMemoryInsightData() {
      setAgentMemoryLoading(true);
      setAgentMemoryError("");
      try {
        const response = await fetchAgentMemoryInsight(
          config,
          agentEditor.agentId,
          agentMemorySearchQuery,
        );
        if (!cancelled) {
          setAgentMemoryInsight(response.result);
        }
      } catch (loadError) {
        if (!cancelled) {
          setAgentMemoryError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) {
          setAgentMemoryLoading(false);
        }
      }
    }

    void loadAgentMemoryInsightData();
    return () => {
      cancelled = true;
    };
  }, [
    agentEditor.agentId,
    agentEditorMode,
    agentMemoryRefreshToken,
    agentMemorySearchQuery,
    agentStudioSection,
    config,
    view,
  ]);

  useEffect(() => {
    if (!selectedSessionKey) {
      return;
    }
    let cancelled = false;

    async function loadHistory(silent = false) {
      const currentHistory = historyRef.current;
      const isSessionSwitch = currentHistory?.sessionKey !== selectedSessionKey;
      const shouldShowBlockingLoading = !silent && (isSessionSwitch || !currentHistory);
      if (shouldShowBlockingLoading) {
        setHistoryLoading(true);
      }

      const container = messagesColumnRef.current;
      if (container && !isSessionSwitch) {
        const distanceFromBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight;
        pendingHistoryScrollRef.current = {
          mode: "preserve",
          top: container.scrollTop,
          nearBottom: distanceFromBottom < 48,
        };
      } else {
        pendingHistoryScrollRef.current = {
          mode: "reset",
          top: 0,
          nearBottom: true,
        };
      }

      try {
        const next = await fetchSessionHistory(config, selectedSessionKey, 120);
        if (!cancelled) {
          setHistory(next);
        }
      } catch (loadError) {
        if (!cancelled) {
          if (loadError instanceof ApiError && loadError.status === 403) {
            setSelectedSessionKey("");
            setHistory(null);
          }
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled && shouldShowBlockingLoading) {
          setHistoryLoading(false);
        }
      }
    }

    void loadHistory(false);
    if (view !== "chat") {
      return () => {
        cancelled = true;
      };
    }

    const interval = window.setInterval(() => {
      void loadHistory(true);
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [config, selectedSessionKey, view]);

  useEffect(() => {
    const [agentId, name] = selectedFileKey.split(":");
    const fileAlreadyLoaded =
      Boolean(selectedFileKey) &&
      Object.prototype.hasOwnProperty.call(fileContent, selectedFileKey);
    if (!agentId || !name || fileAlreadyLoaded) {
      return;
    }
    let cancelled = false;

    async function loadFile() {
      try {
        const next = await fetchFileContent(config, agentId, name);
        const content = resolveFileContentResponseContent(next);
        if (!cancelled) {
          setFileContent((current) => ({ ...current, [selectedFileKey]: content }));
          setFileBaselineContent((current) => ({ ...current, [selectedFileKey]: content }));
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    }

    void loadFile();
    return () => {
      cancelled = true;
    };
  }, [config, fileContent, selectedFileKey]);

  useEffect(() => {
    const [agentId, name] = selectedMemoryKey.split(":");
    const memoryAlreadyLoaded =
      Boolean(selectedMemoryKey) &&
      Object.prototype.hasOwnProperty.call(fileContent, selectedMemoryKey);
    if (!agentId || !name || memoryAlreadyLoaded) {
      return;
    }
    let cancelled = false;

    async function loadMemory() {
      try {
        const next = await fetchFileContent(config, agentId, name);
        const content = resolveFileContentResponseContent(next);
        if (!cancelled) {
          setFileContent((current) => ({ ...current, [selectedMemoryKey]: content }));
          setFileBaselineContent((current) => ({ ...current, [selectedMemoryKey]: content }));
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    }

    void loadMemory();
    return () => {
      cancelled = true;
    };
  }, [config, fileContent, selectedMemoryKey]);

  useEffect(() => {
    const [agentId, name] = selectedAgentFileKey.split(":");
    const agentFileAlreadyLoaded =
      Boolean(selectedAgentFileKey) &&
      Object.prototype.hasOwnProperty.call(fileContent, selectedAgentFileKey);
    if (!agentId || !name || agentFileAlreadyLoaded) {
      return;
    }
    let cancelled = false;

    async function loadAgentFile() {
      try {
        const next = await fetchFileContent(config, agentId, name);
        const content = resolveFileContentResponseContent(next);
        if (!cancelled) {
          setFileContent((current) => ({ ...current, [selectedAgentFileKey]: content }));
          setFileBaselineContent((current) => ({ ...current, [selectedAgentFileKey]: content }));
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    }

    void loadAgentFile();
    return () => {
      cancelled = true;
    };
  }, [config, fileContent, selectedAgentFileKey]);

  useEffect(() => {
    const container = messagesColumnRef.current;
    const pendingScroll = pendingHistoryScrollRef.current;
    if (!container || !pendingScroll) {
      return;
    }
    if (pendingScroll.mode === "reset" || pendingScroll.nearBottom) {
      container.scrollTop = container.scrollHeight;
    } else {
      container.scrollTop = pendingScroll.top;
    }
    pendingHistoryScrollRef.current = null;
  }, [history?.sessionKey, history?.messages.length]);

  useEffect(() => {
    const providerBridges = snapshot?.providerBridges || [];
    if (!providerBridges.length) {
      if (selectedBridgeId) {
        setSelectedBridgeId("");
      }
      if (!bridgeEditorDirty) {
        setBridgeEditor(createBridgeEditor());
      }
      return;
    }

    const active =
      providerBridges.find((bridge) => bridge.id === selectedBridgeId) || providerBridges[0];

    if (active.id !== selectedBridgeId) {
      setSelectedBridgeId(active.id);
    }
    if (!bridgeEditorDirty) {
      setBridgeEditor(bridgeToEditor(active));
    }
  }, [bridgeEditorDirty, selectedBridgeId, snapshot?.providerBridges]);

  useEffect(() => {
    if (!workspaceRoot) {
      return;
    }
    if (agentEditorMode !== "create") {
      return;
    }
    if (agentEditor.workspace) {
      return;
    }
    const discoveredChannelIds = (snapshot?.channels || [])
      .filter((channel) => isManagedOutputRouteChannel(channel))
      .map((channel) => channel.id);
    const discoveredProviderIds = [CLIPROXY_PROVIDER_ID];
    setAgentEditor((current) => ({
      ...createAgentEditor(
        workspaceRoot,
        current.channelIds.length ? current.channelIds : discoveredChannelIds,
        current.providerIds.length ? current.providerIds : discoveredProviderIds,
      ),
      defaultOutputChannelIds: current.defaultOutputChannelIds.length
        ? current.defaultOutputChannelIds
        : discoveredChannelIds,
    }));
  }, [
    agentEditor.workspace,
    agentEditorMode,
    snapshot?.channels,
    workspaceRoot,
  ]);

  useEffect(() => {
    if (!chatDraft.modelRef) {
      return;
    }
    const cliproxyRuntimeModels = (snapshot?.runtimeModels || []).filter(
      (model) => normalizeProviderId(model.provider) === CLIPROXY_PROVIDER_ID,
    );
    const effectiveRuntimeProviderIds = [CLIPROXY_PROVIDER_ID];
    const providerId = modelProviderFromRef(chatDraft.modelRef);
    const fallbackAgentId =
      chatDraft.agentId ||
      (snapshot?.agents && Array.isArray(snapshot.agents) && snapshot.agents[0]?.id
        ? String(snapshot.agents[0].id)
        : "main");
    const allowedProviderIds = getAgentBinding(fallbackAgentId)?.providerIds || [];
    const effectiveProviderIds = allowedProviderIds.length
      ? allowedProviderIds.filter((entry) =>
          cliproxyRuntimeModels.some((model) => model.provider === entry),
        )
      : effectiveRuntimeProviderIds;
    if (providerId && effectiveProviderIds.includes(providerId)) {
      return;
    }
    setChatDraft((current) => ({ ...current, modelRef: "" }));
  }, [
    chatDraft.agentId,
    chatDraft.modelRef,
    snapshot?.agentBindings,
    snapshot?.agents,
    snapshot?.runtimeModels,
  ]);

  useEffect(() => {
    if (!pipelineForm.steps.length) {
      if (selectedPipelineStepId) {
        setSelectedPipelineStepId("");
      }
      return;
    }
    if (pipelineForm.steps.some((step) => step.id === selectedPipelineStepId)) {
      return;
    }
    setSelectedPipelineStepId(pipelineForm.steps[0].id);
  }, [pipelineForm.steps, selectedPipelineStepId]);

  useEffect(() => {
    setPipelineNodePositions((current) => {
      const autoPositions = buildPipelineAutoLayoutPositions(pipelineForm.steps);
      const next: Record<string, { x: number; y: number }> = {};
      pipelineForm.steps.forEach((step, index) => {
        next[step.id] =
          current[step.id] || autoPositions[step.id] || defaultPipelineNodePosition(index);
      });
      return next;
    });
  }, [pipelineForm.steps]);

  useEffect(() => {
    if (view !== "pipelines") {
      return;
    }

    const flow = pipelineCanvasFlowRef.current;
    const track = pipelineCanvasTrackRef.current;
    if (!flow || !track) {
      setPipelineCanvasLayout({ width: 0, height: 0, edges: [] });
      setPipelineCanvasEditorPosition(null);
      return;
    }

    const recompute = () => {
      const flowRect = flow.getBoundingClientRect();
      const edges: PipelineCanvasEdge[] = [];
      for (const step of pipelineForm.steps) {
        const sourceNode = pipelineStepRefs.current[step.id];
        if (!sourceNode) {
          continue;
        }
        const sourceRect = sourceNode.getBoundingClientRect();
        const descriptors = getDraftStepConnectionDescriptors(step, pipelineForm.steps).filter(
          (descriptor) => descriptor.kind === "target" && descriptor.targetStepId,
        );
        for (const descriptor of descriptors) {
          const targetNode = pipelineStepRefs.current[descriptor.targetStepId || ""];
          if (!targetNode) {
            continue;
          }
          const targetRect = targetNode.getBoundingClientRect();
          edges.push({
            key: `${step.id}:${descriptor.targetStepId}:${descriptor.branchLabel}`,
            branchLabel: descriptor.branchLabel,
            routingMode: step.routingMode,
            startX: sourceRect.right - flowRect.left,
            startY: sourceRect.top - flowRect.top + sourceRect.height / 2,
            endX: targetRect.left - flowRect.left,
            endY: targetRect.top - flowRect.top + targetRect.height / 2,
          });
        }
      }
      setPipelineCanvasLayout({
        width: Math.max(track.scrollWidth, flow.clientWidth),
        height: Math.max(track.scrollHeight, flow.clientHeight),
        edges,
      });

      const selectedNode = selectedPipelineStepId
        ? pipelineStepRefs.current[selectedPipelineStepId]
        : null;
      if (!selectedNode) {
        setPipelineCanvasEditorPosition(null);
        return;
      }

      const nodeRect = selectedNode.getBoundingClientRect();
      const nodeLeft = nodeRect.left - flowRect.left + flow.scrollLeft;
      const nodeTop = nodeRect.top - flowRect.top + flow.scrollTop;
      const editorWidth = 420;
      const margin = 18;
      const preferredRightLeft = nodeLeft + nodeRect.width + margin;
      const availableRight = flow.scrollLeft + flow.clientWidth - preferredRightLeft - margin;
      const placeBelow = availableRight < 320;
      let left = placeBelow ? nodeLeft : preferredRightLeft;
      let top = placeBelow ? nodeTop + nodeRect.height + margin : nodeTop;
      const maxWidth = Math.max(300, Math.min(editorWidth, flow.clientWidth - margin * 2));
      const maxLeft = flow.scrollLeft + flow.clientWidth - maxWidth - margin;
      if (left > maxLeft) {
        left = Math.max(margin, maxLeft);
      }
      const maxTop = flow.scrollTop + flow.clientHeight - 160;
      if (top > maxTop) {
        top = Math.max(margin, nodeTop - 40);
      }
      setPipelineCanvasEditorPosition({
        left,
        top,
        width: maxWidth,
      });
    };

    recompute();

    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => recompute()) : null;
    if (observer) {
      observer.observe(flow);
      observer.observe(track);
      for (const step of pipelineForm.steps) {
        const node = pipelineStepRefs.current[step.id];
        if (node) {
          observer.observe(node);
        }
      }
    }

    window.addEventListener("resize", recompute);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, [pipelineForm.steps, selectedPipelineStepId, view]);

  useEffect(() => {
    let cancelled = false;

    async function loadChannelCatalog(silent = false) {
      if (!silent) {
        setChannelCatalogLoading(true);
      }
      try {
        const next = await fetchChannelCatalog(config);
        if (!cancelled) {
          setChannelCatalog(next);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled && !silent) {
          setChannelCatalogLoading(false);
        }
      }
    }

    void loadChannelCatalog(false);
    const interval = window.setInterval(() => {
      void loadChannelCatalog(true);
    }, view === "channels" ? 4000 : 8000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [config, view]);

  useEffect(() => {
    const activeDashboardUser =
      selectedDashboardUserId === DASHBOARD_ROOT_USER_ID
        ? null
        : (snapshot?.users || []).find((user) => user.id === selectedDashboardUserId) || null;
    const canManageAdminViews =
      !activeDashboardUser ||
      (activeDashboardUser.role === "admin" && activeDashboardUser.status === "active");
    const availableEntries = canManageAdminViews
      ? channelCatalog?.entries || []
      : (channelCatalog?.entries || []).filter((entry) => getChannelRouteConfig(entry).enabled);
    const firstEntry = availableEntries[0];
    if (!firstEntry) {
      return;
    }
    const currentEntry = availableEntries.find(
      (entry) => entry.id === selectedChannelTemplateId,
    );
    if (currentEntry) {
      return;
    }
    const ownerId = activeDashboardUser?.id || snapshot?.users[0]?.id || "";
    const accountId =
      firstEntry.template.accountScope === "top-level-only"
        ? "default"
        : firstEntry.defaultAccountId || firstEntry.accounts[0]?.accountId || "default";
    setSelectedChannelTemplateId(firstEntry.id);
    setSelectedChannelAccountId(accountId);
    setSelectedChannelRouteId("");
    setChannelDraft(buildChannelSetupDraft(firstEntry, accountId));
    setChannelRouteDraft(createChannelRouteDraft(ownerId, firstEntry));
  }, [
    channelCatalog?.entries,
    selectedChannelTemplateId,
    selectedDashboardUserId,
    snapshot?.channels,
    snapshot?.users,
  ]);

  useEffect(() => {
    if (!channelOperationId) {
      setChannelOperation(null);
      return;
    }
    let cancelled = false;

    async function loadOperation() {
      try {
        const next = await fetchChannelOperation(config, channelOperationId);
        if (!cancelled) {
          setChannelOperation(next.operation);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    }

    void loadOperation();
    const interval = window.setInterval(() => {
      void loadOperation();
    }, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [channelOperationId, config]);

  useEffect(() => {
    if (view !== "pipelines") {
      return;
    }
    let cancelled = false;
    setPipelineRunHistoryLoading(true);
    fetchPipelineRuns(config, {
      pipelineId: editingPipelineId || undefined,
      limit: editingPipelineId ? 80 : 40,
    })
      .then((response) => {
        if (cancelled) {
          return;
        }
        setPipelineRunSummaries(response.runs);
        const stillVisible = response.runs.some((run) => run.id === selectedPipelineRunId);
        const nextSelectedRunId = stillVisible
          ? selectedPipelineRunId
          : response.runs[0]?.id || "";
        setSelectedPipelineRunId(nextSelectedRunId);
      })
      .catch((pipelineRunError) => {
        if (!cancelled) {
          setError(pipelineRunError instanceof Error ? pipelineRunError.message : String(pipelineRunError));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPipelineRunHistoryLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [config, editingPipelineId, selectedDashboardTeamScopeId, selectedDashboardUserId, view]);

  useEffect(() => {
    if (view !== "pipelines" || !selectedPipelineRunId) {
      setSelectedPipelineRunDetail(null);
      return;
    }
    if (!pipelineRunSummaries.some((run) => run.id === selectedPipelineRunId)) {
      setSelectedPipelineRunDetail(null);
      return;
    }
    let cancelled = false;
    fetchPipelineRunDetail(config, selectedPipelineRunId)
      .then((response) => {
        if (!cancelled) {
          setSelectedPipelineRunDetail(response.run);
        }
      })
      .catch((pipelineRunError) => {
        if (!cancelled) {
          setError(pipelineRunError instanceof Error ? pipelineRunError.message : String(pipelineRunError));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [config, selectedPipelineRunId, pipelineRunSummaries, view]);

  useEffect(() => {
    if (view !== "pipelines" || !selectedPipelineRunDetail) {
      setPipelineStepHistories({});
      setPipelineStepHistoryLoading({});
      setPipelineStepHistoryErrors({});
      return;
    }

    const sessionKeys = selectedPipelineRunDetail.steps
      .map((step) => step.sessionKey)
      .filter((value): value is string => Boolean(value));
    if (!sessionKeys.length) {
      setPipelineStepHistories({});
      setPipelineStepHistoryLoading({});
      setPipelineStepHistoryErrors({});
      return;
    }

    let cancelled = false;
    const loadingState = Object.fromEntries(sessionKeys.map((key) => [key, true])) as Record<
      string,
      boolean
    >;
    setPipelineStepHistories({});
    setPipelineStepHistoryLoading(loadingState);
    setPipelineStepHistoryErrors({});

    void Promise.all(
      sessionKeys.map(async (sessionKey) => {
        try {
          const history = await fetchSessionHistory(config, sessionKey, 120);
          if (!cancelled) {
            setPipelineStepHistories((current) => ({
              ...current,
              [sessionKey]: history,
            }));
          }
        } catch (historyError) {
          if (!cancelled) {
            setPipelineStepHistoryErrors((current) => ({
              ...current,
              [sessionKey]:
                historyError instanceof Error ? historyError.message : String(historyError),
            }));
          }
        } finally {
          if (!cancelled) {
            setPipelineStepHistoryLoading((current) => ({
              ...current,
              [sessionKey]: false,
            }));
          }
        }
      }),
    );

    return () => {
      cancelled = true;
    };
  }, [config, selectedPipelineRunDetail, view]);

  async function refresh() {
    setLoading(true);
    try {
      const next = await fetchDashboardSnapshot(config);
      setSnapshot(next);
      setFlash("Snapshot rafraichi.");
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveRuntimeLink(restartAfterSave = false) {
    if (!ensureAdminAccess("La configuration runtime est reservee a l'admin Elytras.")) {
      return;
    }
    setRuntimeLinkSaving(true);
    setRuntimeLinkError("");
    try {
      const saved = await saveRuntimeLink(config, runtimeLinkDraft);
      setRuntimeLinkStatus(saved.result);
      setRuntimeLinkDraft(createRuntimeLinkDraft(saved.result.values));
      setConfig((current) => ({
        ...current,
        baseUrl: saved.result.values.gatewayUrl,
        token: saved.result.values.dashboardGatewayToken,
      }));
      setRuntimeEnvRefreshToken((current) => current + 1);
      if (restartAfterSave) {
        setRuntimeEnvRestarting(true);
        const restarted = await restartRuntimeBackend({
          ...config,
          baseUrl: saved.result.values.gatewayUrl,
          token: saved.result.values.dashboardGatewayToken,
        });
        setConfig((current) => ({
          ...current,
          baseUrl: restarted.result.gatewayUrl,
          token: restarted.result.gatewayToken,
        }));
        await refresh();
        setRuntimeLinkRefreshToken((current) => current + 1);
        setFlash(
          restarted.result.healthy
            ? "Liaison runtime sauvegardee et backend relance."
            : "Liaison runtime sauvegardee; backend en cours de redemarrage.",
        );
      } else {
        setRuntimeLinkRefreshToken((current) => current + 1);
        setFlash("Liaison Elytras -> OpenClaw sauvegardee.");
      }
    } catch (saveError) {
      setRuntimeLinkError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setRuntimeLinkSaving(false);
      setRuntimeEnvRestarting(false);
    }
  }

  async function handleSaveRuntimeEnv(restartAfterSave = false) {
    if (!ensureAdminAccess("Les variables runtime sont reservees a l'admin Elytras.")) {
      return;
    }
    setRuntimeEnvSaving(true);
    setRuntimeEnvError("");
    try {
      const saved = await saveRuntimeEnv(config, {
        inlineFields: serializeRuntimeEnvDraftRows(runtimeEnvInlineRows),
        varsFields: serializeRuntimeEnvDraftRows(runtimeEnvVarsRows),
        shellEnvEnabled: runtimeShellEnvEnabled,
        shellEnvTimeoutMs: runtimeShellEnvTimeoutMs.trim(),
      });
      setRuntimeEnvStatus(saved.result);
      setRuntimeEnvInlineRows(createRuntimeEnvDraftRows(saved.result.openClawEnv.inlineFields));
      setRuntimeEnvVarsRows(createRuntimeEnvDraftRows(saved.result.openClawEnv.varsFields));
      setRuntimeShellEnvEnabled(saved.result.openClawEnv.shellEnvEnabled);
      setRuntimeShellEnvTimeoutMs(saved.result.openClawEnv.shellEnvTimeoutMs);
      setConfig((current) => ({
        ...current,
        baseUrl: saved.result.gatewayUrl,
        token: saved.result.gatewayToken,
      }));
      if (restartAfterSave) {
        setRuntimeEnvRestarting(true);
        const restarted = await restartRuntimeBackend({
          ...config,
          baseUrl: saved.result.gatewayUrl,
          token: saved.result.gatewayToken,
        });
        setConfig((current) => ({
          ...current,
          baseUrl: restarted.result.gatewayUrl,
          token: restarted.result.gatewayToken,
        }));
        await refresh();
        setRuntimeEnvRefreshToken((current) => current + 1);
        setFlash(
          restarted.result.healthy
            ? "Variables runtime sauvegardees et backend relance."
            : "Variables runtime sauvegardees; backend en cours de redemarrage.",
        );
      } else {
        setRuntimeEnvRefreshToken((current) => current + 1);
        setFlash("Variables runtime sauvegardees.");
      }
    } catch (saveError) {
      setRuntimeEnvError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setRuntimeEnvSaving(false);
      setRuntimeEnvRestarting(false);
    }
  }

  async function handleRestartRuntimeBackendOnly() {
    if (!ensureAdminAccess("Le restart du backend est reserve a l'admin Elytras.")) {
      return;
    }
    const runtimeConfig = runtimeEnvStatus
      ? {
          baseUrl: runtimeEnvStatus.gatewayUrl,
          token: runtimeEnvStatus.gatewayToken,
        }
      : config;
    setRuntimeEnvRestarting(true);
    setRuntimeEnvError("");
    try {
      const restarted = await restartRuntimeBackend(runtimeConfig);
      setConfig((current) => ({
        ...current,
        baseUrl: restarted.result.gatewayUrl,
        token: restarted.result.gatewayToken,
      }));
      setRuntimeEnvRefreshToken((current) => current + 1);
      await refresh();
      setFlash(
        restarted.result.healthy
          ? "Backend local relance."
          : "Restart lance; le backend n’a pas encore repondu.",
      );
    } catch (restartError) {
      setRuntimeEnvError(restartError instanceof Error ? restartError.message : String(restartError));
    } finally {
      setRuntimeEnvRestarting(false);
    }
  }

  async function handleSaveSkill() {
    if (!ensureAdminAccess("La gestion des skills est reservee a l'admin Elytras.")) {
      return;
    }
    if (!activeSkillLibrary) {
      return;
    }
    setSkillEditorBusy("save");
    setSkillContentError("");
    try {
      const saved = await saveSkillContent(config, {
        libraryId: activeSkillLibrary.id,
        dirName: skillEditor.dirName.trim(),
        previousDirName: skillEditor.previousDirName || undefined,
        content: skillEditor.content,
      });
      setSkillEditor({
        mode: "existing",
        libraryId: saved.result.skill.libraryId,
        previousDirName: saved.result.skill.dirName,
        dirName: saved.result.skill.dirName,
        content: saved.result.content,
      });
      setSkillEditorBaseline({
        dirName: saved.result.skill.dirName,
        content: saved.result.content,
      });
      setSelectedSkillEntryKey(
        createSkillEntryKey(saved.result.skill.libraryId, saved.result.skill.dirName),
      );
      setSkillsRefreshToken((current) => current + 1);
      setFlash(`Skill ${saved.result.skill.name} sauvegarde.`);
    } catch (saveError) {
      setSkillContentError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSkillEditorBusy("");
    }
  }

  async function handleDeleteSelectedSkill() {
    if (!ensureAdminAccess("La suppression de skills est reservee a l'admin Elytras.")) {
      return;
    }
    if (!selectedSkillEntry) {
      return;
    }
    if (!window.confirm(`Supprimer le skill ${selectedSkillEntry.name} ?`)) {
      return;
    }
    setSkillEditorBusy("delete");
    setSkillContentError("");
    try {
      await deleteSkillContent(config, {
        libraryId: selectedSkillEntry.libraryId,
        dirName: selectedSkillEntry.dirName,
      });
      setSelectedSkillEntryKey("");
      resetSkillEditor();
      setSkillsRefreshToken((current) => current + 1);
      setFlash(`Skill ${selectedSkillEntry.name} supprime.`);
    } catch (deleteError) {
      setSkillContentError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setSkillEditorBusy("");
    }
  }

  async function handleSelectSkillImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      setSkillImportDraft((current) => ({
        ...current,
        archiveBase64: "",
        fileName: "",
      }));
      return;
    }
    setSkillImportError("");
    try {
      const archiveBase64 = await readFileAsBase64(file);
      setSkillImportDraft((current) => ({
        ...current,
        archiveBase64,
        fileName: file.name,
      }));
    } catch (fileError) {
      setSkillImportError(fileError instanceof Error ? fileError.message : String(fileError));
    } finally {
      event.target.value = "";
    }
  }

  async function handleImportSkill() {
    if (!ensureAdminAccess("L'import de skills est reserve a l'admin Elytras.")) {
      return;
    }
    if (!activeSkillLibrary || skillImportBusy) {
      return;
    }
    setSkillImportBusy(true);
    setSkillImportError("");
    setSkillImportWarnings([]);
    try {
      const imported = await importSkillContent(config, {
        libraryId: activeSkillLibrary.id,
        sourceType: skillImportDraft.sourceType,
        overwrite: skillImportDraft.overwrite,
        repoUrl: skillImportDraft.repoUrl.trim() || undefined,
        ref: skillImportDraft.ref.trim() || undefined,
        sourcePath: skillImportDraft.sourcePath.trim() || undefined,
        archiveUrl: skillImportDraft.archiveUrl.trim() || undefined,
        archiveBase64: skillImportDraft.archiveBase64 || undefined,
        fileName: skillImportDraft.fileName || undefined,
        dirName: skillImportDraft.dirName.trim() || undefined,
        content: skillImportDraft.content || undefined,
      });
      const importedEntry = imported.result.imported[0] || null;
      if (importedEntry) {
        const nextSelectionKey = createSkillEntryKey(importedEntry.libraryId, importedEntry.dirName);
        setPendingSkillEntryKey(nextSelectionKey);
        setSelectedSkillEntryKey(nextSelectionKey);
      }
      setSkillImportWarnings(imported.result.warnings);
      setSkillsRefreshToken((current) => current + 1);
      setSkillImportDraft((current) => ({
        ...current,
        archiveBase64: "",
        fileName: "",
        ...(current.sourceType === "skill-md" ? { dirName: "", content: "" } : {}),
      }));
      setFlash(
        imported.result.imported.length === 1
          ? `1 skill importe dans ${activeSkillLibrary.label}.`
          : `${imported.result.imported.length} skills importes dans ${activeSkillLibrary.label}.`,
      );
    } catch (importError) {
      setSkillImportError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setSkillImportBusy(false);
    }
  }

  async function mutateResource(
    action: "create" | "delete" | "patch",
    resource: string,
    payload: Record<string, unknown>,
    id?: string,
    successMessage?: string,
  ) {
    const requiresOperationalScope =
      resource === "pipelines" || resource === "cronJobs" || resource === "channels";
    const inScope = canMutateStoreResource(action, resource, id);
    if (requiresOperationalScope) {
      if (!ensureOperationalAccess("Cette action demande un utilisateur actif avec droits d'operation.")) {
        return false;
      }
      if (!inScope) {
        setError("Cette ressource n'est pas dans le perimetre du user courant.");
        return false;
      }
    } else {
      if (!ensureAdminAccess("Cette action est reservee a l'admin Elytras.")) {
        return false;
      }
      if (!inScope) {
        setError("Cette ressource reste reservee a l'admin Elytras.");
        return false;
      }
    }
    try {
      if (action === "create") {
        await createStoreResource(resource, config, payload);
      } else if (action === "patch" && id) {
        await updateStoreResource(resource, id, config, payload);
      } else if (action === "delete" && id) {
        await deleteStoreResource(resource, id, config);
      }
      await refresh();
      if (successMessage) {
        setFlash(successMessage);
      }
      return true;
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
      return false;
    }
  }

  function resetChatDraft() {
    setChatDraft({
      ...createChatDraft(chatDraftAgentId),
      projectId:
        selectedDashboardProjectId !== DASHBOARD_NO_PROJECT_ID
          ? selectedDashboardProjectId
          : DASHBOARD_NO_PROJECT_ID,
    });
  }

  async function handleCreateChat() {
    const agentId = chatDraftAgentId;
    if (!agentId) {
      setError("Choisis un agent avant d’ouvrir un chat.");
      return;
    }
    if (!canOperateAgentRecord(agentId)) {
      setError("Le user courant n'a pas le droit d'ouvrir un chat sur cet agent.");
      return;
    }

    setChatCreating(true);
    setError("");
    try {
      const label = chatDraft.label.trim() || buildDefaultChatLabel(agentId);
      const initialMessage = chatDraft.message.trim() || undefined;
      const requestedModelRef = chatDraft.modelRef || getEffectiveAgentModelRef(agentId);
      const safeModelRef = sanitizeModelRefForAgent(agentId, requestedModelRef);
      const requestedProjectId =
        chatDraft.projectId && chatDraft.projectId !== DASHBOARD_NO_PROJECT_ID
          ? chatDraft.projectId
          : undefined;
      const resumeCandidate = getResumeCandidateSession(
        agentId,
        chatDraftAgentBinding?.resumePolicy,
        requestedProjectId,
      );
      const patchPayload = {
        model: safeModelRef || null,
        thinkingLevel: chatDraft.thinkingLevel || null,
        fastMode: typeof chatDraft.fastMode === "boolean" ? chatDraft.fastMode : null,
        verboseLevel: chatDraft.verboseLevel || null,
        reasoningLevel: chatDraft.reasoningLevel || null,
      };

      let nextSessionKey = "";
      if (resumeCandidate) {
        nextSessionKey = resumeCandidate.key;
        if (
          safeModelRef ||
          chatDraft.thinkingLevel ||
          typeof chatDraft.fastMode === "boolean" ||
          chatDraft.verboseLevel ||
          chatDraft.reasoningLevel
        ) {
          await patchSession(config, nextSessionKey, patchPayload);
        }
        if (initialMessage) {
          await sendSessionMessage(config, nextSessionKey, { message: initialMessage });
        }
      } else {
        const created = await createSession(config, {
          agentId,
          label,
          projectId: requestedProjectId,
          model: safeModelRef || undefined,
          message: initialMessage,
          thinkingLevel: chatDraft.thinkingLevel || null,
          fastMode: typeof chatDraft.fastMode === "boolean" ? chatDraft.fastMode : null,
          verboseLevel: chatDraft.verboseLevel || null,
          reasoningLevel: chatDraft.reasoningLevel || null,
        });
        nextSessionKey = created.result.key;
      }

      pendingSelectedSessionKeyRef.current = nextSessionKey;
      setSelectedSessionKey(nextSessionKey);
      setView("chat");
      setComposer("");
      clearChatComposerAttachments();
      setHistory(null);
      await refresh();
      const nextHistory = await fetchSessionHistory(config, nextSessionKey, 120);
      setHistory(nextHistory);
      setFlash(
        resumeCandidate
          ? `Session ${nextSessionKey} reprise pour ${agentId}.`
          : `Chat ${label} ouvert sur ${agentId}.`,
      );
      setChatDraft({
        ...createChatDraft(agentId),
        projectId:
          selectedDashboardProjectId !== DASHBOARD_NO_PROJECT_ID
            ? selectedDashboardProjectId
            : DASHBOARD_NO_PROJECT_ID,
      });
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setChatCreating(false);
    }
  }

  function clearChatComposerAttachments() {
    setChatComposerAttachments((current) => {
      for (const attachment of current) {
        revokeChatComposerAttachment(attachment);
      }
      return [];
    });
  }

  function removeChatComposerAttachment(attachmentId: string) {
    setChatComposerAttachments((current) => {
      const next = current.filter((attachment) => attachment.id !== attachmentId);
      const removed = current.find((attachment) => attachment.id === attachmentId);
      if (removed) {
        revokeChatComposerAttachment(removed);
      }
      return next;
    });
  }

  async function handleImportChatFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) {
      return;
    }

    const currentSessionWorkspaceMode = resolveChatWorkspaceMode(selectedSession);
    const importedAttachments: ChatComposerAttachment[] = [];
    const importedTextBlocks: string[] = [];
    const unsupportedFiles: string[] = [];

    try {
      for (const file of files) {
        if (
          file.type.startsWith("image/") ||
          file.type.startsWith("audio/") ||
          file.type.startsWith("video/") ||
          (currentSessionWorkspaceMode === "inbox" &&
            !isInlineTextImportFile(file) &&
            !file.type.startsWith("text/"))
        ) {
          const base64 = await readFileAsBase64(file);
          importedAttachments.push({
            id: createChatComposerAttachmentId(),
            fileName: file.name,
            mimeType: file.type || "application/octet-stream",
            kind: inferChatComposerAttachmentKind(file),
            base64,
            size: file.size,
            previewUrl: URL.createObjectURL(file),
          });
          continue;
        }
        if (isInlineTextImportFile(file)) {
          importedTextBlocks.push(formatImportedTextBlock(file.name, await readFileAsText(file)));
          continue;
        }
        unsupportedFiles.push(file.name);
      }

      if (importedAttachments.length) {
        setChatComposerAttachments((current) => [...current, ...importedAttachments]);
      }
      if (importedTextBlocks.length) {
        setComposer((current) =>
          [current.trim(), ...importedTextBlocks].filter(Boolean).join("\n\n"),
        );
      }
      if (unsupportedFiles.length) {
        setError(
          `Import partiel: ${unsupportedFiles.join(", ")} non supporte(s) dans le chat. Utilise images ou fichiers texte.`,
        );
      } else {
        setFlash(
          [
            importedAttachments.length
              ? `${importedAttachments.length} piece(s) jointe(s)`
              : "",
            importedTextBlocks.length ? `${importedTextBlocks.length} fichier(s) texte` : "",
          ]
            .filter(Boolean)
            .join(" · ") || "Import termine.",
        );
      }
    } catch (importError) {
      for (const attachment of importedAttachments) {
        revokeChatComposerAttachment(attachment);
      }
      setError(importError instanceof Error ? importError.message : String(importError));
    }
  }

  async function handleSendMessage() {
    const trimmedComposer = composer.trim();
    if (!selectedSessionKey || (!trimmedComposer && chatComposerAttachments.length === 0)) {
      return;
    }
    if (!canOperateSessionRecord(selectedSession)) {
      setError("Le user courant n'a pas le droit d'ecrire dans cette session.");
      return;
    }
    const unsupportedRelayOnlyAttachments = chatComposerAttachments.filter(
      (attachment) => attachment.kind !== "image",
    );
    if (unsupportedRelayOnlyAttachments.length > 0) {
      setError(
        'Les pieces jointes audio, video et document ne peuvent pas etre envoyees au prompt. Utilise "Relayer via bot" pour les transmettre au destinataire reel.',
      );
      return;
    }
    const shouldDeliverExternally = resolveChatWorkspaceMode(selectedSession) === "inbox";
    try {
      await sendSessionMessage(config, selectedSessionKey, {
        message: trimmedComposer,
        deliver: shouldDeliverExternally,
        attachments: chatComposerAttachments.map((attachment) => ({
          type: attachment.kind,
          mimeType: attachment.mimeType,
          fileName: attachment.fileName,
          content: attachment.base64,
        })),
      });
      setComposer("");
      clearChatComposerAttachments();
      setFlash(
        chatComposerAttachments.length
          ? shouldDeliverExternally
            ? `Message et ${chatComposerAttachments.length} piece(s) envoyes; la reponse sera relaye via le bot.`
            : `Message et ${chatComposerAttachments.length} piece(s) envoyes au gateway.`
          : shouldDeliverExternally
            ? "Message envoye; la reponse sera relayee via le bot."
            : "Message envoye au gateway.",
      );
      const next = await fetchSessionHistory(config, selectedSessionKey, 120);
      setHistory(next);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    }
  }

  async function handleRelayMessage() {
    const trimmedComposer = composer.trim();
    const currentSessionWorkspaceMode = resolveChatWorkspaceMode(selectedSession);
    if (
      currentSessionWorkspaceMode !== "inbox" ||
      !selectedSessionKey ||
      (!trimmedComposer && chatComposerAttachments.length === 0)
    ) {
      return;
    }
    if (!canOperateSessionRecord(selectedSession)) {
      setError("Le user courant n'a pas le droit de relayer cette conversation.");
      return;
    }
    try {
      await relaySessionMessage(config, selectedSessionKey, {
        message: trimmedComposer,
        attachments: chatComposerAttachments.map((attachment) => ({
          type: attachment.kind,
          mimeType: attachment.mimeType,
          fileName: attachment.fileName,
          content: attachment.base64,
        })),
      });
      setComposer("");
      clearChatComposerAttachments();
      setFlash(
        chatComposerAttachments.length
          ? `Relai direct envoye via ${selectedSession?.channel || "bot"} avec ${chatComposerAttachments.length} piece(s).`
          : `Relai direct envoye via ${selectedSession?.channel || "bot"}.`,
      );
      const next = await fetchSessionHistory(config, selectedSessionKey, 120);
      setHistory(next);
    } catch (relayError) {
      setError(relayError instanceof Error ? relayError.message : String(relayError));
    }
  }

  async function handleSelectedSessionModelPatch(modelRef: string) {
    if (!selectedSessionKey) {
      return;
    }
    if (!canOperateSessionRecord(selectedSession)) {
      setError("Le user courant n'a pas le droit de modifier cette session.");
      return;
    }
    try {
      await patchSession(config, selectedSessionKey, {
        model: modelRef || null,
      });
      await refresh();
      setFlash("Modele session mis a jour.");
    } catch (patchError) {
      setError(patchError instanceof Error ? patchError.message : String(patchError));
    }
  }

  async function handleResetSession() {
    if (!selectedSessionKey) {
      return;
    }
    if (!canOperateSessionRecord(selectedSession)) {
      setError("Le user courant n'a pas le droit de reset cette session.");
      return;
    }
    try {
      await resetSession(config, selectedSessionKey);
      setFlash("Session reset demandee.");
      const next = await fetchSessionHistory(config, selectedSessionKey, 120);
      setHistory(next);
      await refresh();
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : String(resetError));
    }
  }

  async function syncAgentInboundBots(agentId: string, selectedTransportKeys: string[]) {
    const desiredKeys = new Set(selectedTransportKeys);
    for (const channel of runtimeTransportChannels) {
      const key = makeRuntimeTransportKey(channel);
      const currentlyBoundToAgent = channel.inboundAgentId === agentId;
      if (desiredKeys.has(key)) {
        if (!currentlyBoundToAgent) {
          await saveChannelInboundBinding(config, {
            channelId: channel.kind,
            accountId: channel.accountId,
            agentId,
          });
        }
        continue;
      }
      if (currentlyBoundToAgent) {
        await saveChannelInboundBinding(config, {
          channelId: channel.kind,
          accountId: channel.accountId,
        });
      }
    }
  }

  async function handleSaveAgent() {
    if (!ensureAdminAccess("La creation et l'edition d'agents sont reservees a l'admin Elytras.")) {
      return;
    }
    const name = agentEditor.name.trim();
    const workspace = agentEditor.workspace.trim();
    const effectiveSkillPolicy =
      agentEditor.skillPolicy === "selected" && agentEditor.skillIds.length === 0
        ? "none"
        : agentEditor.skillPolicy;
    const effectiveProviderIds =
      agentEditor.providerIds.length > 0 ? agentEditor.providerIds : activeRuntimeProviderIds;
    const effectiveAccessTeamIds = Array.from(
      new Set(
        [...agentEditor.accessTeamIds, agentEditor.teamId].filter(
          (entry): entry is string => Boolean(entry),
        ),
      ),
    ).toSorted((left, right) => left.localeCompare(right));
    const agentEditorSnapshot: AgentEditor = {
      ...agentEditor,
      name,
      workspace,
      accessTeamIds: effectiveAccessTeamIds,
      inboundTransportKeys: [...agentEditor.inboundTransportKeys],
      providerIds: effectiveProviderIds,
      skillPolicy: effectiveSkillPolicy,
      skillIds: [...agentEditor.skillIds],
      channelIds: [...agentEditor.channelIds],
      defaultOutputChannelIds: [...agentEditor.defaultOutputChannelIds],
    };
    if (!name || !workspace) {
      setError("Nom et workspace sont requis pour un agent.");
      return;
    }

    setAgentSaving(true);
    setError("");
    try {
      if (agentEditorMode === "create") {
        const created = await createAgent(config, {
          name,
          workspace,
          ownerId: agentEditor.ownerId || undefined,
          teamId: agentEditor.teamId || undefined,
          accessTeamIds: effectiveAccessTeamIds,
          purpose: agentEditor.purpose || undefined,
          channelIds: agentEditor.channelIds,
          defaultOutputChannelIds: agentEditor.defaultOutputChannelIds,
          providerIds: effectiveProviderIds,
          skillPolicy: effectiveSkillPolicy,
          skillIds: agentEditor.skillIds,
          tags: splitList(agentEditor.tags),
          emoji: agentEditor.emoji || undefined,
          avatar: agentEditor.avatar || undefined,
          modelRef: agentEditor.modelRef || undefined,
          resumePolicy: agentEditor.resumePolicy,
          dispatchPolicy: agentEditor.dispatchPolicy,
          thinkingLevel: agentEditor.thinkingLevel || undefined,
          fastMode: agentEditor.fastMode,
          verboseLevel: agentEditor.verboseLevel || undefined,
          reasoningLevel: agentEditor.reasoningLevel || undefined,
        });
        const createdResult = (created.result || {}) as Record<string, unknown>;
        const createdBindingResult = createdResult.binding as Record<string, unknown> | undefined;
        const createdPayload = createdResult.create as Record<string, unknown> | undefined;
        const createdAgentId =
          typeof createdBindingResult?.agentId === "string"
            ? createdBindingResult.agentId
            : typeof createdPayload?.agentId === "string"
              ? createdPayload.agentId
              : "";
        let seededFilesCount = 0;
        let seedErrorMessage = "";
        if (createdAgentId) {
          await syncAgentInboundBots(createdAgentId, agentEditor.inboundTransportKeys);
          try {
            seededFilesCount = (
              await seedAgentMarkdownBootstrap(createdAgentId, {
                ...agentEditorSnapshot,
                agentId: createdAgentId,
              })
            ).length;
          } catch (seedError) {
            seedErrorMessage = seedError instanceof Error ? seedError.message : String(seedError);
          }
        }
        const next = await fetchDashboardSnapshot(config);
        setSnapshot(next);
        if (createdAgentId) {
          const createdBinding = next.agentBindings.find(
            (binding) => binding.agentId === createdAgentId,
          );
          const createdAgent = next.agents.find((agent) => agent.id === createdAgentId);
          if (createdAgent) {
            openAgentStudioRecord(createdAgent, createdBinding, {
              section: "files",
              preferredFileName: "AGENTS.md",
            });
            setFlash(
              seedErrorMessage
                ? `Agent ${createdAgentId} cree, mais le bootstrap markdown a echoue: ${seedErrorMessage}`
                : seededFilesCount
                  ? `Agent ${createdAgentId} cree. ${seededFilesCount} markdown(s) initialises et atelier ouvert.`
                  : `Agent ${createdAgentId} cree. Workspace markdown ouvert.`,
            );
          } else {
            resetAgentEditor();
            setFlash(
              seedErrorMessage
                ? `Agent ${createdAgentId} cree, mais le bootstrap markdown a echoue: ${seedErrorMessage}`
                : `Agent ${createdAgentId} cree.`,
            );
          }
        } else {
          resetAgentEditor();
          setFlash(`Agent ${name} cree.`);
        }
      } else {
        await updateAgent(config, agentEditor.agentId, {
          name,
          workspace,
          ownerId: agentEditor.ownerId || undefined,
          teamId: agentEditor.teamId || undefined,
          accessTeamIds: effectiveAccessTeamIds,
          purpose: agentEditor.purpose || undefined,
          channelIds: agentEditor.channelIds,
          defaultOutputChannelIds: agentEditor.defaultOutputChannelIds,
          providerIds: effectiveProviderIds,
          skillPolicy: effectiveSkillPolicy,
          skillIds: agentEditor.skillIds,
          tags: splitList(agentEditor.tags),
          emoji: agentEditor.emoji || undefined,
          avatar: agentEditor.avatar || undefined,
          modelRef: agentEditor.modelRef || undefined,
          resumePolicy: agentEditor.resumePolicy,
          dispatchPolicy: agentEditor.dispatchPolicy,
          thinkingLevel: agentEditor.thinkingLevel || undefined,
          fastMode: agentEditor.fastMode,
          verboseLevel: agentEditor.verboseLevel || undefined,
          reasoningLevel: agentEditor.reasoningLevel || undefined,
        });
        await syncAgentInboundBots(agentEditor.agentId, agentEditor.inboundTransportKeys);
        await syncAgentGeneratedMarkdown(agentEditor.agentId, agentEditorSnapshot);
        const next = await fetchDashboardSnapshot(config);
        setSnapshot(next);
        const updatedBinding = next.agentBindings.find(
          (binding) => binding.agentId === agentEditor.agentId,
        );
        const updatedAgent = next.agents.find((agent) => agent.id === agentEditor.agentId);
        if (updatedAgent) {
          openAgentStudioRecord(updatedAgent, updatedBinding, {
            section: agentStudioSection,
            preferredFileName: selectedAgentFile?.name || "AGENTS.md",
          });
        }
        setFlash(`Agent ${agentEditor.agentId} mis a jour.`);
      }
    } catch (agentError) {
      setError(agentError instanceof Error ? agentError.message : String(agentError));
    } finally {
      setAgentSaving(false);
    }
  }

  async function handleDeleteAgent(agentId: string) {
    if (!ensureAdminAccess("La suppression d'agents est reservee a l'admin Elytras.")) {
      return;
    }
    if (agentId === "main") {
      setError("L’agent main ne peut pas etre supprime.");
      return;
    }

    const confirmed = window.confirm(
      `Supprimer l’agent ${agentId} et nettoyer ses fichiers/workspaces OpenClaw ?`,
    );
    if (!confirmed) {
      return;
    }

    setAgentDeleteBusy(agentId);
    setError("");
    try {
      await deleteAgent(config, agentId, true);
      await refresh();
      if (selectedSession?.agentId === agentId) {
        setSelectedSessionKey("");
        setHistory(null);
      }
      if (agentEditorMode === "edit" && agentEditor.agentId === agentId) {
        resetAgentEditor();
      }
      setFlash(`Agent ${agentId} supprime.`);
    } catch (agentError) {
      setError(agentError instanceof Error ? agentError.message : String(agentError));
    } finally {
      setAgentDeleteBusy("");
    }
  }

  async function handleSaveAgentFile(nameOverride?: string, contentOverride?: string) {
    if (!ensureAdminAccess("Les fichiers natifs d'agent sont reserves a l'admin Elytras.")) {
      return;
    }
    if (agentEditorMode !== "edit" || !agentEditor.agentId) {
      return;
    }
    const targetName = (nameOverride || selectedAgentFile?.name || "").trim();
    const targetKey = `${agentEditor.agentId}:${targetName}`;
    const targetContent =
      contentOverride !== undefined ? contentOverride : fileContent[targetKey] || "";
    if (!targetName) {
      setError("Choisis un fichier markdown a sauvegarder.");
      return;
    }
    if (!targetName.toLowerCase().endsWith(".md")) {
      setError("Le studio agent ecrit uniquement des fichiers .md.");
      return;
    }

    setAgentFileSaveBusy(targetKey);
    setError("");
    try {
      const next = await saveFileContent(config, {
        agentId: agentEditor.agentId,
        name: targetName,
        content: targetContent,
      });
      const savedContent = resolveFileContentResponseContent(next) || targetContent;
      setFileContent((current) => ({ ...current, [targetKey]: savedContent }));
      setFileBaselineContent((current) => ({ ...current, [targetKey]: savedContent }));
      setSelectedAgentFileKey(targetKey);
      setAgentMarkdownDraftName("");
      setAgentMarkdownDraftContent("");
      await refresh();
      setFlash(`${targetName} sauvegarde.`);
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : String(fileError));
    } finally {
      setAgentFileSaveBusy("");
    }
  }

  async function handleInstallManagedMemoryPlugin() {
    if (!ensureAdminAccess("Le moteur memoire runtime est reserve a l'admin Elytras.")) {
      return;
    }
    setMemoryEngineBusy("install");
    setError("");
    try {
      const response = await installManagedMemoryPlugin(config);
      setMemoryEngineRefreshToken((current) => current + 1);
      setFlash(
        response.result.message ||
          (response.result.alreadyInstalled
            ? `${response.result.pluginId} est deja disponible.`
            : `${response.result.pluginId} est pret cote runtime local.`),
      );
    } catch (memoryError) {
      setError(memoryError instanceof Error ? memoryError.message : String(memoryError));
    } finally {
      setMemoryEngineBusy("");
    }
  }

  async function handleSaveMemoryEngine(mode: "legacy" | "elytrasless" | "lossless-claw") {
    if (!ensureAdminAccess("La configuration memoire runtime est reservee a l'admin Elytras.")) {
      return;
    }
    setMemoryEngineBusy(mode);
    setError("");
    try {
      await saveMemoryEngineConfig(config, {
        mode,
        config:
          mode === "legacy"
            ? undefined
            : {
                dbPath: memoryEngineForm.dbPath.trim() || undefined,
                summaryModel: memoryEngineForm.summaryModel || undefined,
                expansionModel: memoryEngineForm.expansionModel || undefined,
                freshTailCount: memoryEngineForm.freshTailCount.trim()
                  ? Number(memoryEngineForm.freshTailCount)
                  : undefined,
                contextThreshold: memoryEngineForm.contextThreshold.trim()
                  ? Number(memoryEngineForm.contextThreshold)
                  : undefined,
                incrementalMaxDepth: memoryEngineForm.incrementalMaxDepth.trim()
                  ? Number(memoryEngineForm.incrementalMaxDepth)
                  : undefined,
                ignoreSessionPatterns: splitMultilineList(memoryEngineForm.ignoreSessionPatterns),
                statelessSessionPatterns: splitMultilineList(
                  memoryEngineForm.statelessSessionPatterns,
                ),
                skipStatelessSessions: memoryEngineForm.skipStatelessSessions,
              },
      });
      setMemoryEngineRefreshToken((current) => current + 1);
      setFlash(
        mode === "legacy"
          ? "Moteur de contexte repasse en mode legacy."
          : `${mode} actif et configure sur le runtime local.`,
      );
    } catch (memoryError) {
      setError(memoryError instanceof Error ? memoryError.message : String(memoryError));
    } finally {
      setMemoryEngineBusy("");
    }
  }

  async function handleCreateBridge() {
    if (!ensureAdminAccess("La gestion des bridges provider est reservee a l'admin Elytras.")) {
      return;
    }
    const created = await mutateResource(
      "create",
      "providerBridges",
      bridgeEditorPayload(bridgeForm),
      undefined,
      "Bridge ajoute.",
    );
    if (created) {
      setBridgeForm(createBridgeEditor());
    }
  }

  async function handleSaveBridge() {
    if (!ensureAdminAccess("La gestion des bridges provider est reservee a l'admin Elytras.")) {
      return;
    }
    if (!selectedBridgeId) {
      return;
    }
    const saved = await mutateResource(
      "patch",
      "providerBridges",
      bridgeEditorPayload(bridgeEditor),
      selectedBridgeId,
      "Bridge mis a jour.",
    );
    if (saved) {
      setBridgeEditorDirty(false);
    }
  }

  async function handleDiscoverBridge(id: string) {
    if (!ensureAdminAccess("La synchronisation provider est reservee a l'admin Elytras.")) {
      return;
    }
    if (selectedBridgeId === id && bridgeEditorDirty) {
      const saved = await mutateResource(
        "patch",
        "providerBridges",
        bridgeEditorPayload(bridgeEditor),
        selectedBridgeId,
      );
      if (!saved) {
        return;
      }
      setBridgeEditorDirty(false);
    }
    setBridgeAction(`discover:${id}`);
    setError("");
    try {
      await discoverProviderBridge(config, id);
      await refresh();
      setBridgeEditorDirty(false);
      setFlash("Catalogue de modeles synchronise.");
    } catch (bridgeError) {
      setError(bridgeError instanceof Error ? bridgeError.message : String(bridgeError));
    } finally {
      setBridgeAction("");
    }
  }

  async function handleImportBridge(id: string) {
    if (!ensureAdminAccess("L'import provider vers OpenClaw est reserve a l'admin Elytras.")) {
      return;
    }
    if (selectedBridgeId === id && bridgeEditorDirty) {
      const saved = await mutateResource(
        "patch",
        "providerBridges",
        bridgeEditorPayload(bridgeEditor),
        selectedBridgeId,
      );
      if (!saved) {
        return;
      }
      setBridgeEditorDirty(false);
    }
    setBridgeAction(`import:${id}`);
    setError("");
    try {
      const result = await importProviderBridge(config, id);
      await refresh();
      setBridgeEditorDirty(false);
      setFlash(`Bridge importe dans OpenClaw sous ${result.result.providerId}.`);
    } catch (bridgeError) {
      setError(bridgeError instanceof Error ? bridgeError.message : String(bridgeError));
    } finally {
      setBridgeAction("");
    }
  }

  async function handleStartCliproxyOauth(provider: string) {
    if (!ensureAdminAccess("La connexion OAuth provider est reservee a l'admin Elytras.")) {
      return;
    }
    cliproxyOauthFlowIdRef.current += 1;
    setCliproxyOauthBusy(provider);
    setError("");
    try {
      const started = await startCliproxyOauth(config, provider);
      window.open(started.url, "_blank");
      setCliproxyOauthDraft({
        provider,
        label: cliproxyProviderLabel(provider),
        state: started.state,
        url: started.url,
        redirectUrl: "",
        submitStatus: "idle",
        submitError: "",
      });
      setFlash(
        `${cliproxyProviderLabel(provider)} ouvert. Termine la connexion puis colle l’URL de retour ici.`,
      );
    } catch (oauthError) {
      setError(oauthError instanceof Error ? oauthError.message : String(oauthError));
    } finally {
      setCliproxyOauthBusy("");
    }
  }

  function cancelCliproxyOauthFlow() {
    cliproxyOauthFlowIdRef.current += 1;
    setCliproxyOauthBusy("");
    setCliproxyOauthDraft(null);
  }

  async function handleSubmitCliproxyOauthCallback() {
    if (!ensureAdminAccess("La validation OAuth provider est reservee a l'admin Elytras.")) {
      return;
    }
    if (!cliproxyOauthDraft) {
      return;
    }
    const redirectUrl = cliproxyOauthDraft.redirectUrl.trim();
    if (!redirectUrl) {
      const message = "Colle l’URL complete de redirection avant de confirmer l’OAuth.";
      setCliproxyOauthDraft((current) =>
        current ? { ...current, submitError: message, submitStatus: "idle" } : current,
      );
      setError(message);
      return;
    }
    const flowId = cliproxyOauthFlowIdRef.current + 1;
    cliproxyOauthFlowIdRef.current = flowId;
    setCliproxyOauthBusy(cliproxyOauthDraft.provider);
    setError("");
    setCliproxyOauthDraft((current) =>
      current ? { ...current, submitStatus: "submitting", submitError: "" } : current,
    );
    try {
      const submitResult = await submitCliproxyOauthCallback(config, {
        provider: cliproxyOauthDraft.provider,
        redirectUrl,
      });
      if (submitResult.status === "error") {
        throw new Error(
          submitResult.error || `Retour OAuth ${cliproxyOauthDraft.label} refuse.`,
        );
      }
      setCliproxyOauthDraft((current) =>
        current ? { ...current, submitStatus: "submitted", submitError: "" } : current,
      );
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (cliproxyOauthFlowIdRef.current !== flowId) {
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        if (cliproxyOauthFlowIdRef.current !== flowId) {
          return;
        }
        const status = await pollCliproxyOauth(config, cliproxyOauthDraft.state);
        if (status.status === "wait") {
          continue;
        }
        if (status.status === "ok") {
          if (cliproxyOauthFlowIdRef.current !== flowId) {
            return;
          }
          setCliproxyRefreshToken((current) => current + 1);
          setCliproxyOauthDraft(null);
          setFlash(`${cliproxyOauthDraft.label} connecte.`);
          return;
        }
        throw new Error(status.error || `OAuth ${cliproxyOauthDraft.label} en erreur.`);
      }
      throw new Error(`Timeout OAuth ${cliproxyOauthDraft.label}.`);
    } catch (oauthError) {
      if (cliproxyOauthFlowIdRef.current !== flowId) {
        return;
      }
      const message = oauthError instanceof Error ? oauthError.message : String(oauthError);
      setCliproxyOauthDraft((current) =>
        current ? { ...current, submitStatus: "idle", submitError: message } : current,
      );
      setError(message);
    } finally {
      if (cliproxyOauthFlowIdRef.current === flowId) {
        setCliproxyOauthBusy("");
      }
    }
  }

  async function handleImportCliproxyOpenClawAuth() {
    if (!ensureAdminAccess("L'import des auth OpenClaw est reserve a l'admin Elytras.")) {
      return;
    }
    setCliproxySectionBusy("import-openclaw-auth");
    setError("");
    try {
      const result = await importCliproxyOpenClawAuth(config);
      setCliproxyRefreshToken((current) => current + 1);
      setFlash(
        `Import OpenClaw local termine: ${result.imported} compte(s) ${result.providers.join(", ")} sync.`,
      );
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setCliproxySectionBusy("");
    }
  }

  async function handleSaveCliproxySection(
    section:
      | "gemini-api-key"
      | "codex-api-key"
      | "claude-api-key"
      | "openai-compatibility"
      | "oauth-excluded-models"
      | "quota-exceeded/switch-project"
      | "quota-exceeded/switch-preview-model",
    value: unknown,
    successMessage: string,
  ) {
    if (!ensureAdminAccess("La configuration providers est reservee a l'admin Elytras.")) {
      return;
    }
    setCliproxySectionBusy(section);
    setError("");
    try {
      await saveCliproxySection(config, { section, value });
      setCliproxyRefreshToken((current) => current + 1);
      setFlash(successMessage);
    } catch (sectionError) {
      setError(sectionError instanceof Error ? sectionError.message : String(sectionError));
    } finally {
      setCliproxySectionBusy("");
    }
  }

  async function handleSaveCliproxyJsonSection(
    section:
      | "gemini-api-key"
      | "codex-api-key"
      | "claude-api-key"
      | "openai-compatibility"
      | "oauth-excluded-models",
    rawValue: string,
    fallback: [] | Record<string, string[]>,
    successMessage: string,
  ) {
    try {
      const parsed = parseJsonEditor(rawValue, fallback);
      await handleSaveCliproxySection(section, parsed, successMessage);
    } catch (jsonError) {
      setError(jsonError instanceof Error ? jsonError.message : String(jsonError));
    }
  }

  async function handleDeleteCliproxyAuth(name: string) {
    if (!ensureAdminAccess("La suppression de comptes provider est reservee a l'admin Elytras.")) {
      return;
    }
    setCliproxySectionBusy(`auth:${name}`);
    setError("");
    try {
      await deleteCliproxyAuthFile(config, name);
      setCliproxyRefreshToken((current) => current + 1);
      setFlash(`Auth file ${name} supprime.`);
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : String(authError));
    } finally {
      setCliproxySectionBusy("");
    }
  }

  function syncSelectedChannelDraft(entry: ChannelCatalogEntry | undefined, accountId: string) {
    const ownerId = selectedDashboardUser?.id || snapshot?.users[0]?.id || "";
    setSelectedChannelAccountId(accountId);
    setChannelDraftIsNewAccount(false);
    setSelectedChannelRouteId("");
    setChannelDraft(buildChannelSetupDraft(entry, accountId));
    setChannelRouteDraft(createChannelRouteDraft(ownerId, entry));
  }

  function handleSelectChannel(channelId: string) {
    const entry = channelCatalog?.entries.find((candidate) => candidate.id === channelId);
    const accountId =
      entry?.template.accountScope === "top-level-only"
        ? "default"
        : entry?.defaultAccountId || entry?.accounts[0]?.accountId || "default";
    setSelectedChannelTemplateId(channelId);
    syncSelectedChannelDraft(entry, accountId);
    setChannelOperationId("");
    setChannelOperation(null);
  }

  function openChannelWorkspace(channelId: string, accountId?: string) {
    const entry = channelCatalog?.entries.find((candidate) => candidate.id === channelId);
    if (!entry) {
      setView("channels");
      return;
    }
    const resolvedAccountId =
      entry.template.accountScope === "top-level-only"
        ? "default"
        : accountId || entry.defaultAccountId || entry.accounts[0]?.accountId || "default";
    setSelectedChannelTemplateId(channelId);
    syncSelectedChannelDraft(entry, resolvedAccountId);
    setChannelOperationId("");
    setChannelOperation(null);
    setView("channels");
  }

  function handleSelectChannelAccount(accountId: string) {
    if (!selectedChannelEntry) {
      return;
    }
    syncSelectedChannelDraft(selectedChannelEntry, accountId);
  }

  function handleStartNewChannelAccount() {
    if (!selectedChannelEntry || selectedChannelEntry.template.accountScope === "top-level-only") {
      return;
    }
    const ownerId = selectedDashboardUser?.id || snapshot?.users[0]?.id || "";
    const suggestedAccountId = suggestNewChannelAccountId(selectedChannelEntry);
    setSelectedChannelAccountId("");
    setChannelDraftIsNewAccount(true);
    setSelectedChannelRouteId("");
    setChannelDraft(
      buildChannelSetupDraft(selectedChannelEntry, suggestedAccountId, {
        hydrateFromExisting: false,
      }),
    );
    setChannelRouteDraft(createChannelRouteDraft(ownerId, selectedChannelEntry));
  }

  function handleCancelNewChannelAccount() {
    if (!selectedChannelEntry) {
      return;
    }
    const fallbackAccountId =
      selectedChannelEntry.defaultAccountId ||
      selectedChannelEntry.accounts[0]?.accountId ||
      "default";
    syncSelectedChannelDraft(selectedChannelEntry, fallbackAccountId);
  }

  function handleSelectChannelRoute(routeId: string) {
    const ownerId = selectedDashboardUser?.id || snapshot?.users[0]?.id || "";
    const route = visibleSelectedChannelOutputRoutes.find((entry) => entry.id === routeId);
    setSelectedChannelRouteId(routeId);
    setChannelRouteDraft(createChannelRouteDraft(ownerId, selectedChannelEntry, route));
  }

  function resetChannelRouteEditor() {
    const ownerId = selectedDashboardUser?.id || snapshot?.users[0]?.id || "";
    setSelectedChannelRouteId("");
    setChannelRouteDraft(createChannelRouteDraft(ownerId, selectedChannelEntry));
  }

  function seedChannelRouteFromDetectedDestination(channel: DashboardChannel) {
    const ownerId = selectedDashboardUser?.id || snapshot?.users[0]?.id || "";
    const inferredTarget = normalizeDetectedDestinationTarget(selectedChannelEntry, channel.target);
    const inferredDestinationType =
      inferRouteDestinationTypeFromDetectedTarget(selectedChannelEntry, channel.target) ||
      getChannelDefaultDestinationType(selectedChannelEntry);
    setSelectedChannelRouteId("");
    setChannelRouteDraft({
      ...createChannelRouteDraft(ownerId, selectedChannelEntry),
      name: `${selectedChannelEntry?.template.label || channel.kind} ${inferredTarget || channel.target}`,
      destinationType: inferredDestinationType,
      deliveryTarget: inferredTarget || channel.target,
    });
  }

  function updateChannelDraftValue(key: string, value: string | boolean | number) {
    setChannelDraft((current) => ({
      ...current,
      values: {
        ...current.values,
        [key]: value,
      },
    }));
  }

  async function handleConfigureSelectedChannel() {
    if (!ensureAdminAccess("Le setup technique des channels est reserve a l'admin Elytras.")) {
      return;
    }
    if (!selectedChannelEntry) {
      return;
    }
    setChannelActionBusy("configure");
    setError("");
    try {
      const nextAccountId =
        selectedChannelEntry.template.accountScope === "top-level-only"
          ? "default"
          : normalizeChannelAccountId(channelDraft.accountId);
      const response = await configureChannel(config, {
        channelId: selectedChannelEntry.id,
        accountId:
          selectedChannelEntry.template.accountScope === "top-level-only"
            ? undefined
            : channelDraft.accountId || undefined,
        name: channelDraft.name || undefined,
        values: channelDraft.values,
      });
      setChannelOperationId(response.operation.id);
      const [nextSnapshot, nextCatalog] = await Promise.all([
        fetchDashboardSnapshot(config),
        fetchChannelCatalog(config),
      ]);
      setSnapshot(nextSnapshot);
      setChannelCatalog(nextCatalog);
      const nextEntry = nextCatalog.entries.find((entry) => entry.id === selectedChannelEntry.id);
      setSelectedChannelAccountId(nextAccountId);
      setChannelDraftIsNewAccount(false);
      setChannelDraft(buildChannelSetupDraft(nextEntry, nextAccountId));
      setFlash(`${selectedChannelEntry.template.label} configure.`);
    } catch (channelError) {
      setError(channelError instanceof Error ? channelError.message : String(channelError));
    } finally {
      setChannelActionBusy("");
    }
  }

  async function handleSaveChannelRoute() {
    if (!ensureOperationalAccess("Le user courant ne peut pas gerer les destinations de channel.")) {
      return;
    }
    if (!selectedChannelEntry) {
      return;
    }
    if (!selectedChannelEntry.template.routeConfig.enabled) {
      setError("Ce channel n’expose pas de destinations operateur configurables.");
      return;
    }
    const deliveryTarget = channelRouteDraft.deliveryTarget.trim();
    if (!deliveryTarget) {
      setError("Renseigne une destination avant de sauvegarder la route.");
      return;
    }
    const accountId =
      selectedChannelEntry.template.accountScope === "top-level-only"
        ? "default"
        : channelDraft.accountId || selectedChannelAccountId || "default";
    if (
      !currentUserCanManageAdminViews &&
      selectedChannelEntry.template.accountScope !== "top-level-only" &&
      !selectedChannelEntry.accounts.some(
        (account) => normalizeChannelAccountId(account.accountId) === normalizeChannelAccountId(accountId),
      )
    ) {
      setError("Choisis un compte runtime deja connecte avant de creer une destination.");
      return;
    }
    const ownerId =
      (currentUserCanManageAdminViews
        ? channelRouteDraft.ownerId
        : selectedDashboardUser?.id || channelRouteDraft.ownerId) ||
      snapshot?.users[0]?.id ||
      "";
    const existingRoute =
      visibleSelectedChannelOutputRoutes.find(
        (entry) =>
          entry.deliveryTarget === deliveryTarget &&
          normalizeChannelAccountId(entry.accountId) === normalizeChannelAccountId(accountId) &&
          (entry.destinationType || "") === (channelRouteDraft.destinationType || ""),
      ) || null;
    const routeId = channelRouteDraft.id || existingRoute?.id || "";
    const payload = {
      name: channelRouteDraft.name.trim() || `${selectedChannelEntry.template.label} ${deliveryTarget}`,
      kind: selectedChannelEntry.id,
      target: deliveryTarget,
      accountId,
      deliveryTarget,
      destinationType: channelRouteDraft.destinationType || undefined,
      ownerId: ownerId || undefined,
      enabled: true,
      source: "custom" as const,
    };

    setChannelActionBusy(routeId ? "route-update" : "route-create");
    setError("");
    try {
      const response = routeId
        ? await updateStoreResource("channels", routeId, config, payload)
        : await createStoreResource("channels", config, payload);
      const savedRoute = response.result as Record<string, unknown> as DashboardChannel;
      const savedRouteId = savedRoute.id ? String(savedRoute.id) : routeId;
      if (!currentUserCanManageAdminViews && !routeId && savedRouteId && selectedDashboardUserTeamIds.length) {
        await Promise.all(
          selectedDashboardUserTeamIds.map(async (teamId) => {
            const team = teams.find((entry) => entry.id === teamId);
            if (!team || team.channelIds.includes(savedRouteId)) {
              return;
            }
            await updateStoreResource(
              "teams",
              teamId,
              config,
              { channelIds: [...team.channelIds, savedRouteId] },
            );
          }),
        );
      }
      await refresh();
      const nextRouteId = savedRouteId;
      const owner = selectedDashboardUser?.id || snapshot?.users[0]?.id || ownerId;
      setSelectedChannelRouteId(nextRouteId);
      setChannelRouteDraft(
        createChannelRouteDraft(owner, selectedChannelEntry, {
          ...savedRoute,
          id: nextRouteId,
        }),
      );
      setFlash(routeId ? "Destination mise a jour." : "Destination ajoutee.");
    } catch (routeError) {
      setError(routeError instanceof Error ? routeError.message : String(routeError));
    } finally {
      setChannelActionBusy("");
    }
  }

  async function handleDeleteSelectedChannelRoute() {
    if (!ensureOperationalAccess("Le user courant ne peut pas supprimer cette destination.")) {
      return;
    }
    if (!selectedChannelRouteId) {
      return;
    }
    setChannelActionBusy("route-delete");
    setError("");
    try {
      await deleteStoreResource("channels", selectedChannelRouteId, config);
      await refresh();
      resetChannelRouteEditor();
      setFlash("Destination supprimee.");
    } catch (routeError) {
      setError(routeError instanceof Error ? routeError.message : String(routeError));
    } finally {
      setChannelActionBusy("");
    }
  }

  async function handleInstallSelectedChannel() {
    if (!ensureAdminAccess("L'installation de plugins channel est reservee a l'admin Elytras.")) {
      return;
    }
    if (!selectedChannelEntry) {
      return;
    }
    setChannelActionBusy("install");
    setError("");
    try {
      const response = await installChannelPlugin(config, selectedChannelEntry.id);
      setChannelOperationId(response.operation.id);
      await fetchChannelCatalog(config).then(setChannelCatalog);
      setFlash(`Installation lancee pour ${selectedChannelEntry.template.label}.`);
    } catch (channelError) {
      setError(channelError instanceof Error ? channelError.message : String(channelError));
    } finally {
      setChannelActionBusy("");
    }
  }

  async function handleLoginSelectedChannel() {
    if (!ensureAdminAccess("Le login ou pairing channel est reserve a l'admin Elytras.")) {
      return;
    }
    if (!selectedChannelEntry) {
      return;
    }
    setChannelActionBusy("login");
    setError("");
    try {
      const response = await loginChannel(config, {
        channelId: selectedChannelEntry.id,
        accountId:
          selectedChannelEntry.template.accountScope === "top-level-only"
            ? undefined
            : channelDraft.accountId || undefined,
        verbose: true,
      });
      setChannelOperationId(response.operation.id);
      setFlash(`Login lance pour ${selectedChannelEntry.template.label}.`);
    } catch (channelError) {
      setError(channelError instanceof Error ? channelError.message : String(channelError));
    } finally {
      setChannelActionBusy("");
    }
  }

  async function handleLogoutSelectedChannel() {
    if (!ensureAdminAccess("Le logout channel est reserve a l'admin Elytras.")) {
      return;
    }
    if (!selectedChannelEntry) {
      return;
    }
    setChannelActionBusy("logout");
    setError("");
    try {
      const response = await logoutChannel(config, {
        channelId: selectedChannelEntry.id,
        accountId:
          selectedChannelEntry.template.accountScope === "top-level-only"
            ? undefined
            : channelDraft.accountId || undefined,
      });
      setChannelOperationId(response.operation.id);
      setFlash(`Logout lance pour ${selectedChannelEntry.template.label}.`);
    } catch (channelError) {
      setError(channelError instanceof Error ? channelError.message : String(channelError));
    } finally {
      setChannelActionBusy("");
    }
  }

  async function handleRemoveSelectedChannel() {
    if (!ensureAdminAccess("La suppression runtime d'un channel est reservee a l'admin Elytras.")) {
      return;
    }
    if (!selectedChannelEntry) {
      return;
    }
    if (channelDraftIsNewAccount) {
      setError("Ce bot n'est pas encore configure. Annule le brouillon ou sauvegarde-le d'abord.");
      return;
    }
    setChannelActionBusy("remove");
    setError("");
    try {
      const response = await removeChannel(config, {
        channelId: selectedChannelEntry.id,
        accountId:
          selectedChannelEntry.template.accountScope === "top-level-only"
            ? undefined
            : channelDraft.accountId || undefined,
        deleteConfig: true,
      });
      setChannelOperationId(response.operation.id);
      const [nextSnapshot, nextCatalog] = await Promise.all([
        fetchDashboardSnapshot(config),
        fetchChannelCatalog(config),
      ]);
      setSnapshot(nextSnapshot);
      setChannelCatalog(nextCatalog);
      const nextEntry = nextCatalog.entries.find((entry) => entry.id === selectedChannelEntry.id);
      const fallbackAccountId =
        selectedChannelEntry.template.accountScope === "top-level-only"
          ? "default"
          : nextEntry?.defaultAccountId || nextEntry?.accounts[0]?.accountId || "default";
      setSelectedChannelAccountId(fallbackAccountId);
      setChannelDraftIsNewAccount(false);
      setChannelDraft(buildChannelSetupDraft(nextEntry, fallbackAccountId));
      setFlash(`${selectedChannelEntry.template.label} supprime du runtime.`);
    } catch (channelError) {
      setError(channelError instanceof Error ? channelError.message : String(channelError));
    } finally {
      setChannelActionBusy("");
    }
  }

  const snapshotReady = Boolean(snapshot);
  const agents = snapshot?.agents || [];
  const sessions = snapshot?.sessions || [];
  const files = snapshot?.files || [];
  const memories = snapshot?.memories || [];
  const workspaces = snapshot?.workspaces || [];
  const channels = snapshot?.channels || [];
  const channelEntries = channelCatalog?.entries || [];
  const channelTemplateById = useMemo(
    () => new Map(channelEntries.map((entry) => [entry.id, entry.template])),
    [channelEntries],
  );
  const managedOutputRouteChannels = useMemo(
    () =>
      [...channels]
        .filter((channel) => isManagedOutputRouteChannel(channel))
        .toSorted((left, right) =>
          buildChannelRouteSummary(left, channelTemplateById.get(left.kind)).localeCompare(
            buildChannelRouteSummary(right, channelTemplateById.get(right.kind)),
          ),
        ),
    [channels, channelTemplateById],
  );
  const outputRouteChannels = managedOutputRouteChannels;
  const runtimeTransportChannels = useMemo(
    () =>
      [...channels]
        .filter((channel) => isRuntimeTransportChannel(channel))
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    [channels],
  );
  const runtimeDestinationChannels = useMemo(
    () =>
      [...channels]
        .filter((channel) => isDetectedDestinationChannel(channel))
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [channels],
  );
  const systemChannelSurfaces = useMemo(
    () =>
      [...channels]
        .filter((channel) => isSystemChannelSurface(channel))
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    [channels],
  );
  const users = snapshot?.users || [];
  const teams = snapshot?.teams || [];
  const projects = snapshot?.projects || [];
  const grants = snapshot?.grants || [];
  const agentBindings = snapshot?.agentBindings || [];
  const agentBindingByAgentId = useMemo(
    () => new Map(agentBindings.map((binding) => [binding.agentId, binding])),
    [agentBindings],
  );
  const pipelines = snapshot?.pipelines || [];
  const cronJobs = snapshot?.cronJobs || [];
  const runtimeDiscoveredSkills = snapshot?.skills || [];
  const runtimeModels = (snapshot?.runtimeModels || []).filter(
    (model) => normalizeProviderId(model.provider) === CLIPROXY_PROVIDER_ID,
  );
  const runtimeDefaults = snapshot?.runtimeDefaults || {
    agentPrimaryModelRef: undefined,
    agentFallbackModelRefs: [],
  };
  const providerBridges = snapshot?.providerBridges || [];
  const availableSkillOptions = useMemo<AgentScopedSkillOption[]>(() => {
    const knownLibraries = skillsCatalog?.libraries || [];
    const runtimeEntries = runtimeDiscoveredSkills.map((entry) => {
      const matchingLibrary = knownLibraries.find((library) => {
        const rootPath = library.rootPath.replace(/\/+$/, "");
        return (
          entry.filePath === rootPath ||
          entry.filePath.startsWith(`${rootPath}/`) ||
          entry.baseDir === rootPath ||
          entry.baseDir.startsWith(`${rootPath}/`)
        );
      });
      return {
        ...entry,
        libraryId: matchingLibrary?.id,
        kind: matchingLibrary?.kind,
        agentId: matchingLibrary?.agentId,
        agentLabel: matchingLibrary?.agentLabel,
      };
    });
    const catalogEntries = (skillsCatalog?.skills || []).map((entry) => ({
      name: entry.name,
      description: entry.description,
      filePath: entry.filePath,
      baseDir: entry.baseDir,
      source: entry.source,
      disableModelInvocation: entry.disableModelInvocation,
      libraryId: entry.libraryId,
      kind: entry.kind,
      agentId: entry.agentId,
      agentLabel: entry.agentLabel,
      updatedAtMs: entry.updatedAtMs,
    }));
    return [...runtimeEntries, ...catalogEntries];
  }, [runtimeDiscoveredSkills, skillsCatalog?.libraries, skillsCatalog?.skills]);
  const activeRuntimeProviderIds = useMemo(() => [CLIPROXY_PROVIDER_ID], []);
  const selectedDashboardUser = useMemo(
    () =>
      selectedDashboardUserId === DASHBOARD_ROOT_USER_ID
        ? null
        : users.find((entry) => entry.id === selectedDashboardUserId) || null,
    [selectedDashboardUserId, users],
  );
  const currentUserCanManageAdminViews =
    !selectedDashboardUser ||
    (selectedDashboardUser.role === "admin" && selectedDashboardUser.status === "active");
  const currentUserCanOperate =
    !selectedDashboardUser ||
    (selectedDashboardUser.status === "active" && selectedDashboardUser.role !== "viewer");
  const currentUserReadOnly =
    Boolean(selectedDashboardUser) &&
    (!currentUserCanOperate || selectedDashboardUser.status !== "active");
  const selectedDashboardAvailableTeamIds = useMemo(() => {
    if (!selectedDashboardUser) {
      return teams.map((team) => team.id);
    }
    const ids = new Set(selectedDashboardUser.teamIds);
    for (const team of teams) {
      if (team.memberIds.includes(selectedDashboardUser.id)) {
        ids.add(team.id);
      }
    }
    return Array.from(ids).sort((left, right) => left.localeCompare(right));
  }, [selectedDashboardUser, teams]);
  const selectedDashboardUserTeamIds = useMemo(() => {
    if (!selectedDashboardUser || currentUserCanManageAdminViews) {
      return teams.map((team) => team.id);
    }
    if (
      selectedDashboardTeamScopeId !== DASHBOARD_ALL_TEAMS_SCOPE_ID &&
      selectedDashboardAvailableTeamIds.includes(selectedDashboardTeamScopeId)
    ) {
      return [selectedDashboardTeamScopeId];
    }
    return selectedDashboardAvailableTeamIds;
  }, [
    currentUserCanManageAdminViews,
    selectedDashboardAvailableTeamIds,
    selectedDashboardTeamScopeId,
    selectedDashboardUser,
    teams,
  ]);
  const selectedDashboardAvailableProjects = useMemo(() => {
    const scopedTeamIds = new Set(selectedDashboardUserTeamIds);
    const actorUserId = selectedDashboardUser?.id;
    return projects
      .filter((project) => {
        if (scopedTeamIds.size > 0 && !scopedTeamIds.has(project.teamId)) {
          return false;
        }
        if (!actorUserId || currentUserCanManageAdminViews) {
          return true;
        }
        return project.memberIds.length === 0 || project.memberIds.includes(actorUserId);
      })
      .toSorted((left, right) => left.name.localeCompare(right.name));
  }, [
    currentUserCanManageAdminViews,
    projects,
    selectedDashboardUser?.id,
    selectedDashboardUserTeamIds,
  ]);
  const selectedDashboardScopedTeam = useMemo(
    () =>
      !currentUserCanManageAdminViews &&
      selectedDashboardTeamScopeId !== DASHBOARD_ALL_TEAMS_SCOPE_ID
        ? teams.find((team) => team.id === selectedDashboardTeamScopeId) || null
        : null,
    [currentUserCanManageAdminViews, selectedDashboardTeamScopeId, teams],
  );
  const selectedDashboardProject = useMemo(
    () =>
      selectedDashboardProjectId !== DASHBOARD_NO_PROJECT_ID
        ? selectedDashboardAvailableProjects.find((project) => project.id === selectedDashboardProjectId) ||
          null
        : null,
    [selectedDashboardAvailableProjects, selectedDashboardProjectId],
  );
  const selectedDashboardUserAgentIds = useMemo(() => {
    if (!selectedDashboardUser) {
      return agents.map((agent) => agent.id);
    }
    const includeLegacyDirectAssignments =
      currentUserCanManageAdminViews ||
      selectedDashboardTeamScopeId === DASHBOARD_ALL_TEAMS_SCOPE_ID;
    const ids = new Set(includeLegacyDirectAssignments ? selectedDashboardUser.agentIds : []);
    for (const team of teams) {
      if (!selectedDashboardUserTeamIds.includes(team.id)) {
        continue;
      }
      for (const agentId of team.agentIds) {
        ids.add(agentId);
      }
    }
    return Array.from(ids).sort((left, right) => left.localeCompare(right));
  }, [
    agents,
    currentUserCanManageAdminViews,
    selectedDashboardTeamScopeId,
    selectedDashboardUser,
    selectedDashboardUserTeamIds,
    teams,
  ]);
  const selectedDashboardUserChannelIds = useMemo(() => {
    if (!selectedDashboardUser) {
      return outputRouteChannels.map((channel) => channel.id);
    }
    const includeLegacyDirectAssignments =
      currentUserCanManageAdminViews ||
      selectedDashboardTeamScopeId === DASHBOARD_ALL_TEAMS_SCOPE_ID;
    const ids = new Set(includeLegacyDirectAssignments ? selectedDashboardUser.channelIds : []);
    for (const team of teams) {
      if (!selectedDashboardUserTeamIds.includes(team.id)) {
        continue;
      }
      for (const channelId of getTeamOwnedOutputChannelIds(team.id)) {
        ids.add(channelId);
      }
    }
    for (const agentId of selectedDashboardUserAgentIds) {
      const binding = getAgentBinding(agentId);
      if (!binding) {
        continue;
      }
      for (const channelId of binding.channelIds) {
        ids.add(channelId);
      }
      for (const channelId of binding.defaultOutputChannelIds) {
        ids.add(channelId);
      }
    }
    return Array.from(ids).sort((left, right) => left.localeCompare(right));
  }, [
    agentBindings,
    currentUserCanManageAdminViews,
    outputRouteChannels,
    selectedDashboardUserAgentIds,
    selectedDashboardTeamScopeId,
    selectedDashboardUser,
    selectedDashboardUserTeamIds,
    teams,
  ]);
  const selectedDashboardUserTeamIdSet = useMemo(
    () => new Set(selectedDashboardUserTeamIds),
    [selectedDashboardUserTeamIds],
  );
  const selectedDashboardUserAgentIdSet = useMemo(
    () => new Set(selectedDashboardUserAgentIds),
    [selectedDashboardUserAgentIds],
  );
  const selectedDashboardUserChannelIdSet = useMemo(
    () => new Set(selectedDashboardUserChannelIds),
    [selectedDashboardUserChannelIds],
  );

  function grantPermissionRank(permission: "view" | "operate" | "admin") {
    if (permission === "admin") {
      return 3;
    }
    if (permission === "operate") {
      return 2;
    }
    return 1;
  }

  function selectedDashboardHasGrant(
    resourceType: "agent" | "skill" | "channel" | "pipeline" | "workspace" | "provider" | "cron" | "*",
    resourceId: string,
    minimumPermission: "view" | "operate" | "admin",
  ) {
    if (!selectedDashboardUser) {
      return true;
    }
    return grants.some((grant) => {
      const matchesSubject =
        (grant.subjectType === "user" && grant.subjectId === selectedDashboardUser.id) ||
        (grant.subjectType === "team" && selectedDashboardUserTeamIdSet.has(grant.subjectId));
      if (!matchesSubject) {
        return false;
      }
      const matchesResourceType =
        grant.resourceType === "*" || grant.resourceType === resourceType;
      const matchesResourceId = grant.resourceId === "*" || grant.resourceId === resourceId;
      return (
        matchesResourceType &&
        matchesResourceId &&
        grantPermissionRank(grant.permission) >= grantPermissionRank(minimumPermission)
      );
    });
  }

  function selectedDashboardHasAnyGrant(
    resourceType: "agent" | "skill" | "channel" | "pipeline" | "workspace" | "provider" | "cron" | "*",
    minimumPermission: "view" | "operate" | "admin",
  ) {
    return selectedDashboardHasGrant(resourceType, "*", minimumPermission);
  }

  function canViewAgentRecord(agentId: string) {
    return (
      currentUserCanManageAdminViews ||
      selectedDashboardUserAgentIdSet.has(agentId) ||
      selectedDashboardHasGrant("agent", agentId, "view")
    );
  }

  function canOperateAgentRecord(agentId: string) {
    if (currentUserCanManageAdminViews) {
      return true;
    }
    return (
      currentUserCanOperate &&
      (selectedDashboardUserAgentIdSet.has(agentId) ||
        selectedDashboardHasGrant("agent", agentId, "operate"))
    );
  }

  function hasImplicitPipelineAccess(pipeline: PipelineRecord) {
    if (pipeline.teamId && selectedDashboardUserTeamIdSet.has(pipeline.teamId)) {
      return true;
    }
    if (pipeline.agentIds.some((agentId) => selectedDashboardUserAgentIdSet.has(agentId))) {
      return true;
    }
    return pipeline.steps.some((step) => selectedDashboardUserAgentIdSet.has(step.agentId));
  }

  function canViewPipelineRecord(pipeline: PipelineRecord) {
    return (
      currentUserCanManageAdminViews ||
      hasImplicitPipelineAccess(pipeline) ||
      selectedDashboardHasGrant("pipeline", pipeline.id, "view")
    );
  }

  function canOperatePipelineRecord(pipeline: PipelineRecord) {
    if (currentUserCanManageAdminViews) {
      return true;
    }
    return (
      currentUserCanOperate &&
      (hasImplicitPipelineAccess(pipeline) ||
        selectedDashboardHasGrant("pipeline", pipeline.id, "operate"))
    );
  }

  function canViewCronJobRecord(job: CronJobRecord) {
    if (currentUserCanManageAdminViews) {
      return true;
    }
    if (selectedDashboardHasGrant("cron", job.id, "view")) {
      return true;
    }
    if (job.pipelineId) {
      const pipeline = pipelines.find((entry) => entry.id === job.pipelineId);
      if (pipeline) {
        return canViewPipelineRecord(pipeline);
      }
    }
    if (job.agentId) {
      return canViewAgentRecord(job.agentId);
    }
    return false;
  }

  function canViewSessionRecord(session: DashboardSession) {
    if (currentUserCanManageAdminViews) {
      return true;
    }
    if (selectedDashboardHasGrant("agent", session.agentId, "view")) {
      return true;
    }
    if (session.pipelineId) {
      const pipeline = pipelines.find((entry) => entry.id === session.pipelineId);
      if (pipeline) {
        return canViewPipelineRecord(pipeline);
      }
    }
    return canViewAgentRecord(session.agentId);
  }

  function canOperateSessionRecord(session?: DashboardSession | null) {
    if (!session) {
      return false;
    }
    if (currentUserCanManageAdminViews) {
      return true;
    }
    if (!currentUserCanOperate) {
      return false;
    }
    if (selectedDashboardHasGrant("agent", session.agentId, "operate")) {
      return true;
    }
    if (session.pipelineId) {
      const pipeline = pipelines.find((entry) => entry.id === session.pipelineId);
      if (pipeline) {
        return canOperatePipelineRecord(pipeline);
      }
    }
    return selectedDashboardUserAgentIdSet.has(session.agentId);
  }

  function canViewChannelRoute(channelId: string) {
    return (
      currentUserCanManageAdminViews ||
      selectedDashboardUserChannelIdSet.has(channelId) ||
      selectedDashboardHasGrant("channel", channelId, "view")
    );
  }

  function canOperateChannelRoute(channelId?: string) {
    if (currentUserCanManageAdminViews) {
      return true;
    }
    if (!currentUserCanOperate) {
      return false;
    }
    if (!channelId) {
      return (
        selectedDashboardUserTeamIds.length > 0 || selectedDashboardHasAnyGrant("channel", "operate")
      );
    }
    return (
      selectedDashboardUserChannelIdSet.has(channelId) ||
      selectedDashboardHasGrant("channel", channelId, "operate")
    );
  }

  function canEditChannelRoutes() {
    return canOperateChannelRoute();
  }

  function defaultDashboardView() {
    if (currentUserCanManageAdminViews) {
      return "mission-control";
    }
    if (
      selectedDashboardUserAgentIds.length > 0 ||
      selectedDashboardHasAnyGrant("agent", "view")
    ) {
      return "chat";
    }
    if (
      selectedDashboardUserTeamIds.length > 0 ||
      selectedDashboardHasAnyGrant("channel", "view") ||
      selectedDashboardHasAnyGrant("pipeline", "view") ||
      selectedDashboardHasAnyGrant("cron", "view")
    ) {
      return "channels";
    }
    return "mission-control";
  }

  function isViewVisible(viewId: DashboardViewId) {
    switch (viewId) {
      case "agents":
      case "files":
      case "memory":
      case "runtime":
      case "workspaces":
      case "skills":
      case "providers":
      case "users":
      case "access":
        return currentUserCanManageAdminViews;
      case "channels":
        return (
          currentUserCanManageAdminViews ||
          selectedDashboardUserTeamIds.length > 0 ||
          selectedDashboardHasAnyGrant("channel", "view")
        );
      case "chat":
        return (
          currentUserCanManageAdminViews ||
          selectedDashboardUserAgentIds.length > 0 ||
          selectedDashboardHasAnyGrant("agent", "view")
        );
      case "pipelines":
      case "cron":
        return (
          currentUserCanManageAdminViews ||
          selectedDashboardUserTeamIds.length > 0 ||
          selectedDashboardHasAnyGrant(viewId === "cron" ? "cron" : "pipeline", "view")
        );
      case "mission-control":
      default:
        return true;
    }
  }

  const visibleAgents = useMemo(
    () =>
      currentUserCanManageAdminViews
        ? agents
        : agents.filter((agent) => canViewAgentRecord(agent.id)),
    [agents, currentUserCanManageAdminViews, selectedDashboardUserAgentIdSet],
  );
  const visibleUsers = useMemo(
    () =>
      currentUserCanManageAdminViews ? users : selectedDashboardUser ? [selectedDashboardUser] : [],
    [currentUserCanManageAdminViews, selectedDashboardUser, users],
  );
  const visibleTeams = useMemo(
    () =>
      currentUserCanManageAdminViews
        ? teams
        : teams.filter((team) => selectedDashboardUserTeamIdSet.has(team.id)),
    [currentUserCanManageAdminViews, selectedDashboardUserTeamIdSet, teams],
  );
  const visibleOutputRouteChannels = useMemo(
    () =>
      currentUserCanManageAdminViews
        ? outputRouteChannels
        : outputRouteChannels.filter((channel) => canViewChannelRoute(channel.id)),
    [currentUserCanManageAdminViews, outputRouteChannels, selectedDashboardUserChannelIdSet],
  );
  const visiblePipelines = useMemo(
    () =>
      currentUserCanManageAdminViews
        ? pipelines
        : pipelines.filter((pipeline) => canViewPipelineRecord(pipeline)),
    [currentUserCanManageAdminViews, pipelines, selectedDashboardUserAgentIdSet, selectedDashboardUserTeamIdSet],
  );
  const visiblePipelineIdSet = useMemo(
    () => new Set(visiblePipelines.map((pipeline) => pipeline.id)),
    [visiblePipelines],
  );
  const visibleCronJobs = useMemo(
    () =>
      currentUserCanManageAdminViews
        ? cronJobs
        : cronJobs.filter((job) => canViewCronJobRecord(job)),
    [cronJobs, currentUserCanManageAdminViews, selectedDashboardUserAgentIdSet, selectedDashboardUserTeamIdSet, visiblePipelines],
  );
  const visibleCronJobIdSet = useMemo(
    () => new Set(visibleCronJobs.map((job) => job.id)),
    [visibleCronJobs],
  );
  const visibleSessions = useMemo(
    () =>
      currentUserCanManageAdminViews
        ? sessions
        : sessions.filter((session) => canViewSessionRecord(session)),
    [currentUserCanManageAdminViews, pipelines, selectedDashboardUserAgentIdSet, selectedDashboardUserTeamIdSet, sessions],
  );
  const visibleFiles = useMemo(
    () =>
      currentUserCanManageAdminViews
        ? files
        : files.filter((file) => selectedDashboardUserAgentIdSet.has(file.agentId)),
    [currentUserCanManageAdminViews, files, selectedDashboardUserAgentIdSet],
  );
  const visibleMemories = useMemo(
    () =>
      currentUserCanManageAdminViews
        ? memories
        : memories.filter((memory) => selectedDashboardUserAgentIdSet.has(memory.agentId)),
    [currentUserCanManageAdminViews, memories, selectedDashboardUserAgentIdSet],
  );
  const visibleWorkspaces = useMemo(
    () =>
      currentUserCanManageAdminViews
        ? workspaces
        : workspaces.filter((workspace) => selectedDashboardUserAgentIdSet.has(workspace.agentId)),
    [currentUserCanManageAdminViews, selectedDashboardUserAgentIdSet, workspaces],
  );
  const visibleNavItems = useMemo(
    () => NAV_ITEMS.filter((item) => isViewVisible(item.id)),
    [currentUserCanManageAdminViews, selectedDashboardUserAgentIds.length, selectedDashboardUserTeamIds.length],
  );
  const activeViewMeta = useMemo(
    () =>
      visibleNavItems.find((item) => item.id === view) ||
      NAV_ITEMS.find((item) => item.id === view) ||
      NAV_ITEMS[0],
    [view, visibleNavItems],
  );
  const routeOwnerOptions = currentUserCanManageAdminViews
    ? visibleUsers
    : selectedDashboardUser
      ? [selectedDashboardUser]
      : [];
  const scopedOverview = useMemo(
    () => ({
      agentCount: visibleAgents.length,
      runningAgents: visibleAgents.filter((agent) => agent.currentStatus === "running").length,
      sessionCount: visibleSessions.length,
      runningSessions: visibleSessions.filter((session) => session.activityStatus === "running").length,
      pipelineCount: visiblePipelines.length,
      activePipelines: visiblePipelines.filter((pipeline) =>
        ["queued", "running"].includes(pipeline.status),
      ).length,
      cronCount: visibleCronJobs.length,
      activeCronJobs: visibleCronJobs.filter((job) =>
        ["running", "active"].includes(job.activityStatus),
      ).length,
    }),
    [visibleAgents, visibleCronJobs, visiblePipelines, visibleSessions],
  );
  const kanbanLanes = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return buildKanbanLanes({
      ...snapshot,
      agents: visibleAgents,
      sessions: visibleSessions,
      files: visibleFiles,
      memories: visibleMemories,
      workspaces: visibleWorkspaces,
      pipelines: visiblePipelines,
      cronJobs: visibleCronJobs,
      users: visibleUsers,
      teams: visibleTeams,
      channels: currentUserCanManageAdminViews ? channels : visibleOutputRouteChannels,
      grants,
    });
  }, [
    channels,
    currentUserCanManageAdminViews,
    grants,
    snapshot,
    visibleAgents,
    visibleCronJobs,
    visibleFiles,
    visibleMemories,
    visibleOutputRouteChannels,
    visiblePipelines,
    visibleSessions,
    visibleTeams,
    visibleUsers,
    visibleWorkspaces,
  ]);
  const dashboardActorLabel = selectedDashboardUser ? selectedDashboardUser.name : "Admin local Elytras";
  const dashboardActorHint = selectedDashboardUser
    ? `${selectedDashboardUser.role} · ${selectedDashboardUser.status}`
    : "Vue root non filtree";
  const dashboardTeamScopeLabel = selectedDashboardScopedTeam
    ? selectedDashboardScopedTeam.name
    : selectedDashboardUser
      ? summarizeLabels(selectedDashboardAvailableTeamIds.map(teamName), 2, "aucune")
      : "Toutes les equipes";
  const dashboardProjectScopeLabel = selectedDashboardProject ? selectedDashboardProject.name : "Perso / agent";
  const gatewayDisplayUrl = snapshot?.meta.gatewayHttpUrl || normalizeBaseUrl(config.baseUrl);
  const heroSummaryText = selectedDashboardUser
    ? `Contexte ${dashboardActorLabel} sur ${dashboardTeamScopeLabel.toLowerCase()} avec memoire ${dashboardProjectScopeLabel.toLowerCase()}.`
    : "Vue operateur globale sur le runtime local, sans filtre de gouvernance.";

  function denyDashboardAction(message: string) {
    setError(message);
    return false;
  }

  function ensureAdminAccess(message: string) {
    return currentUserCanManageAdminViews ? true : denyDashboardAction(message);
  }

  function ensureOperationalAccess(message: string) {
    return currentUserCanOperate ? true : denyDashboardAction(message);
  }

  function canMutateStoreResource(
    action: "create" | "patch" | "delete",
    resource: string,
    id?: string,
  ) {
    if (currentUserCanManageAdminViews) {
      return true;
    }
    switch (resource) {
      case "pipelines":
        return action === "create" || (id ? visiblePipelineIdSet.has(id) : true);
      case "cronJobs":
        return action === "create" || (id ? visibleCronJobIdSet.has(id) : true);
      case "channels":
        return action === "create" ? canEditChannelRoutes() : (id ? canOperateChannelRoute(id) : true);
      default:
        return false;
    }
  }

  useEffect(() => {
    if (
      selectedDashboardUserId !== DASHBOARD_ROOT_USER_ID &&
      !users.some((user) => user.id === selectedDashboardUserId)
    ) {
      setSelectedDashboardUserId(DASHBOARD_ROOT_USER_ID);
    }
  }, [selectedDashboardUserId, users]);

  useEffect(() => {
    if (
      !selectedDashboardUser ||
      currentUserCanManageAdminViews ||
      selectedDashboardAvailableTeamIds.length <= 1
    ) {
      if (selectedDashboardTeamScopeId !== DASHBOARD_ALL_TEAMS_SCOPE_ID) {
        setSelectedDashboardTeamScopeId(DASHBOARD_ALL_TEAMS_SCOPE_ID);
      }
      return;
    }
    if (
      selectedDashboardTeamScopeId !== DASHBOARD_ALL_TEAMS_SCOPE_ID &&
      !selectedDashboardAvailableTeamIds.includes(selectedDashboardTeamScopeId)
    ) {
      setSelectedDashboardTeamScopeId(DASHBOARD_ALL_TEAMS_SCOPE_ID);
    }
  }, [
    currentUserCanManageAdminViews,
    selectedDashboardAvailableTeamIds,
    selectedDashboardTeamScopeId,
    selectedDashboardUser,
  ]);

  useEffect(() => {
    if (
      selectedDashboardProjectId !== DASHBOARD_NO_PROJECT_ID &&
      !selectedDashboardAvailableProjects.some((project) => project.id === selectedDashboardProjectId)
    ) {
      setSelectedDashboardProjectId(DASHBOARD_NO_PROJECT_ID);
    }
  }, [selectedDashboardAvailableProjects, selectedDashboardProjectId]);

  useEffect(() => {
    if (visibleNavItems.some((item) => item.id === view)) {
      return;
    }
    setView(defaultDashboardView());
  }, [view, visibleNavItems]);

  useEffect(() => {
    if (currentUserCanManageAdminViews || chatWorkspaceMode !== "system") {
      return;
    }
    setChatWorkspaceMode("elytras");
  }, [chatWorkspaceMode, currentUserCanManageAdminViews]);

  useEffect(() => {
    const projectStillVisible =
      chatDraft.projectId === DASHBOARD_NO_PROJECT_ID ||
      selectedDashboardAvailableProjects.some((project) => project.id === chatDraft.projectId);
    const nextProjectId = projectStillVisible
      ? chatDraft.projectId
      : selectedDashboardProjectId !== DASHBOARD_NO_PROJECT_ID
        ? selectedDashboardProjectId
        : DASHBOARD_NO_PROJECT_ID;
    if (nextProjectId === chatDraft.projectId) {
      return;
    }
    setChatDraft((current) => ({
      ...current,
      projectId: nextProjectId,
    }));
  }, [chatDraft.projectId, selectedDashboardAvailableProjects, selectedDashboardProjectId]);

  useEffect(() => {
    if (!selectedSessionKey) {
      return;
    }
    if (selectedSessionKey === pendingSelectedSessionKeyRef.current) {
      return;
    }
    if (visibleSessions.some((session) => session.key === selectedSessionKey)) {
      return;
    }
    setSelectedSessionKey("");
    setHistory(null);
  }, [selectedSessionKey, visibleSessions]);

  useEffect(() => {
    const pendingSelectedSessionKey = pendingSelectedSessionKeyRef.current;
    if (!pendingSelectedSessionKey) {
      return;
    }
    if (!visibleSessions.some((session) => session.key === pendingSelectedSessionKey)) {
      return;
    }
    pendingSelectedSessionKeyRef.current = "";
    setSelectedSessionKey((current) =>
      current === pendingSelectedSessionKey ? current : pendingSelectedSessionKey,
    );
  }, [visibleSessions]);

  useEffect(() => {
    if (selectedSessionKey || !visibleSessions[0]?.key) {
      return;
    }
    setSelectedSessionKey(visibleSessions[0].key);
  }, [selectedSessionKey, visibleSessions]);

  useEffect(() => {
    if (sessionAgentFilter === "all") {
      return;
    }
    if (visibleAgents.some((agent) => agent.id === sessionAgentFilter)) {
      return;
    }
    setSessionAgentFilter("all");
  }, [sessionAgentFilter, visibleAgents]);

  useEffect(() => {
    if (!visibleAgents.length) {
      if (chatDraft.agentId) {
        setChatDraft((current) => ({ ...current, agentId: "" }));
      }
      return;
    }
    if (chatDraft.agentId && visibleAgents.some((agent) => agent.id === chatDraft.agentId)) {
      return;
    }
    setChatDraft((current) => ({ ...current, agentId: visibleAgents[0]?.id || "" }));
  }, [chatDraft.agentId, visibleAgents]);

  useEffect(() => {
    if (!selectedFileKey) {
      return;
    }
    if (visibleFiles.some((file) => `${file.agentId}:${file.name}` === selectedFileKey)) {
      return;
    }
    setSelectedFileKey("");
  }, [selectedFileKey, visibleFiles]);

  useEffect(() => {
    if (selectedFileKey || !visibleFiles[0]) {
      return;
    }
    setSelectedFileKey(`${visibleFiles[0].agentId}:${visibleFiles[0].name}`);
  }, [selectedFileKey, visibleFiles]);

  useEffect(() => {
    if (!selectedMemoryKey) {
      return;
    }
    if (visibleMemories.some((memory) => `${memory.agentId}:${memory.name}` === selectedMemoryKey)) {
      return;
    }
    setSelectedMemoryKey("");
  }, [selectedMemoryKey, visibleMemories]);

  useEffect(() => {
    if (selectedMemoryKey || !visibleMemories[0]) {
      return;
    }
    setSelectedMemoryKey(`${visibleMemories[0].agentId}:${visibleMemories[0].name}`);
  }, [selectedMemoryKey, visibleMemories]);

  useEffect(() => {
    if (!editingUserId) {
      return;
    }
    if (users.some((user) => user.id === editingUserId)) {
      return;
    }
    resetUserEditor();
  }, [editingUserId, users]);

  useEffect(() => {
    if (!editingTeamId) {
      return;
    }
    if (teams.some((team) => team.id === editingTeamId)) {
      return;
    }
    resetTeamEditor();
  }, [editingTeamId, teams]);

  useEffect(() => {
    if (pipelineEditorMode !== "create") {
      return;
    }
    setPipelineForm((current) => {
      const fallbackTeamId = visibleTeams[0]?.id || "";
      const resolvedTeamId =
        current.teamId && visibleTeams.some((team) => team.id === current.teamId)
          ? current.teamId
          : fallbackTeamId;
      const scopedAgents = getTeamOwnedAgents(resolvedTeamId);
      const fallbackAgentId = scopedAgents[0]?.id || visibleAgents[0]?.id || "main";
      const scopedChannelIds = new Set(
        getTeamScopedOutputChannels(resolvedTeamId).map((channel) => channel.id),
      );
      const currentOutputTargets = splitList(current.outputTargets);
      const nextOutputTargets = currentOutputTargets.filter((channelId) =>
        scopedChannelIds.has(channelId),
      );
      let changed =
        resolvedTeamId !== current.teamId ||
        !areStringListsEqual(nextOutputTargets, currentOutputTargets);
      const nextSteps = current.steps.map((step) => {
        const nextAgentId = scopedAgents.some((agent) => agent.id === step.agentId)
          ? step.agentId
          : fallbackAgentId;
        const nextStepOutputTargets = step.outputTargets.filter((channelId) =>
          scopedChannelIds.has(channelId),
        );
        if (
          nextAgentId !== step.agentId ||
          !areStringListsEqual(nextStepOutputTargets, step.outputTargets)
        ) {
          changed = true;
          return {
            ...step,
            agentId: nextAgentId,
            outputTargets: nextStepOutputTargets,
          };
        }
        return step;
      });
      if (!changed) {
        return current;
      }
      return {
        ...current,
        teamId: resolvedTeamId,
        outputTargets: nextOutputTargets.join(","),
        steps: nextSteps,
      };
    });
  }, [
    currentUserCanManageAdminViews,
    pipelineEditorMode,
    teams,
    visibleAgents,
    visibleOutputRouteChannels,
    visibleTeams,
  ]);

  useEffect(() => {
    setCronForm((current) => {
      const nextAgentId =
        current.agentId && visibleAgents.some((agent) => agent.id === current.agentId)
          ? current.agentId
          : "";
      const nextPipelineId =
        current.pipelineId && visiblePipelines.some((pipeline) => pipeline.id === current.pipelineId)
          ? current.pipelineId
          : "";
      const nextOwnerId =
        currentUserCanManageAdminViews ? current.ownerId : selectedDashboardUser?.id || current.ownerId;
      if (
        nextAgentId === current.agentId &&
        nextPipelineId === current.pipelineId &&
        nextOwnerId === current.ownerId
      ) {
        return current;
      }
      return {
        ...current,
        agentId: nextAgentId,
        pipelineId: nextPipelineId,
        ownerId: nextOwnerId,
      };
    });
  }, [currentUserCanManageAdminViews, selectedDashboardUser?.id, visibleAgents, visiblePipelines]);

  useEffect(() => {
    if (pipelineEditorMode !== "edit" || !editingPipelineId) {
      return;
    }
    if (visiblePipelines.some((pipeline) => pipeline.id === editingPipelineId)) {
      return;
    }
    resetPipelineBuilder();
  }, [editingPipelineId, pipelineEditorMode, visiblePipelines]);

  useEffect(() => {
    if (!selectedPipelineRunId) {
      return;
    }
    if (pipelineRunSummaries.some((run) => run.id === selectedPipelineRunId && visiblePipelineIdSet.has(run.pipelineId))) {
      return;
    }
    setSelectedPipelineRunId("");
    setSelectedPipelineRunDetail(null);
  }, [pipelineRunSummaries, selectedPipelineRunId, visiblePipelineIdSet]);

  useEffect(() => {
    setMemoryEngineForm(
      createMemoryEngineForm(memoryEngineStatus, runtimeDefaults.agentPrimaryModelRef),
    );
  }, [memoryEngineStatus, runtimeDefaults.agentPrimaryModelRef]);
  const sortedSessions = useMemo(
    () =>
      [...visibleSessions].toSorted((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0)),
    [visibleSessions],
  );
  const inboxSessionChannels = useMemo(
    () =>
      Array.from(
        new Set(
          visibleSessions
            .filter(
              (session) =>
                !isPipelineSessionLike(session, pipelines) &&
                session.sessionKind === "chat" &&
                Boolean(session.channel),
            )
            .map((session) => session.channel || "")
            .filter(Boolean),
        ),
      ).toSorted((left, right) => left.localeCompare(right)),
    [pipelines, visibleSessions],
  );
  const filteredSessions = useMemo(() => {
    const query = sessionSearch.trim().toLowerCase();
    return sortedSessions.filter((session) => {
      if (isPipelineSessionLike(session, pipelines)) {
        return false;
      }
      const matchesAgent = sessionAgentFilter === "all" || session.agentId === sessionAgentFilter;
      if (!matchesAgent) {
        return false;
      }
      const matchesWorkspace =
        chatWorkspaceMode === "elytras"
          ? getSessionWorkspaceMode(session) === "elytras"
          : chatWorkspaceMode === "inbox"
            ? session.sessionKind === "chat" && Boolean(session.channel)
            : session.sessionKind === "heartbeat" || session.sessionKind === "internal";
      if (!matchesWorkspace) {
        return false;
      }
      if (
        chatWorkspaceMode === "inbox" &&
        inboxChannelFilter !== "all" &&
        session.channel !== inboxChannelFilter
      ) {
        return false;
      }
      if (
        chatWorkspaceMode === "system" &&
        systemSessionFilter !== "all" &&
        session.sessionKind !== systemSessionFilter
      ) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = [
        session.displayName,
        session.derivedTitle,
        session.label,
        session.key,
        session.lastMessagePreview,
        session.agentId,
        session.sessionKind,
        session.sessionKindLabel,
        session.sessionKindDescription,
        session.channel,
        session.subject,
        session.chatType,
        session.lastTo,
        session.pipelineId,
        session.pipelineRunId,
        session.pipelineStepId,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [
    chatWorkspaceMode,
    inboxChannelFilter,
    pipelines,
    sessionAgentFilter,
    sessionSearch,
    sortedSessions,
    systemSessionFilter,
  ]);
  const sessionKindStats = useMemo(() => {
    const stats = {
      all: visibleSessions.length,
      elytras: 0,
      inbox: 0,
      chat: 0,
      pipeline: 0,
      system: 0,
      heartbeat: 0,
      internal: 0,
      webchat: 0,
    };
    for (const session of visibleSessions) {
      if (isPipelineSessionLike(session, pipelines)) {
        stats.pipeline += 1;
      } else if (session.sessionKind === "heartbeat") {
        stats.system += 1;
        stats.heartbeat += 1;
      } else if (session.sessionKind === "internal") {
        stats.system += 1;
        stats.internal += 1;
      } else if (getSessionWorkspaceMode(session) === "elytras") {
        if (session.sessionKind === "webchat") {
          stats.webchat += 1;
        }
        stats.elytras += 1;
      } else if (session.sessionKind === "chat" && session.channel) {
        stats.chat += 1;
        stats.inbox += 1;
      } else {
        stats.chat += 1;
      }
    }
    return stats;
  }, [pipelines, visibleSessions]);
  const selectedSession = visibleSessions.find((session) => session.key === selectedSessionKey);
  useEffect(() => {
    if (!selectedSession) {
      return;
    }
    const nextMode = resolveChatWorkspaceMode(selectedSession);
    setChatWorkspaceMode((current) => (current === nextMode ? current : nextMode));
  }, [selectedSession]);
  useEffect(() => {
    if (!selectedSession?.inboundPrincipal) {
      setInboundMappingIdentity("");
      setInboundMappingUserId("");
      return;
    }
    const candidateIds = selectedSession.inboundPrincipal.candidateExternalIds || [];
    const preferredIdentity =
      selectedSession.inboundPrincipal.matchedExternalId ||
      candidateIds[0] ||
      "";
    setInboundMappingIdentity((current) =>
      current && candidateIds.includes(current) ? current : preferredIdentity,
    );
    setInboundMappingUserId("");
  }, [
    selectedSession?.key,
    selectedSession?.inboundPrincipal?.matchedExternalId,
    (selectedSession?.inboundPrincipal?.candidateExternalIds || []).join("|"),
  ]);
  useEffect(() => {
    if (!selectedSession?.inboundPrincipal) {
      return;
    }
    const candidateIds = selectedSession.inboundPrincipal.candidateExternalIds || [];
    const preferredIdentity =
      selectedSession.inboundPrincipal.matchedExternalId ||
      candidateIds[0] ||
      "";
    const defaultTeamIds =
      selectedDashboardScopedTeam?.id
        ? [selectedDashboardScopedTeam.id]
        : selectedDashboardAvailableTeamIds.length === 1
          ? [selectedDashboardAvailableTeamIds[0]!]
          : [];
    setInboundNewUserDraft(createInboundUserDraft(preferredIdentity, defaultTeamIds));
  }, [
    selectedSession?.key,
    selectedSession?.inboundPrincipal?.matchedExternalId,
    (selectedSession?.inboundPrincipal?.candidateExternalIds || []).join("|"),
    selectedDashboardAvailableTeamIds.join("|"),
    selectedDashboardScopedTeam?.id,
  ]);
  useEffect(() => {
    if (!selectedSessionKey) {
      if (filteredSessions[0]?.key) {
        setSelectedSessionKey(filteredSessions[0].key);
      }
      return;
    }
    if (filteredSessions.some((session) => session.key === selectedSessionKey)) {
      return;
    }
    setSelectedSessionKey(filteredSessions[0]?.key || "");
    setHistory(null);
  }, [filteredSessions, selectedSessionKey]);
  const selectedPipelineRunSummary = useMemo(
    () =>
      pipelineRunSummaries.find(
        (run) => run.id === selectedPipelineRunId && visiblePipelineIdSet.has(run.pipelineId),
      ) || null,
    [pipelineRunSummaries, selectedPipelineRunId, visiblePipelineIdSet],
  );
  const selectedBridge = providerBridges.find((bridge) => bridge.id === selectedBridgeId);
  const selectedChannelEntry = channelEntries.find(
    (entry) => entry.id === selectedChannelTemplateId,
  );
  const selectedSessionInboundPrincipal = selectedSession?.inboundPrincipal;
  const selectedInboundMappingUser =
    users.find((entry) => entry.id === inboundMappingUserId) || null;
  const normalizedInboundMappingIdentity = inboundMappingIdentity.trim().toLowerCase();
  const inboundIdentityConflictUsers = normalizedInboundMappingIdentity
    ? users.filter((user) =>
        user.externalIdentities.some((pattern) =>
          matchExternalIdentityPatternLocal(pattern, normalizedInboundMappingIdentity).matched,
        ),
      )
    : [];
  const selectedInboundMappingConflictUsers =
    normalizedInboundMappingIdentity && selectedInboundMappingUser
      ? inboundIdentityConflictUsers.filter((user) => user.id !== selectedInboundMappingUser.id)
      : [];
  const selectedInboundMappingIdentityAlreadyPresent =
    Boolean(normalizedInboundMappingIdentity) &&
    Boolean(
      selectedInboundMappingUser?.externalIdentities.includes(normalizedInboundMappingIdentity),
    );
  const selectedInboundMappingPreview =
    selectedSession &&
    selectedSessionInboundPrincipal &&
    selectedInboundMappingUser
      ? buildInboundUserPreview(selectedInboundMappingUser, {
          targetAgentId:
            selectedSessionInboundPrincipal.targetAgentId || selectedSession.agentId,
          matchedChannelIds: selectedSessionInboundPrincipal.matchedChannelIds,
          modelProviderId: modelProviderFromRef(getSessionEffectiveModelRef(selectedSession)),
        })
      : null;
  const inboundNewUserTeamOptions = useMemo(
    () =>
      visibleTeams.map((team) => ({
        id: team.id,
        label: team.name,
        meta: `${team.agentIds.length} agent(s) · ${getTeamOwnedOutputChannelIds(team.id).size} destination(s)`,
      })),
    [visibleTeams],
  );
  const selectedInboundNewUserPreview =
    selectedSession &&
    selectedSessionInboundPrincipal &&
    normalizedInboundMappingIdentity
      ? buildInboundAccessPreviewForScope(
          {
            id: "__draft__",
            name:
              inboundNewUserDraft.name.trim() ||
              deriveInboundIdentitySeed(normalizedInboundMappingIdentity).name ||
              "nouveau user",
            role: inboundNewUserDraft.role,
            status: inboundNewUserDraft.status,
            teamIds: inboundNewUserDraft.teamIds,
            agentIds: [],
            channelIds: [],
          },
          {
            targetAgentId:
              selectedSessionInboundPrincipal.targetAgentId || selectedSession.agentId,
            matchedChannelIds: selectedSessionInboundPrincipal.matchedChannelIds,
            modelProviderId: modelProviderFromRef(getSessionEffectiveModelRef(selectedSession)),
          },
        )
      : null;
  const inboxGovernanceSessions = useMemo(
    () =>
      sortedSessions.filter(
        (session) =>
          !isPipelineSessionLike(session, pipelines) &&
          session.sessionKind === "chat" &&
          Boolean(session.channel),
      ),
    [pipelines, sortedSessions],
  );
  const inboxGovernanceStats = useMemo(() => {
    const stats = {
      total: inboxGovernanceSessions.length,
      allowed: 0,
      blocked: 0,
      unresolved: 0,
      ambiguous: 0,
    };
    for (const session of inboxGovernanceSessions) {
      const principal = session.inboundPrincipal;
      if (!principal || principal.status === "n/a") {
        stats.unresolved += 1;
        continue;
      }
      if (principal.status === "ambiguous") {
        stats.ambiguous += 1;
        continue;
      }
      if (principal.status === "unresolved") {
        stats.unresolved += 1;
        continue;
      }
      if (principal.canUseAgent) {
        stats.allowed += 1;
      } else {
        stats.blocked += 1;
      }
    }
    return stats;
  }, [inboxGovernanceSessions]);
  const inboundCoverageByUserId = useMemo(() => {
    const map = new Map<
      string,
      {
        sessionKeys: Set<string>;
        allowedSessionKeys: Set<string>;
        blockedSessionKeys: Set<string>;
        conflictSessionKeys: Set<string>;
        channelIds: Set<string>;
        agentIds: Set<string>;
      }
    >();
    for (const user of users) {
      map.set(user.id, {
        sessionKeys: new Set(),
        allowedSessionKeys: new Set(),
        blockedSessionKeys: new Set(),
        conflictSessionKeys: new Set(),
        channelIds: new Set(),
        agentIds: new Set(),
      });
    }
    for (const session of inboxGovernanceSessions) {
      const principal = session.inboundPrincipal;
      if (!principal || principal.status === "n/a") {
        continue;
      }
      const targetAgentId = principal.targetAgentId || session.agentId;
      if (principal.status === "resolved" && principal.userId && map.has(principal.userId)) {
        const coverage = map.get(principal.userId)!;
        coverage.sessionKeys.add(session.key);
        if (principal.canUseAgent) {
          coverage.allowedSessionKeys.add(session.key);
        } else {
          coverage.blockedSessionKeys.add(session.key);
        }
        for (const channelId of principal.matchedChannelIds) {
          coverage.channelIds.add(channelId);
        }
        if (targetAgentId) {
          coverage.agentIds.add(targetAgentId);
        }
      }
      if (principal.status === "ambiguous") {
        for (const userId of principal.ambiguousUserIds || []) {
          if (!map.has(userId)) {
            continue;
          }
          const coverage = map.get(userId)!;
          coverage.conflictSessionKeys.add(session.key);
          coverage.sessionKeys.add(session.key);
          for (const channelId of principal.matchedChannelIds) {
            coverage.channelIds.add(channelId);
          }
          if (targetAgentId) {
            coverage.agentIds.add(targetAgentId);
          }
        }
      }
    }
    return map;
  }, [inboxGovernanceSessions, users]);
  const inboundCoverageByTeamId = useMemo(() => {
    const map = new Map<
      string,
      {
        sessionKeys: Set<string>;
        allowedSessionKeys: Set<string>;
        blockedSessionKeys: Set<string>;
        conflictSessionKeys: Set<string>;
        channelIds: Set<string>;
        agentIds: Set<string>;
      }
    >();
    for (const team of teams) {
      map.set(team.id, {
        sessionKeys: new Set(),
        allowedSessionKeys: new Set(),
        blockedSessionKeys: new Set(),
        conflictSessionKeys: new Set(),
        channelIds: new Set(),
        agentIds: new Set(),
      });
    }
    for (const session of inboxGovernanceSessions) {
      const principal = session.inboundPrincipal;
      if (!principal || principal.status === "n/a") {
        continue;
      }
      const targetAgentId = principal.targetAgentId || session.agentId;
      if (principal.status === "resolved") {
        const coverageTeamIds =
          principal.authorizingTeamIds?.length ? principal.authorizingTeamIds : principal.teamIds;
        for (const teamId of coverageTeamIds) {
          if (!map.has(teamId)) {
            continue;
          }
          const coverage = map.get(teamId)!;
          coverage.sessionKeys.add(session.key);
          if (principal.canUseAgent) {
            coverage.allowedSessionKeys.add(session.key);
          } else {
            coverage.blockedSessionKeys.add(session.key);
          }
          for (const channelId of principal.matchedChannelIds) {
            coverage.channelIds.add(channelId);
          }
          if (targetAgentId) {
            coverage.agentIds.add(targetAgentId);
          }
        }
      }
      if (principal.status === "ambiguous") {
        for (const userId of principal.ambiguousUserIds || []) {
          const user = users.find((entry) => entry.id === userId);
          if (!user) {
            continue;
          }
          for (const teamId of resolveUserTeamIdsLocal(user)) {
            if (!map.has(teamId)) {
              continue;
            }
            const coverage = map.get(teamId)!;
            coverage.conflictSessionKeys.add(session.key);
            coverage.sessionKeys.add(session.key);
            for (const channelId of principal.matchedChannelIds) {
              coverage.channelIds.add(channelId);
            }
            if (targetAgentId) {
              coverage.agentIds.add(targetAgentId);
            }
          }
        }
      }
    }
    return map;
  }, [inboxGovernanceSessions, teams, users]);
  const selectedChannelOutputRoutes = useMemo(() => {
    if (!selectedChannelEntry) {
      return [];
    }
    const selectedAccountId = normalizeChannelAccountId(
      channelDraftIsNewAccount ? channelDraft.accountId : selectedChannelAccountId || channelDraft.accountId,
    );
    return outputRouteChannels.filter(
      (channel) =>
        channel.kind === selectedChannelEntry.id &&
        normalizeChannelAccountId(channel.accountId) === selectedAccountId,
    );
  }, [
    channelDraft.accountId,
    channelDraftIsNewAccount,
    outputRouteChannels,
    selectedChannelAccountId,
    selectedChannelEntry,
  ]);
  const selectedRuntimeTransportChannel = useMemo(() => {
    if (!selectedChannelEntry) {
      return null;
    }
    const selectedAccountId = normalizeChannelAccountId(
      selectedChannelEntry.template.accountScope === "top-level-only"
        ? "default"
        : selectedChannelAccountId || channelDraft.accountId || "default",
    );
    return (
      runtimeTransportChannels.find(
        (channel) =>
          channel.kind === selectedChannelEntry.id &&
          normalizeChannelAccountId(channel.accountId) === selectedAccountId,
      ) || null
    );
  }, [channelDraft.accountId, runtimeTransportChannels, selectedChannelAccountId, selectedChannelEntry]);
  const selectedRuntimeDestinationChannels = useMemo(() => {
    if (!selectedChannelEntry) {
      return [];
    }
    const selectedAccountId = normalizeChannelAccountId(
      selectedChannelEntry.template.accountScope === "top-level-only"
        ? "default"
        : selectedChannelAccountId || channelDraft.accountId || "default",
    );
    return runtimeDestinationChannels.filter((channel) => {
      if (channel.kind !== selectedChannelEntry.id) {
        return false;
      }
      const channelAccountId = normalizeChannelAccountId(channel.accountId);
      return channelAccountId === selectedAccountId;
    });
  }, [
    channelDraft.accountId,
    runtimeDestinationChannels,
    selectedChannelAccountId,
    selectedChannelEntry,
  ]);
  const selectedSystemChannelSurfaces = useMemo(() => {
    if (!selectedChannelEntry) {
      return [];
    }
    const selectedAccountId = normalizeChannelAccountId(
      selectedChannelEntry.template.accountScope === "top-level-only"
        ? "default"
        : selectedChannelAccountId || channelDraft.accountId || "default",
    );
    return systemChannelSurfaces.filter((channel) => {
      if (channel.kind !== selectedChannelEntry.id) {
        return false;
      }
      const channelAccountId = normalizeChannelAccountId(channel.accountId);
      return channelAccountId === selectedAccountId;
    });
  }, [
    channelDraft.accountId,
    selectedChannelAccountId,
    selectedChannelEntry,
    systemChannelSurfaces,
  ]);
  const visibleSelectedChannelOutputRoutes = useMemo(
    () =>
      currentUserCanManageAdminViews
        ? selectedChannelOutputRoutes
        : selectedChannelOutputRoutes.filter((route) => canViewChannelRoute(route.id)),
    [currentUserCanManageAdminViews, selectedChannelOutputRoutes, selectedDashboardUserChannelIdSet],
  );
  const selectedUnmappedRuntimeDestinationChannels = useMemo(
    () =>
      selectedRuntimeDestinationChannels.filter(
        (channel) =>
          !visibleSelectedChannelOutputRoutes.some((route) => channelsShareResolvedTarget(route, channel)),
      ),
    [selectedRuntimeDestinationChannels, visibleSelectedChannelOutputRoutes],
  );
  const comparableOutputRouteChannels = currentUserCanManageAdminViews
    ? outputRouteChannels
    : visibleOutputRouteChannels;
  const visibleRuntimePeerCandidates = useMemo(
    () =>
      runtimeDestinationChannels.filter(
        (channel) =>
          !comparableOutputRouteChannels.some((route) => channelsShareResolvedTarget(route, channel)),
      ),
    [comparableOutputRouteChannels, runtimeDestinationChannels],
  );
  const selectedBridgeModels = selectedBridge?.discoveredModels || [];
  const activeBridgeModels = selectedBridgeModels.filter((model) =>
    bridgeEditor.activeModelIds.includes(model.id),
  );
  const primaryBridgeModelId = bridgeEditor.primaryModelId || activeBridgeModels[0]?.id || "";
  const fallbackBridgeModelIds = activeBridgeModels
    .map((model) => model.id)
    .filter((modelId) => modelId !== primaryBridgeModelId);
  const filteredFiles = visibleFiles.filter((file) => {
    const byAgent = fileAgentFilter === "all" || file.agentId === fileAgentFilter;
    const byType =
      fileTypeFilter === "all" || file.type === fileTypeFilter || file.extension === fileTypeFilter;
    const haystack = `${file.name} ${file.path}`.toLowerCase();
    const bySearch = !fileSearch.trim() || haystack.includes(fileSearch.toLowerCase());
    return byAgent && byType && bySearch;
  });
  const filteredMemories = visibleMemories.filter(
    (memory) => memoryAgentFilter === "all" || memory.agentId === memoryAgentFilter,
  );
  const selectedFile = filteredFiles.find(
    (file) => `${file.agentId}:${file.name}` === selectedFileKey,
  );
  const selectedMemory = filteredMemories.find(
    (memory) => `${memory.agentId}:${memory.name}` === selectedMemoryKey,
  );
  const agentSessionsByAgentId = useMemo(() => {
    const groups = new Map<string, DashboardSession[]>();
    for (const session of visibleSessions) {
      const current = groups.get(session.agentId) || [];
      current.push(session);
      groups.set(session.agentId, current);
    }
    for (const [agentId, agentSessions] of groups.entries()) {
      groups.set(
        agentId,
        [...agentSessions].toSorted(
          (left, right) => (right.updatedAt || 0) - (left.updatedAt || 0),
        ),
      );
    }
    return groups;
  }, [visibleSessions]);
  const selectedAgentRecord =
    agentEditorMode === "edit"
      ? visibleAgents.find((agent) => agent.id === agentEditor.agentId) || null
      : null;
  const selectedAgentWorkspace =
    (selectedAgentRecord?.workspace?.agentId === agentEditor.agentId
      ? selectedAgentRecord.workspace
      : visibleWorkspaces.find((workspace) => workspace.agentId === agentEditor.agentId)) || null;
  const selectedAgentSessions =
    agentEditorMode === "edit" ? getAgentSessions(agentEditor.agentId) : [];
  const selectedAgentAllFiles = visibleFiles
    .filter((file) => {
      if (agentEditorMode !== "edit" || file.agentId !== agentEditor.agentId) {
        return false;
      }
      if (!isAgentMarkdownFile(file.name, file.extension)) {
        return false;
      }
      return true;
    })
    .toSorted((left, right) => {
      const typeRank = left.type === right.type ? 0 : left.type === "memory" ? 1 : -1;
      if (typeRank !== 0) {
        return typeRank;
      }
      const bootstrapRank = rankAgentMarkdownFile(left.name) - rankAgentMarkdownFile(right.name);
      if (bootstrapRank !== 0) {
        return bootstrapRank;
      }
      return left.path.localeCompare(right.path);
    });
  const selectedAgentFileMap = useMemo(
    () => new Map(selectedAgentAllFiles.map((file) => [file.name, file])),
    [selectedAgentAllFiles],
  );
  const selectedAgentFiles = selectedAgentAllFiles.filter((file) => {
    const typeMatch = agentStudioFileFilter === "all" || file.type === agentStudioFileFilter;
    const haystack = `${file.name} ${file.path}`.toLowerCase();
    const searchMatch =
      !agentStudioFileSearch.trim() ||
      haystack.includes(agentStudioFileSearch.trim().toLowerCase());
    return typeMatch && searchMatch;
  });
  const selectedAgentPinnedSurfaces = AGENT_STUDIO_PINNED_FILES.map((fileName) => {
    const file = selectedAgentFileMap.get(fileName) || null;
    const key = `${agentEditor.agentId}:${fileName}`;
    const dirty = file ? (fileContent[key] || "") !== (fileBaselineContent[key] || "") : false;
    const loaded = file ? Object.prototype.hasOwnProperty.call(fileContent, key) : false;
    const starter = buildAgentMarkdownTemplateForEditor(fileName);
    return {
      fileName,
      file,
      key,
      guide: resolveAgentMarkdownGuide(fileName),
      starter,
      state: describeAgentMarkdownStudioState(file, dirty, loaded, starter, fileContent[key]),
    };
  });
  const selectedAgentSecondarySurfaces = AGENT_STUDIO_SECONDARY_FILES.map((fileName) => {
    const file = selectedAgentFileMap.get(fileName) || null;
    const key = `${agentEditor.agentId}:${fileName}`;
    const dirty = file ? (fileContent[key] || "") !== (fileBaselineContent[key] || "") : false;
    const loaded = file ? Object.prototype.hasOwnProperty.call(fileContent, key) : false;
    const starter = buildAgentMarkdownTemplateForEditor(fileName);
    return {
      fileName,
      file,
      key,
      guide: resolveAgentMarkdownGuide(fileName),
      starter,
      state: describeAgentMarkdownStudioState(file, dirty, loaded, starter, fileContent[key]),
    };
  });
  const selectedAgentIndexedMemoryFiles = selectedAgentAllFiles.filter(
    (file) =>
      file.name === "MEMORY.md" ||
      file.name === "memory.md" ||
      file.name.startsWith("memory/"),
  );
  const selectedAgentMemorySurfaceCards = [
    ...selectedAgentPinnedSurfaces.filter(
      (surface) => surface.fileName === "AGENTS.md" || surface.fileName === "MEMORY.md",
    ),
    ...selectedAgentSecondarySurfaces.filter((surface) => surface.fileName === "memory.md"),
  ];
  const selectedAgentSupplementalFiles = selectedAgentFiles.filter(
    (file) =>
      !AGENT_STUDIO_PINNED_FILES.some((entry) => entry === file.name) &&
      !AGENT_STUDIO_SECONDARY_FILES.some((entry) => entry === file.name),
  );
  const selectedAgentPinnedReadyCount = selectedAgentPinnedSurfaces.filter(
    (surface) => Boolean(surface.file),
  ).length;
  const selectedAgentMemoryFileCount = selectedAgentAllFiles.filter(
    (file) => file.type === "memory",
  ).length;
  const selectedAgentFile = selectedAgentAllFiles.find(
    (file) => `${file.agentId}:${file.name}` === selectedAgentFileKey,
  );
  const selectedAgentFileGuide = selectedAgentFile
    ? resolveAgentMarkdownGuide(selectedAgentFile.name)
    : null;
  const selectedAgentFileStarter =
    selectedAgentFile && agentEditorMode === "edit"
      ? buildAgentMarkdownTemplateForEditor(selectedAgentFile.name)
      : "";
  const selectedAgentFileLoaded = selectedAgentFileKey
    ? Object.prototype.hasOwnProperty.call(fileContent, selectedAgentFileKey)
    : false;
  const selectedAgentFileContent = selectedAgentFileKey ? fileContent[selectedAgentFileKey] || "" : "";
  const selectedAgentFileDirty = selectedAgentFileKey
    ? selectedAgentFileContent !== (fileBaselineContent[selectedAgentFileKey] || "")
    : false;
  const memoryEngineToolNames =
    memoryEngineStatus?.managedPlugin.toolNames.length
      ? memoryEngineStatus.managedPlugin.toolNames
      : ["lcm_grep", "lcm_describe", "lcm_expand"];
  const memoryEngineSummaryModel = runtimeModels.find(
    (model) => model.ref === memoryEngineForm.summaryModel,
  );
  const memoryEngineExpansionModel = runtimeModels.find(
    (model) => model.ref === memoryEngineForm.expansionModel,
  );

  useEffect(() => {
    if (!selectedChannelEntry) {
      return;
    }
    let nextAccountId = "default";
    if (selectedChannelEntry.template.accountScope !== "top-level-only") {
      const accountIds = selectedChannelEntry.accounts.map((account) =>
        normalizeChannelAccountId(account.accountId),
      );
      if (accountIds.length) {
        const currentAccountId = normalizeChannelAccountId(
          selectedChannelAccountId || channelDraft.accountId,
        );
        const fallbackAccountId = normalizeChannelAccountId(
          selectedChannelEntry.defaultAccountId || selectedChannelEntry.accounts[0]?.accountId || "default",
        );
        nextAccountId = accountIds.includes(currentAccountId) ? currentAccountId : fallbackAccountId;
      } else {
        nextAccountId = normalizeChannelAccountId(
          selectedChannelAccountId || channelDraft.accountId || "default",
        );
      }
    }
    const draftMatchesSelection =
      channelDraft.channelId === selectedChannelEntry.id &&
      normalizeChannelAccountId(channelDraft.accountId) === nextAccountId;
    if (channelDraftIsNewAccount) {
      if (channelDraft.channelId === selectedChannelEntry.id) {
        return;
      }
      syncSelectedChannelDraft(selectedChannelEntry, nextAccountId);
      return;
    }
    if (draftMatchesSelection && normalizeChannelAccountId(selectedChannelAccountId) === nextAccountId) {
      return;
    }
    syncSelectedChannelDraft(selectedChannelEntry, nextAccountId);
  }, [
    channelDraft.accountId,
    channelDraft.channelId,
    channelDraftIsNewAccount,
    selectedChannelAccountId,
    selectedChannelEntry,
  ]);

  useEffect(() => {
    if (!selectedChannelRouteId) {
      return;
    }
    if (visibleSelectedChannelOutputRoutes.some((route) => route.id === selectedChannelRouteId)) {
      return;
    }
    resetChannelRouteEditor();
  }, [selectedChannelRouteId, visibleSelectedChannelOutputRoutes]);

  useEffect(() => {
    if (agentEditorMode !== "edit" || !agentEditor.agentId) {
      if (selectedAgentFileKey) {
        setSelectedAgentFileKey("");
      }
      return;
    }
    if (
      selectedAgentFileKey &&
      selectedAgentAllFiles.some((file) => `${file.agentId}:${file.name}` === selectedAgentFileKey)
    ) {
      return;
    }
    const fallbackFile = selectedAgentAllFiles[0];
    setSelectedAgentFileKey(fallbackFile ? `${fallbackFile.agentId}:${fallbackFile.name}` : "");
  }, [
    agentEditor.agentId,
    agentEditorMode,
    selectedAgentAllFiles,
    selectedAgentFileKey,
  ]);

  function ownerName(ownerId?: string) {
    return users.find((entry) => entry.id === ownerId)?.name || ownerId || "n/a";
  }

  function teamName(teamId?: string) {
    return teams.find((entry) => entry.id === teamId)?.name || teamId || "n/a";
  }

  function projectName(projectId?: string) {
    return projects.find((entry) => entry.id === projectId)?.name || projectId || "n/a";
  }

  function channelName(channelId?: string) {
    return channels.find((entry) => entry.id === channelId)?.name || channelId || "n/a";
  }

  function agentName(agentId?: string) {
    const agent = agents.find((entry) => entry.id === agentId);
    return agent?.identity?.name || agent?.name || agentId || "n/a";
  }

  function getProjectsForUser(userId?: string) {
    if (!userId) {
      return [];
    }
    return projects.filter(
      (project) => project.memberIds.length === 0 || project.memberIds.includes(userId),
    );
  }

  function resolveUserTeamIdsLocal(user: (typeof users)[number]) {
    const ids = new Set(user.teamIds);
    for (const team of teams) {
      if (team.memberIds.includes(user.id)) {
        ids.add(team.id);
      }
    }
    return Array.from(ids).sort((left, right) => left.localeCompare(right));
  }

  function getAgentAccessTeamIds(agentId: string, ownerTeamId?: string) {
    const ids = new Set(
      teams
        .filter((team) => team.agentIds.includes(agentId))
        .map((team) => team.id),
    );
    if (ownerTeamId) {
      ids.add(ownerTeamId);
    }
    return Array.from(ids).toSorted((left, right) => left.localeCompare(right));
  }

  function getAgentInboundTransportKeys(agentId: string) {
    return runtimeTransportChannels
      .filter((channel) => channel.inboundAgentId === agentId)
      .map((channel) => makeRuntimeTransportKey(channel))
      .toSorted((left, right) => left.localeCompare(right));
  }

  function getTeamAccessibleAgentIds(teamIds: string[]) {
    const ids = new Set<string>();
    for (const teamId of teamIds) {
      for (const agent of getTeamOwnedAgents(teamId)) {
        ids.add(agent.id);
      }
    }
    return Array.from(ids).toSorted((left, right) => left.localeCompare(right));
  }

  function getTeamAccessibleChannelIds(teamIds: string[]) {
    const ids = new Set<string>();
    for (const teamId of teamIds) {
      for (const channelId of getTeamOwnedOutputChannelIds(teamId)) {
        ids.add(channelId);
      }
    }
    return Array.from(ids).toSorted((left, right) => left.localeCompare(right));
  }

  function getUserEffectiveAgentIds(user: (typeof users)[number]) {
    return getEffectiveAgentIdsForScope(resolveUserTeamIdsLocal(user), user.agentIds);
  }

  function getUserEffectiveChannelIds(user: (typeof users)[number]) {
    return getEffectiveChannelIdsForScope(resolveUserTeamIdsLocal(user), user.channelIds);
  }

  function getEffectiveAgentIdsForScope(teamIds: string[], directAgentIds: string[] = []) {
    return Array.from(
      new Set([...directAgentIds, ...getTeamAccessibleAgentIds(teamIds)]),
    ).toSorted((left, right) => left.localeCompare(right));
  }

  function getEffectiveChannelIdsForScope(teamIds: string[], directChannelIds: string[] = []) {
    return Array.from(
      new Set([...directChannelIds, ...getTeamAccessibleChannelIds(teamIds)]),
    ).toSorted((left, right) => left.localeCompare(right));
  }

  function teamHasScopedGrantLocal(params: {
    teamId: string;
    resourceType: AccessGrant["resourceType"];
    resourceId: string;
    minimumPermission: AccessGrant["permission"];
  }) {
    return principalHasGrantLocal({
      userId: "",
      teamIds: [params.teamId],
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      minimumPermission: params.minimumPermission,
    });
  }

  function teamOwnsAgentAccessLocal(teamId: string, agentId: string) {
    if (
      teamHasScopedGrantLocal({
        teamId,
        resourceType: "agent",
        resourceId: agentId,
        minimumPermission: "operate",
      })
    ) {
      return true;
    }
    return getTeamAccessibleAgentIds([teamId]).includes(agentId);
  }

  function getTeamAgentScopedChannelIds(teamId: string, agentId: string) {
    const ids = new Set<string>();
    const team = teams.find((entry) => entry.id === teamId);
    for (const channelId of team?.channelIds || []) {
      ids.add(channelId);
    }
    const teamAgentIds = new Set(team?.agentIds || []);
    for (const binding of agentBindings) {
      const bindingTeamId =
        binding.teamId || agents.find((agent) => agent.id === binding.agentId)?.teamId || "";
      if (binding.agentId !== agentId) {
        continue;
      }
      if (bindingTeamId !== teamId && !teamAgentIds.has(agentId)) {
        continue;
      }
      for (const channelId of binding.channelIds) {
        ids.add(channelId);
      }
      for (const channelId of binding.defaultOutputChannelIds) {
        ids.add(channelId);
      }
    }
    return Array.from(ids).sort((left, right) => left.localeCompare(right));
  }

  function resolveInboundAuthorizingTeamIdsLocal(params: {
    teamIds: string[];
    targetAgentId: string;
    matchedChannelIds: string[];
  }) {
    const ids = new Set<string>();
    for (const teamId of params.teamIds) {
      if (!teamOwnsAgentAccessLocal(teamId, params.targetAgentId)) {
        continue;
      }
      const teamChannelIds = new Set(getTeamAgentScopedChannelIds(teamId, params.targetAgentId));
      const teamAllowsChannel = params.matchedChannelIds.some(
        (channelId) =>
          teamChannelIds.has(channelId) ||
          teamHasScopedGrantLocal({
            teamId,
            resourceType: "channel",
            resourceId: channelId,
            minimumPermission: "operate",
          }),
      );
      if (teamAllowsChannel) {
        ids.add(teamId);
      }
    }
    return Array.from(ids).sort((left, right) => left.localeCompare(right));
  }

  function getSubjectGrantEntries(subjectType: "user" | "team", subjectId: string) {
    return grants.filter(
      (grant) => grant.subjectType === subjectType && grant.subjectId === subjectId,
    );
  }

  function permissionRankLocal(permission: AccessGrant["permission"]) {
    switch (permission) {
      case "admin":
        return 3;
      case "operate":
        return 2;
      default:
        return 1;
    }
  }

  function principalHasGrantLocal(params: {
    userId: string;
    teamIds: string[];
    resourceType: AccessGrant["resourceType"];
    resourceId: string;
    minimumPermission: AccessGrant["permission"];
  }) {
    return grants.some((grant) => {
      const matchesSubject =
        (grant.subjectType === "user" && grant.subjectId === params.userId) ||
        (grant.subjectType === "team" && params.teamIds.includes(grant.subjectId));
      if (!matchesSubject) {
        return false;
      }
      if (
        permissionRankLocal(grant.permission) < permissionRankLocal(params.minimumPermission)
      ) {
        return false;
      }
      const matchesResourceType =
        grant.resourceType === "*" || grant.resourceType === params.resourceType;
      const matchesResourceId = grant.resourceId === "*" || grant.resourceId === params.resourceId;
      return matchesResourceType && matchesResourceId;
    });
  }

  function buildInboundAccessPreviewForScope(
    subject: {
      id: string;
      name: string;
      role: (typeof users)[number]["role"];
      status: (typeof users)[number]["status"];
      teamIds: string[];
      agentIds?: string[];
      channelIds?: string[];
    },
    params: {
      targetAgentId: string;
      matchedChannelIds: string[];
      modelProviderId?: string;
    },
  ) {
    const teamIds = [...subject.teamIds];
    const teamAccessibleAgentIds = getTeamAccessibleAgentIds(teamIds);
    const teamAccessibleChannelIds = getTeamAccessibleChannelIds(teamIds);
    const accessibleAgentIds = getEffectiveAgentIdsForScope(teamIds, subject.agentIds || []);
    const accessibleChannelIds = getEffectiveChannelIdsForScope(teamIds, subject.channelIds || []);
    const binding = params.targetAgentId ? getAgentBinding(params.targetAgentId) : undefined;
    const hasAdminAccess =
      subject.role === "admin" ||
      principalHasGrantLocal({
        userId: subject.id,
        teamIds,
        resourceType: "*",
        resourceId: "*",
        minimumPermission: "admin",
      });
    const hasExplicitAgentAccess = params.targetAgentId
      ? principalHasGrantLocal({
          userId: subject.id,
          teamIds,
          resourceType: "agent",
          resourceId: params.targetAgentId,
          minimumPermission: "operate",
        })
      : false;
    const hasDirectAgentAccess =
      Boolean(params.targetAgentId) && (subject.agentIds || []).includes(params.targetAgentId);
    const hasTeamAgentAccess =
      subject.status === "active" &&
      subject.role !== "viewer" &&
      Boolean(params.targetAgentId) &&
      (teamAccessibleAgentIds.includes(params.targetAgentId) ||
        (binding?.teamId ? teamIds.includes(binding.teamId) : false));
    const hasExplicitChannelAccess = params.matchedChannelIds.some((channelId) =>
      principalHasGrantLocal({
        userId: subject.id,
        teamIds,
        resourceType: "channel",
        resourceId: channelId,
        minimumPermission: "operate",
      }),
    );
    const hasDirectChannelAccess = params.matchedChannelIds.some((channelId) =>
      (subject.channelIds || []).includes(channelId),
    );
    const hasTeamChannelAccess = params.matchedChannelIds.some((channelId) =>
      teamAccessibleChannelIds.includes(channelId),
    );
    const authorizingTeamIds = params.targetAgentId
      ? resolveInboundAuthorizingTeamIdsLocal({
          teamIds,
          targetAgentId: params.targetAgentId,
          matchedChannelIds: params.matchedChannelIds,
        })
      : [];
    const authorizingTeamNames = authorizingTeamIds.map(teamName);
    const hasDirectPairAccess =
      subject.status === "active" &&
      subject.role !== "viewer" &&
      hasDirectAgentAccess &&
      hasDirectChannelAccess;
    const hasImplicitTeamPairAccess =
      subject.status === "active" &&
      subject.role !== "viewer" &&
      authorizingTeamIds.length > 0;
    const canUseChannel =
      hasAdminAccess ||
      (params.matchedChannelIds.length > 0 &&
        (hasExplicitChannelAccess || hasDirectPairAccess || hasImplicitTeamPairAccess));
    const canUseAgent =
      (hasAdminAccess ||
        hasExplicitAgentAccess ||
        hasDirectPairAccess ||
        hasImplicitTeamPairAccess) &&
      canUseChannel;
    const hasAnyScopedAgentAccess =
      Boolean(params.targetAgentId) &&
      (hasExplicitAgentAccess || hasDirectAgentAccess || hasTeamAgentAccess);
    const hasAnyScopedChannelAccess =
      params.matchedChannelIds.length > 0 &&
      (hasExplicitChannelAccess || hasDirectChannelAccess || hasTeamChannelAccess);
    const missingCommonTeamAccess =
      !hasAdminAccess &&
      !hasDirectPairAccess &&
      !hasImplicitTeamPairAccess &&
      !(hasExplicitAgentAccess && hasExplicitChannelAccess) &&
      hasAnyScopedAgentAccess &&
      hasAnyScopedChannelAccess;

    const explicitSkillGrantIds = new Set<string>();
    let hasExplicitSkillRestriction = false;
    let hasWildcardSkillAccess = hasAdminAccess;
    for (const grant of grants) {
      const matchesSubject =
        (grant.subjectType === "user" && grant.subjectId === subject.id) ||
        (grant.subjectType === "team" && teamIds.includes(grant.subjectId));
      if (!matchesSubject || permissionRankLocal(grant.permission) < permissionRankLocal("operate")) {
        continue;
      }
      if (grant.resourceType === "*" && grant.resourceId === "*") {
        hasWildcardSkillAccess = true;
        hasExplicitSkillRestriction = false;
        explicitSkillGrantIds.clear();
        break;
      }
      if (grant.resourceType !== "skill") {
        continue;
      }
      hasExplicitSkillRestriction = true;
      if (grant.resourceId === "*") {
        hasWildcardSkillAccess = true;
        explicitSkillGrantIds.clear();
        break;
      }
      explicitSkillGrantIds.add(grant.resourceId);
    }

    let allowedSkillIds = canUseAgent
      ? getAllowedSkillIdsForAgentProvider(params.targetAgentId, params.modelProviderId)
      : [];
    let restrictionSource = "agent";
    if (hasAdminAccess) {
      restrictionSource = "admin";
    } else if (hasExplicitSkillRestriction) {
      restrictionSource = "grants";
      if (!hasWildcardSkillAccess) {
        allowedSkillIds = allowedSkillIds.filter((skillId: string) =>
          explicitSkillGrantIds.has(skillId),
        );
      }
    }

    return {
      teamIds,
      authorizingTeamIds,
      authorizingTeamNames,
      accessibleAgentIds,
      accessibleChannelIds,
      canUseChannel,
      canUseAgent,
      allowedSkillIds,
      accessSource: hasAdminAccess
        ? "admin"
        : hasExplicitAgentAccess || hasExplicitChannelAccess
          ? "grant"
          : hasDirectPairAccess
            ? "direct"
            : hasImplicitTeamPairAccess
            ? "team"
            : "none",
      restrictionSource,
      reason: canUseAgent
        ? ""
        : !canUseChannel
          ? params.matchedChannelIds.length
            ? missingCommonTeamAccess
              ? "Aucune equipe commune n'autorise a la fois cet agent et ce bot/destination."
              : `User ${subject.name} n'a pas acces a la destination de cette conversation.`
            : "Cette conversation ne correspond a aucune destination Elytras geree."
          : subject.status !== "active"
            ? `User ${subject.name} n'est pas actif.`
            : subject.role === "viewer"
              ? `User ${subject.name} est en role viewer.`
              : missingCommonTeamAccess
                ? "Aucune equipe commune n'autorise a la fois cet agent et ce bot/destination."
                : `User ${subject.name} n'a pas acces a l'agent ${params.targetAgentId}.`,
    };
  }

  function buildInboundUserPreview(
    user: (typeof users)[number],
    params: {
      targetAgentId: string;
      matchedChannelIds: string[];
      modelProviderId?: string;
    },
  ) {
    return buildInboundAccessPreviewForScope(
      {
        id: user.id,
        name: user.name,
        role: user.role,
        status: user.status,
        teamIds: resolveUserTeamIdsLocal(user),
        agentIds: user.agentIds,
        channelIds: user.channelIds,
      },
      params,
    );
  }

  function describeGrantResourceTarget(grant: (typeof grants)[number]) {
    switch (grant.resourceType) {
      case "agent":
        return agentName(grant.resourceId);
      case "channel":
        return channelName(grant.resourceId);
      case "pipeline":
        return pipelines.find((entry) => entry.id === grant.resourceId)?.name || grant.resourceId;
      case "cron":
        return cronJobs.find((entry) => entry.id === grant.resourceId)?.name || grant.resourceId;
      case "provider":
        return (
          providerBridges.find((entry) => entry.id === grant.resourceId)?.name || grant.resourceId
        );
      case "skill":
        return (
          (skillsCatalog?.skills || []).find((entry) => entry.id === grant.resourceId)?.name ||
          grant.resourceId
        );
      case "workspace":
        return workspaces.find((entry) => entry.agentId === grant.resourceId)?.path || grant.resourceId;
      default:
        return grant.resourceId;
    }
  }

  function getTeamOwnedAgents(teamId?: string) {
    const scopedAgents = currentUserCanManageAdminViews ? agents : visibleAgents;
    if (!teamId) {
      return scopedAgents;
    }
    const team = teams.find((entry) => entry.id === teamId);
    if (!team) {
      return scopedAgents;
    }
    const teamAgentIds = new Set(team.agentIds);
    return scopedAgents.filter((agent) => {
      const boundTeamId = getAgentBinding(agent.id)?.teamId || agent.teamId;
      return boundTeamId === teamId || teamAgentIds.has(agent.id);
    });
  }

  function getTeamScopedOutputChannels(teamId?: string) {
    const scopedChannels = currentUserCanManageAdminViews
      ? outputRouteChannels
      : visibleOutputRouteChannels;
    if (!teamId) {
      return scopedChannels;
    }
    const team = teams.find((entry) => entry.id === teamId);
    if (!team) {
      return scopedChannels;
    }
    const teamChannelIds = getTeamOwnedOutputChannelIds(teamId);
    return scopedChannels.filter((channel) => teamChannelIds.has(channel.id));
  }

  function getTeamOwnedOutputChannelIds(teamId?: string) {
    if (!teamId) {
      return new Set<string>();
    }
    const team = teams.find((entry) => entry.id === teamId);
    const ids = new Set<string>(team?.channelIds || []);
    if (!team) {
      return ids;
    }
    const teamAgentIds = new Set(team.agentIds);
    for (const binding of agentBindings) {
      const bindingTeamId =
        binding.teamId || agents.find((agent) => agent.id === binding.agentId)?.teamId || "";
      if (bindingTeamId !== teamId && !teamAgentIds.has(binding.agentId)) {
        continue;
      }
      for (const channelId of binding.channelIds) {
        ids.add(channelId);
      }
      for (const channelId of binding.defaultOutputChannelIds) {
        ids.add(channelId);
      }
    }
    return ids;
  }

  function getAgentAccessibleOutputChannels(agentId: string, teamId?: string) {
    const agentChannelIds = new Set(getAgentBinding(agentId)?.channelIds || []);
    const teamChannelIds = teamId
      ? new Set(getTeamScopedOutputChannels(teamId).map((channel) => channel.id))
      : null;
    const scopedChannels = currentUserCanManageAdminViews
      ? outputRouteChannels
      : visibleOutputRouteChannels;
    return scopedChannels.filter((channel) => {
      if (!agentChannelIds.has(channel.id)) {
        return false;
      }
      return !teamChannelIds || teamChannelIds.has(channel.id);
    });
  }

  function getAgentBinding(agentId: string) {
    return agentBindingByAgentId.get(agentId);
  }

  function getAgentSessions(agentId: string) {
    return agentSessionsByAgentId.get(agentId) || [];
  }

  function getSessionProjectId(session?: DashboardSession | null) {
    return session?.projectId || DASHBOARD_NO_PROJECT_ID;
  }

  function getPrimaryAgentSession(agentId: string, projectId?: string) {
    const sessionsForAgent = getAgentSessions(agentId);
    if (!projectId || projectId === DASHBOARD_NO_PROJECT_ID) {
      return sessionsForAgent[0];
    }
    return (
      sessionsForAgent.find((session) => getSessionProjectId(session) === projectId) ||
      sessionsForAgent[0]
    );
  }

  function getEffectiveAgentProviderIds(agentId: string) {
    const providerIds = getAgentBinding(agentId)?.providerIds || [];
    const filtered = providerIds.filter((providerId) =>
      activeRuntimeProviderIds.includes(providerId),
    );
    return filtered.length ? filtered : activeRuntimeProviderIds;
  }

  function getScopedRuntimeModels(providerIds?: string[]) {
    if (!providerIds?.length) {
      return runtimeModels;
    }
    return runtimeModels.filter((model) => providerIds.includes(model.provider));
  }

  function getEffectiveAgentModelRef(agentId: string) {
    const preferredModelRef = getAgentBinding(agentId)?.preferredModelRef || "";
    if (preferredModelRef && runtimeModels.some((model) => model.ref === preferredModelRef)) {
      return preferredModelRef;
    }
    return runtimeDefaults.agentPrimaryModelRef || preferredModelRef || "";
  }

  function getRuntimeModelDisplay(modelRef?: string) {
    if (!modelRef) {
      return "inherit";
    }
    const runtimeModel = runtimeModels.find((model) => model.ref === modelRef);
    if (runtimeModel?.modelId) {
      return runtimeModel.modelId;
    }
    const chunks = modelRef.split("/");
    return chunks.at(-1) || modelRef;
  }

  function resolveAgentSkillTemplateSummary(editor: AgentEditor) {
    if (editor.skillPolicy === "selected") {
      return editor.skillIds.length ? editor.skillIds : ["Selection manuelle a completer"];
    }
    if (editor.skillPolicy === "none") {
      return ["Aucune skill runtime explicite"];
    }
    return ["Toutes les skills eligibles du runtime"];
  }

  function createAgentMarkdownTemplateContext(
    editor: AgentEditor,
    agentIdOverride?: string,
  ): AgentMarkdownTemplateContext {
    const resolvedAgentId =
      agentIdOverride || editor.agentId || slugifyClient(editor.name || "agent") || "agent";
    const resolvedAccessTeamIds = Array.from(
      new Set(
        [...editor.accessTeamIds, editor.teamId].filter((entry): entry is string => Boolean(entry)),
      ),
    ).toSorted((left, right) => left.localeCompare(right));
    const accessUsers = users
      .filter((user) =>
        resolveUserTeamIdsLocal(user).some((teamId) => resolvedAccessTeamIds.includes(teamId)),
      )
      .toSorted((left, right) => left.name.localeCompare(right.name));
    const inboundTransportLabels = runtimeTransportChannels
      .filter((channel) =>
        editor.agentId
          ? channel.inboundAgentId === resolvedAgentId
          : editor.inboundTransportKeys.includes(makeRuntimeTransportKey(channel)),
      )
      .map((channel) => buildChannelRouteSummary(channel, channelTemplateById.get(channel.kind)));
    const inboundDestinationLabels = channels
      .filter(
        (channel) =>
          channel.inboundAgentId === resolvedAgentId &&
          channel.surfaceType === "destination",
      )
      .map((channel) => buildChannelRouteSummary(channel, channelTemplateById.get(channel.kind)));
    const outputRouteLabels = editor.channelIds.map(channelName);
    const effectiveModelRef =
      editor.modelRef ||
      (editor.agentId ? getEffectiveAgentModelRef(editor.agentId) : runtimeDefaults.agentPrimaryModelRef) ||
      "";
    const modelLabel = effectiveModelRef ? getRuntimeModelDisplay(effectiveModelRef) : "";
    const effectiveProviderIds = editor.providerIds.length
      ? editor.providerIds
      : activeRuntimeProviderIds;
    return {
      agentId: resolvedAgentId,
      purpose: editor.purpose,
      skillIds: resolveAgentSkillTemplateSummary(editor),
      modelLabel: modelLabel && modelLabel !== "inherit" ? modelLabel : undefined,
      workspace: editor.workspace,
      ownerTeamName: teamName(editor.teamId),
      accessTeamNames: resolvedAccessTeamIds.map(teamName),
      allowedUserNames: accessUsers.map((user) => user.name),
      allowedExternalIdentities: accessUsers.flatMap((user) => user.externalIdentities),
      inboundTransportLabels,
      inboundDestinationLabels,
      outputRouteLabels,
      providerIds: effectiveProviderIds,
    };
  }

  function buildAgentMarkdownTemplateForEditor(
    name: string,
    editor: AgentEditor = agentEditor,
    agentIdOverride?: string,
  ) {
    const resolvedAgentId =
      agentIdOverride || editor.agentId || slugifyClient(editor.name || "agent") || "agent";
    return buildAgentMarkdownTemplate(
      name,
      editor.name || resolvedAgentId,
      createAgentMarkdownTemplateContext(editor, resolvedAgentId),
    );
  }

  function getEffectivePipelineStepModelRef(step: PipelineRecord["steps"][number]) {
    return step.modelRef || getEffectiveAgentModelRef(step.agentId);
  }

  function getAgentExecutionSettings(agentId: string): ExecutionSettings {
    const binding = getAgentBinding(agentId);
    return {
      thinkingLevel: binding?.thinkingLevel,
      fastMode: binding?.fastMode,
      verboseLevel: binding?.verboseLevel,
      reasoningLevel: binding?.reasoningLevel,
    };
  }

  function getEffectivePipelineStepExecutionSettings(
    step: PipelineRecord["steps"][number],
  ): ExecutionSettings {
    const agentProfile = getAgentExecutionSettings(step.agentId);
    return {
      thinkingLevel: step.thinkingLevel || agentProfile.thinkingLevel,
      fastMode: typeof step.fastMode === "boolean" ? step.fastMode : agentProfile.fastMode,
      verboseLevel: step.verboseLevel || agentProfile.verboseLevel,
      reasoningLevel: step.reasoningLevel || agentProfile.reasoningLevel,
    };
  }

  function describeAgentSkills(binding?: AgentBinding) {
    if (!binding || binding.skillPolicy === "all" || !binding.skillPolicy) {
      return "toutes les skills eligibles";
    }
    if (binding.skillPolicy === "none") {
      return "aucune skill";
    }
    return binding.skillIds.length ? binding.skillIds.join(", ") : "aucune skill";
  }

  function describeAgentProviders(binding?: AgentBinding) {
    const providerIds = binding?.providerIds?.length
      ? binding.providerIds.filter((providerId) => activeRuntimeProviderIds.includes(providerId))
      : activeRuntimeProviderIds;
    return providerIds.length ? providerIds.join(", ") : "aucun provider actif";
  }

  function describeAgentProviderAccounts(binding?: AgentBinding) {
    const entries = Object.entries(binding?.providerAccountIds || {}).filter(([, accountIds]) =>
      Boolean(accountIds?.length),
    );
    if (!entries.length) {
      return "tous les comptes detectes";
    }
    return entries
      .map(([providerId, accountIds]) => `${providerId} (${accountIds.length})`)
      .join(", ");
  }

  function describeDefaultOutputs(binding?: AgentBinding) {
    return binding?.defaultOutputChannelIds?.length
      ? binding.defaultOutputChannelIds.map(channelName).join(", ")
      : "aucune sortie par defaut";
  }

  function describeProviderSkillPolicies(binding?: AgentBinding) {
    const entries = Object.entries(binding?.providerSkillPolicies || {}).filter(([, policy]) => {
      if (!policy) {
        return false;
      }
      if (policy.mode === "inherit") {
        return false;
      }
      if (policy.mode === "selected" && !policy.skillIds.length) {
        return false;
      }
      return true;
    });
    if (!entries.length) {
      return "inherit";
    }
    return entries
      .map(([providerId, policy]) =>
        policy.mode === "selected"
          ? `${providerId}:selected(${policy.skillIds.length})`
          : `${providerId}:${policy.mode}`,
      )
      .join(" · ");
  }

  function getSkillOptionsForAgent(agentId: string) {
    const resolvedByName = new Map<string, AgentScopedSkillOption>();
    for (const skill of availableSkillOptions) {
      if (skill.agentId && skill.agentId !== agentId) {
        continue;
      }
      const previous = resolvedByName.get(skill.name);
      if (!previous) {
        resolvedByName.set(skill.name, skill);
        continue;
      }
      const previousScore =
        getSkillOptionPrecedence(previous) + (previous.libraryId ? 1 : 0);
      const nextScore = getSkillOptionPrecedence(skill) + (skill.libraryId ? 1 : 0);
      if (nextScore >= previousScore) {
        resolvedByName.set(skill.name, skill);
      }
    }
    return Array.from(resolvedByName.values()).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  function getAllowedSkillIdsForAgentProvider(agentId: string, providerId?: string | null) {
    const binding = getAgentBinding(agentId);
    const allSkillIds = getSkillOptionsForAgent(agentId).map((skill) => skill.name);
    let allowedSkillIds =
      !binding || binding.skillPolicy === "all" || !binding.skillPolicy
        ? allSkillIds
        : binding.skillPolicy === "none"
          ? []
          : binding.skillIds;

    const normalizedProviderId = normalizeProviderId(providerId);
    const providerPolicy =
      normalizedProviderId && binding?.providerSkillPolicies
        ? binding.providerSkillPolicies[normalizedProviderId]
        : undefined;
    if (!providerPolicy || providerPolicy.mode === "inherit") {
      return allowedSkillIds;
    }
    if (providerPolicy.mode === "allow-all") {
      return allSkillIds;
    }
    if (providerPolicy.mode === "deny-all") {
      return [];
    }
    return providerPolicy.skillIds.filter((skillId) => allSkillIds.includes(skillId));
  }

  function filterRequestedSkillsForAgentProvider(
    agentId: string,
    providerId: string | null | undefined,
    requestedSkillIds: string[],
  ) {
    const allowedSkillIds = getAllowedSkillIdsForAgentProvider(agentId, providerId);
    if (!requestedSkillIds.length) {
      return [];
    }
    return requestedSkillIds.filter((skillId) => allowedSkillIds.includes(skillId));
  }

  function getAutoDispatchTargetsForAgent(agentId: string) {
    const binding = getAgentBinding(agentId);
    if (!binding) {
      return [];
    }
    if (binding.dispatchPolicy === "broadcast") {
      return binding.channelIds.filter((channelId) =>
        outputRouteChannels.some((channel) => channel.id === channelId),
      );
    }
    if (binding.dispatchPolicy === "default-channels") {
      return binding.defaultOutputChannelIds.filter((channelId) =>
        outputRouteChannels.some((channel) => channel.id === channelId),
      );
    }
    return [];
  }

  function getSuggestedOutputTargetsForAgents(agentIds: string[]) {
    return Array.from(
      new Set(agentIds.flatMap((agentId) => getAutoDispatchTargetsForAgent(agentId))),
    ).toSorted((left, right) => left.localeCompare(right));
  }

  function sanitizeModelRefForAgent(agentId: string, modelRef?: string) {
    if (!modelRef) {
      return undefined;
    }
    const providerId = modelProviderFromRef(modelRef);
    if (!providerId) {
      return modelRef;
    }
    if (getEffectiveAgentProviderIds(agentId).includes(providerId)) {
      return modelRef;
    }
    return undefined;
  }

  function getResumeCandidateSession(
    agentId: string,
    policy?: AgentBinding["resumePolicy"],
    projectId?: string,
  ) {
    if (!policy || policy === "manual") {
      return undefined;
    }
    const candidate = getPrimaryAgentSession(agentId, projectId);
    if (!candidate) {
      return undefined;
    }
    if (policy === "sticky") {
      return candidate;
    }
    if (!candidate.updatedAt) {
      return undefined;
    }
    if (Date.now() - candidate.updatedAt <= RECENT_SESSION_REUSE_WINDOW_MS) {
      return candidate;
    }
    return undefined;
  }

  function filterRequestedOutputTargetsForAgent(agentId: string, requestedTargets: string[]) {
    if (!requestedTargets.length) {
      return [];
    }
    const accessibleChannelIds = new Set(getAgentBinding(agentId)?.channelIds || []);
    const knownChannelIds = new Set(visibleOutputRouteChannels.map((channel) => channel.id));
    return requestedTargets.filter(
      (target) => !knownChannelIds.has(target) || accessibleChannelIds.has(target),
    );
  }

  function getEffectivePipelineStepOutputTargets(step: PipelineRecord["steps"][number]) {
    const requestedTargets = splitList(step.output || "");
    return filterRequestedOutputTargetsForAgent(step.agentId, requestedTargets);
  }

  function getEffectivePipelineStepSkillIds(step: PipelineRecord["steps"][number]) {
    const providerId = modelProviderFromRef(getEffectivePipelineStepModelRef(step));
    return filterRequestedSkillsForAgentProvider(step.agentId, providerId, step.skills);
  }

  function getEffectiveDraftStepModelRef(step: PipelineDraftStep) {
    return (
      sanitizeModelRefForAgent(step.agentId, step.modelRef) ||
      getEffectiveAgentModelRef(step.agentId)
    );
  }

  function getEffectiveDraftStepOutputTargets(step: PipelineDraftStep) {
    return filterRequestedOutputTargetsForAgent(step.agentId, step.outputTargets);
  }

  function describeSentPipelineDeliveries(deliveries: PipelineRunDeliveryResult[]) {
    const sentDeliveries = deliveries.filter((delivery) => delivery.status === "sent");
    if (!sentDeliveries.length) {
      return "aucune sortie externe";
    }
    const finalCount = sentDeliveries.filter((delivery) => delivery.scope === "final").length;
    const stepCount = sentDeliveries.filter((delivery) => delivery.scope === "step").length;
    if (finalCount && stepCount) {
      return `${sentDeliveries.length} sortie(s) envoyee(s) (${finalCount} finale(s), ${stepCount} d'etape)`;
    }
    if (finalCount) {
      return `${finalCount} sortie(s) finale(s) envoyee(s)`;
    }
    return `${stepCount} sortie(s) d'etape envoyee(s)`;
  }

  function getEffectiveDraftStepSkillIds(step: PipelineDraftStep) {
    return filterRequestedSkillsForAgentProvider(
      step.agentId,
      modelProviderFromRef(getEffectiveDraftStepModelRef(step)),
      step.skillIds,
    );
  }

  function getEffectivePipelineStepNextStepIds(
    step: PipelineRecord["steps"][number],
    steps: PipelineRecord["steps"],
    index: number,
  ) {
    if (step.routingMode === "terminal") {
      return [];
    }
    const validStepIds = new Set(steps.map((entry) => entry.id));
    const explicitNext = (step.nextStepIds || []).filter(
      (nextStepId) => nextStepId !== step.id && validStepIds.has(nextStepId),
    );
    if (explicitNext.length > 0) {
      return explicitNext;
    }
    const sequentialNext = steps[index + 1];
    return sequentialNext ? [sequentialNext.id] : [];
  }

  function buildPipelineStepFromDraft(
    step: PipelineDraftStep,
    index: number,
    steps: PipelineDraftStep[],
  ) {
    const nextStepIds = getEffectiveDraftStepNextStepIds(step, steps, index);
    return {
      id: step.id || `step-${index + 1}`,
      name: step.name.trim() || `Step ${index + 1}`,
      agentId: step.agentId || "main",
      prompt: step.prompt.trim() || undefined,
      output: getEffectiveDraftStepOutputTargets(step).join(","),
      skills: getEffectiveDraftStepSkillIds(step),
      status: "draft" as const,
      nextStepIds,
      routingMode:
        nextStepIds.length > 1 && step.routingMode === "linear" ? "fan-out" : step.routingMode,
      condition:
        step.routingMode === "conditional" ? step.condition.trim() || undefined : undefined,
      modelRef: sanitizeModelRefForAgent(step.agentId, step.modelRef),
      thinkingLevel: step.thinkingLevel || undefined,
      fastMode: typeof step.fastMode === "boolean" ? step.fastMode : undefined,
      verboseLevel: step.verboseLevel || undefined,
      reasoningLevel: step.reasoningLevel || undefined,
    };
  }

  const pipelineFlowOutputLabelsByStepId = useMemo(
    () =>
      Object.fromEntries(
        pipelineForm.steps.map((step) => [
          step.id,
          `${getEffectiveDraftStepOutputTargets(step).length} outputs`,
        ]),
      ),
    [channels, pipelineForm.steps, snapshot?.agentBindings, snapshot?.agents],
  );

  const pipelineFlowModelLabelsByStepId = useMemo(
    () =>
      Object.fromEntries(
        pipelineForm.steps.map((step) => [step.id, getEffectiveDraftStepModelRef(step)]),
      ),
    [pipelineForm.steps, snapshot?.agentBindings, snapshot?.agents, snapshot?.runtimeModels],
  );

  function describePipelineStepNextTitles(
    step: PipelineRecord["steps"][number],
    steps: PipelineRecord["steps"],
  ) {
    const stepIndex = steps.findIndex((entry) => entry.id === step.id);
    return getEffectivePipelineStepNextStepIds(step, steps, stepIndex)
      .map((nextStepId) => {
        const nextIndex = steps.findIndex((entry) => entry.id === nextStepId);
        const nextStep = steps[nextIndex];
        return nextStep ? nextStep.name : nextStepId;
      })
      .filter(Boolean);
  }

  function buildCanvasEdgePath(edge: PipelineCanvasEdge) {
    const bend = Math.max(36, Math.abs(edge.endX - edge.startX) * 0.42);
    return `M ${edge.startX} ${edge.startY} C ${edge.startX + bend} ${edge.startY}, ${edge.endX - bend} ${edge.endY}, ${edge.endX} ${edge.endY}`;
  }

  function buildDraftPipelineCanvasColumns(steps: PipelineDraftStep[]): PipelineCanvasColumn[] {
    if (steps.length === 0) {
      return [];
    }

    const stepById = new Map(steps.map((step) => [step.id, step]));
    const incomingById = new Map<string, string[]>(steps.map((step) => [step.id, [] as string[]]));
    for (const [index, step] of steps.entries()) {
      for (const nextStepId of getEffectiveDraftStepNextStepIds(step, steps, index)) {
        const currentIncoming = incomingById.get(nextStepId) || [];
        incomingById.set(nextStepId, [...currentIncoming, step.id]);
      }
    }

    const columnById = new Map<string, number>();
    const roots = steps.filter((step) => (incomingById.get(step.id) || []).length === 0);
    for (const root of roots.length ? roots : steps.slice(0, 1)) {
      columnById.set(root.id, 0);
    }

    let changed = true;
    let passes = 0;
    while (changed && passes < steps.length * 4) {
      changed = false;
      passes += 1;
      for (const step of steps) {
        const predecessors = incomingById.get(step.id) || [];
        if (predecessors.length === 0) {
          if (!columnById.has(step.id)) {
            columnById.set(step.id, 0);
            changed = true;
          }
          continue;
        }
        if (predecessors.some((predecessorId) => !columnById.has(predecessorId))) {
          continue;
        }
        const branchingPredecessors = predecessors.filter((predecessorId) => {
          const predecessor = stepById.get(predecessorId);
          return (
            predecessor?.routingMode === "conditional" || predecessor?.routingMode === "fan-out"
          );
        });
        const nextColumn =
          branchingPredecessors.length > 0
            ? Math.min(
                ...branchingPredecessors.map(
                  (predecessorId) => (columnById.get(predecessorId) || 0) + 1,
                ),
              )
            : Math.max(
                ...predecessors.map((predecessorId) => (columnById.get(predecessorId) || 0) + 1),
              );
        if (columnById.get(step.id) !== nextColumn) {
          columnById.set(step.id, nextColumn);
          changed = true;
        }
      }
    }

    let fallbackColumn = 0;
    for (const step of steps) {
      const assignedColumn = columnById.get(step.id);
      if (typeof assignedColumn === "number") {
        fallbackColumn = Math.max(fallbackColumn, assignedColumn);
        continue;
      }
      columnById.set(step.id, fallbackColumn);
    }

    const grouped = new Map<number, string[]>();
    for (const step of steps) {
      const column = columnById.get(step.id) || 0;
      const currentIds = grouped.get(column) || [];
      grouped.set(column, [...currentIds, step.id]);
    }

    return [...grouped.entries()]
      .toSorted(([left], [right]) => left - right)
      .map(([index, stepIds]) => ({ index, stepIds }));
  }

  function focusPipelineDraftStep(stepId: string) {
    setSelectedPipelineStepId(stepId);
    window.requestAnimationFrame(() => {
      pipelineStepRefs.current[stepId]?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }

  function updatePipelineDraftStep(
    stepId: string,
    updater: (step: PipelineDraftStep) => PipelineDraftStep,
  ) {
    setPipelineForm((current) => ({
      ...current,
      steps: current.steps.map((step) => (step.id === stepId ? updater(step) : step)),
    }));
  }

  function addPipelineDraftStep(afterStepId?: string) {
    setPipelineForm((current) => {
      const nextStep = createPipelineDraftStep(current.steps.at(-1)?.agentId || "main");
      setSelectedPipelineStepId(nextStep.id);
      if (!afterStepId) {
        return { ...current, steps: [...current.steps, nextStep] };
      }
      const index = current.steps.findIndex((step) => step.id === afterStepId);
      if (index < 0) {
        return { ...current, steps: [...current.steps, nextStep] };
      }
      return {
        ...current,
        steps: [...current.steps.slice(0, index + 1), nextStep, ...current.steps.slice(index + 1)],
      };
    });
  }

  function duplicatePipelineDraftStep(stepId: string) {
    setPipelineForm((current) => {
      const index = current.steps.findIndex((step) => step.id === stepId);
      if (index < 0) {
        return current;
      }
      const source = current.steps[index];
      const duplicate = {
        ...source,
        id: createDraftId("step"),
        name: source.name ? `${source.name} copy` : "",
      };
      setSelectedPipelineStepId(duplicate.id);
      return {
        ...current,
        steps: [...current.steps.slice(0, index + 1), duplicate, ...current.steps.slice(index + 1)],
      };
    });
  }

  function movePipelineDraftStep(stepId: string, direction: -1 | 1) {
    setSelectedPipelineStepId(stepId);
    setPipelineForm((current) => {
      const index = current.steps.findIndex((step) => step.id === stepId);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= current.steps.length) {
        return current;
      }
      const nextSteps = [...current.steps];
      const [step] = nextSteps.splice(index, 1);
      nextSteps.splice(targetIndex, 0, step);
      return { ...current, steps: nextSteps };
    });
  }

  function removePipelineDraftStep(stepId: string) {
    setPipelineForm((current) => {
      if (current.steps.length <= 1) {
        const replacement = createPipelineDraftStep(current.steps[0]?.agentId || "main");
        setSelectedPipelineStepId(replacement.id);
        return {
          ...current,
          steps: [replacement],
        };
      }
      const currentIndex = current.steps.findIndex((step) => step.id === stepId);
      const fallbackStep =
        current.steps[currentIndex + 1] || current.steps[currentIndex - 1] || current.steps[0];
      setSelectedPipelineStepId(fallbackStep?.id || "");
      return {
        ...current,
        steps: current.steps.filter((step) => step.id !== stepId),
      };
    });
  }

  function openPipelineDraftStepModal(stepId: string) {
    setSelectedPipelineStepId(stepId);
    setPipelineStepModalOpen(true);
  }

  function closePipelineDraftStepModal() {
    setPipelineStepModalOpen(false);
  }

  function setPipelineOutputTargets(nextTargets: string[]) {
    setPipelineForm((current) => ({
      ...current,
      outputTargets: nextTargets.toSorted((left, right) => left.localeCompare(right)).join(","),
    }));
  }

  function updatePipelineDraftStepConnections(stepId: string, nextStepIds: string[]) {
    updatePipelineDraftStep(stepId, (current) => ({
      ...current,
      nextStepIds,
      routingMode:
        nextStepIds.length === 0
          ? "terminal"
          : current.routingMode === "conditional"
            ? "conditional"
            : nextStepIds.length > 1
              ? "fan-out"
              : "linear",
    }));
  }

  function handlePipelineFlowNodePositionsChange(
    nextPositions: Record<string, { x: number; y: number }>,
  ) {
    setPipelineNodePositions((current) => {
      if (
        Object.keys(current).length === Object.keys(nextPositions).length &&
        Object.entries(nextPositions).every(([stepId, position]) => {
          const currentPosition = current[stepId];
          return currentPosition?.x === position.x && currentPosition?.y === position.y;
        })
      ) {
        return current;
      }
      return nextPositions;
    });
  }

  function resetAgentEditor() {
    setAgentEditorMode("create");
    setAgentStudioSection("profile");
    setSelectedAgentFileKey("");
    setAgentMarkdownDraftName("");
    setAgentMarkdownDraftContent("");
    const defaultTeamId = teams[0]?.id || "";
    const defaultTeamChannels = getTeamScopedOutputChannels(defaultTeamId).map((channel) => channel.id);
    const next = createAgentEditor(
      workspaceRoot,
      defaultTeamChannels.length
        ? defaultTeamChannels
        : managedOutputRouteChannels.map((channel) => channel.id),
      activeRuntimeProviderIds,
    );
    setAgentEditor({
      ...next,
      teamId: defaultTeamId,
      accessTeamIds: defaultTeamId ? [defaultTeamId] : [],
      defaultOutputChannelIds: defaultTeamChannels,
    });
  }

  function openAgentStudioRecord(
    agent: DashboardAgent,
    binding?: AgentBinding,
    options?: {
      section?: "profile" | "runtime" | "memory" | "routing" | "files";
      preferredFileName?: string;
    },
  ) {
    setAgentEditorMode("edit");
    setAgentStudioSection(options?.section || "files");
    setAgentMarkdownDraftName("");
    setAgentMarkdownDraftContent("");
    setSelectedAgentFileKey(
      options?.preferredFileName ? `${agent.id}:${options.preferredFileName}` : `${agent.id}:AGENTS.md`,
    );
    setAgentEditor({
      agentId: agent.id,
      name: agent.identity?.name || agent.name || agent.id,
      workspace: agent.workspace?.path || `${workspaceRoot}/${agent.id}`,
      ownerId: binding?.ownerId || agent.ownerId || "",
      teamId: binding?.teamId || agent.teamId || "",
      accessTeamIds: getAgentAccessTeamIds(agent.id, binding?.teamId || agent.teamId || ""),
      inboundTransportKeys: getAgentInboundTransportKeys(agent.id),
      purpose: binding?.purpose || agent.purpose || "",
      channelIds:
        binding?.channelIds ||
        agent.channelIds ||
        outputRouteChannels.map((channel) => channel.id),
      defaultOutputChannelIds: binding?.defaultOutputChannelIds || [],
      providerIds:
        binding?.providerIds?.length || agent.providerIds?.length
          ? (binding?.providerIds || agent.providerIds || []).filter((providerId) =>
              activeRuntimeProviderIds.includes(providerId),
            )
          : activeRuntimeProviderIds,
      skillPolicy: binding?.skillPolicy || "all",
      skillIds: binding?.skillIds || [],
      tags: (binding?.tags || agent.tags || []).join(", "),
      emoji: agent.identity?.emoji || "",
      avatar: agent.identity?.avatar || agent.identity?.avatarUrl || "",
      modelRef: binding?.preferredModelRef || "",
      resumePolicy: binding?.resumePolicy || "manual",
      dispatchPolicy: binding?.dispatchPolicy || "manual",
      thinkingLevel: binding?.thinkingLevel,
      fastMode: binding?.fastMode,
      verboseLevel: binding?.verboseLevel,
      reasoningLevel: binding?.reasoningLevel,
    });
  }

  function startAgentEdit(agent: DashboardAgent) {
    openAgentStudioRecord(agent, getAgentBinding(agent.id));
  }

  function openAgentStudioForAgentId(agentId?: string, options?: Parameters<typeof openAgentStudioRecord>[2]) {
    if (!agentId) {
      resetAgentEditor();
      setAgentStudioSection(options?.section || "profile");
      setView("agents");
      return;
    }
    const agent = agents.find((entry) => entry.id === agentId);
    if (!agent) {
      setView("agents");
      return;
    }
    openAgentStudioRecord(agent, getAgentBinding(agent.id), options);
    setView("agents");
  }

  function focusAgentMarkdownFile(name: string) {
    if (agentEditorMode !== "edit" || !agentEditor.agentId) {
      return;
    }
    setAgentStudioSection("files");
    setSelectedAgentFileKey(`${agentEditor.agentId}:${name}`);
  }

  function focusOrStageAgentMarkdownFile(name: string) {
    if (selectedAgentFileMap.has(name)) {
      focusAgentMarkdownFile(name);
      return;
    }
    stageAgentMarkdownTemplate(name);
  }

  function stageAgentMarkdownTemplate(name: string) {
    setAgentStudioSection("files");
    setAgentMarkdownDraftName(name);
    setAgentMarkdownDraftContent(buildAgentMarkdownTemplateForEditor(name));
  }

  function applyStarterToSelectedAgentFile() {
    if (!selectedAgentFileKey || !selectedAgentFile) {
      return;
    }
    setFileContent((current) => ({
      ...current,
      [selectedAgentFileKey]: buildAgentMarkdownTemplateForEditor(selectedAgentFile.name),
    }));
  }

  function injectStarterIntoAgentMarkdown(name: string) {
    if (agentEditorMode !== "edit" || !agentEditor.agentId) {
      return;
    }
    const targetKey = `${agentEditor.agentId}:${name}`;
    setAgentStudioSection("files");
    setSelectedAgentFileKey(targetKey);
    setFileContent((current) => ({
      ...current,
      [targetKey]: buildAgentMarkdownTemplateForEditor(name),
    }));
  }

  async function createAgentMarkdownFromTemplate(name: string) {
    await handleSaveAgentFile(name, buildAgentMarkdownTemplateForEditor(name));
  }

  async function seedAgentMarkdownBootstrap(agentId: string, editor: AgentEditor) {
    const savedNames: string[] = [];
    for (const fileName of AGENT_BOOTSTRAP_SEED_FILES) {
      await saveFileContent(config, {
        agentId,
        name: fileName,
        content: buildAgentMarkdownTemplateForEditor(fileName, editor, agentId),
      });
      savedNames.push(fileName);
    }
    return savedNames;
  }

  async function syncAgentGeneratedMarkdown(agentId: string, editor: AgentEditor) {
    const existingNames = new Set(
      files.filter((file) => file.agentId === agentId).map((file) => file.name),
    );
    const filesToRefresh = ["ACCESS.md"];
    const filesToEnsure = ["ELYTRAS.md", "BOOTSTRAP.md"];

    for (const fileName of [...filesToRefresh, ...filesToEnsure.filter((name) => !existingNames.has(name))]) {
      await saveFileContent(config, {
        agentId,
        name: fileName,
        content: buildAgentMarkdownTemplateForEditor(fileName, editor, agentId),
      });
    }
  }

  function getSessionOverrideModelRef(session?: DashboardSession | null) {
    if (!session?.providerOverride || !session.modelOverride) {
      return "";
    }
    return `${session.providerOverride}/${session.modelOverride}`;
  }

  function getSessionEffectiveModelRef(session?: DashboardSession | null) {
    if (!session?.modelProvider || !session.model) {
      return "";
    }
    return `${session.modelProvider}/${session.model}`;
  }

  function mergeExecutionSettings(
    base: ExecutionSettings,
    inherited: ExecutionSettings,
  ): ExecutionSettings {
    return {
      thinkingLevel: base.thinkingLevel || inherited.thinkingLevel,
      fastMode: typeof base.fastMode === "boolean" ? base.fastMode : inherited.fastMode,
      verboseLevel: base.verboseLevel || inherited.verboseLevel,
      reasoningLevel: base.reasoningLevel || inherited.reasoningLevel,
    };
  }

  const selectedSessionOverrideModelRef = getSessionOverrideModelRef(selectedSession);
  const selectedSessionEffectiveModelRef = getSessionEffectiveModelRef(selectedSession);
  const chatDraftAgentId =
    chatDraft.agentId || selectedSession?.agentId || visibleAgents[0]?.id || "main";
  const chatDraftAgentBinding = getAgentBinding(chatDraftAgentId);
  const chatDraftAgentProviderIds = getEffectiveAgentProviderIds(chatDraftAgentId);
  const chatDraftProjectOptions = selectedDashboardAvailableProjects.filter(
    (project) => project.agentIds.length === 0 || project.agentIds.includes(chatDraftAgentId),
  );
  const chatDraftSuggestedSession = getResumeCandidateSession(
    chatDraftAgentId,
    chatDraftAgentBinding?.resumePolicy,
    chatDraft.projectId !== DASHBOARD_NO_PROJECT_ID ? chatDraft.projectId : undefined,
  );
  const chatDraftInheritedExecution = getAgentExecutionSettings(chatDraftAgentId);
  const chatDraftEffectiveExecution = mergeExecutionSettings(
    chatDraft,
    chatDraftInheritedExecution,
  );
  const chatDraftEffectiveModelRef =
    chatDraft.modelRef || getEffectiveAgentModelRef(chatDraftAgentId);
  const chatDraftProviderHint = modelProviderFromRef(
    chatDraft.modelRef || chatDraftEffectiveModelRef,
  );
  const chatDraftRuntimeModels = getScopedRuntimeModels(chatDraftAgentProviderIds);
  const selectedSessionRuntimeModels = getScopedRuntimeModels(
    selectedSession
      ? getEffectiveAgentProviderIds(selectedSession.agentId)
      : activeRuntimeProviderIds,
  );
  const agentEditorScopedOutputChannels = getTeamScopedOutputChannels(agentEditor.teamId);
  const agentEditorScopedOutputChannelIds = agentEditorScopedOutputChannels.map(
    (channel) => channel.id,
  );
  const pipelineAgentIds = Array.from(
    new Set(pipelineForm.steps.map((step) => step.agentId).filter(Boolean)),
  ).toSorted((left, right) => left.localeCompare(right));
  const suggestedPipelineOutputTargets = getSuggestedOutputTargetsForAgents(pipelineAgentIds);
  const selectedPipelineStepIndex = pipelineForm.steps.findIndex(
    (step) => step.id === selectedPipelineStepId,
  );
  const selectedPipelineStep =
    pipelineForm.steps[selectedPipelineStepIndex] || pipelineForm.steps[0] || null;
  const selectedCronPipeline = cronForm.targetType === "pipeline" && cronForm.pipelineId
    ? visiblePipelines.find((pipeline) => pipeline.id === cronForm.pipelineId)
    : undefined;
  const suggestedCronOutputTargets = selectedCronPipeline
    ? selectedCronPipeline.outputTargets
    : cronForm.targetType === "request" && cronForm.agentId
      ? getAutoDispatchTargetsForAgent(cronForm.agentId)
      : [];
  const suggestedCronOutputChannels = outputRouteChannels.filter((channel) =>
    suggestedCronOutputTargets.includes(channel.id),
  );
  const cronTargetMissing =
    cronForm.targetType === "pipeline" ? !cronForm.pipelineId : !cronForm.agentId;
  const cronScheduleBuilder = useMemo(
    () => parseCronScheduleBuilder(cronForm.schedule),
    [cronForm.schedule],
  );

  function updateCronSchedule(builderPatch: {
    mode?: CronScheduleMode;
    interval?: number;
    unit?: CronEveryUnit;
    time?: string;
    weekday?: string;
    dayOfMonth?: number;
    customExpression?: string;
  }) {
    const nextBuilder = {
      ...cronScheduleBuilder,
      ...builderPatch,
    };
    setCronForm((current) => ({
      ...current,
      schedule: buildCronScheduleExpression(nextBuilder),
    }));
  }

  function applyCronPreset(mode: CronScheduleMode, patch: Parameters<typeof updateCronSchedule>[0] = {}) {
    const nextBuilder = switchCronScheduleMode(cronForm.schedule, mode);
    setCronForm((current) => ({
      ...current,
      schedule: buildCronScheduleExpression({
        ...nextBuilder,
        ...patch,
      }),
    }));
  }

  async function patchLiveSessions(
    sessionKeys: string[],
    patch: ExecutionSettingsPatch,
    successMessage: string,
  ) {
    if (sessionKeys.length === 0) {
      setFlash(successMessage);
      return true;
    }
    try {
      await Promise.all(sessionKeys.map((sessionKey) => patchSession(config, sessionKey, patch)));
      await refresh();
      setFlash(successMessage);
      return true;
    } catch (patchError) {
      setError(patchError instanceof Error ? patchError.message : String(patchError));
      return false;
    }
  }

  async function handleAgentModelAssignment(agentId: string, modelRef: string) {
    if (!ensureAdminAccess("Le parametrage modele agent est reserve a l'admin Elytras.")) {
      return;
    }
    const binding = getAgentBinding(agentId);
    if (!binding) {
      return;
    }
    await mutateResource(
      "patch",
      "agentBindings",
      { preferredModelRef: modelRef || undefined },
      binding.id,
      "Modele agent mis a jour.",
    );
  }

  async function handlePipelineStepModelAssignment(
    pipeline: PipelineRecord,
    stepId: string,
    modelRef: string,
  ) {
    if (!canOperatePipelineRecord(pipeline)) {
      setError("Le user courant n'a pas le droit de modifier cette etape.");
      return;
    }
    const nextSteps = pipeline.steps.map((step) =>
      step.id === stepId ? { ...step, modelRef: modelRef || undefined } : step,
    );
    await mutateResource(
      "patch",
      "pipelines",
      { steps: nextSteps },
      pipeline.id,
      "Modele d’etape mis a jour.",
    );
  }

  async function handleAgentExecutionSettingsAssignment(
    agentId: string,
    patch: ExecutionSettingsPatch,
  ) {
    if (!ensureAdminAccess("Le profil runtime agent est reserve a l'admin Elytras.")) {
      return;
    }
    const binding = getAgentBinding(agentId);
    if (!binding) {
      return;
    }
    const saved = await mutateResource(
      "patch",
      "agentBindings",
      patch as Record<string, unknown>,
      binding.id,
    );
    if (!saved) {
      return;
    }
    const liveSessionKeys = getAgentSessions(agentId).map((session) => session.key);
    await patchLiveSessions(
      liveSessionKeys,
      patch,
      liveSessionKeys.length
        ? `Profil agent mis a jour. ${liveSessionKeys.length} session(s) synchronisee(s).`
        : "Profil agent mis a jour.",
    );
  }

  async function handlePipelineStepExecutionSettingsAssignment(
    pipeline: PipelineRecord,
    stepId: string,
    patch: ExecutionSettingsPatch,
  ) {
    if (!canOperatePipelineRecord(pipeline)) {
      setError("Le user courant n'a pas le droit de modifier cette etape.");
      return;
    }
    const nextSteps = pipeline.steps.map((step) =>
      step.id === stepId ? { ...step, ...patch } : step,
    );
    await mutateResource(
      "patch",
      "pipelines",
      { steps: nextSteps },
      pipeline.id,
      "Profil d’etape mis a jour.",
    );
  }

  async function handleSelectedSessionExecutionPatch(patch: ExecutionSettingsPatch) {
    if (!selectedSessionKey) {
      return;
    }
    if (!canOperateSessionRecord(selectedSession)) {
      setError("Le user courant n'a pas le droit de modifier cette session.");
      return;
    }
    await patchLiveSessions([selectedSessionKey], patch, "Session live mise a jour.");
  }

  async function handleRunPipeline(pipeline: PipelineRecord, input = "") {
    if (!canOperatePipelineRecord(pipeline)) {
      setError("Le user courant n'a pas le droit d'executer ce pipeline.");
      return;
    }
    setPipelineRunBusyId(pipeline.id);
    setError("");
    try {
      const response = await runPipeline(config, pipeline.id, {
        input: input.trim() || undefined,
      });
      await refresh();
      const runs = await fetchPipelineRuns(config, {
        pipelineId: editingPipelineId || pipeline.id,
        limit: editingPipelineId || pipeline.id ? 80 : 40,
      });
      setPipelineRunSummaries(runs.runs);
      setSelectedPipelineRunId(response.result.runId);
      setSelectedPipelineRunDetail((await fetchPipelineRunDetail(config, response.result.runId)).run);
      const sentCount = response.result.deliveries.filter(
        (delivery) => delivery.status === "sent",
      ).length;
      if (response.result.status === "failed") {
        setError(response.result.error || `Pipeline ${pipeline.name} failed.`);
        setFlash(`Pipeline ${pipeline.name} en echec. Consulte les logs du run.`);
      } else {
        setFlash(
          sentCount > 0
            ? `Pipeline ${pipeline.name} execute. ${describeSentPipelineDeliveries(response.result.deliveries)}.`
            : `Pipeline ${pipeline.name} execute sans sortie externe.`,
        );
      }
    } catch (pipelineError) {
      setError(pipelineError instanceof Error ? pipelineError.message : String(pipelineError));
      await refresh();
    } finally {
      setPipelineRunBusyId("");
    }
  }

  function resetPipelineBuilder() {
    setPipelineStepModalOpen(false);
    setPipelineViewport(null);
    setPipelineNodePositions({});
    setPipelineEditorMode("create");
    setEditingPipelineId("");
    setSelectedPipelineRunId("");
    setSelectedPipelineRunDetail(null);
    const defaultTeamId = visibleTeams[0]?.id || "";
    const defaultAgentId = getTeamOwnedAgents(defaultTeamId)[0]?.id || visibleAgents[0]?.id || "main";
    const nextForm = createPipelineForm(defaultAgentId);
    nextForm.teamId = defaultTeamId;
    setSelectedPipelineStepId(nextForm.steps[0]?.id || "");
    setPipelineForm(nextForm);
  }

  function startPipelineEdit(pipeline: PipelineRecord) {
    if (!canViewPipelineRecord(pipeline)) {
      setError("Ce pipeline n'est pas dans le perimetre du user courant.");
      return;
    }
    setPipelineStepModalOpen(false);
    setPipelineEditorMode("edit");
    setEditingPipelineId(pipeline.id);
    setSelectedPipelineRunId("");
    setSelectedPipelineRunDetail(null);
    const nextForm = pipelineToForm(pipeline);
    setPipelineViewport(clonePipelineViewport(pipeline.viewport));
    setPipelineNodePositions(clonePipelineNodePositions(pipeline.nodePositions));
    setSelectedPipelineStepId(nextForm.steps[0]?.id || "");
    setPipelineForm(nextForm);
    setView("pipelines");
  }

  async function handleSavePipeline() {
    if (!ensureOperationalAccess("Le user courant ne peut pas sauver de pipeline.")) {
      return;
    }
    if (pipelineEditorMode === "edit") {
      const currentPipeline = pipelines.find((entry) => entry.id === editingPipelineId);
      if (currentPipeline && !canOperatePipelineRecord(currentPipeline)) {
        setError("Le user courant n'a pas le droit de modifier ce pipeline.");
        return;
      }
    }
    const resolvedTeamId = currentUserCanManageAdminViews
      ? pipelineForm.teamId
      : pipelineForm.teamId || selectedDashboardUserTeamIds[0] || "";
    if (!currentUserCanManageAdminViews && !resolvedTeamId) {
      setError("Choisis une equipe avant de sauver un pipeline.");
      return;
    }
    if (!currentUserCanManageAdminViews && !selectedDashboardUserTeamIdSet.has(resolvedTeamId)) {
      setError("Ce pipeline doit appartenir a l'une des equipes du user courant.");
      return;
    }
    const sanitizedSteps = pipelineForm.steps
      .map((step, index, steps) => buildPipelineStepFromDraft(step, index, steps))
      .filter((step) => step.agentId);
    const payload = {
      name: pipelineForm.name,
      description: pipelineForm.description,
      ownerId:
        currentUserCanManageAdminViews
          ? pipelineForm.ownerId
          : selectedDashboardUser?.id || pipelineForm.ownerId,
      teamId: resolvedTeamId || undefined,
      agentIds: pipelineAgentIds,
      outputTargets: splitList(pipelineForm.outputTargets).length
        ? splitList(pipelineForm.outputTargets)
        : suggestedPipelineOutputTargets,
      outputDeliveryMode: pipelineForm.outputDeliveryMode,
      status: pipelineForm.status,
      steps: sanitizedSteps,
      nodePositions: pipelineNodePositions,
      viewport: pipelineViewport,
    };

    const ok = await mutateResource(
      pipelineEditorMode === "edit" ? "patch" : "create",
      "pipelines",
      payload,
      pipelineEditorMode === "edit" ? editingPipelineId : undefined,
      pipelineEditorMode === "edit" ? "Pipeline mis a jour." : "Pipeline cree.",
    );
    if (ok) {
      resetPipelineBuilder();
    }
  }

  async function handleDeletePipeline(pipelineId: string) {
    const pipeline = pipelines.find((entry) => entry.id === pipelineId);
    if (pipeline && !canOperatePipelineRecord(pipeline)) {
      setError("Le user courant n'a pas le droit de supprimer ce pipeline.");
      return;
    }
    const ok = await mutateResource("delete", "pipelines", {}, pipelineId, "Pipeline supprime.");
    if (!ok) {
      return;
    }
    if (editingPipelineId === pipelineId) {
      closePipelineDraftStepModal();
      resetPipelineBuilder();
    }
  }

  function resetUserEditor() {
    setUserEditorMode("create");
    setEditingUserId("");
    setUserForm(createUserEditorForm());
  }

  function startUserEdit(user: (typeof users)[number]) {
    setUserEditorMode("edit");
    setEditingUserId(user.id);
    setUserForm({
      name: user.name,
      email: user.email,
      title: user.title || "",
      phone: user.phone || "",
      location: user.location || "",
      notes: user.notes || "",
      role: user.role,
      status: user.status,
      teamIds: resolveUserTeamIdsLocal(user),
      externalIdentities: user.externalIdentities.map((identity) => createExternalIdentityDraft(identity)),
    });
  }

  async function handleSaveUser() {
    const existingUser = users.find((entry) => entry.id === editingUserId);
    const nextExternalIdentities = sanitizeExternalIdentityDrafts(userForm.externalIdentities);
    const conflictingUsers = users.filter((user) => {
      if (user.id === editingUserId) {
        return false;
      }
      return user.externalIdentities.some((pattern) =>
        nextExternalIdentities.some(
          (identity) =>
            matchExternalIdentityPatternLocal(pattern, identity).matched ||
            matchExternalIdentityPatternLocal(identity, pattern).matched,
        ),
      );
    });
    if (conflictingUsers.length) {
      setError(
        `Ces identites externes sont deja utilisees par ${conflictingUsers
          .map((user) => user.name)
          .join(", ")}.`,
      );
      return;
    }
    const ok = await mutateResource(
      userEditorMode === "edit" ? "patch" : "create",
      "users",
      {
        name: userForm.name,
        email: userForm.email,
        title: userForm.title,
        phone: userForm.phone,
        location: userForm.location,
        notes: userForm.notes,
        role: userForm.role,
        status: userForm.status,
        teamIds: userForm.teamIds,
        agentIds: existingUser?.agentIds || [],
        channelIds: existingUser?.channelIds || [],
        externalIdentities: nextExternalIdentities,
      },
      userEditorMode === "edit" ? editingUserId : undefined,
      userEditorMode === "edit" ? "Utilisateur mis a jour." : "Utilisateur ajoute.",
    );
    if (ok) {
      resetUserEditor();
    }
  }

  function openUserEditorFromChat(userId?: string) {
    if (!userId) {
      setView("users");
      return;
    }
    const user = users.find((entry) => entry.id === userId);
    if (!user) {
      setView("users");
      return;
    }
    startUserEdit(user);
    setView("users");
  }

  function openInboxSessionFromGovernance(sessionKey: string) {
    setSessionSearch("");
    setSessionAgentFilter("all");
    setInboxChannelFilter("all");
    setChatWorkspaceMode("inbox");
    setSelectedSessionKey(sessionKey);
    setView("chat");
  }

  function getPreferredInboundGrantSubject(principal?: SessionInboundPrincipal) {
    if (!principal || principal.status !== "resolved" || !principal.userId) {
      return null;
    }
    const preferredTeamIds =
      principal.authorizingTeamIds?.length ? principal.authorizingTeamIds : principal.teamIds;
    if (preferredTeamIds.length === 1) {
      const teamId = preferredTeamIds[0]!;
      return {
        subjectType: "team" as const,
        subjectId: teamId,
        label: `equipe ${teamName(teamId)}`,
      };
    }
    return {
      subjectType: "user" as const,
      subjectId: principal.userId,
      label: `user ${principal.userName || ownerName(principal.userId)}`,
    };
  }

  function getInboundGrantAgentIds(
    principal?: SessionInboundPrincipal,
    fallbackAgentId?: string,
  ) {
    return Array.from(
      new Set(
        [principal?.targetAgentId, fallbackAgentId].filter(
          (agentId): agentId is string => Boolean(agentId),
        ),
      ),
    );
  }

  function inboundPrincipalNeedsRbacReview(principal?: SessionInboundPrincipal) {
    return (
      principal?.status === "ambiguous" ||
      (principal?.status === "resolved" &&
        (!principal.canUseChannel || !principal.canUseAgent))
    );
  }

  function subjectHasSufficientGrant(params: {
    subjectType: "user" | "team";
    subjectId: string;
    resourceType: AccessGrant["resourceType"];
    resourceId: string;
    minimumPermission: AccessGrant["permission"];
  }) {
    return grants.some((grant) => {
      if (grant.subjectType !== params.subjectType || grant.subjectId !== params.subjectId) {
        return false;
      }
      if (
        grant.resourceType !== params.resourceType &&
        grant.resourceType !== "*"
      ) {
        return false;
      }
      if (grant.resourceId !== params.resourceId && grant.resourceId !== "*") {
        return false;
      }
      return permissionRankLocal(grant.permission) >= permissionRankLocal(params.minimumPermission);
    });
  }

  async function grantInboundResources(
    principal: SessionInboundPrincipal | undefined,
    resourceType: "agent" | "channel",
    resourceIds: string[],
  ) {
    if (!ensureAdminAccess("La gestion des grants inbound est reservee a l'admin Elytras.")) {
      return false;
    }
    const subject = getPreferredInboundGrantSubject(principal);
    if (!subject) {
      setError("Aucun sujet Elytras resolu pour creer un grant.");
      return false;
    }
    const pendingResourceIds = Array.from(new Set(resourceIds.filter(Boolean))).filter(
      (resourceId) =>
        !subjectHasSufficientGrant({
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          resourceType,
          resourceId,
          minimumPermission: "operate",
        }),
    );
    if (!pendingResourceIds.length) {
      setFlash(`Le grant ${resourceType} existe deja pour ${subject.label}.`);
      return true;
    }
    try {
      for (const resourceId of pendingResourceIds) {
        await createStoreResource("grants", config, {
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          resourceType,
          resourceId,
          permission: "operate",
        });
      }
      await refresh();
      setFlash(
        pendingResourceIds.length === 1
          ? `Grant ${resourceType}:${pendingResourceIds[0]} ajoute pour ${subject.label}.`
          : `${pendingResourceIds.length} grants ${resourceType} ajoutes pour ${subject.label}.`,
      );
      return true;
    } catch (grantError) {
      setError(grantError instanceof Error ? grantError.message : String(grantError));
      return false;
    }
  }

  async function activateInboundUser(principal?: SessionInboundPrincipal) {
    if (!principal || principal.status !== "resolved" || !principal.userId) {
      return false;
    }
    return mutateResource(
      "patch",
      "users",
      { status: "active" },
      principal.userId,
      `User ${principal.userName || ownerName(principal.userId)} active.`,
    );
  }

  async function promoteInboundUserFromViewer(principal?: SessionInboundPrincipal) {
    if (!principal || principal.status !== "resolved" || !principal.userId) {
      return false;
    }
    return mutateResource(
      "patch",
      "users",
      { role: "member" },
      principal.userId,
      `User ${principal.userName || ownerName(principal.userId)} passe en member.`,
    );
  }

  function seedUserEditorFromInboundIdentity(identity: string) {
    const seed = deriveInboundIdentitySeed(identity);
    const defaultTeamIds =
      selectedDashboardScopedTeam?.id
        ? [selectedDashboardScopedTeam.id]
        : selectedDashboardAvailableTeamIds.length === 1
          ? [selectedDashboardAvailableTeamIds[0]!]
          : [];
    resetUserEditor();
    setUserForm({
      name: seed.name,
      email: seed.email,
      title: "",
      phone: "",
      location: "",
      notes: "",
      role: "member",
      status: "active",
      teamIds: defaultTeamIds,
      externalIdentities: [createExternalIdentityDraft(identity)],
    });
    setView("users");
  }

  async function handleAttachInboundIdentityToUser() {
    const identity = inboundMappingIdentity.trim().toLowerCase();
    const user = users.find((entry) => entry.id === inboundMappingUserId);
    if (!identity) {
      setError("Choisis une identite inbound a rattacher.");
      return;
    }
    if (!user) {
      setError("Choisis un user Elytras avant de rattacher cette identite.");
      return;
    }
    const nextExternalIdentities = Array.from(
      new Set([...user.externalIdentities, identity]),
    ).toSorted((left, right) => left.localeCompare(right));
    const ok = await mutateResource(
      "patch",
      "users",
      { externalIdentities: nextExternalIdentities },
      user.id,
      `Identite ${identity} rattachee a ${user.name}.`,
    );
    if (ok) {
      setInboundMappingUserId(user.id);
    }
  }

  async function handleCreateInboundUser() {
    if (!ensureAdminAccess("La creation d'un user inbound est reservee a l'admin Elytras.")) {
      return false;
    }
    const identity = inboundMappingIdentity.trim().toLowerCase();
    if (!identity) {
      setError("Choisis une identite inbound a rattacher.");
      return false;
    }
    if (inboundIdentityConflictUsers.length) {
      setError(
        `Cette identite matche deja ${inboundIdentityConflictUsers
          .map((user) => user.name)
          .join(", ")}.`,
      );
      return false;
    }
    const seed = deriveInboundIdentitySeed(identity);
    const name = inboundNewUserDraft.name.trim() || seed.name || identity;
    const email =
      inboundNewUserDraft.email.trim() ||
      `${slugifyClient(name || identity) || "user"}@local`;
    try {
      const created = await createStoreResource("users", config, {
        name,
        email,
        role: inboundNewUserDraft.role,
        status: inboundNewUserDraft.status,
        teamIds: inboundNewUserDraft.teamIds,
        agentIds: [],
        channelIds: [],
        externalIdentities: [identity],
      });
      await refresh();
      setInboundMappingUserId(String(created.result.id || ""));
      setFlash(`User ${name} cree et rattache a ${identity}.`);
      return true;
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
      return false;
    }
  }

  function getPreferredInboundTeam(principal?: SessionInboundPrincipal) {
    if (!principal || principal.status !== "resolved") {
      return null;
    }
    const preferredTeamIds =
      principal.authorizingTeamIds?.length ? principal.authorizingTeamIds : principal.teamIds;
    if (preferredTeamIds.length !== 1) {
      return null;
    }
    return teams.find((team) => team.id === preferredTeamIds[0]) || null;
  }

  async function attachInboundResourcesToPreferredTeam(
    principal: SessionInboundPrincipal | undefined,
    resourceType: "agent" | "channel",
    resourceIds: string[],
  ) {
    if (!ensureAdminAccess("La gestion des equipes inbound est reservee a l'admin Elytras.")) {
      return false;
    }
    const team = getPreferredInboundTeam(principal);
    if (!team) {
      setError(
        "Cette conversation doit d'abord etre rattachee a une seule equipe avant de propager l'acces par equipe.",
      );
      return false;
    }
    const currentIds = resourceType === "agent" ? team.agentIds : team.channelIds;
    const pendingIds = Array.from(new Set(resourceIds.filter(Boolean))).filter(
      (resourceId) => !currentIds.includes(resourceId),
    );
    if (!pendingIds.length) {
      setFlash(
        resourceType === "agent"
          ? `L'equipe ${team.name} couvre deja cet agent.`
          : `L'equipe ${team.name} couvre deja cette destination.`,
      );
      return true;
    }
    const payload =
      resourceType === "agent"
        ? {
            agentIds: [...currentIds, ...pendingIds].toSorted((left, right) =>
              left.localeCompare(right),
            ),
          }
        : {
            channelIds: [...currentIds, ...pendingIds].toSorted((left, right) =>
              left.localeCompare(right),
            ),
          };
    return mutateResource(
      "patch",
      "teams",
      payload,
      team.id,
      resourceType === "agent"
        ? `Equipe ${team.name} mise a jour: ${pendingIds.length} agent(s) ajoute(s).`
        : `Equipe ${team.name} mise a jour: ${pendingIds.length} destination(s) ajoutee(s).`,
    );
  }

  function resetTeamEditor() {
    setTeamEditorMode("create");
    setEditingTeamId("");
    setTeamForm({
      name: "",
      color: "#234b40",
      description: "",
      contactEmail: "",
      website: "",
      notes: "",
      memberIds: [],
      agentIds: [],
      channelIds: [],
    });
  }

  function startTeamEdit(team: (typeof teams)[number]) {
    setTeamEditorMode("edit");
    setEditingTeamId(team.id);
    setTeamForm({
      name: team.name,
      color: team.color,
      description: team.description,
      contactEmail: team.contactEmail || "",
      website: team.website || "",
      notes: team.notes || "",
      memberIds: [...team.memberIds],
      agentIds: [...team.agentIds],
      channelIds: [...team.channelIds],
    });
  }

  async function handleSaveTeam() {
    const ok = await mutateResource(
      teamEditorMode === "edit" ? "patch" : "create",
      "teams",
      {
        name: teamForm.name,
        color: teamForm.color,
        description: teamForm.description,
        contactEmail: teamForm.contactEmail,
        website: teamForm.website,
        notes: teamForm.notes,
        memberIds: teamForm.memberIds,
        agentIds: teamForm.agentIds,
        channelIds: teamForm.channelIds,
      },
      teamEditorMode === "edit" ? editingTeamId : undefined,
      teamEditorMode === "edit" ? "Equipe mise a jour." : "Equipe ajoutee.",
    );
    if (ok) {
      resetTeamEditor();
    }
  }

  function resetProjectEditor() {
    setProjectEditorMode("create");
    setEditingProjectId("");
    setProjectForm(createProjectEditor(selectedDashboardScopedTeam?.id || visibleTeams[0]?.id || ""));
  }

  function startProjectEdit(project: DashboardProject) {
    setProjectEditorMode("edit");
    setEditingProjectId(project.id);
    setProjectForm({
      name: project.name,
      description: project.description || "",
      teamId: project.teamId,
      memberIds: [...project.memberIds],
      agentIds: [...project.agentIds],
      notes: project.notes || "",
    });
  }

  async function handleSaveProject() {
    const ok = await mutateResource(
      projectEditorMode === "edit" ? "patch" : "create",
      "projects",
      {
        name: projectForm.name,
        description: projectForm.description,
        teamId: projectForm.teamId,
        memberIds: projectForm.memberIds,
        agentIds: projectForm.agentIds,
        notes: projectForm.notes,
      },
      projectEditorMode === "edit" ? editingProjectId : undefined,
      projectEditorMode === "edit" ? "Projet memoire mis a jour." : "Projet memoire ajoute.",
    );
    if (ok) {
      resetProjectEditor();
    }
  }

  function updateBridgeEditorModels(
    updater: (current: ProviderBridgeEditor) => ProviderBridgeEditor,
  ) {
    setBridgeEditorDirty(true);
    setBridgeEditor((current) => {
      const next = updater(current);
      if (next.primaryModelId && !next.activeModelIds.includes(next.primaryModelId)) {
        return {
          ...next,
          primaryModelId: next.activeModelIds[0] || "",
        };
      }
      if (!next.primaryModelId && next.activeModelIds[0]) {
        return {
          ...next,
          primaryModelId: next.activeModelIds[0],
        };
      }
      return next;
    });
  }

  function toggleBridgeModel(modelId: string) {
    updateBridgeEditorModels((current) => ({
      ...current,
      activeModelIds: current.activeModelIds.includes(modelId)
        ? current.activeModelIds.filter((entry) => entry !== modelId)
        : [...current.activeModelIds, modelId],
    }));
  }

  function selectAllBridgeModels() {
    updateBridgeEditorModels((current) => ({
      ...current,
      activeModelIds: selectedBridgeModels.map((model) => model.id),
    }));
  }

  function clearBridgeModels() {
    updateBridgeEditorModels((current) => ({
      ...current,
      activeModelIds: [],
    }));
  }

  function renderMissionControl() {
    if (!snapshot) {
      return null;
    }
    const recentSessions = [...visibleSessions]
      .filter((session) => !isPipelineSessionLike(session, pipelines))
      .toSorted((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
      .slice(0, 8);

    return (
      <section className="stack">
        <div className="metrics-grid">
          <MetricCard
            label="Agents"
            value={String(scopedOverview.agentCount)}
            detail={`${scopedOverview.runningAgents} en train de bosser`}
          />
          <MetricCard
            label="Sessions"
            value={String(scopedOverview.sessionCount)}
            detail={`${scopedOverview.runningSessions} live sur le gateway`}
          />
          <MetricCard
            label="Pipelines"
            value={String(scopedOverview.pipelineCount)}
            detail={`${scopedOverview.activePipelines} en cours`}
          />
          <MetricCard
            label="Cron Jobs"
            value={String(scopedOverview.cronCount)}
            detail={`${scopedOverview.activeCronJobs} actifs`}
          />
        </div>

        <div className="panel-grid mission-layout">
          <section className="panel">
            <ResourceToolbar
              title="Mission Control"
              detail="Kanban temps reel pour pipelines et cron jobs"
            />
            <div className="kanban-grid">
              {kanbanLanes.map((lane) => (
                <article key={lane.id} className="kanban-column">
                  <div className="kanban-head">
                    <strong>{lane.label}</strong>
                    <span>{lane.cards.length}</span>
                  </div>
                  <div className="kanban-cards">
                    {lane.cards.length === 0 ? (
                      <EmptyState title="Lane vide" body="Aucun item dans cette colonne." />
                    ) : (
                      lane.cards.map((card) => (
                        <div
                          key={`${card.kind}-${card.id}`}
                          className={`kanban-card ${card.accent}`}
                        >
                          <div className="info-row compact">
                            <strong>{card.title}</strong>
                            <StatusPill status={card.status}>{card.status}</StatusPill>
                          </div>
                          <p>{card.detail}</p>
                          <small className="muted-line">
                            {card.kind} · {card.meta}
                          </small>
                        </div>
                      ))
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="panel">
            <ResourceToolbar title="Live Agents" detail="Qui fait quoi maintenant" />
            <div className="agent-radar">
              {visibleAgents.map((agent) => (
                <article key={agent.id} className="radar-card">
                  <div className="info-row compact">
                    <strong>{agent.identity?.name || agent.name || agent.id}</strong>
                    <StatusPill status={agent.currentStatus}>{agent.currentStatus}</StatusPill>
                  </div>
                  <p>{agent.currentActivity}</p>
                  <small className="muted-line">
                    team {teamName(agent.teamId)}
                  </small>
                  <small className="muted-line">workspace {agent.workspace?.path || "n/a"}</small>
                </article>
              ))}
            </div>
          </section>
        </div>

        <section className="panel">
          <ResourceToolbar
            title="Recent Sessions"
            detail="Dernieres activites hors runs pipeline"
          />
          <div className="list-grid">
            {recentSessions.map((session) => (
              <button
                key={session.key}
                type="button"
                className={`session-card ${selectedSessionKey === session.key ? "active" : ""}`}
                onClick={() => {
                  setView("chat");
                  setSelectedSessionKey(session.key);
                }}
              >
                <div className="info-row compact">
                  <strong>{session.displayName || session.derivedTitle || session.key}</strong>
                  <StatusPill status={session.activityStatus}>{session.activityStatus}</StatusPill>
                </div>
                <p>{session.lastMessagePreview || "Aucun message recent."}</p>
                <small className="muted-line">
                  {session.agentId} · {formatDateTime(session.updatedAt)}
                </small>
                {shouldShowInboundPrincipal(session) ? (
                  <div className="info-row compact">
                    <StatusPill status={inboundPrincipalTone(session.inboundPrincipal)}>
                      {describeInboundPrincipalState(session.inboundPrincipal)}
                    </StatusPill>
                    <small className="muted-line">
                      {summarizeInboundPrincipal(session.inboundPrincipal)}
                    </small>
                  </div>
                ) : null}
              </button>
            ))}
          </div>
        </section>
      </section>
    );
  }

  function renderMemoryEngineWorkbench() {
    const managedEngineStatus = memoryEngineStatus?.managedPlugin;
    const loadingState = memoryEngineLoading && !memoryEngineStatus;
    const engineStatusLabel = memoryEngineStatus
      ? managedEngineStatus?.selected
        ? `${memoryEngineStatus.managedPluginLabel} actif`
        : memoryEngineStatus.activeEngineId === "legacy"
          ? "legacy actif"
          : memoryEngineStatus.activeEngineId
      : "Chargement";

    return (
      <div className="stack">
        <section className="selection-panel memory-engine-hero">
          <div className="memory-engine-head">
            <div className="stack compact">
              <small className="eyebrow-label">Context Engine</small>
              <h4>Memoire runtime</h4>
              <p className="muted-line">
                Les fichiers markdown de l’agent cadrent son comportement. Ici, tu regles le
                moteur de contexte global OpenClaw qui assemble, compacte et rappelle l’historique.
              </p>
            </div>
            <StatusPill
              status={
                managedEngineStatus?.selected ? "active" : memoryEngineStatus ? "paused" : "workspace"
              }
            >
              {engineStatusLabel}
            </StatusPill>
          </div>

          {loadingState ? (
            <EmptyState
              title="Lecture du moteur de memoire"
              body="Le dashboard interroge la config runtime locale et l’inventaire des plugins."
            />
          ) : memoryEngineStatus ? (
            <>
              <div className="memory-engine-summary-grid">
                <article className="agent-summary-card">
                  <span>Moteur actif</span>
                  <strong>{memoryEngineStatus.activeEngineId}</strong>
                  <small>{memoryEngineStatus.configPath}</small>
                </article>
                <article className="agent-summary-card">
                  <span>Plugin gere</span>
                  <strong>{managedEngineStatus?.installed ? "installe" : "absent"}</strong>
                  <small>
                    {memoryEngineStatus.managedPluginLabel}
                    {managedEngineStatus?.version ? ` · ${managedEngineStatus.version}` : ""}
                  </small>
                </article>
                <article className="agent-summary-card">
                  <span>Base locale</span>
                  <strong>{memoryEngineStatus.resolvedPaths.dbPath}</strong>
                  <small>SQLite locale au runtime Elytras</small>
                </article>
                <article className="agent-summary-card">
                  <span>Etat SQLite</span>
                  <strong>
                    {memoryEngineStatus.dbStats.available
                      ? `${memoryEngineStatus.dbStats.conversations || 0} conv · ${memoryEngineStatus.dbStats.messages || 0} msg`
                      : "db absente"}
                  </strong>
                  <small>
                    {memoryEngineStatus.dbStats.available
                      ? `${formatBytes(memoryEngineStatus.dbStats.sizeBytes)} · maj ${formatDateTime(memoryEngineStatus.dbStats.updatedAtMs)}`
                      : "Aucune base detectee sur la runtime locale"}
                  </small>
                </article>
                <article className="agent-summary-card">
                  <span>Audit Elytras</span>
                  <strong>
                    {memoryEngineStatus.auditLog.exists
                      ? `${memoryEngineStatus.auditLog.lineCount || 0} events`
                      : "audit absent"}
                  </strong>
                  <small>
                    {memoryEngineStatus.auditLog.exists
                      ? `${memoryEngineStatus.auditLog.lastEventType || "event"} · ${formatDateTime(memoryEngineStatus.auditLog.lastEventAt || memoryEngineStatus.auditLog.updatedAtMs)}`
                      : memoryEngineStatus.resolvedPaths.auditLogPath || "Aucun journal detecte"}
                  </small>
                </article>
                <article className="agent-summary-card">
                  <span>Outils de rappel</span>
                  <strong>{memoryEngineToolNames.length}</strong>
                  <small>{memoryEngineToolNames.join(", ")}</small>
                </article>
              </div>

              <div className="button-row">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={memoryEngineBusy === "install"}
                  onClick={() => void handleInstallManagedMemoryPlugin()}
                >
                  {memoryEngineBusy === "install" ? "Verification..." : "Verifier le plugin"}
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={!managedEngineStatus?.installed || Boolean(memoryEngineBusy)}
                  onClick={() => void handleSaveMemoryEngine("elytrasless")}
                >
                  {memoryEngineBusy === "elytrasless"
                    ? "Activation..."
                    : `Activer ${memoryEngineStatus.managedPluginLabel}`}
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={Boolean(memoryEngineBusy)}
                  onClick={() => void handleSaveMemoryEngine("legacy")}
                >
                  {memoryEngineBusy === "legacy" ? "Retour..." : "Revenir au legacy"}
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={memoryEngineLoading}
                  onClick={() => setMemoryEngineRefreshToken((current) => current + 1)}
                >
                  Recharger
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() =>
                    setMemoryEngineForm((current) => ({
                      ...current,
                      freshTailCount: LOSSLESS_CLAW_RECOMMENDED_PRESET.freshTailCount,
                      contextThreshold: LOSSLESS_CLAW_RECOMMENDED_PRESET.contextThreshold,
                      incrementalMaxDepth: LOSSLESS_CLAW_RECOMMENDED_PRESET.incrementalMaxDepth,
                      ignoreSessionPatterns: LOSSLESS_CLAW_RECOMMENDED_PRESET.ignoreSessionPatterns,
                      statelessSessionPatterns:
                        LOSSLESS_CLAW_RECOMMENDED_PRESET.statelessSessionPatterns,
                      skipStatelessSessions:
                        LOSSLESS_CLAW_RECOMMENDED_PRESET.skipStatelessSessions,
                    }))
                  }
                >
                  Preset recommande
                </button>
              </div>
            </>
          ) : null}
        </section>

        {memoryEngineStatus ? (
          <div className="memory-engine-grid">
            <section className="selection-panel">
              <div className="info-row compact">
                <strong>Configuration {memoryEngineStatus.managedPluginLabel}</strong>
                <StatusPill status={managedEngineStatus?.selected ? "active" : "paused"}>
                  {managedEngineStatus?.selected ? "active" : "preconfigure"}
                </StatusPill>
              </div>
              <div className="form-grid">
                <label className="field-span-2">
                  Base SQLite
                  <input
                    className="input"
                    value={memoryEngineForm.dbPath}
                    onChange={(event) =>
                      setMemoryEngineForm((current) => ({
                        ...current,
                        dbPath: event.target.value,
                      }))
                    }
                    placeholder={memoryEngineStatus.defaultDbPath}
                  />
                </label>
                <label>
                  Summary model
                  <select
                    className="select"
                    value={memoryEngineForm.summaryModel}
                    onChange={(event) =>
                      setMemoryEngineForm((current) => ({
                        ...current,
                        summaryModel: event.target.value,
                      }))
                    }
                  >
                    <option value="">Defaut runtime</option>
                    {runtimeModels.map((model) => (
                      <option key={model.ref} value={model.ref}>
                        {model.modelId}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Expansion model
                  <select
                    className="select"
                    value={memoryEngineForm.expansionModel}
                    onChange={(event) =>
                      setMemoryEngineForm((current) => ({
                        ...current,
                        expansionModel: event.target.value,
                      }))
                    }
                  >
                    <option value="">Defaut runtime</option>
                    {runtimeModels.map((model) => (
                      <option key={model.ref} value={model.ref}>
                        {model.modelId}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Fresh tail count
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={memoryEngineForm.freshTailCount}
                    onChange={(event) =>
                      setMemoryEngineForm((current) => ({
                        ...current,
                        freshTailCount: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Context threshold
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={1}
                    step="0.05"
                    value={memoryEngineForm.contextThreshold}
                    onChange={(event) =>
                      setMemoryEngineForm((current) => ({
                        ...current,
                        contextThreshold: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Incremental max depth
                  <input
                    className="input"
                    type="number"
                    min={-1}
                    value={memoryEngineForm.incrementalMaxDepth}
                    onChange={(event) =>
                      setMemoryEngineForm((current) => ({
                        ...current,
                        incrementalMaxDepth: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="field-span-2">
                  Ignore session patterns
                  <textarea
                    className="input textarea"
                    rows={5}
                    value={memoryEngineForm.ignoreSessionPatterns}
                    onChange={(event) =>
                      setMemoryEngineForm((current) => ({
                        ...current,
                        ignoreSessionPatterns: event.target.value,
                      }))
                    }
                    placeholder="Une glob par ligne pour ignorer certaines sessions."
                  />
                </label>
                <label className="field-span-2">
                  Stateless session patterns
                  <textarea
                    className="input textarea"
                    rows={5}
                    value={memoryEngineForm.statelessSessionPatterns}
                    onChange={(event) =>
                      setMemoryEngineForm((current) => ({
                        ...current,
                        statelessSessionPatterns: event.target.value,
                      }))
                    }
                    placeholder="Une glob par ligne pour les sessions ephemeres ou subagents."
                  />
                </label>
                <label className="checkbox-row field-span-2">
                  <input
                    type="checkbox"
                    checked={memoryEngineForm.skipStatelessSessions}
                    onChange={(event) =>
                      setMemoryEngineForm((current) => ({
                        ...current,
                        skipStatelessSessions: event.target.checked,
                      }))
                    }
                  />
                  <span>Ignorer automatiquement les sessions marquees stateless</span>
                </label>
                <div className="agent-markdown-hint field-span-2">
                  Preset recommande pour {memoryEngineStatus.managedPluginLabel}: garde une fresh
                  tail plus large, ignore les cron runs et traite les subagents comme stateless
                  pour ne pas polluer le rappel.
                </div>
              </div>
            </section>

            <section className="selection-panel">
              <div className="info-row compact">
                <strong>Notes d’exploitation</strong>
                <StatusPill status="workspace">runtime</StatusPill>
              </div>
              <div className="stack compact">
                <div className="agent-studio-note">
                  <strong>Rappel natif OpenClaw</strong>
                  <p>
                    Garde tes instructions profondes dans `AGENTS.md`, `MEMORY.md` et
                    `memory/*.md`. {memoryEngineStatus.managedPluginLabel} s’occupe ensuite du
                    recall et de la compaction au niveau runtime.
                  </p>
                </div>
                <div className="agent-studio-note">
                  <strong>Outils exposes au modele</strong>
                  <div className="runtime-model-card-meta">
                    {memoryEngineToolNames.map((toolName) => (
                      <span key={toolName} className="inline-tag">
                        {toolName}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="detail-pairs compact-grid">
                  <span>Plugin source</span>
                  <span>{managedEngineStatus?.source || "non detecte"}</span>
                  <span>Plugin status</span>
                  <span>{managedEngineStatus?.status || "n/a"}</span>
                  <span>DB resolue</span>
                  <span>{memoryEngineStatus.resolvedPaths.dbPath}</span>
                  <span>Store Elytras</span>
                  <span>{memoryEngineStatus.resolvedPaths.storePath || "n/a"}</span>
                  <span>Data root</span>
                  <span>{memoryEngineStatus.resolvedPaths.dataRoot || "n/a"}</span>
                  <span>Audit log</span>
                  <span>{memoryEngineStatus.resolvedPaths.auditLogPath || "n/a"}</span>
                  <span>Subagent override</span>
                  <span>
                    {managedEngineStatus?.subagent.allowModelOverride ? "active" : "off"}
                  </span>
                  <span>Allowed models</span>
                  <span>
                    {managedEngineStatus?.subagent.allowedModels.join(", ") || "aucun explicite"}
                  </span>
                  <span>Summaries SQLite</span>
                  <span>
                    {memoryEngineStatus.dbStats.available
                      ? `${memoryEngineStatus.dbStats.summaries || 0}`
                      : "n/a"}
                  </span>
                  <span>Dernier audit</span>
                  <span>
                    {memoryEngineStatus.auditLog.exists
                      ? `${memoryEngineStatus.auditLog.lastEventType || "event"} · ${formatDateTime(memoryEngineStatus.auditLog.lastEventAt || memoryEngineStatus.auditLog.updatedAtMs)}`
                      : "aucun"}
                  </span>
                </div>
                <div className="agent-studio-note">
                  <strong>Modeles actuellement relies</strong>
                  <p>
                    Summary: {memoryEngineSummaryModel?.modelId || memoryEngineForm.summaryModel || "defaut runtime"}
                  </p>
                  <p>
                    Expansion: {memoryEngineExpansionModel?.modelId || memoryEngineForm.expansionModel || "defaut runtime"}
                  </p>
                </div>
                <div className="button-row">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      setMemoryEngineForm(
                        createMemoryEngineForm(
                          memoryEngineStatus,
                          runtimeDefaults.agentPrimaryModelRef,
                        ),
                      )
                    }
                  >
                    Reprendre la config runtime
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={!managedEngineStatus?.installed || Boolean(memoryEngineBusy)}
                    onClick={() => void handleSaveMemoryEngine("elytrasless")}
                  >
                    Sauvegarder la memoire
                  </button>
                </div>
              </div>
            </section>
          </div>
        ) : null}
      </div>
    );
  }

  function renderAgentMemoryWorkbench() {
    if (agentEditorMode !== "edit") {
      return (
        <div className="stack">
          {renderMemoryEngineWorkbench()}
          <section className="selection-panel">
            <EmptyState
              title="Insight agent apres creation"
              body="Sauvegarde d’abord l’agent pour inspecter ce que le moteur memoire runtime indexe reellement dans sa base locale."
            />
          </section>
        </div>
      );
    }

    const insight = agentMemoryInsight;
    const engineStateLabel = !insight
      ? agentMemoryLoading
        ? "lecture"
        : "n/a"
      : insight.engine.active
        ? "memoire active"
        : insight.engine.available
          ? "db lisible"
          : "db absente";
    const engineStateTone = !insight
      ? "paused"
      : insight.engine.active
        ? "active"
        : insight.engine.available
          ? "warning"
          : "paused";

    return (
      <div className="stack">
        {renderMemoryEngineWorkbench()}

        <section className="selection-panel agent-memory-hero">
          <div className="memory-engine-head">
            <div className="stack compact">
              <small className="eyebrow-label">{memoryEngineStatus?.managedPluginLabel || "Memoire runtime"}</small>
              <h4>Memoire agent</h4>
              <p className="muted-line">
                Vue read-only du recall reel pour {agentEditor.name || agentEditor.agentId}: base
                SQLite locale, conversations indexees, resumes compacts et recherche plein texte.
              </p>
            </div>
            <StatusPill status={engineStateTone}>{engineStateLabel}</StatusPill>
          </div>

          {agentMemoryError ? <div className="banner danger">{agentMemoryError}</div> : null}

          {agentMemoryLoading && !insight ? (
            <EmptyState
              title="Inspection en cours"
              body="Le dashboard relie les sessions de l’agent au contenu actuellement present dans la base memoire runtime."
            />
          ) : insight ? (
            <>
              <div className="agent-memory-summary-grid">
                <article className="agent-summary-card">
                  <span>Base locale</span>
                  <strong>{insight.engine.dbPath}</strong>
                  <small>{insight.engine.reason || "Lecture SQLite directe sur le runtime local."}</small>
                </article>
                <article className="agent-summary-card">
                  <span>Sessions dashboard</span>
                  <strong>{insight.stats.dashboardSessionCount}</strong>
                  <small>{insight.stats.indexedSessionCount} session(s) vues dans la base</small>
                </article>
                <article className="agent-summary-card">
                  <span>Conversations</span>
                  <strong>{insight.stats.conversationCount}</strong>
                  <small>{insight.stats.messageCount} message(s) indexes</small>
                </article>
                <article className="agent-summary-card">
                  <span>Resumes</span>
                  <strong>{insight.stats.summaryCount}</strong>
                  <small>
                    Dernier compactage {formatDateTime(insight.stats.lastSummaryAt)}
                  </small>
                </article>
              </div>

              <div className="agent-memory-toolbar">
                <label className="agent-memory-search-field">
                  Recherche dans la memoire
                  <input
                    className="input"
                    value={agentMemorySearchDraft}
                    onChange={(event) => setAgentMemorySearchDraft(event.target.value)}
                    placeholder="decision, client, contrainte, TODO..."
                  />
                </label>
                <div className="button-row">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setAgentMemorySearchQuery(agentMemorySearchDraft.trim())}
                    disabled={agentMemoryLoading}
                  >
                    {agentMemoryLoading && agentMemorySearchQuery ? "Recherche..." : "Rechercher"}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={!agentMemorySearchDraft && !agentMemorySearchQuery}
                    onClick={() => {
                      setAgentMemorySearchDraft("");
                      setAgentMemorySearchQuery("");
                    }}
                  >
                    Effacer
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={agentMemoryLoading}
                    onClick={() => setAgentMemoryRefreshToken((current) => current + 1)}
                  >
                    Recharger
                  </button>
                </div>
              </div>

              {insight.trackedSessionKeys.length ? (
                <div className="runtime-model-card-meta">
                  {insight.trackedSessionKeys.slice(0, 8).map((sessionKey) => (
                    <span key={sessionKey} className="inline-tag">
                      {sessionKey}
                    </span>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </section>

        {insight ? (
          <>
            <div className="agent-memory-grid">
              <section className="selection-panel">
                <div className="info-row compact">
                  <strong>Surfaces indexables</strong>
                  <StatusPill status="active">
                    {selectedAgentIndexedMemoryFiles.length} fichier(s)
                  </StatusPill>
                </div>
                <div className="detail-pairs compact-grid">
                  <span>Workspace</span>
                  <code className="mono">{agentEditor.workspace || "n/a"}</code>
                  <span>Markdowns</span>
                  <span>{selectedAgentAllFiles.length}</span>
                  <span>Memoires notees</span>
                  <span>{selectedAgentIndexedMemoryFiles.length}</span>
                  <span>Derniere conversation</span>
                  <span>{formatDateTime(insight.stats.lastConversationAt)}</span>
                </div>
                <div className="agent-memory-surface-grid">
                  {selectedAgentMemorySurfaceCards.map((surface) => (
                    <article key={surface.fileName} className="agent-template-card static">
                      <div className="info-row compact">
                        <strong>{surface.fileName}</strong>
                        <StatusPill status={surface.state.status}>{surface.state.label}</StatusPill>
                      </div>
                      <p>{surface.guide.description}</p>
                      <small>{surface.guide.emphasis}</small>
                    </article>
                  ))}
                </div>
                {selectedAgentIndexedMemoryFiles.length ? (
                  <div className="agent-memory-list compact">
                    {selectedAgentIndexedMemoryFiles.map((file) => (
                      <article key={file.path} className="agent-memory-item">
                        <div className="info-row compact">
                          <strong>{file.name}</strong>
                          <StatusPill status={file.type}>{file.type}</StatusPill>
                        </div>
                        <small className="muted-line">
                          {file.path} · {formatBytes(file.size)} · maj {formatDateTime(file.updatedAtMs)}
                        </small>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="Aucune note indexable"
                    body="Ajoute surtout `MEMORY.md` ou des fichiers `memory/*.md` pour donner de la matiere durable au moteur memoire."
                  />
                )}
              </section>

              <section className="selection-panel">
                <div className="info-row compact">
                  <strong>Conversations recentes</strong>
                  <StatusPill status="active">{insight.conversations.length}</StatusPill>
                </div>
                {insight.conversations.length ? (
                  <div className="agent-memory-list">
                    {insight.conversations.map((conversation) => (
                      <article
                        key={`${conversation.conversationId}:${conversation.sessionKey}`}
                        className="agent-memory-item"
                      >
                        <div className="info-row compact">
                          <strong>{conversation.sessionLabel || conversation.sessionKey}</strong>
                          <StatusPill status="active">
                            {conversation.summaryCount} resume(s)
                          </StatusPill>
                        </div>
                        <p>{conversation.title || conversation.sessionKey}</p>
                        <small className="muted-line">
                          {conversation.messageCount} message(s) · update{" "}
                          {formatDateTime(conversation.updatedAt)}
                        </small>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="Aucune conversation indexee"
                    body="Le workspace est pret, mais le moteur memoire n’a pas encore de conversation persistante pour cet agent."
                  />
                )}
              </section>
            </div>

            <div className="agent-memory-grid">
              <section className="selection-panel">
                <div className="info-row compact">
                  <strong>Resumes recents</strong>
                  <StatusPill status="active">{insight.summaries.length}</StatusPill>
                </div>
                {insight.summaries.length ? (
                  <div className="agent-memory-list">
                    {insight.summaries.map((summary) => (
                      <article
                        key={`${summary.summaryId}:${summary.conversationId}`}
                        className="agent-memory-item"
                      >
                        <div className="info-row compact">
                          <strong>{summary.sessionLabel || summary.sessionKey}</strong>
                          <StatusPill status="done">
                            {summary.kind} · depth {summary.depth}
                          </StatusPill>
                        </div>
                        <p>{summary.preview || "Resume vide."}</p>
                        <small className="muted-line">
                          {summary.model || "modele n/a"} · {summary.tokenCount || 0} token(s) ·{" "}
                          {formatDateTime(summary.createdAt)}
                        </small>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="Aucun resume"
                    body="Le moteur memoire n’a pas encore compacte de conversation pour cet agent."
                  />
                )}
              </section>

              <section className="selection-panel">
                <div className="info-row compact">
                  <strong>Recherche memoire</strong>
                  <StatusPill status={insight.searchTerm ? "active" : "paused"}>
                    {insight.searchTerm ? insight.matches.length : "idle"}
                  </StatusPill>
                </div>
                {insight.searchTerm ? (
                  insight.matches.length ? (
                    <div className="agent-memory-list">
                      {insight.matches.map((match) => (
                        <article key={`${match.type}:${match.id}`} className="agent-memory-item">
                          <div className="info-row compact">
                            <strong>{match.sessionLabel || match.sessionKey}</strong>
                            <StatusPill status={match.type === "summary" ? "done" : "active"}>
                              {match.type === "summary"
                                ? match.model || "summary"
                                : match.role || "message"}
                            </StatusPill>
                          </div>
                          <p>{match.preview || "Aucun extrait disponible."}</p>
                          <small className="muted-line">
                            {match.type} · {formatDateTime(match.createdAt)}
                          </small>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      title="Aucun resultat"
                      body="Essaie un mot-clé plus stable, par exemple un client, une decision, un tag de projet ou une contrainte."
                    />
                  )
                ) : (
                  <EmptyState
                    title="Recherche a la demande"
                    body="Lance une requete pour voir si une info est deja recapitulée dans les resumes ou encore presente dans les messages indexes."
                  />
                )}
              </section>
            </div>
          </>
        ) : null}
      </div>
    );
  }

  function renderAgents() {
    const effectiveProviderIds =
      agentEditor.providerIds.length > 0 ? agentEditor.providerIds : activeRuntimeProviderIds;
    const effectiveAgentModelRef =
      agentEditor.modelRef ||
      (agentEditorMode === "edit"
        ? getEffectiveAgentModelRef(agentEditor.agentId)
        : runtimeDefaults.agentPrimaryModelRef) ||
      "";
    const effectiveAgentModelLabel = getRuntimeModelDisplay(effectiveAgentModelRef);
    const inheritedRuntimeModelLabel = getRuntimeModelDisplay(
      runtimeDefaults.agentPrimaryModelRef || "",
    );
    const editedAgentExecution =
      agentEditorMode === "edit"
        ? mergeExecutionSettings(
            {
              thinkingLevel: agentEditor.thinkingLevel,
              fastMode: agentEditor.fastMode,
              verboseLevel: agentEditor.verboseLevel,
              reasoningLevel: agentEditor.reasoningLevel,
            },
            getAgentExecutionSettings(agentEditor.agentId),
          )
        : {
            thinkingLevel: agentEditor.thinkingLevel,
            fastMode: agentEditor.fastMode,
            verboseLevel: agentEditor.verboseLevel,
            reasoningLevel: agentEditor.reasoningLevel,
          };
    const selectedAgentSession =
      agentEditorMode === "edit" ? getPrimaryAgentSession(agentEditor.agentId) : undefined;
    const agentSkillOptions = getSkillOptionsForAgent(agentEditor.agentId);
    const sectionTabs: Array<{
      id: "profile" | "runtime" | "memory" | "routing" | "files";
      label: string;
      detail: string;
    }> = [
      { id: "profile", label: "Profil", detail: "identite, ownership, mission" },
      { id: "runtime", label: "Runtime", detail: "modele, execution, skills" },
      { id: "memory", label: "Memoire", detail: "context engine et recall" },
      { id: "routing", label: "Sorties", detail: "canaux, outputs, policies" },
      {
        id: "files",
        label: "Markdowns",
        detail: agentEditorMode === "edit" ? "workspace natif" : "bootstrap natif",
      },
    ];
    const activeSectionTab =
      sectionTabs.find((tab) => tab.id === agentStudioSection) || sectionTabs[0];
    const selectedAgentDisplayName =
      agentEditorMode === "create"
        ? agentEditor.name || "Nouveau profil agent"
        : agentEditor.name || agentEditor.agentId;
    const selectedAgentIdPreview =
      agentEditor.agentId || slugifyClient(agentEditor.name || "new-agent") || "new-agent";
    const selectedAgentStatus =
      agentEditorMode === "edit" ? selectedAgentRecord?.currentStatus || "active" : "workspace";
    const selectedAgentPurpose =
      agentEditor.purpose ||
      selectedAgentRecord?.purpose ||
      "Cadre, mission et garde-fous a formaliser dans AGENTS.md.";
    const selectedAgentDispatchTargetIds =
      agentEditor.dispatchPolicy === "broadcast"
        ? agentEditor.channelIds
        : agentEditor.dispatchPolicy === "default-channels"
          ? agentEditor.defaultOutputChannelIds
          : [];
    const selectedAgentDispatchTargetLabels = selectedAgentDispatchTargetIds.map((channelId) =>
      channelName(channelId),
    );
    const selectedAgentDefaultOutputLabels = agentEditor.defaultOutputChannelIds.map((channelId) =>
      channelName(channelId),
    );
    const selectedAgentAccessibleOutputLabels = agentEditor.channelIds.map((channelId) =>
      channelName(channelId),
    );
    const selectedAgentAccessTeamIds = Array.from(
      new Set(
        [...agentEditor.accessTeamIds, agentEditor.teamId].filter(
          (entry): entry is string => Boolean(entry),
        ),
      ),
    ).toSorted((left, right) => left.localeCompare(right));
    const selectedAgentAccessTeamLabels = selectedAgentAccessTeamIds.map(teamName);
    const selectedAgentOwnerTeamLabel = teamName(agentEditor.teamId || selectedAgentRecord?.teamId);
    const selectedAgentAccessUsers = users
      .filter((user) =>
        resolveUserTeamIdsLocal(user).some((teamId) => selectedAgentAccessTeamIds.includes(teamId)),
      )
      .toSorted((left, right) => left.name.localeCompare(right.name));
    const selectedAgentAccessUserLabels = selectedAgentAccessUsers.map((user) => user.name);
    const selectedAgentAccessIdentityLabels = Array.from(
      new Set(selectedAgentAccessUsers.flatMap((user) => user.externalIdentities)),
    ).toSorted((left, right) => left.localeCompare(right));
    const selectedAgentTeamInheritedOutputLabels = Array.from(
      new Set(
        selectedAgentAccessTeamIds.flatMap((teamId) =>
          Array.from(getTeamOwnedOutputChannelIds(teamId)).map(channelName),
        ),
      ),
    ).toSorted((left, right) => left.localeCompare(right));
    const selectedAgentInboundBotLabels = agentEditor.inboundTransportKeys
      .map((key) => {
        const channel = runtimeTransportChannels.find(
          (candidate) => makeRuntimeTransportKey(candidate) === key,
        );
        return channel
          ? buildChannelRouteSummary(channel, channelTemplateById.get(channel.kind))
          : key;
      })
      .filter(Boolean);
    const agentInboundBotCards = runtimeTransportChannels
      .map((channel) => {
        const template = channelTemplateById.get(channel.kind);
        const entry = channelEntries.find((candidate) => candidate.id === channel.kind);
        const runtimeAccount = findChannelRuntimeAccount(entry, channel.accountId);
        const accountId = normalizeChannelAccountId(channel.accountId);
        const accountLabel = entry
          ? channelAccountLabel(entry, accountId)
          : accountId;
        const routeKind = template
          ? resolveChannelRouteKind({ template }, channel.destinationType)
          : null;
        const linkedAgentId = channel.inboundAgentId || "";
        const selected = agentEditor.inboundTransportKeys.includes(makeRuntimeTransportKey(channel));
        const linkedToCurrentAgent = Boolean(linkedAgentId) && linkedAgentId === agentEditor.agentId;
        let draftStateLabel = "non lie";
        let draftStateTone = "paused";
        if (selected && linkedToCurrentAgent) {
          draftStateLabel = "deja lie";
          draftStateTone = "active";
        } else if (selected && linkedAgentId && linkedAgentId !== agentEditor.agentId) {
          draftStateLabel = `sera repris a ${agentName(linkedAgentId)}`;
          draftStateTone = "warning";
        } else if (selected) {
          draftStateLabel = "sera lie au save";
          draftStateTone = "active";
        } else if (linkedToCurrentAgent) {
          draftStateLabel = "sera retire au save";
          draftStateTone = "danger";
        } else if (linkedAgentId) {
          draftStateLabel = `lie a ${agentName(linkedAgentId)}`;
          draftStateTone = "muted";
        }
        return {
          key: makeRuntimeTransportKey(channel),
          channelId: channel.kind,
          accountId,
          label: `${template?.label || channel.kind} · ${accountLabel}`,
          targetLabel: channel.deliveryTarget || channel.target || "n/a",
          routeLabel: routeKind?.label || "Transport",
          runtimeStatusLabel: runtimeAccount?.statusLabel || formatChannelRuntimeState(entry),
          linkedAgentId,
          linkedAgentLabel: linkedAgentId ? agentName(linkedAgentId) : "aucun agent",
          selected,
          draftStateLabel,
          draftStateTone,
          lastInboundAt: runtimeAccount?.lastInboundAt || "",
          lastOutboundAt: runtimeAccount?.lastOutboundAt || "",
        };
      })
      .toSorted((left, right) => {
        if (left.selected !== right.selected) {
          return left.selected ? -1 : 1;
        }
        return left.label.localeCompare(right.label);
      });
    const selectedAgentInboundBotCards = agentInboundBotCards.filter((card) => card.selected);
    const availableAgentInboundBotCards = agentInboundBotCards.filter((card) => !card.selected);
    const agentAccessTeamOptions = teams.map((team) => ({
      id: team.id,
      label: team.name,
      description:
        team.id === agentEditor.teamId
          ? "Equipe proprietaire de l’agent"
          : `${team.memberIds.length} membre(s) rattache(s)`,
      meta: `${team.agentIds.length} agent(s) · ${getTeamOwnedOutputChannelIds(team.id).size} destination(s)`,
    }));
    const selectedAgentSessionLabel =
      selectedAgentSession?.displayName ||
      selectedAgentSession?.derivedTitle ||
      selectedAgentSession?.label ||
      selectedAgentSession?.key ||
      "Aucune session recente";
    const scopedRuntimeModelCount = getScopedRuntimeModels(effectiveProviderIds).length;

    return (
      <section className="stack">
        <section className="panel agent-studio-shell">
          <aside className="agent-studio-sidebar">
            <div className="agent-studio-sidebar-head">
              <div>
                <small className="eyebrow-label">Fleet</small>
                <h3>Agent Studio</h3>
              </div>
              <button type="button" className="ghost-button" onClick={resetAgentEditor}>
                Nouvel agent
              </button>
            </div>
            <p className="muted-line">
              Choisis un agent pour le personnaliser ou ouvre un nouveau draft propre.
            </p>
            <div className="agent-sidebar-list">
              {visibleAgents.map((agent) => {
                const selected = agentEditorMode === "edit" && agentEditor.agentId === agent.id;
                const binding = getAgentBinding(agent.id);
                const accessTeams = getAgentAccessTeamIds(agent.id, binding?.teamId || agent.teamId);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    className={`agent-sidebar-card ${selected ? "active" : ""}`}
                    onClick={() => startAgentEdit(agent)}
                  >
                    <div className="info-row compact">
                      <strong>{agent.identity?.name || agent.name || agent.id}</strong>
                      <StatusPill status={agent.currentStatus}>{agent.currentStatus}</StatusPill>
                    </div>
                    <p>{agent.purpose || "Aucun cadrage operateur defini."}</p>
                    <small className="muted-line">
                      {getRuntimeModelDisplay(
                        binding?.preferredModelRef || getEffectiveAgentModelRef(agent.id),
                      ) || "modele auto"}
                    </small>
                    <small className="muted-line">
                      equipes {accessTeams.map(teamName).join(", ") || "n/a"}
                    </small>
                    <small className="muted-line">
                      {agent.sessionCount} session(s) · {agent.workspace?.fileCount || 0} fichier(s)
                    </small>
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="agent-studio-main">
            <div className="agent-studio-hero">
              <div className="agent-studio-copy">
                <small className="eyebrow-label">Agent Studio</small>
                <h3>{selectedAgentDisplayName}</h3>
                <p>
                  {agentEditorMode === "create"
                    ? "Configure l’identite, le runtime, les sorties et la surface de travail depuis une seule interface."
                    : `Personnalise ${agentEditor.agentId} sans quitter la console operateur.`}
                </p>
              </div>
              <div className="agent-studio-summary">
                <article className="agent-summary-card">
                  <span>Mode</span>
                  <strong>{agentEditorMode}</strong>
                  <small>{agentEditorMode === "create" ? "draft" : agentEditor.agentId}</small>
                </article>
                <article className="agent-summary-card">
                  <span>Modele effectif</span>
                  <strong>{effectiveAgentModelLabel}</strong>
                  <small>catalogue runtime</small>
                </article>
                <article className="agent-summary-card">
                  <span>Workspace</span>
                  <strong>{selectedAgentWorkspace?.fileCount || 0} fichiers</strong>
                  <small>{selectedAgentWorkspace?.memoryFileCount || 0} memoire(s)</small>
                </article>
                <article className="agent-summary-card">
                  <span>Sessions</span>
                  <strong>{selectedAgentSessions.length}</strong>
                  <small>{selectedAgentSession?.activityStatus || "aucune live"}</small>
                </article>
              </div>
            </div>

            <div className="agent-cockpit-grid">
              <div className="agent-cockpit-workspace">
                <div className="agent-studio-tabs">
                  {sectionTabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      className={`agent-studio-tab ${agentStudioSection === tab.id ? "active" : ""}`}
                      onClick={() => setAgentStudioSection(tab.id)}
                    >
                      <strong>{tab.label}</strong>
                      <small>{tab.detail}</small>
                    </button>
                  ))}
                </div>

                {agentStudioSection === "profile" ? (
              <div className="agent-studio-section-grid">
                <section className="selection-panel">
                  <div className="info-row compact">
                    <strong>Identite & ownership</strong>
                    <StatusPill status={agentEditorMode === "create" ? "active" : "running"}>
                      {agentEditorMode}
                    </StatusPill>
                  </div>
                  <div className="agent-markdown-hint">
                    <strong>Bootstrap natif</strong>
                    <p>
                      Le nom, la mission, le modele et le workspace remplissent automatiquement les
                      premiers markdowns natifs OpenClaw au moment de la creation.
                    </p>
                    <small>Agent ID runtime vise: {selectedAgentIdPreview}</small>
                  </div>
                  <div className="form-grid">
                    <label>
                      Nom
                      <input
                        className="input"
                        value={agentEditor.name}
                        onChange={(event) => {
                          const nextName = event.target.value;
                          setAgentEditor((current) => ({
                            ...current,
                            name: nextName,
                            workspace:
                              agentEditorMode === "create" &&
                              (!current.workspace ||
                                current.workspace === `${workspaceRoot}/new-agent`)
                                ? `${workspaceRoot}/${slugifyClient(nextName || "new-agent") || "new-agent"}`
                                : current.workspace,
                          }));
                        }}
                        placeholder="Research Ops"
                      />
                    </label>

                    <label>
                      Workspace
                      <input
                        className="input"
                        value={agentEditor.workspace}
                        onChange={(event) =>
                          setAgentEditor((current) => ({
                            ...current,
                            workspace: event.target.value,
                          }))
                        }
                        placeholder={`${workspaceRoot || "~/.openclaw/workspaces/default"}/research-ops`}
                      />
                    </label>

                    <label className="field-span-2">
                      Purpose
                      <textarea
                        className="input textarea"
                        rows={4}
                        value={agentEditor.purpose}
                        onChange={(event) =>
                          setAgentEditor((current) => ({
                            ...current,
                            purpose: event.target.value,
                          }))
                        }
                        placeholder="Mission, ton, perimetre et garde-fous de l’agent."
                      />
                    </label>
                  </div>
                  <details className="agent-advanced-settings">
                    <summary>Options avancees</summary>
                    <div className="form-grid agent-advanced-grid">
                      <label>
                        Equipe proprietaire
                        <select
                          className="select"
                          value={agentEditor.teamId}
                          onChange={(event) =>
                            setAgentEditor((current) => {
                              const nextTeamId = event.target.value;
                              const nextTeamChannelIds = getTeamScopedOutputChannels(nextTeamId).map(
                                (channel) => channel.id,
                              );
                              return {
                                ...current,
                                teamId: nextTeamId,
                                accessTeamIds: Array.from(
                                  new Set(
                                    [...current.accessTeamIds, nextTeamId].filter(
                                      (entry): entry is string => Boolean(entry),
                                    ),
                                  ),
                                ).toSorted((left, right) => left.localeCompare(right)),
                                channelIds:
                                  current.channelIds.length > 0
                                    ? current.channelIds.filter((channelId) =>
                                        nextTeamChannelIds.includes(channelId),
                                      )
                                    : nextTeamChannelIds,
                                defaultOutputChannelIds: current.defaultOutputChannelIds.filter(
                                  (channelId) => nextTeamChannelIds.includes(channelId),
                                ),
                              };
                            })
                          }
                        >
                          <option value="">Auto</option>
                          {teams.map((team) => (
                            <option key={team.id} value={team.id}>
                              {team.name}
                            </option>
                          ))}
                        </select>
                      </label>

                      <article className="callout field-span-2">
                        <strong>Modele team-first</strong>
                        <p>
                          L'agent appartient a une equipe proprietaire, puis peut etre partage
                          avec d'autres equipes autorisees. Les users recuperent ensuite l'acces
                          uniquement via leurs equipes.
                        </p>
                      </article>

                      <label>
                        Emoji
                        <input
                          className="input"
                          value={agentEditor.emoji}
                          onChange={(event) =>
                            setAgentEditor((current) => ({
                              ...current,
                              emoji: event.target.value,
                            }))
                          }
                          placeholder="🤖"
                        />
                      </label>

                      <label>
                        Avatar
                        <input
                          className="input"
                          value={agentEditor.avatar}
                          onChange={(event) =>
                            setAgentEditor((current) => ({
                              ...current,
                              avatar: event.target.value,
                            }))
                          }
                          placeholder="avatars/research.png"
                        />
                      </label>

                      <label className="field-span-2">
                        Tags
                        <input
                          className="input"
                          value={agentEditor.tags}
                          onChange={(event) =>
                            setAgentEditor((current) => ({
                              ...current,
                              tags: event.target.value,
                            }))
                          }
                          placeholder="ops, sales, support"
                        />
                      </label>
                    </div>
                  </details>

                  <EntityMultiSelector
                    title="Equipes autorisees"
                    detail="L’equipe proprietaire reste toujours incluse. Ajouter ici les autres equipes qui peuvent parler a cet agent."
                    selectedIds={selectedAgentAccessTeamIds}
                    options={agentAccessTeamOptions}
                    lockedIds={agentEditor.teamId ? [agentEditor.teamId] : []}
                    searchPlaceholder="Rechercher une equipe autorisee..."
                    onChange={(nextIds) =>
                      setAgentEditor((current) => ({
                        ...current,
                        accessTeamIds: Array.from(
                          new Set(
                            [...nextIds, current.teamId].filter(
                              (entry): entry is string => Boolean(entry),
                            ),
                          ),
                        ).toSorted((left, right) => left.localeCompare(right)),
                      }))
                    }
                    emptyTitle="Aucune equipe"
                    emptyBody="Cree d’abord une equipe pour partager cet agent."
                  />

                  <section className="selection-panel agent-inbound-bot-panel">
                    <div className="info-row compact">
                      <strong>Bots lies</strong>
                      <StatusPill status="active">
                        {agentEditor.inboundTransportKeys.length} selectionne(s)
                      </StatusPill>
                    </div>
                    <p className="muted-line">
                      Les tokens, pairings et OAuth restent geres dans <code>Channels</code>. Ici,
                      tu choisis quels bots runtime doivent envoyer leurs messages entrants vers cet agent.
                    </p>
                    <div className="agent-inbound-bot-columns">
                      <div className="stack compact">
                        <div className="info-row compact">
                          <strong>Actuellement lies a cet agent</strong>
                          <small className="muted-line">{selectedAgentInboundBotCards.length}</small>
                        </div>
                        {selectedAgentInboundBotCards.length ? (
                          selectedAgentInboundBotCards.map((bot) => (
                            <article key={`selected-${bot.key}`} className="agent-inbound-bot-card selected">
                              <div className="info-row compact">
                                <strong>{bot.label}</strong>
                                <StatusPill status={bot.draftStateTone}>{bot.draftStateLabel}</StatusPill>
                              </div>
                              <div className="detail-pairs compact-grid">
                                <span>Transport</span>
                                <span>{bot.routeLabel}</span>
                                <span>Cible runtime</span>
                                <span>{bot.targetLabel}</span>
                                <span>Etat</span>
                                <span>{bot.runtimeStatusLabel}</span>
                                <span>Binding runtime</span>
                                <span>{bot.linkedAgentLabel}</span>
                                <span>Activite</span>
                                <span>
                                  inbound {formatDateTime(bot.lastInboundAt)} · outbound{" "}
                                  {formatDateTime(bot.lastOutboundAt)}
                                </span>
                              </div>
                              <div className="button-row">
                                <button
                                  type="button"
                                  className="ghost-button"
                                  onClick={() =>
                                    setAgentEditor((current) => ({
                                      ...current,
                                      inboundTransportKeys: current.inboundTransportKeys.filter(
                                        (entry) => entry !== bot.key,
                                      ),
                                    }))
                                  }
                                >
                                  Retirer
                                </button>
                                <button
                                  type="button"
                                  className="ghost-button"
                                  onClick={() => openChannelWorkspace(bot.channelId, bot.accountId)}
                                >
                                  Ouvrir le transport
                                </button>
                              </div>
                            </article>
                          ))
                        ) : (
                          <EmptyState
                            title="Aucun bot lie"
                            body="Lie ici les bots Telegram, Discord et autres qui doivent parler a cet agent."
                          />
                        )}
                      </div>
                      <div className="stack compact">
                        <div className="info-row compact">
                          <strong>Bots runtime disponibles</strong>
                          <small className="muted-line">{availableAgentInboundBotCards.length}</small>
                        </div>
                        {availableAgentInboundBotCards.length ? (
                          availableAgentInboundBotCards.map((bot) => (
                            <article key={`available-${bot.key}`} className="agent-inbound-bot-card">
                              <div className="info-row compact">
                                <strong>{bot.label}</strong>
                                <StatusPill status={bot.draftStateTone}>{bot.draftStateLabel}</StatusPill>
                              </div>
                              <div className="detail-pairs compact-grid">
                                <span>Transport</span>
                                <span>{bot.routeLabel}</span>
                                <span>Cible runtime</span>
                                <span>{bot.targetLabel}</span>
                                <span>Etat</span>
                                <span>{bot.runtimeStatusLabel}</span>
                                <span>Agent actuel</span>
                                <span>{bot.linkedAgentLabel}</span>
                              </div>
                              <div className="button-row">
                                <button
                                  type="button"
                                  className="ghost-button"
                                  onClick={() =>
                                    setAgentEditor((current) => ({
                                      ...current,
                                      inboundTransportKeys: Array.from(
                                        new Set([...current.inboundTransportKeys, bot.key]),
                                      ).toSorted((left, right) => left.localeCompare(right)),
                                    }))
                                  }
                                >
                                  {bot.linkedAgentId ? "Reprendre ce bot" : "Lier ce bot"}
                                </button>
                                {bot.linkedAgentId ? (
                                  <button
                                    type="button"
                                    className="ghost-button"
                                    onClick={() => openAgentStudioForAgentId(bot.linkedAgentId, { section: "profile" })}
                                  >
                                    Ouvrir {bot.linkedAgentLabel}
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  className="ghost-button"
                                  onClick={() => openChannelWorkspace(bot.channelId, bot.accountId)}
                                >
                                  Config technique
                                </button>
                              </div>
                            </article>
                          ))
                        ) : (
                          <EmptyState
                            title="Aucun bot disponible"
                            body="Connecte d'abord un bot dans Channels, puis reviens ici pour le lier a l'agent."
                          />
                        )}
                      </div>
                    </div>
                  </section>

                  <div className="summary-card-grid governance-summary-grid">
                    <article className="agent-summary-card">
                      <span>Equipe proprietaire</span>
                      <strong>{selectedAgentOwnerTeamLabel}</strong>
                      <small>socle RBAC de l’agent</small>
                    </article>
                    <article className="agent-summary-card">
                      <span>Equipes joignables</span>
                      <strong>{selectedAgentAccessTeamIds.length}</strong>
                      <small>{summarizeLabels(selectedAgentAccessTeamLabels, 2)}</small>
                    </article>
                    <article className="agent-summary-card">
                      <span>Users potentiels</span>
                      <strong>{selectedAgentAccessUsers.length}</strong>
                      <small>{summarizeLabels(selectedAgentAccessUserLabels, 2, "aucun user")}</small>
                    </article>
                    <article className="agent-summary-card">
                      <span>Bots inbound</span>
                      <strong>{agentEditor.inboundTransportKeys.length}</strong>
                      <small>{summarizeLabels(selectedAgentInboundBotLabels, 1, "aucun bot")}</small>
                    </article>
                    <article className="agent-summary-card">
                      <span>Identites mappees</span>
                      <strong>{selectedAgentAccessIdentityLabels.length}</strong>
                      <small>
                        {summarizeLabels(selectedAgentAccessIdentityLabels, 1, "aucune identite")}
                      </small>
                    </article>
                    <article className="agent-summary-card">
                      <span>Outputs visibles</span>
                      <strong>{agentEditor.channelIds.length}</strong>
                      <small>
                        {summarizeLabels(selectedAgentAccessibleOutputLabels, 2, "aucune destination")}
                      </small>
                    </article>
                    <article className="agent-summary-card">
                      <span>Destinations equipe</span>
                      <strong>{selectedAgentTeamInheritedOutputLabels.length}</strong>
                      <small>
                        {summarizeLabels(
                          selectedAgentTeamInheritedOutputLabels,
                          2,
                          "aucune destination equipe",
                        )}
                      </small>
                    </article>
                  </div>
                </section>

                <section className="selection-panel">
                  {agentEditorMode === "create" ? (
                    <>
                      <div className="info-row compact">
                        <strong>Fondations creees au premier save</strong>
                        <StatusPill status="workspace">bootstrap</StatusPill>
                      </div>
                      <div className="detail-pairs compact-grid">
                        <span>Agent ID</span>
                        <code className="mono">{selectedAgentIdPreview}</code>
                        <span>Workspace</span>
                        <code className="mono">{agentEditor.workspace || "n/a"}</code>
                        <span>Equipes autorisees</span>
                        <span>{selectedAgentAccessTeamLabels.join(", ") || "n/a"}</span>
                        <span>Users potentiels</span>
                        <span>{summarizeLabels(selectedAgentAccessUserLabels, 3, "aucun")}</span>
                        <span>Identites mappees</span>
                        <span>{summarizeLabels(selectedAgentAccessIdentityLabels, 2, "aucune")}</span>
                        <span>Bots inbound</span>
                        <span>{selectedAgentInboundBotLabels.join(", ") || "n/a"}</span>
                        <span>Destinations equipe</span>
                        <span>
                          {summarizeLabels(
                            selectedAgentTeamInheritedOutputLabels,
                            2,
                            "aucune destination equipe",
                          )}
                        </span>
                        <span>Modele par defaut</span>
                        <span>{effectiveAgentModelLabel}</span>
                        <span>Catalogue modeles</span>
                        <span>{runtimeModels.length}</span>
                        <span>Memoire runtime</span>
                        <span>
                          {memoryEngineStatus?.activeEngineId ||
                            (memoryEngineLoading ? "chargement" : "runtime")}
                        </span>
                        <span>Seed markdown</span>
                        <span>{AGENT_BOOTSTRAP_SEED_FILES.length} fichier(s)</span>
                        <span>Apres creation</span>
                        <span>ouverture directe de l’atelier markdown</span>
                      </div>
                      <div className="agent-blueprint-grid">
                        {[...AGENT_STUDIO_PINNED_FILES, "memory/*.md"].map((fileName) => {
                          const guide = resolveAgentMarkdownGuide(fileName);
                          return (
                            <article key={fileName} className="agent-blueprint-card">
                              <div className="info-row compact">
                                <strong>{fileName}</strong>
                                <span className="inline-tag">{guide.label}</span>
                              </div>
                              <p>{guide.description}</p>
                              <small>{guide.emphasis}</small>
                            </article>
                          );
                        })}
                      </div>
                      <div className="agent-studio-note">
                        <strong>Flux conseille</strong>
                        <p>
                          Cree l’agent, choisis son modele, puis renseigne surtout `AGENTS.md`,
                          `MEMORY.md` et `memory/*.md`. Ce sont ces surfaces qui nourrissent le
                          recall durable.
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="info-row compact">
                        <strong>Vue d’ensemble</strong>
                        <StatusPill status={selectedAgentRecord?.currentStatus || "active"}>
                          {selectedAgentRecord?.currentStatus || "draft"}
                        </StatusPill>
                      </div>
                      <div className="detail-pairs compact-grid">
                        <span>Agent ID</span>
                        <code className="mono">{agentEditor.agentId || "nouvel-agent"}</code>
                        <span>Team</span>
                        <span>{teamName(agentEditor.teamId || selectedAgentRecord?.teamId)}</span>
                        <span>Equipes autorisees</span>
                        <span>{selectedAgentAccessTeamLabels.join(", ") || "n/a"}</span>
                        <span>Users potentiels</span>
                        <span>{summarizeLabels(selectedAgentAccessUserLabels, 3, "aucun")}</span>
                        <span>Identites mappees</span>
                        <span>{summarizeLabels(selectedAgentAccessIdentityLabels, 2, "aucune")}</span>
                        <span>Bots inbound</span>
                        <span>{selectedAgentInboundBotLabels.join(", ") || "n/a"}</span>
                        <span>Destinations equipe</span>
                        <span>
                          {summarizeLabels(
                            selectedAgentTeamInheritedOutputLabels,
                            2,
                            "aucune destination equipe",
                          )}
                        </span>
                        <span>Workspace</span>
                        <code className="mono">{agentEditor.workspace || "n/a"}</code>
                        <span>Modele</span>
                        <span>{effectiveAgentModelLabel}</span>
                        <span>Memoire</span>
                        <span>{memoryEngineStatus?.activeEngineId || "runtime"}</span>
                        <span>Sessions</span>
                        <span>{selectedAgentSessions.length}</span>
                        <span>Markdowns</span>
                        <span>{selectedAgentWorkspace?.fileCount || 0}</span>
                        <span>Skills</span>
                        <span>
                          {agentEditor.skillPolicy === "all"
                            ? "toutes les skills eligibles"
                            : agentEditor.skillPolicy === "none"
                              ? "aucune skill"
                              : agentEditor.skillIds.length
                                ? agentEditor.skillIds.join(", ")
                                : "aucune skill"}
                        </span>
                      </div>
                      <div className="agent-studio-note">
                        <strong>Cap a suivre</strong>
                        <p>
                          Garde ce panneau simple: identite, mission, ownership. Le comportement
                          reel de l’agent se regle ensuite dans le runtime et surtout dans ses
                          fichiers markdown natifs.
                        </p>
                      </div>
                    </>
                  )}
                  {selectedAgentInboundBotCards.length ? (
                    <div className="agent-governance-preview-grid">
                      {selectedAgentInboundBotCards.map((bot) => (
                        <article key={bot.key} className="agent-blueprint-card">
                          <div className="info-row compact">
                            <strong>{bot.label}</strong>
                            <span className="inline-tag">inbound</span>
                          </div>
                          <p>{bot.routeLabel} vers {bot.targetLabel}</p>
                          <small>{bot.runtimeStatusLabel} · {bot.draftStateLabel}</small>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </section>
              </div>
            ) : null}

            {agentStudioSection === "runtime" ? (
              <div className="stack">
                <div className="selection-panel">
                  <div className="info-row compact">
                    <strong>Runtime agent</strong>
                    <StatusPill status="active">{effectiveAgentModelLabel}</StatusPill>
                  </div>
                  <small className="muted-line">
                    Ici tu choisis seulement le modele, le profil d’execution et les skills. Le
                    pont provider reste gere par le runtime Elytras/OpenClaw.
                  </small>
                  <div className="detail-pairs compact-grid">
                    <span>Source runtime</span>
                    <span>hub providers</span>
                    <span>Modele herite</span>
                    <span>{inheritedRuntimeModelLabel}</span>
                    <span>Catalogue actif</span>
                    <span>{runtimeModels.length} modele(s)</span>
                    <span>Memoire</span>
                    <span>{memoryEngineStatus?.activeEngineId || "runtime"}</span>
                  </div>
                </div>

                <RuntimeModelPicker
                  label="Modele par defaut de l’agent"
                  selectedModelRef={agentEditor.modelRef}
                  effectiveModelRef={agentEditor.modelRef || runtimeDefaults.agentPrimaryModelRef}
                  inheritLabel="Heriter du defaut runtime"
                  inheritDescription={
                    runtimeDefaults.agentPrimaryModelRef
                      ? `Defaut runtime courant: ${inheritedRuntimeModelLabel}`
                      : "Aucun defaut runtime explicite."
                  }
                  models={runtimeModels}
                  allowedProviders={effectiveProviderIds}
                  onChange={(modelRef) =>
                    setAgentEditor((current) => ({
                      ...current,
                      modelRef,
                    }))
                  }
                />

                <ExecutionSettingsPicker
                  title="Profil d’execution"
                  description="Ces reglages deviennent le profil operateur stocke pour l’agent."
                  providerHint="cliproxyapi"
                  profile={{
                    thinkingLevel: agentEditor.thinkingLevel,
                    fastMode: agentEditor.fastMode,
                    verboseLevel: agentEditor.verboseLevel,
                    reasoningLevel: agentEditor.reasoningLevel,
                  }}
                  effectiveProfile={editedAgentExecution}
                  effectiveLabel="Profil apres sauvegarde"
                  onChange={(patch) =>
                    setAgentEditor((current) => ({
                      ...current,
                      thinkingLevel: patch.thinkingLevel === null ? undefined : patch.thinkingLevel,
                      fastMode: patch.fastMode === null ? undefined : patch.fastMode,
                      verboseLevel: patch.verboseLevel === null ? undefined : patch.verboseLevel,
                      reasoningLevel:
                        patch.reasoningLevel === null ? undefined : patch.reasoningLevel,
                    }))
                  }
                />

                <div className="selection-panel">
                  <div className="info-row compact">
                    <strong>Skills agent</strong>
                    <StatusPill status="active">{agentEditor.skillPolicy}</StatusPill>
                  </div>
                  <small className="muted-line">
                    Un seul catalogue de skills pour l’agent. Tu choisis soit toutes les skills
                    eligibles, soit un set manuel.
                  </small>
                  <div className="form-grid">
                    <label>
                      Policy
                      <select
                        className="select"
                        value={agentEditor.skillPolicy}
                        onChange={(event) =>
                          setAgentEditor((current) => ({
                            ...current,
                            skillPolicy: event.target.value as AgentEditor["skillPolicy"],
                            skillIds:
                              event.target.value === "selected" ? current.skillIds : [],
                          }))
                        }
                      >
                        <option value="all">Toutes les skills eligibles</option>
                        <option value="selected">Selection manuelle</option>
                        <option value="none">Aucune skill</option>
                      </select>
                    </label>
                  </div>
                  {agentEditor.skillPolicy === "selected" ? (
                    agentSkillOptions.length ? (
                      <div className="selection-grid">
                        {agentSkillOptions.map((skill) => {
                          const selected = agentEditor.skillIds.includes(skill.name);
                          return (
                            <button
                              key={skill.name}
                              type="button"
                              className={`runtime-model-card ${selected ? "selected" : ""}`}
                              onClick={() =>
                                setAgentEditor((current) => ({
                                  ...current,
                                  skillIds: selected
                                    ? current.skillIds.filter((entry) => entry !== skill.name)
                                    : [...current.skillIds, skill.name].toSorted((left, right) =>
                                        left.localeCompare(right),
                                      ),
                                }))
                              }
                            >
                              <div className="info-row compact">
                                <strong>{skill.name}</strong>
                                <StatusPill status={selected ? "active" : "paused"}>
                                  {selected ? "active" : "off"}
                                </StatusPill>
                              </div>
                              <small className="muted-line">
                                {skill.description || skill.filePath || "Skill sans description"}
                              </small>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <EmptyState
                        title="Catalogue vide"
                        body="Aucune skill partagee ou liee a cet agent n’est disponible pour l’instant."
                      />
                    )
                  ) : null}
                </div>
              </div>
            ) : null}

            {agentStudioSection === "memory" ? renderAgentMemoryWorkbench() : null}

            {agentStudioSection === "routing" ? (
              <div className="stack">
                <section className="selection-panel">
                  <div className="info-row compact">
                    <strong>Policies operateur</strong>
                    <StatusPill status="active">
                      {agentEditor.resumePolicy} · {agentEditor.dispatchPolicy}
                    </StatusPill>
                  </div>
                  <div className="form-grid">
                    <label>
                      Resume policy
                      <select
                        className="select"
                        value={agentEditor.resumePolicy}
                        onChange={(event) =>
                          setAgentEditor((current) => ({
                            ...current,
                            resumePolicy: event.target.value as AgentEditor["resumePolicy"],
                          }))
                        }
                      >
                        {RESUME_POLICIES.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      Dispatch policy
                      <select
                        className="select"
                        value={agentEditor.dispatchPolicy}
                        onChange={(event) =>
                          setAgentEditor((current) => ({
                            ...current,
                            dispatchPolicy: event.target.value as AgentEditor["dispatchPolicy"],
                          }))
                        }
                      >
                        {DISPATCH_POLICIES.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </section>

                <div className="selection-panel">
                  <div className="info-row compact">
                    <strong>Channels accessibles</strong>
                    <StatusPill status="active">{agentEditor.channelIds.length} actif(s)</StatusPill>
                  </div>
                  <small className="muted-line">
                    Scope operateur pour les sorties, reprises et affectations canal.
                  </small>
                  <small className="muted-line">
                    Les destinations visibles ici viennent uniquement de l’equipe{" "}
                    <strong>{teamName(agentEditor.teamId) || "non definie"}</strong>.
                  </small>
                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() =>
                        setAgentEditor((current) => ({
                          ...current,
                          channelIds: agentEditorScopedOutputChannelIds,
                        }))
                      }
                    >
                      Toutes les destinations
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() =>
                        setAgentEditor((current) => ({
                          ...current,
                          channelIds: [],
                        }))
                      }
                    >
                      Aucun
                    </button>
                  </div>
                  {agentEditorScopedOutputChannels.length ? (
                    <ChannelRouteMultiSelector
                      channels={agentEditorScopedOutputChannels}
                      channelTemplateById={channelTemplateById}
                      selectedIds={agentEditor.channelIds}
                      emptySelectionLabel="Aucune destination accessible"
                      onChange={(nextIds) =>
                        setAgentEditor((current) => ({
                          ...current,
                          channelIds: nextIds,
                          defaultOutputChannelIds: current.defaultOutputChannelIds.filter((entry) =>
                            nextIds.includes(entry),
                          ),
                        }))
                      }
                    />
                  ) : (
                    <EmptyState
                      title="Aucune destination"
                      body="Cree d’abord des destinations dans l’onglet Channels."
                    />
                  )}
                </div>

                <div className="selection-panel">
                  <div className="info-row compact">
                    <strong>Sorties par defaut</strong>
                    <StatusPill status="active">
                      {agentEditor.defaultOutputChannelIds.length} cible(s)
                    </StatusPill>
                  </div>
                  <small className="muted-line">
                    Ces destinations servent de cible par defaut quand la policy de dispatch n’est pas
                    `manual`.
                  </small>
                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() =>
                        setAgentEditor((current) => ({
                          ...current,
                          defaultOutputChannelIds: current.channelIds,
                        }))
                      }
                    >
                      Reprendre les destinations accessibles
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() =>
                        setAgentEditor((current) => ({
                          ...current,
                          defaultOutputChannelIds: [],
                        }))
                      }
                    >
                      Aucune sortie par defaut
                    </button>
                  </div>
                  {agentEditor.channelIds.length ? (
                    <ChannelRouteMultiSelector
                      channels={agentEditorScopedOutputChannels.filter((channel) =>
                        agentEditor.channelIds.includes(channel.id),
                      )}
                      channelTemplateById={channelTemplateById}
                      selectedIds={agentEditor.defaultOutputChannelIds}
                      emptySelectionLabel="Aucune sortie par defaut"
                      onChange={(nextIds) =>
                        setAgentEditor((current) => ({
                          ...current,
                          defaultOutputChannelIds: nextIds,
                        }))
                      }
                    />
                  ) : (
                    <EmptyState
                      title="Aucune destination accessible"
                      body="Ajoute d’abord des destinations dans Channels si tu veux configurer des sorties par defaut."
                    />
                  )}
                </div>
              </div>
            ) : null}

            {agentStudioSection === "files" ? (
              agentEditorMode === "edit" ? (
                <div className="stack">
                  <section className="selection-panel">
                    <div className="info-row compact">
                      <strong>Workspace markdown natif</strong>
                      <StatusPill status="workspace">
                        {selectedAgentWorkspace?.fileCount || 0} fichier(s)
                      </StatusPill>
                    </div>
                    <div className="detail-pairs compact-grid">
                      <span>Agent</span>
                      <span>{agentEditor.agentId}</span>
                      <span>Path</span>
                      <code className="mono">{agentEditor.workspace || "n/a"}</code>
                      <span>Memoire</span>
                      <span>{selectedAgentMemoryFileCount}</span>
                      <span>Surfaces clefs</span>
                      <span>
                        {selectedAgentPinnedReadyCount}/{AGENT_STUDIO_PINNED_FILES.length}
                      </span>
                      <span>Bootstrap</span>
                      <span>{selectedAgentWorkspace?.state.bootstrapSeededAt || "n/a"}</span>
                      <span>Setup</span>
                      <span>{selectedAgentWorkspace?.state.setupCompletedAt || "non termine"}</span>
                    </div>
                    <div className="agent-markdown-hint">
                      <strong>Studio natif OpenClaw</strong>
                      <p>
                        `AGENTS.md` fixe le cadre, `MEMORY.md` et `memory/*.md` nourrissent le
                        recall memoire, et les autres markdowns pilotent le ton, les outils et
                        les routines.
                      </p>
                    </div>
                    <div className="button-row">
                      {AGENT_STUDIO_PINNED_FILES.map((fileName) => (
                        <button
                          key={fileName}
                          type="button"
                          className="ghost-button"
                          onClick={() => focusAgentMarkdownFile(fileName)}
                        >
                          {fileName}
                        </button>
                      ))}
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => {
                          if (selectedAgentFileKey) {
                            setSelectedFileKey(selectedAgentFileKey);
                          }
                          setView("files");
                        }}
                      >
                        Ouvrir dans Files
                      </button>
                    </div>
                  </section>

                  <div className="agent-files-grid">
                    <section className="selection-panel">
                      <div className="form-grid slim">
                        <label>
                          Type
                          <select
                            className="select"
                            value={agentStudioFileFilter}
                            onChange={(event) =>
                              setAgentStudioFileFilter(
                                event.target.value as "all" | "memory" | "workspace",
                              )
                            }
                          >
                            <option value="all">Tous</option>
                            <option value="memory">Memoire</option>
                            <option value="workspace">Workspace</option>
                          </select>
                        </label>
                        <label className="field-span-2">
                          Recherche
                          <input
                            className="input"
                            value={agentStudioFileSearch}
                            onChange={(event) => setAgentStudioFileSearch(event.target.value)}
                            placeholder="AGENTS.md, MEMORY.md, memory/notes.md..."
                          />
                        </label>
                      </div>
                      <div className="agent-markdown-hint">
                        <strong>Surfaces prioritaires</strong>
                        <p>
                          Traite ces fichiers comme le vrai bootstrap de l’agent. Ouvre, precharge
                          ou cree chaque surface sans quitter le studio.
                        </p>
                      </div>
                      <div className="agent-bootstrap-lane">
                        <article className="agent-bootstrap-step">
                          <span className="inline-tag">1</span>
                          <strong>Cadre l’agent</strong>
                          <p>`AGENTS.md` puis `SOUL.md` pour mission, ton et garde-fous.</p>
                        </article>
                        <article className="agent-bootstrap-step">
                          <span className="inline-tag">2</span>
                          <strong>Fixe la memoire</strong>
                          <p>`MEMORY.md` pour les faits durables, puis `memory/*.md` pour les journaux.</p>
                        </article>
                        <article className="agent-bootstrap-step">
                          <span className="inline-tag">3</span>
                          <strong>Calibre l’execution</strong>
                          <p>`TOOLS.md` et `HEARTBEAT.md` pour la discipline et les routines.</p>
                        </article>
                      </div>
                      <div className="agent-surface-grid">
                        {selectedAgentPinnedSurfaces.map((surface) => (
                          <article
                            key={surface.fileName}
                            className={`agent-surface-card ${selectedAgentFileKey === surface.key ? "active" : ""}`}
                          >
                            <div className="info-row compact">
                              <strong>{surface.fileName}</strong>
                              <StatusPill status={surface.state.status}>
                                {surface.state.label}
                              </StatusPill>
                            </div>
                            <p>{surface.guide.description}</p>
                            <small>
                              {surface.file
                                ? `${surface.file.type} · ${formatDateTime(surface.file.updatedAtMs)}`
                                : surface.guide.starterLabel || surface.guide.emphasis}
                            </small>
                            <div className="button-row agent-surface-actions">
                              <button
                                type="button"
                                className="ghost-button"
                                onClick={() => focusOrStageAgentMarkdownFile(surface.fileName)}
                              >
                                {surface.file ? "Ouvrir" : "Preparer"}
                              </button>
                              <button
                                type="button"
                                className="ghost-button"
                                disabled={agentFileSaveBusy === `${agentEditor.agentId}:${surface.fileName}`}
                                onClick={() =>
                                  surface.file
                                    ? injectStarterIntoAgentMarkdown(surface.fileName)
                                    : void createAgentMarkdownFromTemplate(surface.fileName)
                                }
                              >
                                {surface.file
                                  ? "Injecter starter"
                                  : agentFileSaveBusy === `${agentEditor.agentId}:${surface.fileName}`
                                    ? "Creation..."
                                    : "Creer tout de suite"}
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                      <div className="agent-secondary-list">
                        <div className="info-row compact">
                          <strong>Autres fichiers natifs</strong>
                          <small>{AGENT_STUDIO_SECONDARY_FILES.length} surface(s)</small>
                        </div>
                        <div className="agent-secondary-chips">
                          {selectedAgentSecondarySurfaces.map((surface) => (
                            <button
                              key={surface.fileName}
                              type="button"
                              className={`agent-secondary-chip ${selectedAgentFileKey === surface.key ? "active" : ""}`}
                              onClick={() => focusOrStageAgentMarkdownFile(surface.fileName)}
                            >
                              <span>{surface.fileName}</span>
                              <StatusPill status={surface.state.status}>
                                {surface.state.label}
                              </StatusPill>
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="agent-template-grid">
                        {AGENT_QUICK_TEMPLATES.map((template) => (
                          <button
                            key={template.name}
                            type="button"
                            className="agent-template-card"
                            onClick={() => stageAgentMarkdownTemplate(template.name)}
                          >
                            <div className="info-row compact">
                              <strong>{template.label}</strong>
                              <span className="inline-tag">{template.name}</span>
                            </div>
                            <p>{template.description}</p>
                          </button>
                        ))}
                      </div>
                      {selectedAgentSupplementalFiles.length ? (
                        <div className="list-grid scroll-column">
                          {selectedAgentSupplementalFiles.map((file) => (
                            <button
                              key={`${file.agentId}:${file.name}`}
                              type="button"
                              className={`session-card ${selectedAgentFileKey === `${file.agentId}:${file.name}` ? "active" : ""}`}
                              onClick={() => setSelectedAgentFileKey(`${file.agentId}:${file.name}`)}
                            >
                              <div className="info-row compact">
                                <strong>{file.name}</strong>
                                <StatusPill status={file.type}>{file.type}</StatusPill>
                              </div>
                              <p>{file.path}</p>
                              <small className="muted-line">
                                {formatBytes(file.size)} · {formatDateTime(file.updatedAtMs)}
                              </small>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <EmptyState
                          title="Pas d’autres markdowns"
                          body="Les surfaces natives sont listees plus haut. La recherche actuelle ne montre aucun fichier supplementaire."
                        />
                      )}
                    </section>

                    <section className="selection-panel">
                      <div className="info-row compact">
                        <strong>Atelier markdown natif</strong>
                        <StatusPill status={selectedAgentFile?.type || "workspace"}>
                          {selectedAgentFile?.name || "aucun"}
                        </StatusPill>
                      </div>
                      {selectedAgentFile ? (
                        <>
                          <div className="detail-pairs compact-grid">
                            <span>Path</span>
                            <code className="mono">{selectedAgentFile.path}</code>
                            <span>Updated</span>
                            <span>{formatDateTime(selectedAgentFile.updatedAtMs)}</span>
                            <span>Size</span>
                            <span>{formatBytes(selectedAgentFile.size)}</span>
                          </div>
                          <div className="agent-markdown-guide-grid">
                            <div className="agent-markdown-hint">
                              <strong>{selectedAgentFileGuide?.label || "Markdown"}</strong>
                              <p>{selectedAgentFileGuide?.description}</p>
                              <small>{selectedAgentFileGuide?.emphasis}</small>
                            </div>
                            <div className="agent-markdown-hint">
                              <strong>Sections conseillees</strong>
                              <ul className="agent-guide-list">
                                {(selectedAgentFileGuide?.sections || ["Contexte", "Contenu utile"]).map(
                                  (section) => (
                                    <li key={section}>{section}</li>
                                  ),
                                )}
                              </ul>
                            </div>
                            <div className="agent-markdown-hint">
                              <strong>Checklist rapide</strong>
                              <ul className="agent-guide-list">
                                {(
                                  selectedAgentFileGuide?.checklist || [
                                    "Garder uniquement ce qui restera utile",
                                    "Nommer clairement le fichier et ses sections",
                                  ]
                                ).map((item) => (
                                  <li key={item}>{item}</li>
                                ))}
                              </ul>
                            </div>
                          </div>
                          <div className="agent-markdown-starter">
                            <div className="info-row compact">
                              <strong>Starter recommande</strong>
                              <button
                                type="button"
                                className="ghost-button"
                                onClick={applyStarterToSelectedAgentFile}
                              >
                                Injecter dans l’editeur
                              </button>
                            </div>
                            <p className="muted-line">
                              {selectedAgentFileGuide?.starterLabel || "Base de depart"} pour{" "}
                              {selectedAgentFile.name}. Tu peux l’injecter, l’ajuster puis
                              sauvegarder.
                            </p>
                            <pre className="agent-markdown-starter-preview">
                              <code>{selectedAgentFileStarter}</code>
                            </pre>
                          </div>
                          {selectedAgentFileLoaded ? (
                            <>
                              <textarea
                                className="input textarea agent-markdown-editor"
                                rows={20}
                                value={selectedAgentFileContent}
                                onChange={(event) =>
                                  setFileContent((current) => ({
                                    ...current,
                                    [selectedAgentFileKey]: event.target.value,
                                  }))
                                }
                              />
                              <div className="button-row">
                                <button
                                  type="button"
                                  className="ghost-button"
                                  disabled={!selectedAgentFileDirty || agentFileSaveBusy === selectedAgentFileKey}
                                  onClick={() => void handleSaveAgentFile()}
                                >
                                  {agentFileSaveBusy === selectedAgentFileKey
                                    ? "Sauvegarde..."
                                    : selectedAgentFileDirty
                                      ? "Sauvegarder le markdown"
                                      : "A jour"}
                                </button>
                                <button
                                  type="button"
                                  className="ghost-button"
                                  disabled={!selectedAgentFileDirty || agentFileSaveBusy === selectedAgentFileKey}
                                  onClick={() =>
                                    setFileContent((current) => ({
                                      ...current,
                                      [selectedAgentFileKey]:
                                        fileBaselineContent[selectedAgentFileKey] || "",
                                    }))
                                  }
                                >
                                  Annuler les modifications
                                </button>
                              </div>
                            </>
                          ) : (
                            <EmptyState
                              title="Chargement..."
                              body="Le contenu du fichier est en cours de lecture depuis le workspace agent."
                            />
                          )}
                        </>
                      ) : (
                        <EmptyState
                          title="Aucun fichier"
                          body="Selectionne un markdown du workspace agent pour l’editer."
                        />
                      )}
                      <div className="agent-markdown-composer">
                        <div className="info-row compact">
                          <strong>Nouveau fichier markdown</strong>
                          <StatusPill status="workspace">.md</StatusPill>
                        </div>
                        <p className="muted-line">
                          Utilise ce brouillon pour creer un nouveau journal `memory/*.md` ou
                          preparer une surface native absente.
                        </p>
                        <div className="form-grid">
                          <label>
                            Path
                            <input
                              className="input"
                              value={agentMarkdownDraftName}
                              onChange={(event) => setAgentMarkdownDraftName(event.target.value)}
                              placeholder="memory/decision-log.md"
                            />
                          </label>
                          <label className="field-span-2">
                            Contenu initial
                            <textarea
                              className="input textarea"
                              rows={6}
                              value={agentMarkdownDraftContent}
                              onChange={(event) => setAgentMarkdownDraftContent(event.target.value)}
                              placeholder="# Decision log"
                            />
                          </label>
                        </div>
                        <div className="button-row">
                          <button
                            type="button"
                            className="ghost-button"
                            disabled={!agentMarkdownDraftName.trim()}
                            onClick={() =>
                              setAgentMarkdownDraftContent(
                                buildAgentMarkdownTemplateForEditor(agentMarkdownDraftName.trim()),
                              )
                            }
                          >
                            Charger un starter
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            disabled={!agentMarkdownDraftName.trim() || Boolean(agentFileSaveBusy)}
                            onClick={() =>
                              void handleSaveAgentFile(
                                agentMarkdownDraftName.trim(),
                                agentMarkdownDraftContent,
                              )
                            }
                          >
                            {agentFileSaveBusy === `${agentEditor.agentId}:${agentMarkdownDraftName.trim()}`
                              ? "Creation..."
                              : "Creer / mettre a jour"}
                          </button>
                        </div>
                      </div>
                    </section>
                  </div>
                </div>
              ) : (
                <div className="stack">
                  <section className="selection-panel">
                    <div className="info-row compact">
                      <strong>Creation puis ouverture du workspace</strong>
                      <StatusPill status="workspace">markdown</StatusPill>
                    </div>
                    <p className="muted-line">
                      Le gateway OpenClaw cree le workspace nativement, Elytras initialise
                      automatiquement les fichiers bootstrap depuis ce formulaire, puis ouvre
                      directement cet atelier pour modifier les vrais `.md` de l’agent.
                    </p>
                    <div className="agent-blueprint-grid">
                      {[...AGENT_STUDIO_PINNED_FILES, "memory/*.md"].map((fileName) => {
                        const guide = resolveAgentMarkdownGuide(fileName);
                        return (
                          <article key={fileName} className="agent-blueprint-card">
                            <div className="info-row compact">
                              <strong>{fileName}</strong>
                              <span className="inline-tag">{guide.label}</span>
                            </div>
                            <p>{guide.description}</p>
                            <small>{guide.emphasis}</small>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                  <section className="selection-panel">
                    <div className="info-row compact">
                      <strong>Templates conseilles</strong>
                      <StatusPill status="workspace">memoire runtime</StatusPill>
                    </div>
                    <div className="agent-template-grid">
                      {AGENT_QUICK_TEMPLATES.map((template) => (
                        <article key={template.name} className="agent-template-card static">
                          <div className="info-row compact">
                            <strong>{template.label}</strong>
                            <span className="inline-tag">{template.name}</span>
                          </div>
                          <p>{template.description}</p>
                          <small>{buildAgentMarkdownTemplateForEditor(template.name).trim()}</small>
                        </article>
                      ))}
                    </div>
                    <div className="agent-markdown-hint">
                      Priorite pratique: `AGENTS.md` pour le cadre, `MEMORY.md` pour les faits
                      stables, puis `memory/*.md` pour les journaux et notes indexees.
                    </div>
                  </section>
                </div>
              )
            ) : null}

                <div className="button-row agent-studio-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={agentSaving}
                    onClick={() => void handleSaveAgent()}
                  >
                    {agentSaving
                      ? agentEditorMode === "create"
                        ? "Creation..."
                        : "Sauvegarde..."
                      : agentEditorMode === "create"
                        ? "Creer l’agent et ouvrir les markdowns"
                        : "Sauvegarder"}
                  </button>
                  <button type="button" className="ghost-button" onClick={resetAgentEditor}>
                    Reinitialiser
                  </button>
                  {agentEditorMode === "edit" ? (
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={
                        agentEditor.agentId === "main" || agentDeleteBusy === agentEditor.agentId
                      }
                      onClick={() => void handleDeleteAgent(agentEditor.agentId)}
                    >
                      {agentDeleteBusy === agentEditor.agentId ? "Suppression..." : "Supprimer"}
                    </button>
                  ) : null}
                </div>
              </div>

              <aside className="agent-cockpit-inspector">
                <section className="selection-panel agent-inspector-panel">
                  <div className="info-row compact">
                    <div className="stack compact">
                      <small className="eyebrow-label">Console agent</small>
                      <strong>{selectedAgentDisplayName}</strong>
                    </div>
                    <StatusPill status={selectedAgentStatus}>{selectedAgentStatus}</StatusPill>
                  </div>
                  <p className="muted-line">{selectedAgentPurpose}</p>
                  <div className="detail-pairs compact-grid">
                    <span>Section</span>
                    <span>{activeSectionTab.label}</span>
                    <span>Workspace</span>
                    <code className="mono">{agentEditor.workspace || "n/a"}</code>
                    <span>Fichiers</span>
                    <span>{selectedAgentWorkspace?.fileCount || 0}</span>
                    <span>Memoires</span>
                    <span>{selectedAgentWorkspace?.memoryFileCount || 0}</span>
                  </div>
                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        setAgentStudioSection("files");
                        focusOrStageAgentMarkdownFile("AGENTS.md");
                      }}
                    >
                      Ouvrir AGENTS.md
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => setAgentStudioSection("memory")}
                    >
                      Voir memoire
                    </button>
                  </div>
                </section>

                <section className="selection-panel agent-inspector-panel">
                  <div className="info-row compact">
                    <strong>Surfaces natives</strong>
                    <StatusPill status="workspace">
                      {selectedAgentPinnedReadyCount}/{AGENT_STUDIO_PINNED_FILES.length}
                    </StatusPill>
                  </div>
                  <div className="agent-inspector-surface-list">
                    {selectedAgentPinnedSurfaces.map((surface) => (
                      <button
                        key={surface.fileName}
                        type="button"
                        className={`agent-inspector-surface-button ${selectedAgentFileKey === surface.key ? "active" : ""}`}
                        onClick={() => focusOrStageAgentMarkdownFile(surface.fileName)}
                      >
                        <div className="info-row compact">
                          <strong>{surface.fileName}</strong>
                          <StatusPill status={surface.state.status}>
                            {surface.state.label}
                          </StatusPill>
                        </div>
                        <small>
                          {surface.file
                            ? `${surface.file.type} · ${formatDateTime(surface.file.updatedAtMs)}`
                            : surface.guide.emphasis}
                        </small>
                      </button>
                    ))}
                  </div>
                </section>

                <section className="selection-panel agent-inspector-panel">
                  <div className="info-row compact">
                    <strong>Runtime effectif</strong>
                    <StatusPill status="active">{effectiveAgentModelLabel}</StatusPill>
                  </div>
                  <div className="detail-pairs compact-grid">
                    <span>Modele</span>
                    <span>{effectiveAgentModelLabel}</span>
                    <span>Catalogue</span>
                    <span>{scopedRuntimeModelCount} modele(s)</span>
                    <span>Execution</span>
                    <span>
                      {formatExecutionSummary(
                        editedAgentExecution,
                        modelProviderFromRef(effectiveAgentModelRef),
                      )}
                    </span>
                    <span>Skills</span>
                    <span>
                      {agentEditor.skillPolicy === "selected"
                        ? `${agentEditor.skillIds.length} selectionnee(s)`
                        : agentEditor.skillPolicy === "none"
                          ? "aucune"
                          : "toutes eligibles"}
                    </span>
                    <span>Memoire</span>
                    <span>{memoryEngineStatus?.activeEngineId || "runtime"}</span>
                  </div>
                </section>

                <section className="selection-panel agent-inspector-panel">
                  <div className="info-row compact">
                    <strong>Sorties & sessions</strong>
                    <StatusPill status="active">
                      {selectedAgentAccessibleOutputLabels.length} sortie(s)
                    </StatusPill>
                  </div>
                  <div className="detail-pairs compact-grid">
                    <span>Dispatch</span>
                    <span>{agentEditor.dispatchPolicy}</span>
                    <span>Outputs auto</span>
                    <span>
                      {selectedAgentDispatchTargetLabels.length
                        ? selectedAgentDispatchTargetLabels.join(", ")
                        : "aucun"}
                    </span>
                    <span>Outputs defaut</span>
                    <span>
                      {selectedAgentDefaultOutputLabels.length
                        ? selectedAgentDefaultOutputLabels.join(", ")
                        : "aucune"}
                    </span>
                    <span>Derniere session</span>
                    <span>{selectedAgentSessionLabel}</span>
                    <span>Derniere activite</span>
                    <span>{formatDateTime(selectedAgentSession?.updatedAt)}</span>
                  </div>
                  {agentEditorMode === "edit" && selectedAgentSession?.key ? (
                    <div className="button-row">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => {
                          setSelectedSessionKey(selectedAgentSession.key);
                          setView("chat");
                        }}
                      >
                        Ouvrir la session
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => setAgentStudioSection("routing")}
                      >
                        Regler les sorties
                      </button>
                    </div>
                  ) : null}
                </section>
              </aside>
            </div>
          </div>
        </section>
      </section>
    );
  }

  function renderChat() {
    const currentHistory = history?.sessionKey === selectedSessionKey ? history : null;
    const currentMessages = currentHistory?.messages || [];
    const selectedSessionInheritedModelRef = selectedSession
      ? getEffectiveAgentModelRef(selectedSession.agentId)
      : "";
    const selectedSessionWorkspaceMode = resolveChatWorkspaceMode(selectedSession);
    const selectedSessionAgentPromptBlocked =
      selectedSessionWorkspaceMode === "inbox" &&
      (selectedSessionInboundPrincipal?.status === "ambiguous" ||
        selectedSessionInboundPrincipal?.status === "unresolved" ||
        (selectedSessionInboundPrincipal?.status === "resolved" &&
          !selectedSessionInboundPrincipal.canUseAgent));
    const selectedSessionAllowedSkillIds =
      selectedSessionWorkspaceMode === "inbox"
        ? selectedSessionInboundPrincipal?.status === "resolved"
          ? selectedSessionInboundPrincipal.allowedSkillIds
          : []
        : getAllowedSkillIdsForAgentProvider(
            selectedSession?.agentId || "",
            modelProviderFromRef(selectedSessionEffectiveModelRef),
          );
    const selectedSessionAllowedSkillLabels = selectedSessionAllowedSkillIds.map((skillId) => {
      const skillEntry = (skillsCatalog?.skills || []).find((entry) => entry.id === skillId);
      return skillEntry?.name || skillEntry?.dirName || skillId;
    });
    const selectedSessionInboundAccessibleAgentLabels =
      selectedSessionInboundPrincipal?.accessibleAgentIds.map((agentId) => agentName(agentId)) || [];
    const selectedSessionInboundAccessibleChannelLabels =
      selectedSessionInboundPrincipal?.accessibleChannelIds.map((channelId) => channelName(channelId)) || [];
    const selectedSessionInboundMatchedChannelLabels =
      selectedSessionInboundPrincipal?.matchedChannelIds.map((channelId) => channelName(channelId)) || [];
    const selectedSessionInboundGrantAgentIds = getInboundGrantAgentIds(
      selectedSessionInboundPrincipal,
      selectedSession?.agentId,
    );
    const selectedSessionModelSelectionRef =
      selectedSessionOverrideModelRef ||
      (selectedSessionEffectiveModelRef &&
      selectedSessionEffectiveModelRef !== selectedSessionInheritedModelRef
        ? selectedSessionEffectiveModelRef
        : "");
    const workspaceTabs = [
      {
        id: "elytras" as const,
        label: "Chats Elytras",
        detail: `${sessionKindStats.elytras} session(s)`,
      },
      {
        id: "inbox" as const,
        label: "Inbox bots",
        detail: `${sessionKindStats.inbox} session(s)`,
      },
      ...(currentUserCanManageAdminViews
        ? [
            {
              id: "system" as const,
              label: "Logs systeme",
              detail: `${sessionKindStats.system} session(s)`,
            },
          ]
        : []),
    ];
    const workspaceTitle =
      chatWorkspaceMode === "elytras"
        ? "Chats Elytras"
        : chatWorkspaceMode === "inbox"
          ? "Inbox bots"
          : "Logs systeme";
    const workspaceCount =
      chatWorkspaceMode === "elytras"
        ? sessionKindStats.elytras
        : chatWorkspaceMode === "inbox"
          ? sessionKindStats.inbox
          : sessionKindStats.system;
    const canReplyToSelectedSession =
      Boolean(selectedSession) &&
      !isPipelineSessionLike(selectedSession, pipelines) &&
      selectedSessionWorkspaceMode !== "system" &&
      canOperateSessionRecord(selectedSession);
    const selectedSessionRouteLabel = [
      selectedSession?.subject,
      selectedSession?.lastTo,
      selectedSession?.chatType,
    ]
      .filter(Boolean)
      .join(" · ");
    const selectedSessionLabel =
      selectedSession?.displayName || selectedSession?.derivedTitle || selectedSession?.key || "session";
    const canExportCurrentSession = Boolean(selectedSession && currentMessages.length);
    const chatWorkspaceToolbarDetail = currentUserCanManageAdminViews
      ? "Conversations Elytras, inbox bots et logs systeme separes"
      : "Chats Elytras et inbox bots separes";
    const selectedSessionSurfaceLabel = describeSessionSurfaceLabel(selectedSession);
    const workspaceDescription = describeChatWorkspace(chatWorkspaceMode);
    const workspaceBehaviorHint =
      chatWorkspaceMode === "elytras"
        ? "Les nouveaux chats crees ici restent separes des runs pipeline et des surfaces techniques."
        : chatWorkspaceMode === "inbox"
          ? "Chaque conversation inbox reste reliee a son bot; repondre ici repart sur la surface externe."
          : "Les sessions heartbeat/internal restent lisibles pour le debug, sans composer operateur.";
    const showSelectedSessionLiveControls =
      Boolean(selectedSession) &&
      !isPipelineSessionLike(selectedSession, pipelines) &&
      selectedSessionWorkspaceMode !== "system";
    const showSelectedSessionInboundGovernance =
      selectedSessionWorkspaceMode === "inbox" &&
      Boolean(
        selectedSessionInboundPrincipal && selectedSessionInboundPrincipal.status !== "n/a",
      );
    const selectedSessionInboundSummary = summarizeInboundPrincipal(selectedSessionInboundPrincipal);
    const selectedSessionInboundNeedsRbacReview = inboundPrincipalNeedsRbacReview(
      selectedSessionInboundPrincipal,
    );
    const openSelectedSessionInboundGovernance =
      selectedSessionInboundPrincipal?.status === "ambiguous" ||
      selectedSessionInboundPrincipal?.status === "unresolved" ||
      (selectedSessionInboundPrincipal?.status === "resolved" &&
        (!selectedSessionInboundPrincipal.canUseAgent ||
          !selectedSessionInboundPrincipal.canUseChannel));

    return (
      <section className="stack">
        <section className="panel chat-workspace-panel">
          <ResourceToolbar
            title="Chat Workspace"
            detail={chatWorkspaceToolbarDetail}
          >
            <StatusPill status="active">{workspaceTitle}</StatusPill>
          </ResourceToolbar>

          <div className="agent-studio-tabs chat-workspace-tabs">
            {workspaceTabs.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`agent-studio-tab ${chatWorkspaceMode === item.id ? "active" : ""}`}
                onClick={() => setChatWorkspaceMode(item.id)}
              >
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </button>
            ))}
          </div>

          <div className="chat-workspace-summary">
            <div className="stack compact">
              <strong>{workspaceTitle}</strong>
              <small className="muted-line">{workspaceDescription}</small>
              <small className="muted-line">{workspaceBehaviorHint}</small>
            </div>
            <div className="chat-workspace-summary-meta">
              <StatusPill status="active">{workspaceCount}</StatusPill>
              <span className="inline-tag">{chatWorkspaceMode}</span>
            </div>
          </div>

          {chatWorkspaceMode === "elytras" ? (
            <div className="chat-launchpad-grid">
              <article className="selection-panel chat-launchpad-panel">
                <div className="info-row compact">
                  <strong>Nouveau chat</strong>
                  <StatusPill status="active">{chatDraftAgentId || "agent"}</StatusPill>
                </div>
                <div className="chat-launchpad-form">
                  <label>
                    Agent
                    <select
                      className="select"
                      value={chatDraftAgentId}
                      onChange={(event) =>
                        setChatDraft((current) => ({
                          ...current,
                          agentId: event.target.value,
                          projectId:
                            current.projectId !== DASHBOARD_NO_PROJECT_ID &&
                            selectedDashboardAvailableProjects.some(
                              (project) =>
                                project.id === current.projectId &&
                                (project.agentIds.length === 0 ||
                                  project.agentIds.includes(event.target.value)),
                            )
                              ? current.projectId
                              : selectedDashboardProjectId !== DASHBOARD_NO_PROJECT_ID &&
                                  selectedDashboardAvailableProjects.some(
                                    (project) =>
                                      project.id === selectedDashboardProjectId &&
                                      (project.agentIds.length === 0 ||
                                        project.agentIds.includes(event.target.value)),
                                  )
                                ? selectedDashboardProjectId
                                : DASHBOARD_NO_PROJECT_ID,
                        }))
                      }
                    >
                      {visibleAgents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.identity?.name || agent.name || agent.id}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    Memoire projet
                    <select
                      className="select"
                      value={chatDraft.projectId}
                      onChange={(event) =>
                        setChatDraft((current) => ({
                          ...current,
                          projectId: event.target.value,
                        }))
                      }
                    >
                      <option value={DASHBOARD_NO_PROJECT_ID}>Aucun projet partage</option>
                      {chatDraftProjectOptions.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name} · {teamName(project.teamId)}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    Nom du chat
                    <input
                      className="input"
                      value={chatDraft.label}
                      onChange={(event) =>
                        setChatDraft((current) => ({
                          ...current,
                          label: event.target.value,
                        }))
                      }
                      placeholder={`ex. ${buildDefaultChatLabel(chatDraftAgentId || "main")}`}
                    />
                  </label>

                  <label className="field-span-2">
                    Message initial
                    <textarea
                      className="input textarea"
                      rows={3}
                      value={chatDraft.message}
                      onChange={(event) =>
                        setChatDraft((current) => ({
                          ...current,
                          message: event.target.value,
                        }))
                      }
                      placeholder="Optionnel. Laisse vide si tu veux juste ouvrir le chat."
                    />
                  </label>
                </div>
                <div className="button-row">
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={chatCreating || !chatDraftAgentId || !currentUserCanOperate}
                    onClick={() => void handleCreateChat()}
                  >
                    {chatCreating
                      ? "Ouverture..."
                      : chatDraftSuggestedSession
                        ? "Reprendre ou reutiliser la session"
                        : "Ouvrir un nouveau chat"}
                  </button>
                  <button type="button" className="ghost-button" onClick={resetChatDraft}>
                    Reinitialiser
                  </button>
                </div>
              </article>

              <article className="selection-panel chat-launchpad-panel chat-launchpad-inspector">
                <div className="info-row compact">
                  <strong>Policies de l’agent selectionne</strong>
                  <StatusPill status="active">{chatDraftAgentId}</StatusPill>
                </div>
                <small className="muted-line">
                  resume {chatDraftAgentBinding?.resumePolicy || "manual"} · dispatch{" "}
                  {chatDraftAgentBinding?.dispatchPolicy || "manual"} · outputs{" "}
                  {describeDefaultOutputs(chatDraftAgentBinding)}
                </small>
                {chatDraftSuggestedSession ? (
                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        setSelectedSessionKey(chatDraftSuggestedSession.key);
                        setView("chat");
                      }}
                    >
                      Reprendre la session suggeree
                    </button>
                    <small className="muted-line">
                      {chatDraftSuggestedSession.displayName ||
                        chatDraftSuggestedSession.derivedTitle ||
                        chatDraftSuggestedSession.key}{" "}
                      · {formatDateTime(chatDraftSuggestedSession.updatedAt)}
                    </small>
                  </div>
                ) : (
                  <small className="muted-line">Aucune reprise suggeree pour cet agent.</small>
                )}
                {currentUserCanManageAdminViews ? (
                  <small className="muted-line">
                    Skills autorisees pour {chatDraftProviderHint || "provider actif"}:{" "}
                    {getAllowedSkillIdsForAgentProvider(chatDraftAgentId, chatDraftProviderHint).join(
                      ", ",
                    ) || "aucune"}
                  </small>
                ) : null}
              </article>

              <details className="chat-advanced-panel chat-launchpad-advanced">
                <summary>
                  <span>Reglages avances du nouveau chat</span>
                  <small>Modele runtime et variables d’execution</small>
                </summary>
                <div className="chat-advanced-grid">
                  <RuntimeModelPicker
                    label="Modele du nouveau chat"
                    selectedModelRef={chatDraft.modelRef}
                    effectiveModelRef={chatDraftEffectiveModelRef}
                    inheritLabel="Heriter du modele agent/runtime"
                    inheritDescription={
                      getEffectiveAgentModelRef(chatDraftAgentId)
                        ? `Modele agent/runtime courant: ${getEffectiveAgentModelRef(chatDraftAgentId)}`
                        : "Aucun modele agent/runtime explicite."
                    }
                    models={chatDraftRuntimeModels}
                    allowedProviders={chatDraftAgentProviderIds}
                    onChange={(modelRef) =>
                      setChatDraft((current) => ({
                        ...current,
                        modelRef,
                      }))
                    }
                  />

                  <ExecutionSettingsPicker
                    title="Variables du nouveau chat"
                    description="Ces valeurs sont appliquees des l’ouverture du chat."
                    providerHint={chatDraftProviderHint}
                    profile={chatDraft}
                    effectiveProfile={chatDraftEffectiveExecution}
                    effectiveLabel="Profil effectif"
                    onChange={(patch) =>
                      setChatDraft((current) => ({
                        ...current,
                        ...(Object.prototype.hasOwnProperty.call(patch, "thinkingLevel")
                          ? { thinkingLevel: patch.thinkingLevel || undefined }
                          : {}),
                        ...(Object.prototype.hasOwnProperty.call(patch, "fastMode")
                          ? {
                              fastMode:
                                typeof patch.fastMode === "boolean" ? patch.fastMode : undefined,
                            }
                          : {}),
                        ...(Object.prototype.hasOwnProperty.call(patch, "verboseLevel")
                          ? { verboseLevel: patch.verboseLevel || undefined }
                          : {}),
                        ...(Object.prototype.hasOwnProperty.call(patch, "reasoningLevel")
                          ? { reasoningLevel: patch.reasoningLevel || undefined }
                          : {}),
                      }))
                    }
                  />
                </div>
              </details>
            </div>
          ) : null}
        </section>

        <section className="session-grid">
          <section className="panel list-column">
            <ResourceToolbar
              title={workspaceTitle}
              detail={`${filteredSessions.length} visible(s) · ${workspaceCount} dans cette surface · runs pipeline ${sessionKindStats.pipeline} masques ici`}
            />
            <div className="chat-session-toolbar">
              <label>
                Agent
                <select
                  className="select"
                  value={sessionAgentFilter}
                  onChange={(event) => setSessionAgentFilter(event.target.value)}
                >
                  <option value="all">Tous</option>
                  {visibleAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.identity?.name || agent.name || agent.id}
                    </option>
                  ))}
                </select>
              </label>

              {chatWorkspaceMode === "inbox" ? (
                <label>
                  Channel
                  <select
                    className="select"
                    value={inboxChannelFilter}
                    onChange={(event) => setInboxChannelFilter(event.target.value)}
                  >
                    <option value="all">Tous</option>
                    {inboxSessionChannels.map((channelId) => (
                      <option key={channelId} value={channelId}>
                        {channelId}
                      </option>
                    ))}
                  </select>
                </label>
              ) : chatWorkspaceMode === "system" ? (
                <label>
                  Type
                  <select
                    className="select"
                    value={systemSessionFilter}
                    onChange={(event) =>
                      setSystemSessionFilter(
                        event.target.value as "all" | "heartbeat" | "internal",
                      )
                    }
                  >
                    <option value="all">Tous</option>
                    <option value="heartbeat">heartbeat</option>
                    <option value="internal">internal</option>
                  </select>
                </label>
              ) : null}

              <label>
                Recherche
                <input
                  className="input"
                  value={sessionSearch}
                  onChange={(event) => setSessionSearch(event.target.value)}
                  placeholder="Nom, agent, extrait, cle..."
                />
              </label>
            </div>

            <div className="list-grid scroll-column chat-session-list">
              {filteredSessions.length ? (
                filteredSessions.map((session) => (
                  <button
                    key={session.key}
                    type="button"
                    className={`session-card ${selectedSessionKey === session.key ? "active" : ""}`}
                    onClick={() => setSelectedSessionKey(session.key)}
                  >
                    <div className="info-row compact">
                      <strong>{session.displayName || session.derivedTitle || session.key}</strong>
                      <div className="info-row compact">
                        <StatusPill status={sessionKindPillStatus(session.sessionKind)}>
                          {session.sessionKindLabel || session.sessionKind || "chat"}
                        </StatusPill>
                        <StatusPill status={session.activityStatus}>
                          {session.activityStatus}
                        </StatusPill>
                      </div>
                    </div>
                    <p>{session.lastMessagePreview || "Aucun apercu recent."}</p>
                    <small className="muted-line">
                      {session.agentId} · {session.modelProvider || "provider"} /{" "}
                      {session.model || "model"}
                    </small>
                    <small className="muted-line">
                      {currentUserCanManageAdminViews
                        ? getSessionChannelBadge(session)
                        : describeSessionSurfaceLabel(session)}
                    </small>
                    {session.projectName ? (
                      <small className="muted-line">projet {session.projectName}</small>
                    ) : null}
                    {currentUserCanManageAdminViews ? (
                      <small className="muted-line">{describeSessionSurface(session)}</small>
                    ) : null}
                    {shouldShowInboundPrincipal(session) ? (
                      <div className="info-row compact">
                        <StatusPill status={inboundPrincipalTone(session.inboundPrincipal)}>
                          {describeInboundPrincipalState(session.inboundPrincipal)}
                        </StatusPill>
                        <small className="muted-line">
                          {summarizeInboundPrincipal(session.inboundPrincipal)}
                        </small>
                      </div>
                    ) : null}
                    <small className="muted-line">{formatDateTime(session.updatedAt)}</small>
                  </button>
                ))
              ) : (
                <EmptyState
                  title="Aucune session"
                  body={
                    selectedSession
                      ? isPipelineSessionLike(selectedSession, pipelines)
                        ? "Cette session appartient a un run pipeline. Ouvre la page Pipelines pour inspecter ses logs et transcripts."
                        : "La session selectionnee appartient a une autre surface. Change d’onglet pour la retrouver."
                      : chatWorkspaceMode === "elytras"
                        ? "Aucun chat Elytras ne correspond au filtre courant. Ouvre un nouveau chat ou elargis la recherche."
                        : chatWorkspaceMode === "inbox"
                          ? "Aucune conversation inbound de bot ne correspond au filtre courant."
                          : "Aucun log systeme ne correspond au filtre courant."
                  }
                />
              )}
            </div>
          </section>

          <section className="panel detail-column">
            <ResourceToolbar
              title="Conversation"
              detail={
                selectedSession
                  ? selectedSessionLabel
                  : "Choisis une session"
              }
            >
              {canExportCurrentSession ? (
                <>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      exportSessionTranscriptMarkdown({
                        sessionKey: selectedSession?.key || "",
                        sessionLabel: selectedSessionLabel,
                        messages: currentMessages,
                      })
                    }
                  >
                    Export MD
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      exportSessionTranscriptJson({
                        sessionKey: selectedSession?.key || "",
                        sessionLabel: selectedSessionLabel,
                        messages: currentMessages,
                      })
                    }
                  >
                    Export JSON
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="ghost-button"
                disabled={!canOperateSessionRecord(selectedSession)}
                onClick={handleResetSession}
              >
                Reset
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => window.open(OPENCLAW_DOCS_URL, "_blank")}
              >
                Docs OpenClaw
              </button>
            </ResourceToolbar>
            {selectedSession ? (
              isPipelineSessionLike(selectedSession, pipelines) ? (
                <article className="callout">
                  <strong>Session de pipeline</strong>
                  <p>
                    Cette session provient d’un run pipeline. Elle n’est plus traitee comme un chat
                    operateur.
                  </p>
                  <div className="detail-pairs compact-grid">
                    <span>Pipeline</span>
                    <span>{selectedSession.pipelineId || "n/a"}</span>
                    <span>Run pipeline</span>
                    <span>{selectedSession.pipelineRunId || "n/a"}</span>
                    <span>Etape pipeline</span>
                    <span>{selectedSession.pipelineStepId || "n/a"}</span>
                    <span>Session key</span>
                    <code className="mono">{selectedSession.key}</code>
                  </div>
                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        setView("pipelines");
                        if (selectedSession.pipelineRunId) {
                          setSelectedPipelineRunId(selectedSession.pipelineRunId);
                        }
                        if (selectedSession.pipelineId) {
                          const pipeline = visiblePipelines.find(
                            (candidate) => candidate.id === selectedSession.pipelineId,
                          );
                          if (pipeline) {
                            startPipelineEdit(pipeline);
                          }
                        }
                      }}
                    >
                      Ouvrir dans Pipelines
                    </button>
                  </div>
                </article>
              ) : (
              <>
                <article className="selection-panel chat-session-hero">
                  <div className="chat-session-hero-head">
                    <div className="stack compact">
                      <strong className="chat-session-title">{selectedSessionLabel}</strong>
                      <small className="muted-line">
                        {selectedSessionRouteLabel ||
                          (currentUserCanManageAdminViews
                            ? getSessionChannelBadge(selectedSession)
                            : selectedSessionSurfaceLabel)}
                      </small>
                    </div>
                    <div className="button-row">
                      <StatusPill status={sessionKindPillStatus(selectedSession.sessionKind)}>
                        {selectedSession.sessionKindLabel || selectedSession.sessionKind || "chat"}
                      </StatusPill>
                      <StatusPill status={selectedSession.activityStatus}>
                        {selectedSession.activityStatus}
                      </StatusPill>
                    </div>
                  </div>
                  <div className="chat-session-meta">
                    <span className="inline-tag">{selectedSession.agentId}</span>
                    <span className="inline-tag">
                      {selectedSession.modelProvider || "provider"} / {selectedSession.model || "model"}
                    </span>
                    {selectedSession.projectName ? (
                      <span className="inline-tag">projet {selectedSession.projectName}</span>
                    ) : null}
                    <span className="inline-tag">
                      {selectedSession.totalTokens || 0} token(s)
                    </span>
                    {currentUserCanManageAdminViews ? (
                      <span className="inline-tag">
                        cout {formatCurrency(selectedSession.estimatedCostUsd)}
                      </span>
                    ) : null}
                    <span className="inline-tag">{formatDateTime(selectedSession.updatedAt)}</span>
                  </div>
                  {selectedSessionWorkspaceMode === "inbox" ? (
                    <small className="muted-line">
                      Reply bridge actif via <span className="mono">{selectedSession.channel || "channel"}</span>.
                    </small>
                  ) : null}
                  {showSelectedSessionInboundGovernance ? (
                    <div className="stack">
                      <div className="info-row compact">
                        <StatusPill status={inboundPrincipalTone(selectedSessionInboundPrincipal)}>
                          {describeInboundPrincipalState(selectedSessionInboundPrincipal)}
                        </StatusPill>
                        <small className="muted-line">{selectedSessionInboundSummary}</small>
                      </div>
                      <div className="detail-pairs compact-grid">
                        <span>User Elytras</span>
                        <span>
                          {selectedSessionInboundPrincipal?.userName
                            ? `${selectedSessionInboundPrincipal.userName} (${selectedSessionInboundPrincipal.userId || "n/a"})`
                            : "non mappe"}
                        </span>
                        <span>Identite source</span>
                        <span>
                          {selectedSessionInboundPrincipal?.matchedExternalId ||
                            selectedSessionInboundPrincipal?.candidateExternalIds.join(", ") ||
                            "n/a"}
                        </span>
                        <span>Equipe(s)</span>
                        <span>
                          {selectedSessionInboundPrincipal?.teamNames.join(", ") || "aucune"}
                        </span>
                        <span>Equipe(s) autorisante(s)</span>
                        <span>
                          {selectedSessionInboundPrincipal?.authorizingTeamNames?.join(", ") ||
                            "aucune"}
                        </span>
                        <span>Agent</span>
                        <span>{agentName(selectedSessionInboundPrincipal?.targetAgentId)}</span>
                        <span>Acces agent</span>
                        <span>
                          {selectedSessionInboundPrincipal?.canUseAgent ? "autorise" : "bloque"}
                        </span>
                        <span>Acces destination</span>
                        <span>
                          {selectedSessionInboundPrincipal?.canUseChannel ? "autorise" : "bloque"}
                        </span>
                      </div>
                    </div>
                  ) : null}
                  {selectedSessionWorkspaceMode === "system" ? (
                    <small className="muted-line">
                      Surface technique visible pour le debug; le composer reste masque sur cette session.
                    </small>
                  ) : null}
                </article>

                {showSelectedSessionInboundGovernance && selectedSessionAgentPromptBlocked ? (
                  <article className="callout">
                    <div className="info-row compact">
                      <strong>Bridge inbound bloque</strong>
                      <StatusPill status={inboundPrincipalTone(selectedSessionInboundPrincipal)}>
                        {describeInboundPrincipalState(selectedSessionInboundPrincipal)}
                      </StatusPill>
                    </div>
                    <p>
                      {describeInboundPrincipalAccess(selectedSessionInboundPrincipal)}
                      {selectedSessionInboundPrincipal?.reason
                        ? ` ${selectedSessionInboundPrincipal.reason}`
                        : ""}
                    </p>
                    <div className="detail-pairs compact-grid">
                      <span>Expediteur</span>
                      <span>
                        {selectedSessionInboundPrincipal?.senderLabel ||
                          selectedSessionInboundPrincipal?.senderExternalIds.join(", ") ||
                          "n/a"}
                      </span>
                      <span>Identite</span>
                      <span>
                        {selectedSessionInboundPrincipal?.matchedExternalId ||
                          selectedSessionInboundPrincipal?.candidateExternalIds.join(", ") ||
                          "n/a"}
                      </span>
                      <span>Destination</span>
                      <span>{selectedSessionInboundMatchedChannelLabels.join(", ") || "non geree"}</span>
                    </div>
                    {currentUserCanManageAdminViews ? (
                      <div className="button-row">
                        {selectedSessionInboundPrincipal?.status === "resolved" &&
                        selectedSessionInboundPrincipal.userId ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() =>
                              openUserEditorFromChat(selectedSessionInboundPrincipal.userId)
                            }
                          >
                            Modifier user
                          </button>
                        ) : null}
                        {selectedSessionInboundPrincipal?.status === "unresolved" ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() =>
                              seedUserEditorFromInboundIdentity(
                                selectedSessionInboundPrincipal.candidateExternalIds[0] || "",
                              )
                            }
                          >
                            Mapper ce sender
                          </button>
                        ) : null}
                        {selectedSessionInboundNeedsRbacReview ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => setView("access")}
                          >
                            Ouvrir Teams & Access
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                ) : null}

                <div className="messages-column" ref={messagesColumnRef}>
                  {historyLoading && currentMessages.length === 0 ? (
                    <EmptyState title="Chargement" body="Recuperation du transcript en cours." />
                  ) : currentMessages.length ? (
                    currentMessages.map((message) => (
                      <MessageBubble key={message.id} message={message} />
                    ))
                  ) : (
                    <EmptyState
                      title="Transcript vide"
                      body="Cette session n'a pas encore de messages visibles."
                    />
                  )}
                </div>

                {canReplyToSelectedSession ? (
                  <div className="composer">
                    <input
                      ref={chatImportInputRef}
                      type="file"
                      accept="image/*,audio/*,video/*,.md,.mdx,.txt,.json,.csv,.tsv,.xml,.yaml,.yml,.js,.jsx,.ts,.tsx,.py,.sh,.html,.css,.pdf,.zip"
                      multiple
                      hidden
                      onChange={(event) => void handleImportChatFiles(event)}
                    />
                    <div className="chat-composer-toolbar">
                      <div className="button-row">
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => chatImportInputRef.current?.click()}
                        >
                          Importer fichiers
                        </button>
                      </div>
                      <small className="muted-line">
                        {selectedSessionWorkspaceMode === "inbox"
                          ? selectedSessionAgentPromptBlocked
                            ? `Parler a l'agent est bloque. ${describeInboundPrincipalAccess(selectedSessionInboundPrincipal)}`
                            : 'Envoyer parle a l\'agent. "Relayer via bot" envoie directement texte et pieces jointes au destinataire reel.'
                          : "Images jointes au prompt. Fichiers texte injectes dans le message."}
                      </small>
                    </div>
                    {chatComposerAttachments.length ? (
                      <div className="chat-attachment-strip">
                        {chatComposerAttachments.map((attachment) => (
                          <article key={attachment.id} className="chat-attachment-card">
                            {attachment.kind === "image" ? (
                              <img src={attachment.previewUrl} alt={attachment.fileName} />
                            ) : attachment.kind === "audio" ? (
                              <audio
                                className="message-attachment-audio"
                                controls
                                preload="none"
                                src={attachment.previewUrl}
                              />
                            ) : attachment.kind === "video" ? (
                              <video
                                className="message-attachment-video"
                                controls
                                preload="metadata"
                                src={attachment.previewUrl}
                              />
                            ) : (
                              <div className="message-attachment-placeholder">{attachment.kind}</div>
                            )}
                            <div className="stack compact">
                              <strong>{attachment.fileName}</strong>
                              <small className="muted-line">
                                {attachment.mimeType || attachment.kind} ·{" "}
                                {(attachment.size / 1024).toFixed(1)} KB
                              </small>
                            </div>
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() => removeChatComposerAttachment(attachment.id)}
                            >
                              Retirer
                            </button>
                          </article>
                        ))}
                      </div>
                    ) : null}
                    <textarea
                      className="input textarea"
                      rows={4}
                      placeholder={
                        selectedSessionWorkspaceMode === "inbox"
                          ? `Repondre via ${selectedSession.channel || "bot"}...`
                          : "Reprendre la session ici..."
                      }
                      value={composer}
                      onChange={(event) => setComposer(event.target.value)}
                    />
                    <div className="button-row">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => void handleSendMessage()}
                        disabled={selectedSessionAgentPromptBlocked}
                      >
                        {selectedSessionWorkspaceMode === "inbox"
                          ? "Parler a l'agent"
                          : "Envoyer"}
                      </button>
                      {selectedSessionWorkspaceMode === "inbox" ? (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => void handleRelayMessage()}
                        >
                          Relayer via bot
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => {
                          setComposer("");
                          clearChatComposerAttachments();
                        }}
                      >
                        Vider tout
                      </button>
                    </div>
                  </div>
                ) : null}

                <section className="chat-advanced-stack">
                  <details className="chat-advanced-panel">
                    <summary>
                      <span>Details session</span>
                      <small>Route, surface, usage et identifiants</small>
                    </summary>
                    {currentUserCanManageAdminViews ? (
                      <div className="detail-pairs compact-grid">
                        <span>Display</span>
                        <span>
                          {selectedSession.displayName || selectedSession.derivedTitle || "n/a"}
                        </span>
                        <span>Type</span>
                        <span>
                          <StatusPill status={sessionKindPillStatus(selectedSession.sessionKind)}>
                            {selectedSession.sessionKindLabel || selectedSession.sessionKind || "chat"}
                          </StatusPill>
                        </span>
                        <span>Surface</span>
                        <span>{getSessionChannelBadge(selectedSession)}</span>
                        <span>Agent</span>
                        <span>{selectedSession.agentId}</span>
                        <span>Session key</span>
                        <code className="mono">{selectedSession.key}</code>
                        {selectedSession.sessionKind === "pipeline" ? (
                          <>
                            <span>Pipeline</span>
                            <span>{selectedSession.pipelineId || "n/a"}</span>
                            <span>Run pipeline</span>
                            <span>{selectedSession.pipelineRunId || "n/a"}</span>
                            <span>Etape pipeline</span>
                            <span>{selectedSession.pipelineStepId || "n/a"}</span>
                          </>
                        ) : null}
                        <span>Provider / Model</span>
                        <span>
                          {selectedSession.modelProvider || "n/a"} / {selectedSession.model || "n/a"}
                        </span>
                        <span>Route</span>
                        <span>{selectedSessionRouteLabel || "n/a"}</span>
                        <span>Role</span>
                        <span>{describeSessionSurface(selectedSession)}</span>
                        <span>Tokens</span>
                        <span>{selectedSession.totalTokens || 0}</span>
                        <span>Cost</span>
                        <span>{formatCurrency(selectedSession.estimatedCostUsd)}</span>
                        <span>Updated</span>
                        <span>{formatDateTime(selectedSession.updatedAt)}</span>
                      </div>
                    ) : (
                      <div className="detail-pairs compact-grid">
                        <span>Display</span>
                        <span>
                          {selectedSession.displayName || selectedSession.derivedTitle || "n/a"}
                        </span>
                        <span>Surface</span>
                        <span>{selectedSessionSurfaceLabel}</span>
                        <span>Agent</span>
                        <span>{selectedSession.agentId}</span>
                        {selectedSessionRouteLabel ? (
                          <>
                            <span>Conversation</span>
                            <span>{selectedSessionRouteLabel}</span>
                          </>
                        ) : null}
                        <span>Provider / Model</span>
                        <span>
                          {selectedSession.modelProvider || "n/a"} / {selectedSession.model || "n/a"}
                        </span>
                        <span>Tokens</span>
                        <span>{selectedSession.totalTokens || 0}</span>
                        <span>Updated</span>
                        <span>{formatDateTime(selectedSession.updatedAt)}</span>
                      </div>
                    )}
                  </details>

                  {showSelectedSessionLiveControls ? (
                    <details className="chat-advanced-panel">
                      <summary>
                        <span>Reglages live</span>
                        <small>Modele runtime et variables appliquees a la session</small>
                      </summary>
                      <div className="chat-advanced-grid">
                        <RuntimeModelPicker
                          label="Modele session live"
                          selectedModelRef={selectedSessionModelSelectionRef}
                          effectiveModelRef={selectedSessionEffectiveModelRef}
                          inheritLabel="Heriter du modele agent/runtime"
                          inheritDescription={
                            selectedSessionInheritedModelRef
                              ? `Modele agent/runtime courant: ${selectedSessionInheritedModelRef}`
                              : "Aucun modele agent/runtime explicite."
                          }
                          models={selectedSessionRuntimeModels}
                          allowedProviders={
                            selectedSession
                              ? getEffectiveAgentProviderIds(selectedSession.agentId)
                              : undefined
                          }
                          onChange={(modelRef) => void handleSelectedSessionModelPatch(modelRef)}
                        />

                        <ExecutionSettingsPicker
                          title="Variables session live"
                          description="Patch direct sur la session OpenClaw selectionnee."
                          providerHint={modelProviderFromRef(selectedSessionEffectiveModelRef)}
                          profile={{
                            thinkingLevel: selectedSession.thinkingLevel,
                            fastMode: selectedSession.fastMode,
                            verboseLevel: selectedSession.verboseLevel,
                            reasoningLevel: selectedSession.reasoningLevel,
                          }}
                          effectiveProfile={{
                            thinkingLevel: selectedSession.thinkingLevel,
                            fastMode: selectedSession.fastMode,
                            verboseLevel: selectedSession.verboseLevel,
                            reasoningLevel: selectedSession.reasoningLevel,
                          }}
                          effectiveLabel="Etat courant"
                          onChange={(patch) => void handleSelectedSessionExecutionPatch(patch)}
                        />
                      </div>
                    </details>
                  ) : null}

                  {showSelectedSessionInboundGovernance ? (
                    <details
                      className="chat-advanced-panel"
                      open={openSelectedSessionInboundGovernance}
                    >
                      <summary>
                        <span>Gouvernance inbound</span>
                        <small>Identite, droits et mappage utilisateur</small>
                      </summary>
                      <article className="callout">
                        <div className="info-row compact">
                          <strong>Identite inbound</strong>
                          <StatusPill status={inboundPrincipalTone(selectedSessionInboundPrincipal)}>
                            {describeInboundPrincipalState(selectedSessionInboundPrincipal)}
                          </StatusPill>
                        </div>
                        <div className="detail-pairs compact-grid">
                          <span>Resolution via</span>
                          <span>
                            {formatInboundResolutionSurface(
                              selectedSessionInboundPrincipal?.resolutionSurface,
                            )}
                          </span>
                          <span>Expediteur</span>
                          <span>
                            {selectedSessionInboundPrincipal?.senderLabel ||
                              selectedSessionInboundPrincipal?.senderExternalIds.join(", ") ||
                              "n/a"}
                          </span>
                          <span>Identite mappee</span>
                          <span>
                            {selectedSessionInboundPrincipal?.matchedExternalId ||
                              selectedSessionInboundPrincipal?.candidateExternalIds.join(", ") ||
                              "n/a"}
                          </span>
                          <span>User</span>
                          <span>
                            {selectedSessionInboundPrincipal?.userName ||
                              selectedSessionInboundPrincipal?.ambiguousUserIds?.join(", ") ||
                              "non mappe"}
                          </span>
                          <span>Teams</span>
                          <span>{selectedSessionInboundPrincipal?.teamNames.join(", ") || "n/a"}</span>
                          <span>Equipes autorisantes</span>
                          <span>
                            {selectedSessionInboundPrincipal?.authorizingTeamNames?.join(", ") ||
                              "aucune"}
                          </span>
                          <span>Role</span>
                          <span>
                            {selectedSessionInboundPrincipal?.status === "resolved"
                              ? `${selectedSessionInboundPrincipal.userRole || "member"} · ${selectedSessionInboundPrincipal.userStatus || "active"}`
                              : "n/a"}
                          </span>
                          <span>Agent cible</span>
                          <span>{agentName(selectedSessionInboundPrincipal?.targetAgentId)}</span>
                          <span>Acces</span>
                          <span>
                            {formatInboundAccessSource(selectedSessionInboundPrincipal?.accessSource)}
                          </span>
                          <span>Agents autorises</span>
                          <span>{selectedSessionInboundAccessibleAgentLabels.join(", ") || "aucun"}</span>
                          <span>Destinations autorisees</span>
                          <span>
                            {selectedSessionInboundAccessibleChannelLabels.join(", ") || "aucune"}
                          </span>
                          <span>Destination courante</span>
                          <span>
                            {selectedSessionInboundMatchedChannelLabels.join(", ") || "non geree"}
                          </span>
                          <span>Identites destination</span>
                          <span>
                            {selectedSessionInboundPrincipal?.destinationExternalIds.join(", ") ||
                              "n/a"}
                          </span>
                          <span>Canal</span>
                          <span>
                            {selectedSessionInboundPrincipal?.canUseChannel ? "autorise" : "bloque"}
                          </span>
                          <span>Restriction</span>
                          <span>{selectedSessionInboundPrincipal?.restrictionSource || "n/a"}</span>
                          <span>Skills autorisees</span>
                          <span>{selectedSessionAllowedSkillLabels.join(", ") || "aucune"}</span>
                        </div>
                        <small className="muted-line">
                          {describeInboundPrincipalAccess(selectedSessionInboundPrincipal)}
                          {selectedSessionInboundPrincipal?.reason
                            ? ` ${selectedSessionInboundPrincipal.reason}`
                            : ""}
                        </small>
                      </article>

                      {selectedSessionInboundPrincipal?.status === "unresolved" ? (
                        <div className="stack">
                          <article className="selection-panel">
                            <div className="info-row compact">
                              <strong>Mapper cette conversation</strong>
                              <StatusPill
                                status={selectedInboundMappingPreview?.canUseAgent ? "active" : "paused"}
                              >
                                preview
                              </StatusPill>
                            </div>
                            <small className="muted-line">
                              Rattache l'identite externe a un user existant et verifie tout de
                              suite son scope effectif.
                            </small>
                            <div className="form-grid">
                              <label>
                                User Elytras
                                <select
                                  className="select"
                                  value={inboundMappingUserId}
                                  onChange={(event) => setInboundMappingUserId(event.target.value)}
                                >
                                  <option value="">Choisir...</option>
                                  {users.map((user) => (
                                    <option key={user.id} value={user.id}>
                                      {user.name}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                Identite expediteur a rattacher
                                <select
                                  className="select"
                                  value={inboundMappingIdentity}
                                  onChange={(event) => setInboundMappingIdentity(event.target.value)}
                                >
                                  {selectedSessionInboundPrincipal.candidateExternalIds.map(
                                    (candidateId) => (
                                      <option key={candidateId} value={candidateId}>
                                        {candidateId}
                                      </option>
                                    ),
                                  )}
                                </select>
                              </label>
                            </div>
                            {selectedInboundMappingUser && selectedInboundMappingPreview ? (
                              <div className="detail-pairs compact-grid">
                                <span>Teams</span>
                                <span>
                                  {selectedInboundMappingPreview.teamIds.map(teamName).join(", ") ||
                                    "n/a"}
                                </span>
                                <span>Equipes autorisantes</span>
                                <span>
                                  {selectedInboundMappingPreview.authorizingTeamNames?.join(", ") ||
                                    "aucune"}
                                </span>
                                <span>Agents</span>
                                <span>
                                  {selectedInboundMappingPreview.accessibleAgentIds
                                    .map(agentName)
                                    .join(", ") || "aucun"}
                                </span>
                                <span>Destinations</span>
                                <span>
                                  {selectedInboundMappingPreview.accessibleChannelIds
                                    .map(channelName)
                                    .join(", ") || "aucune"}
                                </span>
                                <span>Acces cible</span>
                                <span>
                                  {selectedInboundMappingPreview.canUseAgent
                                    ? "pret a parler a l'agent"
                                    : "encore bloque"}
                                </span>
                                <span>Canal courant</span>
                                <span>
                                  {selectedInboundMappingPreview.canUseChannel
                                    ? "destination autorisee"
                                    : "destination non autorisee"}
                                </span>
                                <span>Skills</span>
                                <span>
                                  {selectedInboundMappingPreview.allowedSkillIds
                                    .map((skillId) => {
                                      const skillEntry = (skillsCatalog?.skills || []).find(
                                        (entry) => entry.id === skillId,
                                      );
                                      return skillEntry?.name || skillEntry?.dirName || skillId;
                                    })
                                    .join(", ") || "aucune"}
                                </span>
                              </div>
                            ) : null}
                            <small className="muted-line">
                              {selectedInboundMappingIdentityAlreadyPresent
                                ? `Cette identite est deja presente sur ${selectedInboundMappingUser?.name}.`
                                : selectedInboundMappingConflictUsers.length
                                  ? `Conflit: ${selectedInboundMappingConflictUsers
                                      .map((user) => user.name)
                                      .join(", ")} matche deja cette identite.`
                                  : selectedInboundMappingPreview?.reason ||
                                    "Choisis un user pour previsualiser le scope reel."}
                            </small>
                            <div className="button-row">
                              <button
                                type="button"
                                className="ghost-button"
                                onClick={() => void handleAttachInboundIdentityToUser()}
                                disabled={
                                  !selectedInboundMappingUser ||
                                  !normalizedInboundMappingIdentity ||
                                  selectedInboundMappingIdentityAlreadyPresent ||
                                  selectedInboundMappingConflictUsers.length > 0
                                }
                              >
                                Ajouter au user
                              </button>
                              <button
                                type="button"
                                className="ghost-button"
                                onClick={() =>
                                  selectedInboundMappingUser
                                    ? openUserEditorFromChat(selectedInboundMappingUser.id)
                                    : setView("users")
                                }
                              >
                                Ouvrir Users
                              </button>
                            </div>
                          </article>

                          <article className="selection-panel">
                            <div className="info-row compact">
                              <strong>Creer un user depuis ce bot</strong>
                              <StatusPill
                                status={selectedInboundNewUserPreview?.canUseAgent ? "active" : "paused"}
                              >
                                preview
                              </StatusPill>
                            </div>
                            <small className="muted-line">
                              Cree le user, rattache l'identite externe et definis directement les
                              equipes qui porteront l'acces.
                            </small>
                            <div className="form-grid">
                              <label>
                                Nom
                                <input
                                  className="input"
                                  value={inboundNewUserDraft.name}
                                  onChange={(event) =>
                                    setInboundNewUserDraft((current) => ({
                                      ...current,
                                      name: event.target.value,
                                    }))
                                  }
                                />
                              </label>
                              <label>
                                Email
                                <input
                                  className="input"
                                  value={inboundNewUserDraft.email}
                                  onChange={(event) =>
                                    setInboundNewUserDraft((current) => ({
                                      ...current,
                                      email: event.target.value,
                                    }))
                                  }
                                />
                              </label>
                              <label>
                                Role
                                <select
                                  className="select"
                                  value={inboundNewUserDraft.role}
                                  onChange={(event) =>
                                    setInboundNewUserDraft((current) => ({
                                      ...current,
                                      role: event.target.value as InboundUserDraft["role"],
                                    }))
                                  }
                                >
                                  <option value="admin">admin</option>
                                  <option value="operator">operator</option>
                                  <option value="member">member</option>
                                  <option value="viewer">viewer</option>
                                </select>
                              </label>
                              <label>
                                Status
                                <select
                                  className="select"
                                  value={inboundNewUserDraft.status}
                                  onChange={(event) =>
                                    setInboundNewUserDraft((current) => ({
                                      ...current,
                                      status: event.target.value as InboundUserDraft["status"],
                                    }))
                                  }
                                >
                                  <option value="active">active</option>
                                  <option value="invited">invited</option>
                                  <option value="disabled">disabled</option>
                                </select>
                              </label>
                            </div>
                            <EntityMultiSelector
                              title="Equipes"
                              detail="Le user heritera des agents et destinations portes par ces equipes."
                              selectedIds={inboundNewUserDraft.teamIds}
                              options={inboundNewUserTeamOptions}
                              onChange={(nextIds) =>
                                setInboundNewUserDraft((current) => ({
                                  ...current,
                                  teamIds: nextIds,
                                }))
                              }
                              emptyTitle="Aucune equipe visible"
                              emptyBody="Cree d'abord une equipe pour propager l'acces via le scope equipe."
                            />
                            {selectedInboundNewUserPreview ? (
                              <div className="detail-pairs compact-grid">
                                <span>Teams</span>
                                <span>
                                  {selectedInboundNewUserPreview.teamIds.map(teamName).join(", ") ||
                                    "aucune"}
                                </span>
                                <span>Equipes autorisantes</span>
                                <span>
                                  {selectedInboundNewUserPreview.authorizingTeamNames?.join(", ") ||
                                    "aucune"}
                                </span>
                                <span>Agents</span>
                                <span>
                                  {selectedInboundNewUserPreview.accessibleAgentIds
                                    .map(agentName)
                                    .join(", ") || "aucun"}
                                </span>
                                <span>Destinations</span>
                                <span>
                                  {selectedInboundNewUserPreview.accessibleChannelIds
                                    .map(channelName)
                                    .join(", ") || "aucune"}
                                </span>
                                <span>Acces cible</span>
                                <span>
                                  {selectedInboundNewUserPreview.canUseAgent
                                    ? "pret a parler a l'agent"
                                    : "encore bloque"}
                                </span>
                                <span>Canal courant</span>
                                <span>
                                  {selectedInboundNewUserPreview.canUseChannel
                                    ? "destination autorisee"
                                    : "destination non autorisee"}
                                </span>
                              </div>
                            ) : null}
                            <small className="muted-line">
                              {inboundIdentityConflictUsers.length
                                ? `Conflit: ${inboundIdentityConflictUsers
                                    .map((user) => user.name)
                                    .join(", ")} matche deja cette identite.`
                                : selectedInboundNewUserPreview?.reason ||
                                  "Le preview montre tout de suite si ce nouveau user pourra parler a l'agent."}
                            </small>
                            <div className="button-row">
                              <button
                                type="button"
                                className="ghost-button"
                                onClick={() => void handleCreateInboundUser()}
                                disabled={
                                  !normalizedInboundMappingIdentity ||
                                  inboundIdentityConflictUsers.length > 0
                                }
                              >
                                Creer et rattacher
                              </button>
                              <button
                                type="button"
                                className="ghost-button"
                                onClick={() =>
                                  seedUserEditorFromInboundIdentity(normalizedInboundMappingIdentity)
                                }
                                disabled={!normalizedInboundMappingIdentity}
                              >
                                Basculer dans Users
                              </button>
                            </div>
                          </article>
                        </div>
                      ) : (
                        <div className="button-row">
                          {selectedSessionInboundPrincipal?.userId ? (
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() =>
                                openUserEditorFromChat(selectedSessionInboundPrincipal.userId)
                              }
                            >
                              Modifier le user
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() => setView("users")}
                            >
                              Ouvrir Users
                            </button>
                          )}
                          {selectedSessionInboundPrincipal?.status === "resolved" &&
                          selectedSessionInboundPrincipal.userStatus !== "active" ? (
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() =>
                                void activateInboundUser(selectedSessionInboundPrincipal)
                              }
                            >
                              Activer le user
                            </button>
                          ) : null}
                          {selectedSessionInboundPrincipal?.status === "resolved" &&
                          selectedSessionInboundPrincipal.userRole === "viewer" ? (
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() =>
                                void promoteInboundUserFromViewer(selectedSessionInboundPrincipal)
                              }
                            >
                              Passer en member
                            </button>
                          ) : null}
                          {selectedSessionInboundPrincipal?.status === "resolved" &&
                          !selectedSessionInboundPrincipal.canUseChannel &&
                          selectedSessionInboundPrincipal.matchedChannelIds.length ? (
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() =>
                                void (
                                  getPreferredInboundTeam(selectedSessionInboundPrincipal)
                                    ? attachInboundResourcesToPreferredTeam(
                                        selectedSessionInboundPrincipal,
                                        "channel",
                                        selectedSessionInboundPrincipal.matchedChannelIds,
                                      )
                                    : grantInboundResources(
                                        selectedSessionInboundPrincipal,
                                        "channel",
                                        selectedSessionInboundPrincipal.matchedChannelIds,
                                      )
                                )
                              }
                            >
                              {getPreferredInboundTeam(selectedSessionInboundPrincipal)
                                ? `Ajouter destination a ${getPreferredInboundTeam(selectedSessionInboundPrincipal)?.name}`
                                : "Autoriser destination (grant)"}
                            </button>
                          ) : null}
                          {selectedSessionInboundPrincipal?.status === "resolved" &&
                          selectedSessionInboundPrincipal.canUseChannel &&
                          !selectedSessionInboundPrincipal.canUseAgent &&
                          selectedSessionInboundGrantAgentIds.length ? (
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() =>
                                void (
                                  getPreferredInboundTeam(selectedSessionInboundPrincipal)
                                    ? attachInboundResourcesToPreferredTeam(
                                        selectedSessionInboundPrincipal,
                                        "agent",
                                        selectedSessionInboundGrantAgentIds,
                                      )
                                    : grantInboundResources(
                                        selectedSessionInboundPrincipal,
                                        "agent",
                                        selectedSessionInboundGrantAgentIds,
                                      )
                                )
                              }
                            >
                              {getPreferredInboundTeam(selectedSessionInboundPrincipal)
                                ? `Ajouter agent a ${getPreferredInboundTeam(selectedSessionInboundPrincipal)?.name}`
                                : "Autoriser agent (grant)"}
                            </button>
                          ) : null}
                          {selectedSessionInboundPrincipal?.status === "resolved" &&
                          getPreferredInboundTeam(selectedSessionInboundPrincipal) &&
                          !selectedSessionInboundPrincipal.canUseChannel &&
                          selectedSessionInboundPrincipal.matchedChannelIds.length ? (
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() =>
                                void grantInboundResources(
                                  selectedSessionInboundPrincipal,
                                  "channel",
                                  selectedSessionInboundPrincipal.matchedChannelIds,
                                )
                              }
                            >
                              Forcer grant destination
                            </button>
                          ) : null}
                          {selectedSessionInboundPrincipal?.status === "resolved" &&
                          getPreferredInboundTeam(selectedSessionInboundPrincipal) &&
                          selectedSessionInboundPrincipal.canUseChannel &&
                          !selectedSessionInboundPrincipal.canUseAgent &&
                          selectedSessionInboundGrantAgentIds.length ? (
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() =>
                                void grantInboundResources(
                                  selectedSessionInboundPrincipal,
                                  "agent",
                                  selectedSessionInboundGrantAgentIds,
                                )
                              }
                            >
                              Forcer grant agent
                            </button>
                          ) : null}
                          {selectedSessionInboundPrincipal &&
                          inboundPrincipalNeedsRbacReview(selectedSessionInboundPrincipal) ? (
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() => setView("access")}
                            >
                              Ouvrir Teams & Access
                            </button>
                          ) : null}
                        </div>
                      )}
                    </details>
                  ) : null}

                  {currentUserCanManageAdminViews ? (
                    <details className="chat-advanced-panel">
                      <summary>
                        <span>Skill fence</span>
                        <small>Skills autorisees par provider runtime</small>
                      </summary>
                      <div className="selection-panel">
                        <div className="info-row compact">
                          <strong>Skill fence</strong>
                          <StatusPill status="active">
                            {modelProviderFromRef(selectedSessionEffectiveModelRef) || "inherit"}
                          </StatusPill>
                        </div>
                        <small className="muted-line">
                          Skills autorisees pour cette session:{" "}
                          {selectedSessionAllowedSkillLabels.join(", ") || "aucune"}
                        </small>
                      </div>
                    </details>
                  ) : null}
                </section>
              </>
              )
            ) : (
              <EmptyState
                title="Aucune session"
                body="Selectionne une session dans la colonne de gauche."
              />
            )}
          </section>
        </section>
      </section>
    );
  }

  function renderFiles() {
    return (
      <section className="panel-grid mission-layout">
        <section className="panel">
          <ResourceToolbar title="Files" detail="Artifacts produits par les agents" />
          <div className="form-grid slim">
            <label>
              Recherche
              <input
                className="input"
                value={fileSearch}
                onChange={(event) => setFileSearch(event.target.value)}
              />
            </label>
            <label>
              Agent
              <select
                className="select"
                value={fileAgentFilter}
                onChange={(event) => setFileAgentFilter(event.target.value)}
              >
                <option value="all">Tous</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Type
              <select
                className="select"
                value={fileTypeFilter}
                onChange={(event) => setFileTypeFilter(event.target.value)}
              >
                <option value="all">Tous</option>
                <option value="workspace">workspace</option>
                <option value="memory">memory</option>
                <option value="md">md</option>
                <option value="json">json</option>
              </select>
            </label>
          </div>
          <div className="list-grid scroll-column large">
            {filteredFiles.map((file) => (
              <button
                key={`${file.agentId}:${file.name}`}
                type="button"
                className={`session-card ${selectedFileKey === `${file.agentId}:${file.name}` ? "active" : ""}`}
                onClick={() => setSelectedFileKey(`${file.agentId}:${file.name}`)}
              >
                <div className="info-row compact">
                  <strong>{file.name}</strong>
                  <StatusPill status={file.type}>{file.type}</StatusPill>
                </div>
                <p>{file.path}</p>
                <small className="muted-line">
                  {file.agentId} · {formatBytes(file.size)} · {formatDateTime(file.updatedAtMs)}
                </small>
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <ResourceToolbar
            title="Preview"
            detail={selectedFile?.name || "Selectionne un fichier"}
          />
          {selectedFile ? (
            <>
              <div className="detail-pairs compact-grid">
                <span>Agent</span>
                <span>{selectedFile.agentId}</span>
                <span>Path</span>
                <code className="mono">{selectedFile.path}</code>
                <span>Updated</span>
                <span>{formatDateTime(selectedFile.updatedAtMs)}</span>
                <span>Size</span>
                <span>{formatBytes(selectedFile.size)}</span>
              </div>
              <pre className="code-block file-preview">
                <code>{fileContent[selectedFileKey] || "Chargement..."}</code>
              </pre>
            </>
          ) : (
            <EmptyState
              title="Aucun fichier"
              body="Selectionne un fichier pour voir son contenu."
            />
          )}
        </section>
      </section>
    );
  }

  function renderMemory() {
    return (
      <section className="stack">
        {renderMemoryEngineWorkbench()}

        <section className="panel-grid mission-layout">
          <section className="panel">
            <ResourceToolbar
              title="Memory Explorer"
              detail="Surface memoire et fichiers de cadrage"
            />
            <div className="form-grid slim">
              <label>
                Agent
                <select
                  className="select"
                  value={memoryAgentFilter}
                  onChange={(event) => setMemoryAgentFilter(event.target.value)}
                >
                  <option value="all">Tous</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="list-grid scroll-column">
              {filteredMemories.map((memory) => (
                <button
                  key={`${memory.agentId}:${memory.name}`}
                  type="button"
                  className={`session-card ${selectedMemoryKey === `${memory.agentId}:${memory.name}` ? "active" : ""}`}
                  onClick={() => setSelectedMemoryKey(`${memory.agentId}:${memory.name}`)}
                >
                  <div className="info-row compact">
                    <strong>{memory.name}</strong>
                    <StatusPill status="memory">memory</StatusPill>
                  </div>
                  <p>{memory.path}</p>
                  <small className="muted-line">
                    {memory.agentId} · {formatDateTime(memory.updatedAtMs)}
                  </small>
                </button>
              ))}
            </div>
          </section>

          <section className="panel">
            <ResourceToolbar
              title="Memory Content"
              detail={selectedMemory?.name || "Selectionne une surface"}
            />
            {selectedMemory ? (
              <pre className="code-block file-preview">
                <code>{fileContent[selectedMemoryKey] || "Chargement..."}</code>
              </pre>
            ) : (
              <EmptyState
                title="Aucune surface"
                body="Selectionne un fichier de memoire pour l'ouvrir."
              />
            )}
          </section>
        </section>
      </section>
    );
  }

  function renderWorkspaces() {
    return (
      <section className="panel">
        <ResourceToolbar title="Workspaces" detail="Isolation et etat des dossiers agent" />
        <div className="card-grid">
          {workspaces.map((workspace) => (
            <article key={workspace.agentId} className="entity-card">
              <div className="info-row compact">
                <strong>{workspace.agentId}</strong>
                <StatusPill status="workspace">workspace</StatusPill>
              </div>
              <p>{workspace.path}</p>
              <div className="detail-pairs">
                <span>Files</span>
                <span>{workspace.fileCount}</span>
                <span>Memory</span>
                <span>{workspace.memoryFileCount}</span>
                <span>Bootstrap</span>
                <span>{workspace.state.bootstrapSeededAt || "n/a"}</span>
                <span>Setup complete</span>
                <span>{workspace.state.setupCompletedAt || "non termine"}</span>
              </div>
            </article>
          ))}
        </div>
      </section>
    );
  }

  function renderSkills() {
    const precedence = skillsCatalog?.precedence || [];
    const hasSkills = visibleSkills.length > 0;
    const canDeleteSkill = Boolean(
      selectedSkillEntry && skillEditor.mode === "existing" && !skillEditorBusy,
    );
    const skillImportReady = Boolean(
      activeSkillLibrary &&
        (skillImportDraft.sourceType === "git"
          ? skillImportDraft.repoUrl.trim()
          : skillImportDraft.sourceType === "zip-url"
            ? skillImportDraft.archiveUrl.trim()
            : skillImportDraft.sourceType === "zip-upload"
              ? skillImportDraft.archiveBase64
              : skillImportDraft.dirName.trim() && skillImportDraft.content.trim()),
    );
    return (
      <section className="stack">
        <section className="panel">
          <ResourceToolbar title="Skills" detail="Gestion shared + par agent des dossiers SKILL.md">
            <button
              type="button"
              className="ghost-button"
              disabled={skillsLoading}
              onClick={() => setSkillsRefreshToken((current) => current + 1)}
            >
              {skillsLoading ? "Refresh..." : "Refresh skills"}
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={!activeSkillLibrary || skillEditorBusy === "save"}
              onClick={() => startNewSkillDraft()}
            >
              Nouveau skill
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={
                !activeSkillLibrary ||
                !skillEditor.dirName.trim() ||
                !skillEditor.content.trim() ||
                !skillEditorDirty ||
                Boolean(skillEditorBusy)
              }
              onClick={() => void handleSaveSkill()}
            >
              {skillEditorBusy === "save" ? "Sauvegarde..." : "Sauvegarder"}
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={!canDeleteSkill}
              onClick={() => void handleDeleteSelectedSkill()}
            >
              {skillEditorBusy === "delete" ? "Suppression..." : "Supprimer"}
            </button>
          </ResourceToolbar>
          {skillsError ? <div className="banner danger">{skillsError}</div> : null}
          <div className="callout provider-callout">
            <strong>Scopes reels du runtime</strong>
            <p>
              Le dashboard gere les skills partages dans <span className="mono">~/.openclaw/skills</span>{" "}
              et <span className="mono">~/.agents/skills</span>, plus les skills lies a chaque
              agent dans <span className="mono">workspace/skills</span> et{" "}
              <span className="mono">workspace/.agents/skills</span>.
            </p>
            <div className="runtime-model-meta-row">
              <span className="inline-tag">{skillLibraries.length} bibliotheque(s)</span>
              <span className="inline-tag">{skillsCatalog?.skills.length || 0} skill(s) geres</span>
              <span className="inline-tag">
                {snapshot?.skills.length || 0} skill(s) resolves par le runtime
              </span>
            </div>
            {precedence.length ? (
              <div className="skill-precedence-row">
                {precedence.map((entry) => (
                  <span key={entry} className="inline-tag">
                    {entry}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </section>

        <section className="skill-manager-shell">
          <section className="selection-panel skill-manager-sidebar">
            <div className="skill-scope-tabs">
              {(["shared", "agent"] as SkillManagerScope[]).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  className={`skill-scope-tab ${skillManagerScope === scope ? "selected" : ""}`}
                  onClick={() => setSkillManagerScope(scope)}
                >
                  {scope === "shared" ? "Shared" : "Par agent"}
                </button>
              ))}
            </div>

            {skillManagerScope === "agent" ? (
              <label className="input-stack">
                <span>Agent</span>
                <select
                  className="select"
                  value={selectedSkillAgentId}
                  onChange={(event) => setSelectedSkillAgentId(event.target.value)}
                >
                  {skillAgentOptions.map((option) => (
                    <option key={option.agentId} value={option.agentId}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="input-stack">
              <span>Bibliotheque</span>
              <select
                className="select"
                value={activeSkillLibrary?.id || ""}
                onChange={(event) => setSelectedSkillLibraryId(event.target.value)}
              >
                {activeSkillLibraries.map((library) => (
                  <option key={library.id} value={library.id}>
                    {library.label}
                  </option>
                ))}
              </select>
            </label>

            {activeSkillLibrary ? (
              <div className="agent-studio-note">
                <strong>{activeSkillLibrary.label}</strong>
                <p>{activeSkillLibrary.description}</p>
                <code className="mono">{activeSkillLibrary.rootPath}</code>
              </div>
            ) : (
              <EmptyState
                title="Aucune bibliotheque"
                body="Aucune bibliotheque de skills disponible pour ce scope."
              />
            )}

            {activeSkillLibrary ? (
              <details className="skill-import-panel" open>
                <summary>Importer des skills</summary>
                <p className="muted-line">
                  Accepte un repo git, un ZIP distant, un ZIP local ou un simple fichier{" "}
                  <span className="mono">SKILL.md</span>.
                </p>
                {skillImportError ? <div className="banner danger">{skillImportError}</div> : null}
                {skillImportWarnings.length ? (
                  <div className="banner">{skillImportWarnings.join(" · ")}</div>
                ) : null}
                <label className="input-stack">
                  <span>Source</span>
                  <select
                    className="select"
                    value={skillImportDraft.sourceType}
                    onChange={(event) =>
                      setSkillImportDraft((current) => ({
                        ...current,
                        sourceType: event.target.value as SkillImportSourceType,
                      }))
                    }
                  >
                    <option value="git">Repo git</option>
                    <option value="zip-url">ZIP distant</option>
                    <option value="zip-upload">ZIP local</option>
                    <option value="skill-md">SKILL.md brut</option>
                  </select>
                </label>

                {skillImportDraft.sourceType === "git" ? (
                  <>
                    <label className="input-stack">
                      <span>URL du repo</span>
                      <input
                        className="input mono"
                        value={skillImportDraft.repoUrl}
                        placeholder="https://github.com/org/repo.git"
                        onChange={(event) =>
                          setSkillImportDraft((current) => ({
                            ...current,
                            repoUrl: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <div className="form-grid">
                      <label className="input-stack">
                        <span>Ref optionnelle</span>
                        <input
                          className="input mono"
                          value={skillImportDraft.ref}
                          placeholder="main"
                          onChange={(event) =>
                            setSkillImportDraft((current) => ({
                              ...current,
                              ref: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label className="input-stack">
                        <span>Sous-dossier optionnel</span>
                        <input
                          className="input mono"
                          value={skillImportDraft.sourcePath}
                          placeholder="skills/my-skill"
                          onChange={(event) =>
                            setSkillImportDraft((current) => ({
                              ...current,
                              sourcePath: event.target.value,
                            }))
                          }
                        />
                      </label>
                    </div>
                  </>
                ) : null}

                {skillImportDraft.sourceType === "zip-url" ? (
                  <>
                    <label className="input-stack">
                      <span>URL de l’archive</span>
                      <input
                        className="input mono"
                        value={skillImportDraft.archiveUrl}
                        placeholder="https://example.com/skill-pack.zip"
                        onChange={(event) =>
                          setSkillImportDraft((current) => ({
                            ...current,
                            archiveUrl: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="input-stack">
                      <span>Sous-dossier optionnel</span>
                      <input
                        className="input mono"
                        value={skillImportDraft.sourcePath}
                        placeholder="skills/my-skill"
                        onChange={(event) =>
                          setSkillImportDraft((current) => ({
                            ...current,
                            sourcePath: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </>
                ) : null}

                {skillImportDraft.sourceType === "zip-upload" ? (
                  <>
                    <label className="input-stack">
                      <span>Archive locale</span>
                      <input
                        className="input"
                        type="file"
                        accept=".zip,application/zip"
                        onChange={(event) => void handleSelectSkillImportFile(event)}
                      />
                    </label>
                    {skillImportDraft.fileName ? (
                      <small className="muted-line">Fichier charge: {skillImportDraft.fileName}</small>
                    ) : null}
                    <label className="input-stack">
                      <span>Sous-dossier optionnel</span>
                      <input
                        className="input mono"
                        value={skillImportDraft.sourcePath}
                        placeholder="skills/my-skill"
                        onChange={(event) =>
                          setSkillImportDraft((current) => ({
                            ...current,
                            sourcePath: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </>
                ) : null}

                {skillImportDraft.sourceType === "skill-md" ? (
                  <>
                    <label className="input-stack">
                      <span>Dossier cible</span>
                      <input
                        className="input mono"
                        value={skillImportDraft.dirName}
                        placeholder="my-skill"
                        onChange={(event) =>
                          setSkillImportDraft((current) => ({
                            ...current,
                            dirName: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="input-stack">
                      <span>Contenu SKILL.md</span>
                      <textarea
                        className="textarea mono skill-import-textarea"
                        value={skillImportDraft.content}
                        placeholder="---&#10;name: my_skill&#10;description: ...&#10;---"
                        onChange={(event) =>
                          setSkillImportDraft((current) => ({
                            ...current,
                            content: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </>
                ) : null}

                <label className="skill-import-checkbox">
                  <input
                    type="checkbox"
                    checked={skillImportDraft.overwrite}
                    onChange={(event) =>
                      setSkillImportDraft((current) => ({
                        ...current,
                        overwrite: event.target.checked,
                      }))
                    }
                  />
                  <span>Ecraser un dossier existant si le nom collide</span>
                </label>

                <button
                  type="button"
                  className="ghost-button"
                  disabled={!skillImportReady || skillImportBusy}
                  onClick={() => void handleImportSkill()}
                >
                  {skillImportBusy ? "Import..." : "Importer dans cette bibliotheque"}
                </button>
              </details>
            ) : null}

            <div className="list-grid scroll-column skill-manager-list">
              {hasSkills ? (
                visibleSkills.map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    className={`session-card ${selectedSkillEntry?.id === skill.id ? "active" : ""}`}
                    onClick={() => setSelectedSkillEntryKey(skill.id)}
                  >
                    <div className="info-row compact">
                      <strong>{skill.name}</strong>
                      <StatusPill status={skill.disableModelInvocation ? "paused" : "active"}>
                        {skill.disableModelInvocation ? "manual" : "callable"}
                      </StatusPill>
                    </div>
                    <p>{skill.description || "Sans description pour l’instant."}</p>
                    <small className="muted-line">
                      {skill.dirName} · {formatDateTime(skill.updatedAtMs)}
                    </small>
                  </button>
                ))
              ) : (
                <EmptyState
                  title="Aucun skill"
                  body="Cette bibliotheque est vide. Cree un dossier de skill depuis le dashboard."
                />
              )}
            </div>
          </section>

          <section className="selection-panel skill-manager-editor">
            <div className="info-row compact">
              <strong>
                {skillEditor.mode === "new"
                  ? "Nouveau skill"
                  : selectedSkillEntry?.name || "Selectionne un skill"}
              </strong>
              <StatusPill status={skillEditorDirty ? "warning" : "active"}>
                {skillEditorDirty ? "modifie" : skillEditor.mode === "new" ? "draft" : "synchro"}
              </StatusPill>
            </div>
            {skillContentError ? <div className="banner danger">{skillContentError}</div> : null}
            {skillContentLoading ? (
              <EmptyState title="Chargement" body="Lecture du fichier SKILL.md en cours." />
            ) : activeSkillLibrary ? (
              <>
                <div className="detail-pairs compact-grid">
                  <span>Library</span>
                  <span>{activeSkillLibrary.label}</span>
                  <span>Source runtime</span>
                  <span>{selectedSkillEntry?.source || activeSkillLibrary.source}</span>
                  <span>Path</span>
                  <code className="mono">
                    {selectedSkillEntry?.filePath ||
                      `${activeSkillLibrary.rootPath}/${skillEditor.dirName || "<skill>"}/SKILL.md`}
                  </code>
                </div>

                <label className="input-stack">
                  <span>Dossier du skill</span>
                  <input
                    className="input mono"
                    value={skillEditor.dirName}
                    placeholder="my-skill"
                    onChange={(event) =>
                      setSkillEditor((current) => ({
                        ...current,
                        dirName: event.target.value,
                      }))
                    }
                  />
                </label>

                <label className="input-stack">
                  <span>SKILL.md</span>
                  <textarea
                    className="textarea skill-manager-textarea mono"
                    value={skillEditor.content}
                    placeholder="Contenu du skill..."
                    onChange={(event) =>
                      setSkillEditor((current) => ({
                        ...current,
                        content: event.target.value,
                      }))
                    }
                  />
                </label>

                <div className="agent-studio-note">
                  <strong>Comportement runtime</strong>
                  <p>
                    Les changements sont ecrits directement dans la bibliotheque choisie. OpenClaw
                    recharge ensuite ces skills via son watcher natif ou au prochain nouveau run.
                  </p>
                </div>
              </>
            ) : (
              <EmptyState
                title="Selection requise"
                body="Choisis un scope puis une bibliotheque pour editer ou creer un skill."
              />
            )}
          </section>
        </section>
      </section>
    );
  }

  function renderRuntime() {
    const normalizeComparableRuntimeLink = (draft: RuntimeLinkDraft) => ({
      backendRoot: draft.backendRoot.trim(),
      cliBin: draft.cliBin.trim(),
      runtimeDir: draft.runtimeDir.trim(),
      stateDir: draft.stateDir.trim(),
      workspaceDir: draft.workspaceDir.trim(),
      configPath: draft.configPath.trim(),
      gatewayPort: draft.gatewayPort.trim(),
      gatewayToken: draft.gatewayToken.trim(),
      gatewayUrl: draft.gatewayUrl.trim(),
      dashboardGatewayToken: draft.dashboardGatewayToken.trim(),
    });
    const serializeComparableRuntimeEnvRows = (rows: RuntimeEnvDraftRow[]) =>
      serializeRuntimeEnvDraftRows(rows).map((row) => ({
        key: row.key,
        value: row.value,
      }));
    const runtimeLinkDirty = runtimeLinkStatus
      ? JSON.stringify(normalizeComparableRuntimeLink(runtimeLinkDraft)) !==
        JSON.stringify(normalizeComparableRuntimeLink(runtimeLinkStatus.values))
      : false;
    const runtimeDirty = runtimeEnvStatus
      ? JSON.stringify({
          inlineFields: serializeComparableRuntimeEnvRows(runtimeEnvInlineRows),
          varsFields: serializeComparableRuntimeEnvRows(runtimeEnvVarsRows),
          shellEnvEnabled: runtimeShellEnvEnabled,
          shellEnvTimeoutMs: runtimeShellEnvTimeoutMs.trim(),
        }) !==
        JSON.stringify({
          inlineFields: runtimeEnvStatus.openClawEnv.inlineFields.map((field) => ({
            key: field.key,
            value: field.value,
          })),
          varsFields: runtimeEnvStatus.openClawEnv.varsFields.map((field) => ({
            key: field.key,
            value: field.value,
          })),
          shellEnvEnabled: runtimeEnvStatus.openClawEnv.shellEnvEnabled,
          shellEnvTimeoutMs: runtimeEnvStatus.openClawEnv.shellEnvTimeoutMs,
        })
      : false;
    const renderRuntimeLinkField = (
      label: string,
      key: keyof RuntimeLinkDraft,
      placeholder?: string,
      options?: {
        secret?: boolean;
        mono?: boolean;
        help?: string;
      },
    ) => (
      <label className={key === "backendRoot" || key === "configPath" ? "field-span-2 input-stack" : "input-stack"}>
        <span className="muted-line">{label}</span>
        <input
          className={`input ${(options?.mono ?? true) ? "mono" : ""}`.trim()}
          type={options?.secret ? "password" : "text"}
          value={runtimeLinkDraft[key]}
          placeholder={placeholder}
          onChange={(event) =>
            setRuntimeLinkDraft((current) => ({
              ...current,
              [key]: event.target.value,
            }))
          }
        />
        {options?.help ? <small className="muted-line">{options.help}</small> : null}
      </label>
    );
    const renderRuntimeEnvSection = (
      title: string,
      detail: string,
      rows: RuntimeEnvDraftRow[],
      setRows: Dispatch<SetStateAction<RuntimeEnvDraftRow[]>>,
      emptyLabel: string,
    ) => (
      <section className="selection-panel">
        <div className="info-row compact">
          <strong>{title}</strong>
          <button
            type="button"
            className="ghost-button"
            onClick={() =>
              setRows((current) => [
                ...current,
                {
                  id: createRuntimeEnvDraftId(),
                  key: "",
                  value: "",
                  secret: false,
                  redacted: false,
                },
              ])
            }
          >
            Ajouter
          </button>
        </div>
        <small className="muted-line">{detail}</small>
        <div className="runtime-env-list">
          {rows.length ? (
            rows.map((row) => (
              <article key={row.id} className="runtime-env-field">
                <div className="runtime-env-row">
                  <label className="input-stack">
                    <span className="muted-line">Variable</span>
                    <input
                      className="input mono"
                      type="text"
                      value={row.key}
                      placeholder="OPENAI_API_KEY"
                      onChange={(event) => {
                        const nextKey = event.target.value.toUpperCase().replace(/\s+/g, "");
                        setRows((current) =>
                          current.map((entry) =>
                            entry.id === row.id
                              ? {
                                  ...entry,
                                  key: nextKey,
                                  secret: looksSensitiveRuntimeEnvKey(nextKey),
                                }
                              : entry,
                          ),
                        );
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="ghost-button danger"
                    onClick={() =>
                      setRows((current) => current.filter((entry) => entry.id !== row.id))
                    }
                  >
                    Supprimer
                  </button>
                </div>
                <label className="input-stack">
                  <span className="muted-line">Valeur</span>
                  <input
                    className="input mono"
                    type={row.secret ? "password" : "text"}
                    value={row.value}
                    placeholder={
                      row.redacted
                        ? "Secret deja configure. Laisser vide pour conserver."
                        : "Valeur"
                    }
                    onChange={(event) =>
                      setRows((current) =>
                        current.map((entry) =>
                          entry.id === row.id
                            ? {
                                ...entry,
                                value: event.target.value,
                              }
                            : entry,
                        ),
                      )
                    }
                  />
                </label>
                {row.redacted ? (
                  <small className="muted-line">
                    Valeur masquee par OpenClaw. Laisser vide pour la conserver, ou saisis une
                    nouvelle valeur pour la remplacer.
                  </small>
                ) : null}
              </article>
            ))
          ) : (
            <div className="agent-studio-note">
              <strong>{emptyLabel}</strong>
              <p>Aucune variable explicite dans cette section pour l’instant.</p>
            </div>
          )}
        </div>
      </section>
    );

    return (
      <section className="stack">
        <section className="panel">
          <ResourceToolbar
            title="Runtime Link"
            detail="Liaison Elytras -> installation OpenClaw et backend cible"
          >
            <button
              type="button"
              className="ghost-button"
              disabled={runtimeLinkLoading}
              onClick={() => setRuntimeLinkRefreshToken((current) => current + 1)}
            >
              {runtimeLinkLoading ? "Refresh..." : "Refresh link"}
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={!runtimeLinkStatus}
              onClick={() =>
                runtimeLinkStatus &&
                setRuntimeLinkDraft(createRuntimeLinkDraft(runtimeLinkStatus.presets.linkedOpenClaw))
              }
            >
              Utiliser ~/.openclaw
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={!runtimeLinkStatus}
              onClick={() =>
                runtimeLinkStatus &&
                setRuntimeLinkDraft(
                  createRuntimeLinkDraft(runtimeLinkStatus.presets.isolatedControlTower),
                )
              }
            >
              Utiliser runtime Elytras
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={runtimeLinkSaving || runtimeEnvRestarting}
              onClick={() => void handleSaveRuntimeLink(false)}
            >
              {runtimeLinkSaving && !runtimeEnvRestarting ? "Save..." : "Sauvegarder la liaison"}
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={runtimeLinkSaving || runtimeEnvRestarting}
              onClick={() => void handleSaveRuntimeLink(true)}
            >
              {runtimeLinkSaving && runtimeEnvRestarting
                ? "Save + restart..."
                : "Sauvegarder + relancer"}
            </button>
          </ResourceToolbar>

          {runtimeLinkError ? <div className="banner danger">{runtimeLinkError}</div> : null}

          {runtimeLinkLoading && !runtimeLinkStatus ? (
            <EmptyState
              title="Lecture de la liaison runtime"
              body="Le dashboard lit `.env.local` pour savoir a quelle installation OpenClaw Elytras est rattache."
            />
          ) : runtimeLinkStatus ? (
            <>
              <div className="metrics-grid provider-metrics">
                <MetricCard
                  label="Env file"
                  value={runtimeLinkStatus.envFileExists ? ".env.local" : "absent"}
                  detail={runtimeLinkStatus.envFilePath}
                />
                <MetricCard
                  label="Backend root"
                  value={runtimeLinkStatus.checks.backendEntrypointExists ? "linked" : "missing"}
                  detail={runtimeLinkStatus.values.backendRoot}
                />
                <MetricCard
                  label="Config runtime"
                  value={runtimeLinkStatus.checks.configExists ? "ready" : "missing"}
                  detail={runtimeLinkStatus.values.configPath}
                />
                <MetricCard
                  label="Mode"
                  value={
                    runtimeLinkStatus.checks.usingIsolatedRuntime ? "isole Elytras" : "installe OpenClaw"
                  }
                  detail={runtimeLinkStatus.values.stateDir}
                />
              </div>

              <div className="callout provider-callout">
                <strong>Deux couches distinctes</strong>
                <p>
                  Cette carte edite la liaison Elytras vers une installation OpenClaw via{" "}
                  <span className="mono">.env.local</span>. Le bloc plus bas continue a editer le{" "}
                  <span className="mono">env</span> natif de la config OpenClaw cible.
                </p>
              </div>

              <div className="runtime-link-grid">
                <section className="selection-panel">
                  <div className="info-row compact">
                    <strong>Variables de rattachement</strong>
                    <StatusPill status={runtimeLinkDirty ? "warning" : "active"}>
                      {runtimeLinkDirty ? "modifie" : "synchro"}
                    </StatusPill>
                  </div>
                  <div className="form-grid">
                    {renderRuntimeLinkField(
                      "Backend root",
                      "backendRoot",
                      runtimeLinkStatus.detected.backendRoot,
                      {
                        help: "Checkout ou installation OpenClaw contenant openclaw.mjs.",
                      },
                    )}
                    {renderRuntimeLinkField("CLI bin", "cliBin", "openclaw", {
                      help: "Laisse vide pour utiliser `openclaw` ou `node openclaw.mjs`.",
                    })}
                    {renderRuntimeLinkField(
                      "Runtime dir",
                      "runtimeDir",
                      runtimeLinkStatus.presets.isolatedControlTower.runtimeDir,
                    )}
                    {renderRuntimeLinkField(
                      "Config path",
                      "configPath",
                      runtimeLinkStatus.detected.openClawHomeConfigPath,
                    )}
                    {renderRuntimeLinkField(
                      "State dir",
                      "stateDir",
                      runtimeLinkStatus.detected.openClawHomeStateDir,
                    )}
                    {renderRuntimeLinkField(
                      "Workspace dir",
                      "workspaceDir",
                      runtimeLinkStatus.detected.openClawHomeWorkspaceDir,
                    )}
                    {renderRuntimeLinkField("Gateway port", "gatewayPort", "18789")}
                    {renderRuntimeLinkField("Gateway URL", "gatewayUrl", "http://127.0.0.1:18789")}
                    {renderRuntimeLinkField(
                      "Gateway token runtime",
                      "gatewayToken",
                      "openclaw-local-token",
                      { secret: true },
                    )}
                    {renderRuntimeLinkField(
                      "Gateway token dashboard",
                      "dashboardGatewayToken",
                      "openclaw-local-token",
                      { secret: true },
                    )}
                  </div>
                </section>

                <section className="selection-panel">
                  <div className="info-row compact">
                    <strong>Checks de liaison</strong>
                    <StatusPill
                      status={
                        runtimeLinkStatus.checks.backendEntrypointExists &&
                        runtimeLinkStatus.checks.configExists
                          ? "active"
                          : "warning"
                      }
                    >
                      {runtimeLinkStatus.checks.backendEntrypointExists &&
                      runtimeLinkStatus.checks.configExists
                        ? "pret"
                        : "a verifier"}
                    </StatusPill>
                  </div>
                  <div className="runtime-link-checks">
                    <div className="runtime-link-check">
                      <span>Entrypoint OpenClaw</span>
                      <StatusPill status={runtimeLinkStatus.checks.backendEntrypointExists ? "active" : "failed"}>
                        {runtimeLinkStatus.checks.backendEntrypointExists ? "ok" : "missing"}
                      </StatusPill>
                    </div>
                    <div className="runtime-link-check">
                      <span>CLI resolvable</span>
                      <StatusPill status={runtimeLinkStatus.checks.cliResolvable ? "active" : "warning"}>
                        {runtimeLinkStatus.checks.cliResolvable ? "ok" : "fallback"}
                      </StatusPill>
                    </div>
                    <div className="runtime-link-check">
                      <span>Config path</span>
                      <StatusPill status={runtimeLinkStatus.checks.configExists ? "active" : "failed"}>
                        {runtimeLinkStatus.checks.configExists ? "ok" : "missing"}
                      </StatusPill>
                    </div>
                    <div className="runtime-link-check">
                      <span>State dir</span>
                      <StatusPill status={runtimeLinkStatus.checks.stateDirExists ? "active" : "warning"}>
                        {runtimeLinkStatus.checks.stateDirExists ? "ok" : "missing"}
                      </StatusPill>
                    </div>
                    <div className="runtime-link-check">
                      <span>Workspace dir</span>
                      <StatusPill status={runtimeLinkStatus.checks.workspaceDirExists ? "active" : "warning"}>
                        {runtimeLinkStatus.checks.workspaceDirExists ? "ok" : "missing"}
                      </StatusPill>
                    </div>
                    <div className="runtime-link-check">
                      <span>Preset ~/.openclaw</span>
                      <StatusPill
                        status={runtimeLinkStatus.checks.linkedOpenClawConfigExists ? "active" : "paused"}
                      >
                        {runtimeLinkStatus.checks.linkedOpenClawConfigExists ? "detecte" : "absent"}
                      </StatusPill>
                    </div>
                  </div>
                  <div className="agent-studio-note">
                    <strong>Usage recommande</strong>
                    <p>
                      Si tu veux piloter une vraie install locale, utilise le preset{" "}
                      <span className="mono">~/.openclaw</span>. Si tu veux un runtime jetable pour
                      tester sans toucher ton install, repasse sur le preset runtime Elytras.
                    </p>
                  </div>
                </section>
              </div>
            </>
          ) : null}
        </section>

        <section className="panel">
          <ResourceToolbar
            title="Runtime"
            detail="Edition native du bloc env pour le backend OpenClaw local"
          >
            <button
              type="button"
              className="ghost-button"
              disabled={runtimeEnvLoading}
              onClick={() => setRuntimeEnvRefreshToken((current) => current + 1)}
            >
              {runtimeEnvLoading ? "Refresh..." : "Refresh runtime"}
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={runtimeEnvSaving || runtimeEnvRestarting}
              onClick={() => void handleSaveRuntimeEnv(false)}
            >
              {runtimeEnvSaving && !runtimeEnvRestarting ? "Save..." : "Sauvegarder"}
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={runtimeEnvSaving || runtimeEnvRestarting}
              onClick={() => void handleSaveRuntimeEnv(true)}
            >
              {runtimeEnvSaving && runtimeEnvRestarting
                ? "Save + restart..."
                : "Sauvegarder + relancer"}
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={runtimeEnvRestarting}
              onClick={() => void handleRestartRuntimeBackendOnly()}
            >
              {runtimeEnvRestarting ? "Restart..." : "Relancer backend"}
            </button>
          </ResourceToolbar>

          {runtimeEnvError ? <div className="banner danger">{runtimeEnvError}</div> : null}

          {runtimeEnvLoading && !runtimeEnvStatus ? (
            <EmptyState
              title="Lecture du bloc env"
              body="Le dashboard lit la config OpenClaw locale, extrait le bloc env et probe le backend si disponible."
            />
          ) : runtimeEnvStatus ? (
            <>
              <div className="metrics-grid provider-metrics">
                <MetricCard
                  label="Config"
                  value={runtimeEnvStatus.openClawEnv.configPath}
                  detail="Source de verite OpenClaw"
                />
                <MetricCard
                  label="Backend"
                  value={runtimeEnvStatus.backendHealthy ? "healthy" : "down"}
                  detail={runtimeEnvStatus.gatewayUrl}
                />
                <MetricCard
                  label="Runtime dir"
                  value={runtimeEnvStatus.effective.runtimeDir}
                  detail={runtimeEnvStatus.effective.stateDir}
                />
                <MetricCard
                  label="Source order"
                  value={runtimeEnvStatus.openClawEnv.sourceOrder.join(" -> ")}
                  detail="Priorite native OpenClaw"
                />
              </div>

              <div className="callout provider-callout">
                <strong>Source de verite native</strong>
                <p>
                  Cette vue edite le bloc <span className="mono">env</span> de la config OpenClaw
                  locale. Elle respecte la semantique native documentee pour{" "}
                  <span className="mono">env.KEY</span>, <span className="mono">env.vars</span>,{" "}
                  <span className="mono">env.shellEnv</span> et la substitution{" "}
                  <span className="mono">${"{VAR}"}</span>.
                </p>
                <p>
                  <a href={runtimeEnvStatus.docsUrl} target="_blank" rel="noreferrer">
                    Voir la reference OpenClaw
                  </a>
                </p>
              </div>
            </>
          ) : null}
        </section>

        {runtimeEnvStatus ? (
          <section className="panel runtime-env-shell">
            <div className="runtime-env-grid">
              {renderRuntimeEnvSection(
                "env inline",
                "Equivalent direct a `env.OPENAI_API_KEY = ...` dans la config.",
                runtimeEnvInlineRows,
                setRuntimeEnvInlineRows,
                "Inline env vide",
              )}
              {renderRuntimeEnvSection(
                "env.vars",
                "Equivalent a `env: { vars: { OPENAI_API_KEY: ... } }`.",
                runtimeEnvVarsRows,
                setRuntimeEnvVarsRows,
                "env.vars vide",
              )}

              <section className="selection-panel">
                <div className="info-row compact">
                  <strong>shellEnv</strong>
                  <StatusPill status={runtimeShellEnvEnabled ? "active" : "paused"}>
                    {runtimeShellEnvEnabled ? "enabled" : "disabled"}
                  </StatusPill>
                </div>
                <small className="muted-line">
                  Import optionnel des variables manquantes depuis le shell de login OpenClaw.
                </small>
                <label className="checkbox-row runtime-env-checkbox">
                  <input
                    type="checkbox"
                    checked={runtimeShellEnvEnabled}
                    onChange={(event) => setRuntimeShellEnvEnabled(event.target.checked)}
                  />
                  <span>Activer env.shellEnv.enabled</span>
                </label>
                <label className="input-stack">
                  <span className="muted-line">timeoutMs</span>
                  <input
                    className="input mono"
                    type="text"
                    inputMode="numeric"
                    value={runtimeShellEnvTimeoutMs}
                    placeholder="15000"
                    onChange={(event) => setRuntimeShellEnvTimeoutMs(event.target.value)}
                  />
                </label>
                <small className="muted-line">
                  Laisse vide pour ne pas ecrire de timeout explicite dans la config.
                </small>
              </section>

              <section className="selection-panel">
                <div className="info-row compact">
                  <strong>Etat effectif</strong>
                  <StatusPill status={runtimeEnvStatus.backendHealthy ? "active" : "failed"}>
                    {runtimeEnvStatus.backendHealthy ? "backend ok" : "backend down"}
                  </StatusPill>
                </div>
                <div className="detail-pairs compact-grid">
                  <span>Gateway URL</span>
                  <code className="mono">{runtimeEnvStatus.gatewayUrl}</code>
                  <span>Gateway token</span>
                  <code className="mono">{runtimeEnvStatus.gatewayToken}</code>
                  <span>Backend root</span>
                  <code className="mono">{runtimeEnvStatus.effective.backendRoot}</code>
                  <span>CLI bin</span>
                  <code className="mono">{runtimeEnvStatus.effective.cliBin || "node openclaw.mjs"}</code>
                  <span>Workspace dir</span>
                  <code className="mono">{runtimeEnvStatus.effective.workspaceDir}</code>
                  <span>State dir</span>
                  <code className="mono">{runtimeEnvStatus.effective.stateDir}</code>
                  <span>Config path</span>
                  <code className="mono">{runtimeEnvStatus.openClawEnv.configPath}</code>
                  <span>Start script</span>
                  <code className="mono">{runtimeEnvStatus.startScriptPath}</code>
                  <span>Backend log</span>
                  <code className="mono">{runtimeEnvStatus.backendLogPath}</code>
                </div>
                <div className="agent-studio-note">
                  <strong>Mode d’application</strong>
                  <p>
                    `Sauvegarder` ecrit seulement la config locale. `Sauvegarder + relancer`
                    reapplique la config au backend local tout de suite. Les variables de boot du
                    wrapper Elytras restent separees: ici tu pilotes uniquement le mecanisme natif
                    OpenClaw.
                  </p>
                </div>
                {runtimeDirty ? (
                  <div className="banner">Des changements locaux ne sont pas encore sauvegardes.</div>
                ) : null}
              </section>
            </div>
          </section>
        ) : null}
      </section>
    );
  }

  function renderProviders() {
    const cliproxyAuthFiles = cliproxyStatus?.authFiles || [];
    const cliproxyAuthByProvider = Array.from(
      cliproxyAuthFiles.reduce((map, entry) => {
        const bucket = map.get(entry.provider) || [];
        bucket.push(entry);
        map.set(entry.provider, bucket);
        return map;
      }, new Map<string, typeof cliproxyAuthFiles>()),
    ).toSorted(([left], [right]) => left.localeCompare(right));
    const cliproxyManagedProviders = summarizeCliproxyManagedProviders(cliproxyStatus);
    const cliproxyQuotaWindows = cliproxyAuthFiles.reduce(
      (sum, account) => sum + (account.usage?.windows.length || 0),
      0,
    );
    const cliproxyApiKeyPools = [
      {
        id: "gemini-api-key" as const,
        label: "Gemini API keys",
        editorKey: "geminiApiKeys" as const,
        value: cliproxyStatus?.geminiApiKeys || [],
      },
      {
        id: "codex-api-key" as const,
        label: "Codex API keys",
        editorKey: "codexApiKeys" as const,
        value: cliproxyStatus?.codexApiKeys || [],
      },
      {
        id: "claude-api-key" as const,
        label: "Claude API keys",
        editorKey: "claudeApiKeys" as const,
        value: cliproxyStatus?.claudeApiKeys || [],
      },
    ];
    const cliproxyOauthActions = [
      { id: "anthropic", label: "Anthropic OAuth" },
      { id: "codex", label: "Codex OAuth" },
      { id: "gemini-cli", label: "Gemini OAuth" },
      { id: "antigravity", label: "Antigravity OAuth" },
      { id: "qwen", label: "Qwen OAuth" },
      { id: "iflow", label: "iFlow OAuth" },
    ];
    const providerTabs = [
      {
        id: "overview" as const,
        label: "Vue d’ensemble",
        detail: "Etat runtime, quotas et prochaines actions",
      },
      {
        id: "connect" as const,
        label: "Connecter",
        detail: "Ajouter un compte OAuth rapidement",
      },
      {
        id: "accounts" as const,
        label: "Comptes",
        detail: "Voir les comptes, leur statut et leur quota",
      },
      {
        id: "models" as const,
        label: "Modeles",
        detail: "Explorer le catalogue actif",
      },
      {
        id: "settings" as const,
        label: "Reglages",
        detail: "Cles, upstreams et options avancees",
      },
    ];
    const cliproxyAuthDetail =
      cliproxyStatus?.authFilesSource === "project-auth-dir"
        ? "Comptes OAuth detectes dans le dossier auths local du projet."
        : "Connexions OAuth detectees via l’API d’administration du runtime providers.";
    const cliproxyRuntimeModelsDetail =
      cliproxyStatus?.modelsSource === "bridge"
        ? "Fallback sur les modeles actifs importes dans OpenClaw tant que `/v1/models` reste vide."
        : "Catalogue `/v1/models` actuellement expose par le runtime providers.";
    const filteredModels = (cliproxyStatus?.models || []).filter((model) =>
      providerModelQuery.trim()
        ? [
            model.id,
            model.label,
            model.providerId,
            model.family,
            model.description,
            model.category,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(providerModelQuery.trim().toLowerCase())
        : true,
    );
    const filteredAuthByProvider = cliproxyAuthByProvider
      .map(([providerId, accounts]) => [
        providerId,
        accounts.filter((account) =>
          providerAccountQuery.trim()
            ? [
                providerId,
                account.label,
                account.name,
                account.email,
                account.account,
                account.accountType,
                account.status,
                account.statusMessage,
              ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase()
                .includes(providerAccountQuery.trim().toLowerCase())
            : true,
        ),
      ] as const)
      .filter(([, accounts]) => accounts.length > 0);
    const accountsWithUsage = cliproxyAuthFiles
      .filter((account) => account.usage?.windows.length)
      .map((account) => {
        const windows = account.usage?.windows || [];
        const shortWindow = findQuotaWindow(windows, "5h");
        const weeklyWindow = findQuotaWindow(windows, "weekly");
        const primaryWindow = shortWindow || weeklyWindow || windows[0];
        const remainingPercent = remainingPercentFromUsed(primaryWindow?.usedPercent);
        return {
          account,
          remainingPercent,
          providerLabel: cliproxyProviderLabel(account.provider),
          shortWindow,
          weeklyWindow,
        };
      })
      .toSorted((left, right) => left.remainingPercent - right.remainingPercent)
      .slice(0, 4);
    const mostCriticalShortWindow = accountsWithUsage
      .filter((entry) => entry.shortWindow)
      .toSorted(
        (left, right) =>
          remainingPercentFromUsed(left.shortWindow?.usedPercent) -
          remainingPercentFromUsed(right.shortWindow?.usedPercent),
      )[0];
    const mostCriticalWeeklyWindow = accountsWithUsage
      .filter((entry) => entry.weeklyWindow)
      .toSorted(
        (left, right) =>
          remainingPercentFromUsed(left.weeklyWindow?.usedPercent) -
          remainingPercentFromUsed(right.weeklyWindow?.usedPercent),
      )[0];
    const providerRuntimeHealthy = Boolean(cliproxyStatus?.available);
    const managementReady = Boolean(cliproxyStatus?.managementConfigured);
    const activeAccountCount = cliproxyAuthFiles.filter((entry) => entry.status === "ok").length;
    const providerSummaryItems = [
      {
        label: "Runtime",
        value: providerRuntimeHealthy ? "actif" : "hors ligne",
        detail: providerRuntimeHealthy ? "Catalogue expose au dashboard." : "Le runtime ne repond pas.",
      },
      {
        label: "Comptes actifs",
        value: String(activeAccountCount),
        detail: `${cliproxyAuthFiles.length} compte(s) OAuth au total.`,
      },
      {
        label: "Modeles",
        value: String(cliproxyStatus?.models.length || 0),
        detail: cliproxyRuntimeModelsDetail,
      },
      {
        label: "5h critique",
        value: mostCriticalShortWindow
          ? `${remainingPercentFromUsed(mostCriticalShortWindow.shortWindow?.usedPercent)}%`
          : "n/a",
        detail: mostCriticalShortWindow
          ? `${mostCriticalShortWindow.providerLabel} · ${mostCriticalShortWindow.account.label || mostCriticalShortWindow.account.name}`
          : "Aucune fenetre 5h remontee.",
      },
      {
        label: "Hebdo critique",
        value: mostCriticalWeeklyWindow
          ? `${remainingPercentFromUsed(mostCriticalWeeklyWindow.weeklyWindow?.usedPercent)}%`
          : "n/a",
        detail: mostCriticalWeeklyWindow
          ? `${mostCriticalWeeklyWindow.providerLabel} · ${mostCriticalWeeklyWindow.account.label || mostCriticalWeeklyWindow.account.name}`
          : "Aucune fenetre de quota remontee.",
      },
    ];

    return (
      <section className="stack provider-shell">
        <section className="panel provider-hero-panel">
          <div className="provider-hero">
            <div className="provider-hero-copy">
              <span className="eyebrow">Providers</span>
              <h3>Connecte tes comptes, surveille les quotas, choisis les modeles.</h3>
              <p>
                Cette page ne montre que les donnees utiles au runtime: comptes actifs, disponibilite
                des quotas et catalogue reellement exploitable par les chats, agents et pipelines.
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setCliproxyRefreshToken((current) => current + 1)}
                >
                  {cliproxyLoading ? "Refresh..." : "Refresh providers"}
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setProviderWorkspaceTab("connect")}
                >
                  Ajouter un compte
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => window.open(PROVIDERS_DOCS_URL, "_blank")}
                >
                  Docs providers
                </button>
              </div>
            </div>
            <div className="provider-hero-status">
              {providerSummaryItems.map((item) => (
                <article key={item.label} className="provider-summary-card">
                  <small>{item.label}</small>
                  <strong>{item.value}</strong>
                  <span>{item.detail}</span>
                </article>
              ))}
            </div>
          </div>
          {cliproxyError ? <div className="banner danger">{cliproxyError}</div> : null}
          {cliproxyStatus?.warnings.length ? (
            <div className="banner">{cliproxyStatus.warnings.join(" · ")}</div>
          ) : null}
        </section>

        <section className="panel">
          <div className="agent-studio-tabs provider-page-tabs">
            {providerTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`agent-studio-tab ${providerWorkspaceTab === tab.id ? "active" : ""}`}
                onClick={() => setProviderWorkspaceTab(tab.id)}
              >
                <strong>{tab.label}</strong>
                <small>{tab.detail}</small>
              </button>
            ))}
          </div>
        </section>

        {!cliproxyStatus ? (
          <section className="panel">
            <EmptyState
              title={cliproxyLoading ? "Chargement" : "Providers indisponibles"}
              body="Le dashboard attend l’inventaire management du runtime providers."
            />
          </section>
        ) : null}

        {cliproxyStatus && providerWorkspaceTab === "overview" ? (
          <section className="provider-overview-grid">
            <section className="panel">
              <div className="info-row compact">
                <strong>Etat actuel</strong>
                <StatusPill status={providerRuntimeHealthy ? "active" : "failed"}>
                  {providerRuntimeHealthy ? "runtime actif" : "runtime indisponible"}
                </StatusPill>
              </div>
              <div className="provider-overview-list">
                <article className="provider-overview-row">
                  <span>Comptes OAuth</span>
                  <strong>{cliproxyAuthFiles.length}</strong>
                </article>
                <article className="provider-overview-row">
                  <span>Sources actives</span>
                  <strong>{cliproxyManagedProviders.length}</strong>
                </article>
                <article className="provider-overview-row">
                  <span>Modeles exposes</span>
                  <strong>{cliproxyStatus.models.length}</strong>
                </article>
                <article className="provider-overview-row">
                  <span>Acces admin</span>
                  <strong>{managementReady ? "ready" : "missing"}</strong>
                </article>
              </div>
              <small className="muted-line">{cliproxyAuthDetail}</small>
            </section>

            <section className="panel">
              <div className="info-row compact">
                <strong>Actions rapides</strong>
                <small className="muted-line">Les operations les plus frequentes.</small>
              </div>
              <div className="provider-quick-actions">
                {cliproxyOauthActions.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="ghost-button"
                    disabled={!managementReady || cliproxyOauthBusy === entry.id}
                    onClick={() => {
                      setProviderWorkspaceTab("connect");
                      void handleStartCliproxyOauth(entry.id);
                    }}
                  >
                    {cliproxyOauthBusy === entry.id ? "OAuth..." : entry.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="ghost-button"
                  disabled={cliproxySectionBusy === "import-openclaw-auth"}
                  onClick={() => void handleImportCliproxyOpenClawAuth()}
                >
                  {cliproxySectionBusy === "import-openclaw-auth"
                    ? "Import..."
                    : "Importer comptes OpenClaw"}
                </button>
              </div>
            </section>

            <section className="panel provider-overview-span">
              <div className="info-row compact">
                <strong>Comptes a surveiller</strong>
                <small className="muted-line">
                  Les comptes les plus proches de leur limite actuelle.
                </small>
              </div>
              {accountsWithUsage.length ? (
                <div className="provider-critical-list">
                  {accountsWithUsage.map(
                    ({ account, remainingPercent, providerLabel, shortWindow, weeklyWindow }) => (
                    <article key={account.id} className="provider-critical-card">
                      <div className="info-row compact">
                        <strong>{account.label || account.name}</strong>
                        <StatusPill
                          status={
                            remainingPercent <= 10
                              ? "failed"
                              : remainingPercent <= 30
                                ? "running"
                                : "active"
                          }
                        >
                          {remainingPercent}% restant
                        </StatusPill>
                      </div>
                      <small className="muted-line">
                        {providerLabel} · {account.email || account.account || account.accountType || "oauth"}
                      </small>
                      <div className="provider-critical-windows">
                        {shortWindow ? (
                          <div className="provider-critical-window">
                            <div className="info-row compact">
                              <span>{shortWindow.label}</span>
                              <strong>
                                {remainingPercentFromUsed(shortWindow.usedPercent)}% restant
                              </strong>
                            </div>
                            <div className="provider-usage-meter" aria-hidden="true">
                              <span
                                style={{
                                  width: `${remainingPercentFromUsed(shortWindow.usedPercent)}%`,
                                }}
                              />
                            </div>
                          </div>
                        ) : null}
                        {weeklyWindow ? (
                          <div className="provider-critical-window">
                            <div className="info-row compact">
                              <span>{weeklyWindow.label}</span>
                              <strong>
                                {remainingPercentFromUsed(weeklyWindow.usedPercent)}% restant
                              </strong>
                            </div>
                            <div className="provider-usage-meter" aria-hidden="true">
                              <span
                                style={{
                                  width: `${remainingPercentFromUsed(weeklyWindow.usedPercent)}%`,
                                }}
                              />
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </article>
                    ),
                  )}
                </div>
              ) : (
                <EmptyState
                  title="Aucun quota detaille"
                  body="Les fenetres de quota apparaitront ici des qu’un compte remontera ses stats."
                />
              )}
            </section>
          </section>
        ) : null}

        {cliproxyStatus && providerWorkspaceTab === "connect" ? (
          <section className="provider-connect-grid">
            <section className="panel">
              <div className="info-row compact">
                <strong>Ajouter un compte OAuth</strong>
                <small className="muted-line">
                  Lance le flow, puis colle l’URL de retour pour finaliser.
                </small>
              </div>
              <div className="provider-quick-actions">
                {cliproxyOauthActions.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="ghost-button"
                    disabled={!managementReady || cliproxyOauthBusy === entry.id}
                    onClick={() => void handleStartCliproxyOauth(entry.id)}
                  >
                    {cliproxyOauthBusy === entry.id ? "OAuth..." : entry.label}
                  </button>
                ))}
              </div>
              {!managementReady ? (
                <div className="banner">Ajoute d’abord une cle d’administration dans Reglages.</div>
              ) : null}
            </section>

            <section className="panel">
              {cliproxyOauthDraft ? (
                <div className="provider-oauth-flow">
                  <div className="info-row compact">
                    <strong>Confirmer l’URL de retour</strong>
                    <StatusPill
                      status={cliproxyOauthDraft.submitStatus === "submitted" ? "running" : "paused"}
                    >
                      {cliproxyOauthDraft.label}
                    </StatusPill>
                  </div>
                  <ol className="provider-steps-list">
                    <li>Ouvre la connexion OAuth.</li>
                    <li>Termine l’authentification dans l’onglet externe.</li>
                    <li>Colle ici l’URL complete de retour.</li>
                  </ol>
                  <small className="muted-line mono">state {cliproxyOauthDraft.state}</small>
                  <textarea
                    className="input textarea"
                    rows={4}
                    placeholder="Colle ici l’URL complete de retour apres la connexion OAuth"
                    value={cliproxyOauthDraft.redirectUrl}
                    onChange={(event) =>
                      setCliproxyOauthDraft((current) =>
                        current
                          ? {
                              ...current,
                              redirectUrl: event.target.value,
                              submitError: "",
                            }
                          : current,
                      )
                    }
                  />
                  {cliproxyOauthDraft.submitError ? (
                    <div className="banner danger">{cliproxyOauthDraft.submitError}</div>
                  ) : null}
                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => window.open(cliproxyOauthDraft.url, "_blank")}
                    >
                      Rouvrir OAuth
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => cancelCliproxyOauthFlow()}
                    >
                      Annuler
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={cliproxyOauthBusy === cliproxyOauthDraft.provider}
                      onClick={() => void handleSubmitCliproxyOauthCallback()}
                    >
                      {cliproxyOauthBusy === cliproxyOauthDraft.provider &&
                      cliproxyOauthDraft.submitStatus !== "idle"
                        ? "Confirmation..."
                        : "Confirmer"}
                    </button>
                  </div>
                </div>
              ) : (
                <EmptyState
                  title="Aucun flow en cours"
                  body="Choisis un provider a connecter dans la colonne de gauche."
                />
              )}
            </section>
          </section>
        ) : null}

        {cliproxyStatus && providerWorkspaceTab === "accounts" ? (
          <section className="panel">
            <div className="provider-section-toolbar">
              <div className="stack compact">
                <strong>Comptes OAuth</strong>
                <small className="muted-line">
                  Filtre par provider, email ou statut puis ouvre les quotas compte par compte.
                </small>
              </div>
              <label className="provider-search">
                Recherche
                <input
                  className="input"
                  value={providerAccountQuery}
                  onChange={(event) => setProviderAccountQuery(event.target.value)}
                  placeholder="codex, gemini, email, status..."
                />
              </label>
            </div>
            {filteredAuthByProvider.length ? (
              <div className="provider-accounts-groups">
                {filteredAuthByProvider.map(([providerId, accounts]) => (
                  <section key={providerId} className="provider-account-group">
                    <div className="info-row compact">
                      <strong>{cliproxyProviderLabel(providerId)}</strong>
                      <span className="inline-tag">{accounts.length} compte(s)</span>
                    </div>
                    <div className="provider-account-list">
                      {accounts.map((account) => (
                        <article key={account.id} className="provider-account-card provider-account-card-rich">
                          <div className="info-row compact">
                            <div className="stack compact">
                              <strong>{account.label || account.name}</strong>
                              <small className="muted-line">
                                {account.email || account.account || account.accountType || "oauth"}
                              </small>
                            </div>
                            <StatusPill
                              status={
                                account.status === "ok"
                                  ? "active"
                                  : account.status === "wait"
                                    ? "running"
                                    : account.disabled || account.unavailable
                                      ? "failed"
                                      : "paused"
                              }
                            >
                              {account.status || "stored"}
                            </StatusPill>
                          </div>
                          {account.statusMessage ? (
                            <small className="muted-line">{account.statusMessage}</small>
                          ) : null}
                          {account.usage?.windows.length ? (
                            <div className="provider-usage-list">
                              {account.usage.windows.map((window) => {
                                const usedPercent = clampPercent(window.usedPercent);
                                const remainingPercent = remainingPercentFromUsed(window.usedPercent);
                                return (
                                  <article
                                    key={`${account.id}:${window.label}`}
                                    className="provider-usage-card"
                                  >
                                    <div className="info-row compact">
                                      <strong>{window.label}</strong>
                                      <span className="mono">{remainingPercent}% restant</span>
                                    </div>
                                    <div className="provider-usage-meter" aria-hidden="true">
                                      <span style={{ width: `${remainingPercent}%` }} />
                                    </div>
                                    <small className="muted-line">
                                      utilise {usedPercent}% · reset {formatDateTime(window.resetAt)}
                                    </small>
                                  </article>
                                );
                              })}
                            </div>
                          ) : account.usage?.error ? (
                            <small className="muted-line">{account.usage.error}</small>
                          ) : (
                            <small className="muted-line">Pas de fenetre de quota detaillee.</small>
                          )}
                          <div className="info-row compact">
                            <small className="muted-line">
                              maj {account.updatedAt || account.modtime || account.lastRefresh || "n/a"}
                            </small>
                            <button
                              type="button"
                              className="ghost-button"
                              disabled={cliproxySectionBusy === `auth:${account.name}`}
                              onClick={() => void handleDeleteCliproxyAuth(account.name)}
                            >
                              {cliproxySectionBusy === `auth:${account.name}`
                                ? "Suppression..."
                                : "Supprimer"}
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <EmptyState
                title="Aucun compte"
                body="Aucun compte ne correspond au filtre actuel."
              />
            )}
          </section>
        ) : null}

        {cliproxyStatus && providerWorkspaceTab === "models" ? (
          <section className="panel">
            <div className="provider-section-toolbar">
              <div className="stack compact">
                <strong>Catalogue de modeles</strong>
                <small className="muted-line">{cliproxyRuntimeModelsDetail}</small>
              </div>
              <label className="provider-search">
                Recherche
                <input
                  className="input"
                  value={providerModelQuery}
                  onChange={(event) => setProviderModelQuery(event.target.value)}
                  placeholder="gpt-5.4, gemini, codex..."
                />
              </label>
            </div>
            <div className="runtime-model-meta-row">
              <span className="inline-tag">{filteredModels.length} modele(s)</span>
              <span className="inline-tag">{cliproxyManagedProviders.length} source(s)</span>
            </div>
            {filteredModels.length ? (
              <div className="provider-model-grid">
                {filteredModels.map((model) => (
                  <article key={model.id} className="provider-model-card">
                    <div className="info-row compact">
                      <strong>{model.id}</strong>
                      <StatusPill status="active">{model.providerId || "runtime"}</StatusPill>
                    </div>
                    <div className="provider-chip-row">
                      {model.family ? <span className="provider-chip">{model.family}</span> : null}
                      {model.category ? <span className="provider-chip">{model.category}</span> : null}
                      {model.contextWindow ? (
                        <span className="provider-chip">ctx {model.contextWindow}</span>
                      ) : null}
                      {model.maxTokens ? (
                        <span className="provider-chip">max {model.maxTokens}</span>
                      ) : null}
                    </div>
                    <small className="muted-line">
                      {model.description || model.label || "Modele disponible dans le runtime."}
                    </small>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState
                title="Aucun modele"
                body="Aucun modele ne correspond a la recherche actuelle."
              />
            )}
          </section>
        ) : null}

        {cliproxyStatus && providerWorkspaceTab === "settings" ? (
          <section className="stack">
            <section className="panel">
              <div className="provider-section-toolbar">
                <div className="stack compact">
                  <strong>Reglages avances</strong>
                  <small className="muted-line">
                    Cles API, upstreams compatibles, filtres et comportement quota.
                  </small>
                </div>
              </div>
              <div className="provider-settings-meta">
                <span>Projet</span>
                <code className="mono">{cliproxyStatus.projectDir || "n/a"}</code>
                <span>Config</span>
                <code className="mono">{cliproxyStatus.projectConfigPath || "n/a"}</code>
                <span>Auths</span>
                <code className="mono">{cliproxyStatus.projectAuthDir || "n/a"}</code>
              </div>
            </section>

            <section className="panel">
              <div className="stack compact">
                <strong>API key pools</strong>
                <small className="muted-line">
                  Edite directement les listes de credentials gerees par le runtime providers.
                </small>
              </div>
              <div className="provider-settings-grid">
                {cliproxyApiKeyPools.map((pool) => (
                  <article key={pool.id} className="callout">
                    <div className="info-row compact">
                      <strong>{pool.label}</strong>
                      <StatusPill status="active">{pool.value.length}</StatusPill>
                    </div>
                    <textarea
                      className="input textarea"
                      rows={8}
                      value={cliproxyEditors[pool.editorKey]}
                      onChange={(event) =>
                        setCliproxyEditors((current) => ({
                          ...current,
                          [pool.editorKey]: event.target.value,
                        }))
                      }
                    />
                    <div className="button-row">
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={cliproxySectionBusy === pool.id}
                        onClick={() =>
                          void handleSaveCliproxyJsonSection(
                            pool.id,
                            cliproxyEditors[pool.editorKey],
                            [],
                            `${pool.label} mis a jour.`,
                          )
                        }
                      >
                        {cliproxySectionBusy === pool.id ? "Sauvegarde..." : "Sauver"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="provider-settings-grid">
                <article className="callout">
                  <div className="stack compact">
                    <strong>Upstreams compatibles</strong>
                    <small className="muted-line">
                      Providers compatibles additionnels portes par le hub providers.
                    </small>
                  </div>
                  <textarea
                    className="input textarea"
                    rows={10}
                    value={cliproxyEditors.openAiCompatibility}
                    onChange={(event) =>
                      setCliproxyEditors((current) => ({
                        ...current,
                        openAiCompatibility: event.target.value,
                      }))
                    }
                  />
                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={cliproxySectionBusy === "openai-compatibility"}
                      onClick={() =>
                        void handleSaveCliproxyJsonSection(
                          "openai-compatibility",
                          cliproxyEditors.openAiCompatibility,
                          [],
                          "Upstreams OpenAI-compatibles mis a jour.",
                        )
                      }
                    >
                      {cliproxySectionBusy === "openai-compatibility" ? "Sauvegarde..." : "Sauver"}
                    </button>
                  </div>
                </article>

                <article className="callout">
                  <div className="stack compact">
                    <strong>Filtres de modeles OAuth</strong>
                    <small className="muted-line">
                      Controle les exclusions de modeles pour les comptes OAuth.
                    </small>
                  </div>
                  <textarea
                    className="input textarea"
                    rows={8}
                    value={cliproxyEditors.oauthExcludedModels}
                    onChange={(event) =>
                      setCliproxyEditors((current) => ({
                        ...current,
                        oauthExcludedModels: event.target.value,
                      }))
                    }
                  />
                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={cliproxySectionBusy === "oauth-excluded-models"}
                      onClick={() =>
                        void handleSaveCliproxyJsonSection(
                          "oauth-excluded-models",
                          cliproxyEditors.oauthExcludedModels,
                          {},
                          "Exclusions OAuth mises a jour.",
                        )
                      }
                    >
                      {cliproxySectionBusy === "oauth-excluded-models" ? "Sauvegarde..." : "Sauver"}
                    </button>
                  </div>
                </article>
              </div>
            </section>

            <section className="panel">
              <div className="stack compact">
                <strong>Comportement quota</strong>
                <small className="muted-line">
                  Regle les bascules automatiques quand un compte atteint sa limite.
                </small>
              </div>
              <div className="button-row">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={cliproxySectionBusy === "quota-exceeded/switch-project"}
                  onClick={() =>
                    void handleSaveCliproxySection(
                      "quota-exceeded/switch-project",
                      !cliproxyStatus.switchProjectOnQuotaExceeded,
                      "Switch project mis a jour.",
                    )
                  }
                >
                  switch-project: {cliproxyStatus.switchProjectOnQuotaExceeded ? "on" : "off"}
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={cliproxySectionBusy === "quota-exceeded/switch-preview-model"}
                  onClick={() =>
                    void handleSaveCliproxySection(
                      "quota-exceeded/switch-preview-model",
                      !cliproxyStatus.switchPreviewModelOnQuotaExceeded,
                      "Switch preview model mis a jour.",
                    )
                  }
                >
                  switch-preview-model:{" "}
                  {cliproxyStatus.switchPreviewModelOnQuotaExceeded ? "on" : "off"}
                </button>
              </div>
              <small className="muted-line">
                usage-statistics-enabled: {String(cliproxyStatus.usageStatisticsEnabled ?? false)}
              </small>
            </section>
          </section>
        ) : null}
      </section>
    );
  }

  function renderChannels() {
    const entries = currentUserCanManageAdminViews
      ? channelEntries
      : channelEntries.filter((catalogEntry) => getChannelRouteConfig(catalogEntry).enabled);
    const channelWorkspaceTitle = currentUserCanManageAdminViews
      ? "Bots & destinations"
      : "Destinations de sortie";
    const channelWorkspaceDetail = currentUserCanManageAdminViews
      ? "Configure les bots techniques, leurs bindings inbound, puis les destinations de sortie reelles."
      : "Choisis un transport deja relie au runtime puis rattache une destination reelle user, groupe, salon ou thread.";
    const operatorRuntimeAccountCount = entries.reduce((total, catalogEntry) => {
      if (catalogEntry.template.accountScope === "top-level-only") {
        return total + (catalogEntry.configured || catalogEntry.accounts.length ? 1 : 0);
      }
      return total + catalogEntry.accounts.length;
    }, 0);
    const entry = selectedChannelEntry;
    const routeConfig = entry ? getChannelRouteConfig(entry) : null;
    const routeEditorEnabled = Boolean(routeConfig?.enabled);
    const routeKinds = routeConfig?.destinationKinds || [];
    const selectedRouteKind = entry
      ? resolveChannelRouteKind(entry, channelRouteDraft.destinationType)
      : null;
    const elytrasManagedInboundAccess = isElytrasManagedInboundChannel(entry?.id);
    const operationMatchesSelection =
      channelOperation && entry ? channelOperation.channelId === entry.id : false;
    const routeEditorReadOnly =
      !canEditChannelRoutes() ||
      Boolean(
        entry &&
          !currentUserCanManageAdminViews &&
          entry.template.accountScope !== "top-level-only" &&
          entry.accounts.length === 0,
      );
    const selectedRuntimeAccountId = entry
      ? entry.template.accountScope === "top-level-only"
        ? "default"
        : selectedChannelAccountId ||
          channelDraft.accountId ||
          entry.defaultAccountId ||
          entry.accounts[0]?.accountId ||
          "default"
      : "default";

    return (
      <section className="stack">
        <section className="panel">
          <ResourceToolbar
            title={channelWorkspaceTitle}
            detail={channelWorkspaceDetail}
          />
          <div className="channel-summary-strip">
            <span className="inline-tag">{entries.length} service(s)</span>
            <span className="inline-tag">
              {currentUserCanManageAdminViews ? runtimeTransportChannels.length : operatorRuntimeAccountCount}{" "}
              bot(s) / dispatcher(s)
            </span>
            <span className="inline-tag">{visibleOutputRouteChannels.length} destination(s) configuree(s)</span>
            <span className="inline-tag">{visibleRuntimePeerCandidates.length} peer(s) detecte(s)</span>
            {currentUserCanManageAdminViews ? (
              <span className="inline-tag">{systemChannelSurfaces.length} signal(s) systeme</span>
            ) : null}
          </div>
          <div className="channel-layout">
            <aside className="channel-catalog-panel">
              <div className="channel-catalog-toolbar">
                <strong>
                  {currentUserCanManageAdminViews ? "Services supportes" : "Services disponibles"}
                </strong>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void fetchChannelCatalog(config).then(setChannelCatalog)}
                >
                  Rafraichir
                </button>
              </div>
              <div className="channel-catalog-list">
                {entries.map((catalogEntry) => (
                  <button
                    key={catalogEntry.id}
                    type="button"
                    className={`channel-catalog-card ${
                      catalogEntry.id === selectedChannelTemplateId ? "selected" : ""
                    }`}
                    onClick={() => handleSelectChannel(catalogEntry.id)}
                  >
                    <div className="info-row compact">
                      <strong>{catalogEntry.template.label}</strong>
                      <StatusPill status={catalogEntry.installed ? "active" : "paused"}>
                        {catalogEntry.installed ? "loaded" : "plugin"}
                      </StatusPill>
                    </div>
                    <p>{catalogEntry.template.summary}</p>
                    <small className="muted-line">
                      {formatChannelRuntimeState(catalogEntry)} · {catalogEntry.accounts.length}{" "}
                      account(s)
                    </small>
                    <div className="pill-row">
                      {catalogEntry.template.tags.slice(0, 3).map((tag) => (
                        <span key={tag} className="inline-tag">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            </aside>

            <div className="channel-detail-panel">
              {entry ? (
                <>
                  <section className="channel-detail-hero">
                    <div className="stack compact">
                      <div className="info-row compact">
                        <strong>{entry.template.label}</strong>
                        <StatusPill
                          status={entry.installed ? (entry.configured ? "active" : "queued") : "paused"}
                        >
                          {formatChannelRuntimeState(entry)}
                        </StatusPill>
                      </div>
                      <p>{entry.template.summary}</p>
                      <div className="channel-summary-strip">
                        <span className="inline-tag">
                          {currentUserCanManageAdminViews
                            ? `service ${entry.template.accountScope}`
                            : "service exploitable"}
                        </span>
                        <span className="inline-tag">{entry.accounts.length} bot(s)</span>
                        <span className="inline-tag">
                          {routeEditorEnabled
                            ? `${visibleSelectedChannelOutputRoutes.length} destination(s) configuree(s)`
                            : "pas de destination"}
                        </span>
                        <span className="inline-tag">
                          {selectedUnmappedRuntimeDestinationChannels.length} peer(s) detecte(s)
                        </span>
                        {selectedSystemChannelSurfaces.length ? (
                          <span className="inline-tag">
                            {selectedSystemChannelSurfaces.length} signal(s) runtime
                          </span>
                        ) : null}
                      </div>
                      <small className="muted-line">
                        {currentUserCanManageAdminViews
                          ? `${entry.template.accountScope} · ${entry.accounts.length} bot(s) / compte(s) runtime`
                          : entry.template.accountScope === "top-level-only"
                            ? entry.configured || entry.accounts.length
                              ? "compte runtime global pret"
                              : "aucun compte runtime"
                            : `${entry.accounts.length} compte(s) runtime disponibles`}
                      </small>
                    </div>
                    <div className="button-row">
                      <a
                        className="ghost-button"
                        href={entry.template.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Docs
                      </a>
                      {currentUserCanManageAdminViews && entry.template.installPath && !entry.installed ? (
                        <button
                          type="button"
                          className="ghost-button"
                          disabled={channelActionBusy === "install"}
                          onClick={() => void handleInstallSelectedChannel()}
                        >
                          Installer le plugin
                        </button>
                      ) : null}
                    </div>
                  </section>

                  {channelCatalog?.degraded ? (
                    <article className="callout">
                      <strong>Gateway en redemarrage</strong>
                      <p>
                        Le catalogue reste navigable et la checklist de setup reste disponible,
                        mais l&apos;etat runtime peut etre incomplet tant que le gateway n&apos;est
                        pas revenu.
                      </p>
                      {channelCatalog.warning ? (
                        <small className="muted-line">{channelCatalog.warning}</small>
                      ) : null}
                    </article>
                  ) : null}

                  <section className="panel inset channel-topology-grid">
                    <div className="channel-step-grid">
                      <article className="callout">
                        <strong>1. Bot / dispatcher</strong>
                        <p>
                          Le token, le login OAuth, le pairing ou le fichier secret se configurent
                          ici. C&apos;est la surface technique qui parle au service Telegram,
                          Discord, Slack, WhatsApp, etc.
                        </p>
                      </article>
                      <article className="callout">
                        <strong>2. Binding inbound</strong>
                        <p>
                          Le bot est ensuite rattache a un agent, mais cette decision se prend
                          maintenant dans <code>Agent Studio</code>. Ici, tu restes sur la partie
                          technique: token, OAuth, pairing, allowlist et destinations.
                        </p>
                      </article>
                      <article className="callout">
                        <strong>3. Destination de sortie</strong>
                        <p>
                          Une destination est une cible reelle: user, DM, groupe, salon, thread ou
                          topic. Ce sont elles que tu choisis dans les chats, pipelines et cron jobs.
                        </p>
                      </article>
                      <article className="callout">
                        <strong>4. Signals runtime</strong>
                        <p>
                          Les surfaces comme <code>heartbeat</code> ou <code>session</code> sont des
                          signaux systeme. Elles ne doivent pas polluer tes selecteurs de sorties.
                        </p>
                      </article>
                    </div>
                  </section>

                  {elytrasManagedInboundAccess ? (
                    <article className="callout">
                      <strong>DM policy geree par Elytras</strong>
                      <p>
                        Pour <code>{entry.id}</code>, la <code>dmPolicy</code> et l&apos;allowlist DM
                        ne se reglent pas manuellement ici. Elytras les derive automatiquement a partir
                        du bot lie, des teams autorisees a parler a l&apos;agent, puis des identites
                        externes des users autorises.
                      </p>
                      <small className="muted-line">
                        En pratique: tant qu&apos;aucun user autorise n&apos;est resolvable pour ce bot,
                        la policy reste verrouillee. Pour l&apos;ouvrir, configure le bot, lie-le a un
                        agent dans Agent Studio, puis autorise les bons users/teams.
                      </small>
                    </article>
                  ) : null}

                  {currentUserCanManageAdminViews ? (
                  <section
                    className="panel inset"
                    key={`channel-config:${entry.id}:${
                      channelDraftIsNewAccount
                        ? `new:${normalizeChannelAccountId(channelDraft.accountId)}`
                        : selectedRuntimeAccountId
                    }`}
                  >
                    <div className="channel-account-toolbar">
                      <div className="info-row compact">
                        <strong>Bots / comptes runtime</strong>
                        <small className="muted-line">
                          {channelCatalogLoading ? "synchronisation..." : "snapshot courant"}
                        </small>
                      </div>
                      {entry.template.accountScope !== "top-level-only" ? (
                        <div className="button-row">
                          {channelDraftIsNewAccount ? (
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={handleCancelNewChannelAccount}
                            >
                              Annuler le nouveau bot
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={handleStartNewChannelAccount}
                            >
                              Nouveau bot
                            </button>
                          )}
                        </div>
                      ) : null}
                    </div>
                    {entry.accounts.length || channelDraftIsNewAccount ? (
                      <div className="channel-account-list">
                        {channelDraftIsNewAccount ? (
                          <div className="channel-account-card selected channel-account-draft-card">
                            <div className="info-row compact">
                              <strong>Nouveau bot</strong>
                              <StatusPill status="queued">brouillon</StatusPill>
                            </div>
                            <small className="muted-line">
                              account {normalizeChannelAccountId(channelDraft.accountId)}
                            </small>
                            <small className="muted-line">
                              Configure d&apos;abord le token, l&apos;allowlist et les surfaces de sortie,
                              puis lie ce bot a un agent depuis Agent Studio.
                            </small>
                          </div>
                        ) : null}
                        {entry.accounts.map((account) => (
                          <button
                            key={`${entry.id}:${account.accountId}`}
                            type="button"
                            className={`channel-account-card ${
                              selectedChannelAccountId === account.accountId ? "selected" : ""
                            }`}
                            onClick={() => handleSelectChannelAccount(account.accountId)}
                          >
                            <div className="info-row compact">
                              <strong>{channelAccountLabel(entry, account.accountId)}</strong>
                              <StatusPill
                                status={
                                  account.connected
                                    ? "active"
                                    : account.configured || account.linked
                                      ? "queued"
                                      : "paused"
                                }
                              >
                                {account.statusLabel}
                              </StatusPill>
                            </div>
                            <small className="muted-line">
                              agent lie{" "}
                              {agentName(
                                runtimeTransportChannels.find(
                                  (channel) =>
                                    channel.kind === entry.id &&
                                    normalizeChannelAccountId(channel.accountId) ===
                                      normalizeChannelAccountId(account.accountId),
                                )?.inboundAgentId,
                              )}
                            </small>
                            {account.dmPolicy ? (
                              <small className="muted-line">
                                DM {account.dmPolicy}
                                {account.allowFrom.length
                                  ? ` · allowFrom ${account.allowFrom.slice(0, 3).join(", ")}${
                                      account.allowFrom.length > 3 ? ` +${account.allowFrom.length - 3}` : ""
                                    }`
                                  : ""}
                              </small>
                            ) : null}
                            {(account.lastInboundAt || account.lastOutboundAt) ? (
                              <small className="muted-line">
                                inbound {formatDateTime(account.lastInboundAt)} · outbound{" "}
                                {formatDateTime(account.lastOutboundAt)}
                              </small>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <article className="callout">
                        <strong>Aucun compte configure</strong>
                        <p>Le runtime ne remonte encore aucun compte pour ce channel.</p>
                      </article>
                    )}
                  </section>
                  ) : (
                    <section className="panel inset">
                      <div className="info-row compact">
                        <strong>Compte runtime</strong>
                        <small className="muted-line">selection du bot deja connecte</small>
                      </div>
                      {entry.template.accountScope === "top-level-only" ? (
                        <article className="callout">
                          <strong>Compte runtime</strong>
                          <p>
                            Ce transport ne gere qu'un seul compte runtime global.
                          </p>
                          <small className="muted-line">
                            Compte actif: <span className="mono">default</span>
                          </small>
                        </article>
                      ) : entry.accounts.length ? (
                        <label>
                          Compte runtime
                          <select
                            className="select"
                            value={selectedRuntimeAccountId}
                            onChange={(event) => handleSelectChannelAccount(event.target.value)}
                          >
                            {entry.accounts.map((account) => (
                              <option key={`${entry.id}:${account.accountId}`} value={account.accountId}>
                                {channelAccountLabel(entry, account.accountId)} · {account.statusLabel}
                              </option>
                            ))}
                          </select>
                          <small className="muted-line">
                            Les destinations creees plus bas seront rattachees a ce compte runtime.
                          </small>
                        </label>
                      ) : (
                        <article className="callout">
                          <strong>Aucun compte runtime</strong>
                          <p>
                            L'admin doit d'abord connecter un compte pour ce transport avant que
                            ton equipe puisse y rattacher des destinations.
                          </p>
                        </article>
                      )}
                    </section>
                  )}

                  <section className="panel inset">
                    <div className="info-row compact">
                      <strong>Binding inbound</strong>
                      <small className="muted-line">{selectedRuntimeAccountId}</small>
                    </div>
                    {selectedRuntimeTransportChannel ? (
                      <>
                        <article className="callout">
                          <strong>
                            {selectedRuntimeTransportChannel.inboundAgentId
                              ? `Lie a ${agentName(selectedRuntimeTransportChannel.inboundAgentId)}`
                              : "Aucun agent lie"}
                          </strong>
                          <p>
                            Le binding agent / bot se gere dans la configuration de l&apos;agent.
                            Cette page reste la vue technique du transport et du compte runtime.
                          </p>
                        </article>
                        <div className="button-row">
                          {selectedRuntimeTransportChannel.inboundAgentId ? (
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() =>
                                openAgentStudioForAgentId(selectedRuntimeTransportChannel.inboundAgentId, {
                                  section: "profile",
                                })
                              }
                            >
                              Ouvrir l&apos;agent lie
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => openAgentStudioForAgentId(undefined, { section: "profile" })}
                          >
                            Aller dans Agent Studio
                          </button>
                        </div>
                      </>
                    ) : (
                      <article className="callout">
                        <strong>Aucun compte runtime detecte</strong>
                        <p>
                          Connecte d&apos;abord un compte pour ce transport. Une fois le bot present,
                          lie-le ensuite a un agent depuis Agent Studio.
                        </p>
                      </article>
                    )}
                  </section>

                  {currentUserCanManageAdminViews ? (
                  <section className="panel inset">
                    <div className="info-row compact">
                      <strong>Configurer {entry.template.label}</strong>
                      <small className="muted-line">
                        {channelDraftIsNewAccount
                          ? `nouveau bot ${normalizeChannelAccountId(channelDraft.accountId)}`
                          : `bot ${normalizeChannelAccountId(channelDraft.accountId)}`}
                      </small>
                    </div>
                    {entry.template.setupMode === "native-ui" ? (
                      <article className="callout">
                        <strong>Pas de formulaire additionnel</strong>
                        <p>
                          Ce channel se pilote directement via le Control UI natif OpenClaw et le
                          gateway local.
                        </p>
                      </article>
                    ) : (
                      <>
                      <div className="form-grid">
                        {entry.template.accountScope !== "top-level-only" ? (
                          <label>
                            Account ID
                            <input
                              className="input"
                              name={`channel-${entry.id}-account-id`}
                              autoComplete="off"
                              value={channelDraft.accountId}
                              onChange={(event) => {
                                const nextAccountId = event.target.value;
                                setSelectedChannelAccountId(channelDraftIsNewAccount ? "" : nextAccountId);
                                setChannelDraft((current) => ({
                                  ...current,
                                  accountId: nextAccountId,
                                }));
                                resetChannelRouteEditor();
                              }}
                              placeholder="default"
                              disabled={!channelDraftIsNewAccount}
                            />
                            <small className="muted-line">
                              {channelDraftIsNewAccount
                                ? "Identifiant technique du bot pour ce transport."
                                : "Pour renommer un compte, cree un nouveau bot puis supprime l'ancien si besoin."}
                            </small>
                          </label>
                        ) : null}
                          <label>
                            Display name
                            <input
                              className="input"
                              name={`channel-${entry.id}-display-name`}
                              autoComplete="off"
                              value={channelDraft.name}
                            onChange={(event) =>
                              setChannelDraft((current) => ({
                                ...current,
                                name: event.target.value,
                              }))
                            }
                            placeholder={`${entry.template.label} primary`}
                            />
                          </label>
                        {entry.template.fields.map((field) => {
                          if (
                            elytrasManagedInboundAccess &&
                            (field.key === "dmPolicy" || field.key === "allowFrom")
                          ) {
                            return null;
                          }
                          const rawValue = channelDraft.values[field.key];
                          const value =
                            typeof rawValue === "string" || typeof rawValue === "number"
                              ? rawValue
                              : "";
                          if (field.type === "checkbox") {
                            return (
                              <div key={`${entry.id}:${field.key}`} className="row-gap">
                                <strong>{field.label}</strong>
                                <label className="checkbox-row">
                                  <input
                                    type="checkbox"
                                    checked={rawValue === true}
                                    onChange={(event) =>
                                      updateChannelDraftValue(field.key, event.target.checked)
                                    }
                                  />
                                  <span>{field.description || "Activer"}</span>
                                </label>
                              </div>
                            );
                          }
                          return (
                            <label key={`${entry.id}:${field.key}`}>
                              {field.label}
                              {field.type === "select" ? (
                                <select
                                  className="select"
                                  name={`channel-${entry.id}-${field.key}`}
                                  autoComplete="off"
                                  value={String(value)}
                                  onChange={(event) =>
                                    updateChannelDraftValue(field.key, event.target.value)
                                  }
                                >
                                  {(field.options || []).map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                              ) : field.type === "textarea" ? (
                                <textarea
                                  className="textarea"
                                  name={`channel-${entry.id}-${field.key}`}
                                  autoComplete="off"
                                  value={String(value)}
                                  placeholder={field.placeholder}
                                  onChange={(event) =>
                                    updateChannelDraftValue(field.key, event.target.value)
                                  }
                                />
                              ) : (
                                <input
                                  className="input"
                                  name={`channel-${entry.id}-${field.key}`}
                                  type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
                                  autoComplete={field.type === "password" ? "new-password" : "off"}
                                  data-1p-ignore={field.type === "password" ? "true" : undefined}
                                  value={String(value)}
                                  placeholder={field.placeholder}
                                  onChange={(event) =>
                                    updateChannelDraftValue(
                                      field.key,
                                      field.type === "number"
                                        ? Number(event.target.value)
                                        : event.target.value,
                                    )
                                  }
                                />
                              )}
                              {field.description && field.type !== "checkbox" ? (
                                <small className="muted-line">{field.description}</small>
                              ) : null}
                            </label>
                          );
                        })}
                      </div>
                      </>
                    )}
                    <div className="button-row">
                      {entry.template.setupMode === "config" ? (
                        <button
                          type="button"
                          className="ghost-button"
                          disabled={
                            channelActionBusy === "configure" ||
                            Boolean(entry.template.installPath && !entry.installed)
                          }
                          onClick={() => void handleConfigureSelectedChannel()}
                        >
                          {channelDraftIsNewAccount ? "Creer le bot" : "Sauvegarder le bot"}
                        </button>
                      ) : null}
                      {entry.template.loginMode === "cli-login" ? (
                        <button
                          type="button"
                          className="ghost-button"
                          disabled={
                            channelActionBusy === "login" ||
                            channelDraftIsNewAccount ||
                            Boolean(entry.template.installPath && !entry.installed)
                          }
                          onClick={() => void handleLoginSelectedChannel()}
                        >
                          Lancer le login / pairing
                        </button>
                      ) : null}
                      {entry.template.supportsLogout ? (
                        <button
                          type="button"
                          className="ghost-button"
                          disabled={
                            channelActionBusy === "logout" ||
                            channelDraftIsNewAccount ||
                            Boolean(entry.template.installPath && !entry.installed)
                          }
                          onClick={() => void handleLogoutSelectedChannel()}
                        >
                          Logout
                        </button>
                      ) : null}
                      {entry.template.supportsRemove ? (
                        <button
                          type="button"
                          className="ghost-button"
                          disabled={
                            channelActionBusy === "remove" ||
                            channelDraftIsNewAccount ||
                            Boolean(entry.template.installPath && !entry.installed)
                          }
                          onClick={() => void handleRemoveSelectedChannel()}
                        >
                          Supprimer le bot
                        </button>
                      ) : null}
                    </div>
                  </section>
                  ) : null}

                  <section className="panel inset">
                    <div className="info-row compact">
                      <strong>Destinations de sortie</strong>
                      <small className="muted-line">
                        {routeConfig?.summary ||
                          "Une destination = un transport/account + une cible reelle user, DM, group, channel ou conversation."}
                      </small>
                    </div>
                    {routeEditorEnabled ? (
                      <>
                        {!currentUserCanManageAdminViews &&
                        entry.template.accountScope !== "top-level-only" &&
                        entry.accounts.length ? (
                          <label>
                            Compte runtime
                            <select
                              className="select"
                              value={selectedRuntimeAccountId}
                              onChange={(event) => handleSelectChannelAccount(event.target.value)}
                              disabled={routeEditorReadOnly}
                            >
                              {entry.accounts.map((account) => (
                                <option key={`${entry.id}:route:${account.accountId}`} value={account.accountId}>
                                  {channelAccountLabel(entry, account.accountId)} · {account.statusLabel}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                        {visibleSelectedChannelOutputRoutes.length ? (
                          <div className="channel-account-list">
                            {visibleSelectedChannelOutputRoutes.map((channel) => {
                              const routeKind = resolveChannelRouteKind(entry, channel.destinationType);
                              return (
                                <button
                                  key={channel.id}
                                  type="button"
                                  className={`channel-account-card ${
                                    selectedChannelRouteId === channel.id ? "selected" : ""
                                  }`}
                                  onClick={() => handleSelectChannelRoute(channel.id)}
                              >
                                <div className="info-row compact">
                                  <strong>{channel.name}</strong>
                                  <StatusPill status="active">
                                    {routeKind?.label || channel.kind}
                                  </StatusPill>
                                </div>
                                  <small className="muted-line">
                                    {channel.accountId || "default"} ·{" "}
                                    {channel.deliveryTarget || channel.target || "n/a"}
                                    {currentUserCanManageAdminViews
                                      ? ` · owner ${ownerName(channel.ownerId)}`
                                      : ""}
                                  </small>
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <article className="callout">
                            <strong>Aucune destination configuree</strong>
                            <p>
                              Cree une ou plusieurs destinations pour ce transport afin de les rendre
                              selectionnables dans Agents, Chats, Pipelines et Cron.
                            </p>
                          </article>
                        )}

                        <div className="button-row">
                          <button
                            type="button"
                            className="ghost-button"
                            disabled={routeEditorReadOnly}
                            onClick={() => resetChannelRouteEditor()}
                          >
                            Nouvelle destination
                          </button>
                        </div>

                        <div className="form-grid">
                          <label>
                            Nom de destination
                            <input
                              className="input"
                              value={channelRouteDraft.name}
                              disabled={routeEditorReadOnly}
                              onChange={(event) =>
                                setChannelRouteDraft((current) => ({
                                  ...current,
                                  name: event.target.value,
                                }))
                              }
                              placeholder={`${entry.template.label} Ops`}
                            />
                          </label>
                          {currentUserCanManageAdminViews ? (
                            <label>
                              Owner
                              <select
                                className="select"
                                value={channelRouteDraft.ownerId}
                                disabled={routeEditorReadOnly}
                                onChange={(event) =>
                                  setChannelRouteDraft((current) => ({
                                    ...current,
                                    ownerId: event.target.value,
                                  }))
                                }
                              >
                                <option value="">Aucun</option>
                                {routeOwnerOptions.map((user) => (
                                  <option key={user.id} value={user.id}>
                                    {user.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : null}
                          <label>
                            Type de destination
                            <select
                              className="select"
                              value={channelRouteDraft.destinationType}
                              disabled={routeEditorReadOnly}
                              onChange={(event) =>
                                setChannelRouteDraft((current) => ({
                                  ...current,
                                  destinationType: event.target.value,
                                }))
                              }
                            >
                              {routeKinds.map((kind) => (
                                <option key={kind.id} value={kind.id}>
                                  {kind.label}
                                </option>
                              ))}
                            </select>
                            <small className="muted-line">
                              {selectedRouteKind?.description ||
                                routeConfig?.hint ||
                                "Cette destination sera utilisee pour les outputs pipeline, agents et cron jobs."}
                            </small>
                          </label>
                          <label className="field-span-2">
                            {routeConfig?.targetLabel || "Destination"}
                            <input
                              className="input"
                              value={channelRouteDraft.deliveryTarget}
                              disabled={routeEditorReadOnly}
                              onChange={(event) =>
                                setChannelRouteDraft((current) => ({
                                  ...current,
                                  deliveryTarget: event.target.value,
                                }))
                              }
                              placeholder={
                                selectedRouteKind?.example ||
                                routeConfig?.placeholder ||
                                "Identifiant de destination"
                              }
                            />
                            <small className="muted-line">
                              {selectedRouteKind?.example
                                ? `Exemple: ${selectedRouteKind.example}`
                                : routeConfig?.hint ||
                                  "Cette destination sera utilisee pour les outputs pipeline, agents et cron jobs."}
                            </small>
                          </label>
                        </div>

                        <div className="button-row">
                          <button
                            type="button"
                            className="ghost-button"
                            disabled={
                              routeEditorReadOnly ||
                              channelActionBusy === "route-create" ||
                              channelActionBusy === "route-update"
                            }
                            onClick={() => void handleSaveChannelRoute()}
                          >
                            {selectedChannelRouteId
                              ? "Mettre a jour la destination"
                              : "Ajouter la destination"}
                          </button>
                          {selectedChannelRouteId ? (
                            <button
                              type="button"
                              className="ghost-button"
                              disabled={routeEditorReadOnly || channelActionBusy === "route-delete"}
                              onClick={() => void handleDeleteSelectedChannelRoute()}
                            >
                              Supprimer la destination
                            </button>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <article className="callout">
                        <strong>Pas de destination operateur</strong>
                        <p>
                          {routeConfig?.summary ||
                            "Ce channel reste une surface runtime utile pour l’observabilite, mais il n’apparait pas dans les pickers d’outputs."}
                        </p>
                      </article>
                    )}
                  </section>

                  <section className="panel inset">
                    <div className="info-row compact">
                      <strong>Peers detectes</strong>
                      <small className="muted-line">
                        Cibles reelles observees sur ce transport et ce compte runtime. Elles peuvent
                        servir de base pour creer une destination de sortie propre.
                      </small>
                    </div>
                    {selectedRuntimeDestinationChannels.length >
                    selectedUnmappedRuntimeDestinationChannels.length ? (
                      <small className="muted-line">
                        {selectedRuntimeDestinationChannels.length -
                          selectedUnmappedRuntimeDestinationChannels.length}{" "}
                        peer(s) deja couverts par une destination configuree sont masques ici.
                      </small>
                    ) : null}
                    {selectedUnmappedRuntimeDestinationChannels.length ? (
                      <div className="channel-account-list">
                        {selectedUnmappedRuntimeDestinationChannels.map((channel) => (
                          <div key={`detected-destination:${channel.id}`} className="channel-account-card">
                            <div className="info-row compact">
                              <strong>
                                {describeDetectedDestinationLabel(selectedChannelEntry, channel)}
                              </strong>
                              <StatusPill status="queued">
                                {inferRouteDestinationTypeFromDetectedTarget(
                                  selectedChannelEntry,
                                  channel.target,
                                ) || channel.kind}
                              </StatusPill>
                            </div>
                            <small className="muted-line">
                              {normalizeChannelAccountId(channel.accountId)} · {channel.target}
                            </small>
                            <small className="muted-line">
                              dernier signal {formatDateTime(channel.updatedAt)}
                              {channel.inboundAgentId ? ` · inbound ${agentName(channel.inboundAgentId)}` : ""}
                            </small>
                            {routeEditorEnabled ? (
                              <div className="button-row">
                                <button
                                  type="button"
                                  className="ghost-button"
                                  disabled={routeEditorReadOnly}
                                  onClick={() => seedChannelRouteFromDetectedDestination(channel)}
                                >
                                  Utiliser pour une destination operateur
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <article className="callout">
                        <strong>Aucune destination detectee</strong>
                        <p>
                          Aucun user, channel, groupe ou thread reel n&apos;a encore ete observe pour
                          ce transport et ce compte runtime qui ne soit pas deja couvert par une
                          destination de sortie configuree.
                        </p>
                      </article>
                    )}
                  </section>

                  {selectedSystemChannelSurfaces.length ? (
                  <section className="panel inset">
                    <div className="info-row compact">
                      <strong>Signals runtime</strong>
                      <small className="muted-line">
                        Surfaces systeme detectees sur ce service. Elles restent hors des selecteurs
                        de destinations.
                      </small>
                    </div>
                    <div className="channel-account-list">
                      {selectedSystemChannelSurfaces.map((channel) => (
                        <div key={`system-surface:${channel.id}`} className="channel-account-card">
                          <div className="info-row compact">
                            <strong>{channel.name}</strong>
                            <StatusPill status="paused">systeme</StatusPill>
                          </div>
                          <small className="muted-line">
                            {normalizeChannelAccountId(channel.accountId)} · {channel.target}
                          </small>
                          <small className="muted-line">
                            dernier signal {formatDateTime(channel.updatedAt)}
                          </small>
                        </div>
                      ))}
                    </div>
                  </section>
                  ) : null}

                  {currentUserCanManageAdminViews ? (
                  <section className="panel inset">
                    <div className="info-row compact">
                      <strong>Operation</strong>
                      <small className="muted-line">
                        {operationMatchesSelection
                          ? `${channelOperation?.kind} · ${channelOperation?.status}`
                          : "Aucune operation recente"}
                      </small>
                    </div>
                    {operationMatchesSelection ? (
                      <div className="channel-operation-log">
                        <code>{channelOperation?.command}</code>
                        <div className="channel-log-lines">
                          {(channelOperation?.logs || []).length ? (
                            (channelOperation?.logs || []).map((line, index) => (
                              <pre key={`${channelOperation?.id}:${index}`}>{line}</pre>
                            ))
                          ) : (
                            <pre>En attente de logs...</pre>
                          )}
                        </div>
                      </div>
                    ) : (
                      <article className="callout">
                        <strong>Pas de log courant</strong>
                        <p>Lance une installation, un login ou un remove pour voir le transcript.</p>
                      </article>
                    )}
                  </section>
                  ) : null}
                </>
              ) : (
                <article className="callout">
                  <strong>Aucun channel selectionne</strong>
                  <p>Choisis un channel dans le catalogue pour ouvrir son setup guide.</p>
                </article>
              )}
            </div>
          </div>
        </section>
      </section>
    );
  }

  function renderPipelinesWorkbench() {
    const selectedDraftStep = selectedPipelineStep;
    const pipelineScopedAgents = getTeamOwnedAgents(pipelineForm.teamId);
    const pipelineScopedOutputChannels = getTeamScopedOutputChannels(pipelineForm.teamId);
    const selectedDraftStepAccessibleChannels = selectedDraftStep
      ? getAgentAccessibleOutputChannels(selectedDraftStep.agentId, pipelineForm.teamId)
      : [];
    const selectedDraftStepIndex = selectedDraftStep
      ? pipelineForm.steps.findIndex((step) => step.id === selectedDraftStep.id)
      : -1;
    const selectedDraftStepEffectiveModelRef = selectedDraftStep
      ? getEffectiveDraftStepModelRef(selectedDraftStep)
      : "";
    const selectedDraftStepEffectiveOutputs = selectedDraftStep
      ? getEffectiveDraftStepOutputTargets(selectedDraftStep)
      : [];
    const selectedDraftStepEffectiveSkills = selectedDraftStep
      ? getEffectiveDraftStepSkillIds(selectedDraftStep)
      : [];
    const selectedDraftStepEffectiveProviderIds = selectedDraftStep
      ? getEffectiveAgentProviderIds(selectedDraftStep.agentId)
      : activeRuntimeProviderIds;
    const selectedDraftStepEffectiveNextIds =
      selectedDraftStep && selectedDraftStepIndex >= 0
        ? getEffectiveDraftStepNextStepIds(
            selectedDraftStep,
            pipelineForm.steps,
            selectedDraftStepIndex,
          )
        : [];
    const selectedDraftStepEffectiveNextTitles = selectedDraftStep
      ? describeDraftStepNextTitles(selectedDraftStep, pipelineForm.steps)
      : [];
    const selectedDraftStepAllowedSkillIds = selectedDraftStep
      ? getAllowedSkillIdsForAgentProvider(
          selectedDraftStep.agentId,
          modelProviderFromRef(selectedDraftStepEffectiveModelRef),
        )
      : [];
    const pipelineOutputDeliveryMode = normalizePipelineOutputDeliveryMode(
      pipelineForm.outputDeliveryMode,
    );
    const pipelineRequestedOutputTargets = splitList(pipelineForm.outputTargets);
    const pipelineOutputChoices = [...pipelineScopedOutputChannels].toSorted((left, right) => {
      const leftSelected = pipelineRequestedOutputTargets.includes(left.id) ? 1 : 0;
      const rightSelected = pipelineRequestedOutputTargets.includes(right.id) ? 1 : 0;
      if (leftSelected !== rightSelected) {
        return rightSelected - leftSelected;
      }
      return left.name.localeCompare(right.name);
    });
    const selectedDraftStepOutputChoices = selectedDraftStep
      ? [...pipelineScopedOutputChannels].toSorted((left, right) => {
          const leftSelected = selectedDraftStep.outputTargets.includes(left.id) ? 1 : 0;
          const rightSelected = selectedDraftStep.outputTargets.includes(right.id) ? 1 : 0;
          if (leftSelected !== rightSelected) {
            return rightSelected - leftSelected;
          }
          const leftAllowed = selectedDraftStepAccessibleChannels.some(
            (channel) => channel.id === left.id,
          )
            ? 1
            : 0;
          const rightAllowed = selectedDraftStepAccessibleChannels.some(
            (channel) => channel.id === right.id,
          )
            ? 1
            : 0;
          if (leftAllowed !== rightAllowed) {
            return rightAllowed - leftAllowed;
          }
          return left.name.localeCompare(right.name);
        })
      : pipelineScopedOutputChannels;
    const editingPipeline =
      pipelineEditorMode === "edit"
        ? pipelines.find((pipeline) => pipeline.id === editingPipelineId) || null
        : null;
    const selectedPipelineRunMode = normalizePipelineOutputDeliveryMode(
      selectedPipelineRunDetail?.outputDeliveryMode || selectedPipelineRunSummary?.outputDeliveryMode,
    );
    const selectedPipelineRunStepDeliveries =
      selectedPipelineRunDetail?.deliveries.filter((delivery) => delivery.scope === "step") || [];
    const selectedPipelineRunFinalDeliveries =
      selectedPipelineRunDetail?.deliveries.filter((delivery) => delivery.scope === "final") || [];
    const visiblePipelineRunSummaries = pipelineRunSummaries.filter((run) =>
      visiblePipelineIdSet.has(run.pipelineId),
    );
    return (
      <section className="stack">
        <section className="panel pipeline-workbench">
          <div className="pipeline-workbench-sidebar">
            <ResourceToolbar title="Pipelines" detail="Inventaire, execution et traces" />
            <div className="pipeline-sidebar-actions">
              <button
                type="button"
                className="ghost-button"
                disabled={!currentUserCanOperate}
                onClick={resetPipelineBuilder}
              >
                Nouveau pipeline
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={!currentUserCanOperate}
                onClick={() => addPipelineDraftStep()}
              >
                Ajouter une etape
              </button>
            </div>
            <div className="pipeline-record-list">
              {visiblePipelines.map((pipeline) => (
                <article
                  key={pipeline.id}
                  className={`pipeline-record-card ${
                    editingPipelineId === pipeline.id ? "selected-entity-card" : ""
                  }`}
                >
                  <div className="info-row compact">
                    <strong>{pipeline.name}</strong>
                    <StatusPill status={pipeline.status}>{pipeline.status}</StatusPill>
                  </div>
                  <p>{pipeline.description || "Pipeline sans description."}</p>
                  <small className="muted-line">
                    {pipeline.steps.length} etape(s) · {formatPipelineOutputDeliveryMode(
                      pipeline.outputDeliveryMode,
                    )} · finales {pipeline.outputTargets.join(", ") || "aucune"}
                  </small>
                  <div className="button-row">
                    <button type="button" className="ghost-button" onClick={() => startPipelineEdit(pipeline)}>
                      Ouvrir
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={!canOperatePipelineRecord(pipeline)}
                      onClick={() => void handleDeletePipeline(pipeline.id)}
                    >
                      Supprimer
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={pipelineRunBusyId === pipeline.id || !canOperatePipelineRecord(pipeline)}
                      onClick={() => void handleRunPipeline(pipeline, pipelineRunInput)}
                    >
                      {pipelineRunBusyId === pipeline.id ? "Execution..." : "Executer"}
                    </button>
                  </div>
                </article>
              ))}
            </div>

            <section className="pipeline-run-panel">
              <div className="info-row compact">
                <strong>Run input</strong>
                <small className="muted-line">
                  {editingPipeline ? `pour ${editingPipeline.name}` : "sauvegarde puis execute"}
                </small>
              </div>
              <textarea
                className="textarea"
                rows={4}
                value={pipelineRunInput}
                onChange={(event) => setPipelineRunInput(event.target.value)}
                placeholder="Contexte operateur ou payload d'entree du pipeline..."
              />
              {editingPipeline ? (
                <button
                  type="button"
                  className="ghost-button"
                  disabled={
                    pipelineRunBusyId === editingPipeline.id ||
                    !canOperatePipelineRecord(editingPipeline)
                  }
                  onClick={() => void handleRunPipeline(editingPipeline, pipelineRunInput)}
                >
                  {pipelineRunBusyId === editingPipeline.id ? "Execution..." : "Executer ce pipeline"}
                </button>
              ) : (
                <small className="muted-line">Sauvegarde le pipeline pour lancer un run traçable.</small>
              )}
              <div className="info-row compact">
                <strong>Historique des runs</strong>
                <small className="muted-line">
                  {editingPipeline
                    ? `${visiblePipelineRunSummaries.length} run(s) pour ${editingPipeline.name}`
                    : `${visiblePipelineRunSummaries.length} run(s) recents, toutes pipelines`}
                </small>
              </div>
              {pipelineRunHistoryLoading && !visiblePipelineRunSummaries.length ? (
                <article className="callout">
                  <strong>Chargement des runs...</strong>
                  <p>Lecture du journal de runs pipeline depuis le store Elytras.</p>
                </article>
              ) : visiblePipelineRunSummaries.length ? (
                <>
                  <div className="pipeline-run-summary-list">
                    {visiblePipelineRunSummaries.map((run) => (
                      <button
                        key={run.id}
                        type="button"
                        className={`pipeline-run-summary-card ${
                          selectedPipelineRunId === run.id ? "active" : ""
                        }`}
                        onClick={() => setSelectedPipelineRunId(run.id)}
                      >
                        <div className="info-row compact">
                          <strong>
                            {editingPipeline ? `Run ${run.id.slice(0, 8)}` : run.pipelineName}
                          </strong>
                          <StatusPill status={run.status}>{run.status}</StatusPill>
                        </div>
                        <p>{summarizeText(run.input || run.error || "Run sans input explicite.")}</p>
                        <small className="muted-line">
                          {formatDateTime(run.startedAt)} · {formatRunDuration(run.startedAt, run.completedAt)}
                        </small>
                        <small className="muted-line">
                          {formatPipelineOutputDeliveryMode(run.outputDeliveryMode)} ·{" "}
                          {run.stepCount} etape(s) · {run.sessionCount} session(s)
                        </small>
                        <small className="muted-line">
                          {run.sentDeliveryCount}/{run.totalDeliveryCount} sortie(s) envoyee(s)
                        </small>
                      </button>
                    ))}
                  </div>

                  {selectedPipelineRunSummary ? (
                    selectedPipelineRunDetail &&
                    selectedPipelineRunDetail.id === selectedPipelineRunSummary.id ? (
                      <div className="pipeline-run-log-card">
                        <div className="info-row compact">
                          <div className="stack compact">
                            <strong>
                              {selectedPipelineRunDetail.pipelineName} · run {selectedPipelineRunDetail.id.slice(0, 8)}
                            </strong>
                            <small className="muted-line">
                              demarre {formatDateTime(selectedPipelineRunDetail.startedAt)} ·{" "}
                              {formatRunDuration(
                                selectedPipelineRunDetail.startedAt,
                                selectedPipelineRunDetail.completedAt,
                              )}
                            </small>
                          </div>
                          <StatusPill status={selectedPipelineRunDetail.status}>
                            {selectedPipelineRunDetail.status}
                          </StatusPill>
                        </div>

                        <div className="detail-pairs compact-grid">
                          <span>Pipeline</span>
                          <span>{selectedPipelineRunDetail.pipelineName}</span>
                          <span>Run ID</span>
                          <code className="mono">{selectedPipelineRunDetail.id}</code>
                          <span>Started</span>
                          <span>{formatDateTime(selectedPipelineRunDetail.startedAt)}</span>
                          <span>Completed</span>
                          <span>{formatDateTime(selectedPipelineRunDetail.completedAt)}</span>
                          <span>Delivery mode</span>
                          <span>{formatPipelineOutputDeliveryMode(selectedPipelineRunMode)}</span>
                          <span>Duree</span>
                          <span>
                            {formatRunDuration(
                              selectedPipelineRunDetail.startedAt,
                              selectedPipelineRunDetail.completedAt,
                            )}
                          </span>
                          <span>Final session</span>
                          <code className="mono">
                            {selectedPipelineRunDetail.finalSessionKey || "n/a"}
                          </code>
                        </div>

                        {selectedPipelineRunDetail.input ? (
                          <article className="pipeline-run-section">
                            <strong>Input operateur</strong>
                            <pre className="pipeline-run-output">
                              {selectedPipelineRunDetail.input}
                            </pre>
                          </article>
                        ) : null}

                        {selectedPipelineRunDetail.error ? (
                          <article className="pipeline-run-section">
                            <strong>Erreur finale</strong>
                            <pre className="pipeline-run-output">
                              {selectedPipelineRunDetail.error}
                            </pre>
                          </article>
                        ) : null}

                        <article className="pipeline-run-section">
                          <div className="info-row compact">
                            <strong>Etapes et sessions</strong>
                            <small className="muted-line">
                              {selectedPipelineRunDetail.steps.length} etape(s)
                            </small>
                          </div>
                          {selectedPipelineRunDetail.steps.length ? (
                            <div className="pipeline-run-step-list">
                              {selectedPipelineRunDetail.steps.map((step) => (
                                <article
                                  key={`${selectedPipelineRunDetail.id}:${step.stepId}`}
                                  className="pipeline-run-step-card"
                                >
                                  <div className="info-row compact">
                                    <strong>{step.stepName}</strong>
                                    <StatusPill status={step.status}>{step.status}</StatusPill>
                                  </div>
                                  <small className="muted-line">
                                    agent {step.agentId || "__static__"} · run {step.runId}
                                  </small>
                                  {step.sessionKey ? (
                                    <small className="muted-line">session {step.sessionKey}</small>
                                  ) : null}
                                  <pre className="pipeline-run-output">{summarizeText(step.output, 420)}</pre>
                                  {step.sessionKey ? (
                                    <div className="pipeline-run-transcript">
                                      <div className="info-row compact">
                                        <strong>Transcript d’etape</strong>
                                        <small className="muted-line">
                                          {pipelineStepHistoryLoading[step.sessionKey]
                                            ? "chargement..."
                                            : pipelineStepHistories[step.sessionKey]?.messages?.length || 0}{" "}
                                          message(s)
                                        </small>
                                      </div>
                                      {pipelineStepHistoryLoading[step.sessionKey] ? (
                                        <small className="muted-line">
                                          Recuperation de l’historique de session OpenClaw...
                                        </small>
                                      ) : pipelineStepHistoryErrors[step.sessionKey] ? (
                                        <pre className="pipeline-run-output">
                                          {pipelineStepHistoryErrors[step.sessionKey]}
                                        </pre>
                                      ) : pipelineStepHistories[step.sessionKey]?.messages?.length ? (
                                        <div className="messages-column pipeline-run-transcript-messages">
                                          {pipelineStepHistories[step.sessionKey].messages.map((message) => (
                                            <MessageBubble
                                              key={`${step.sessionKey}:${message.id}`}
                                              message={message}
                                            />
                                          ))}
                                        </div>
                                      ) : (
                                        <small className="muted-line">
                                          Aucun transcript visible pour cette etape.
                                        </small>
                                      )}
                                    </div>
                                  ) : null}
                                </article>
                              ))}
                            </div>
                          ) : (
                            <small className="muted-line">Aucune etape journalisee.</small>
                          )}
                        </article>

                        <article className="pipeline-run-section">
                          <div className="info-row compact">
                            <strong>Deliveries</strong>
                            <small className="muted-line">
                              {
                                selectedPipelineRunDetail.deliveries.filter(
                                  (entry) => entry.status === "sent",
                                ).length
                              }{" "}
                              / {selectedPipelineRunDetail.deliveries.length} envoyee(s)
                            </small>
                          </div>
                          <small className="muted-line">
                            {describePipelineOutputDeliveryMode(selectedPipelineRunMode)}
                          </small>
                          {selectedPipelineRunDetail.deliveries.length ? (
                            <div className="pipeline-run-step-list">
                              <article className="pipeline-run-step-card">
                                <div className="info-row compact">
                                  <strong>Sorties finales</strong>
                                  <StatusPill status={selectedPipelineRunFinalDeliveries.length ? "done" : "paused"}>
                                    {selectedPipelineRunFinalDeliveries.length}
                                  </StatusPill>
                                </div>
                                {selectedPipelineRunFinalDeliveries.length ? (
                                  <div className="pipeline-run-delivery-list">
                                    {selectedPipelineRunFinalDeliveries.map((delivery, index) => (
                                      <article
                                        key={`${selectedPipelineRunDetail.id}:delivery:final:${index}`}
                                        className="pipeline-run-delivery-card"
                                      >
                                        <div className="info-row compact">
                                          <strong>{delivery.channel}</strong>
                                          <StatusPill
                                            status={delivery.status === "sent" ? "done" : "paused"}
                                          >
                                            {delivery.status}
                                          </StatusPill>
                                        </div>
                                        <small className="muted-line">
                                          route {delivery.channelId} · account {delivery.accountId || "default"} ·
                                          {" "}destination {delivery.to || "n/a"}
                                        </small>
                                        <small className="muted-line">
                                          chatId {delivery.chatId || "n/a"} · messageId {delivery.messageId || "n/a"}
                                        </small>
                                        {delivery.reason ? (
                                          <pre className="pipeline-run-output">{delivery.reason}</pre>
                                        ) : null}
                                      </article>
                                    ))}
                                  </div>
                                ) : (
                                  <small className="muted-line">
                                    Aucune delivery finale pour ce run.
                                  </small>
                                )}
                              </article>

                              <article className="pipeline-run-step-card">
                                <div className="info-row compact">
                                  <strong>Sorties d'etape</strong>
                                  <StatusPill status={selectedPipelineRunStepDeliveries.length ? "done" : "paused"}>
                                    {selectedPipelineRunStepDeliveries.length}
                                  </StatusPill>
                                </div>
                                {selectedPipelineRunStepDeliveries.length ? (
                                  <div className="pipeline-run-delivery-list">
                                    {selectedPipelineRunStepDeliveries.map((delivery, index) => (
                                      <article
                                        key={`${selectedPipelineRunDetail.id}:delivery:step:${index}`}
                                        className="pipeline-run-delivery-card"
                                      >
                                        <div className="info-row compact">
                                          <strong>{delivery.channel}</strong>
                                          <StatusPill
                                            status={delivery.status === "sent" ? "done" : "paused"}
                                          >
                                            {delivery.status}
                                          </StatusPill>
                                        </div>
                                        <small className="muted-line">
                                          {delivery.stepName || delivery.stepId || "etape inconnue"}
                                        </small>
                                        <small className="muted-line">
                                          route {delivery.channelId} · account {delivery.accountId || "default"} ·
                                          {" "}destination {delivery.to || "n/a"}
                                        </small>
                                        <small className="muted-line">
                                          chatId {delivery.chatId || "n/a"} · messageId {delivery.messageId || "n/a"}
                                        </small>
                                        {delivery.reason ? (
                                          <pre className="pipeline-run-output">{delivery.reason}</pre>
                                        ) : null}
                                      </article>
                                    ))}
                                  </div>
                                ) : (
                                  <small className="muted-line">
                                    Aucune delivery d'etape pour ce run.
                                  </small>
                                )}
                              </article>
                            </div>
                          ) : (
                            <small className="muted-line">Aucune sortie externe pour ce run.</small>
                          )}
                        </article>

                        <article className="pipeline-run-section">
                          <div className="info-row compact">
                            <strong>Logs dates</strong>
                            <small className="muted-line">
                              {selectedPipelineRunDetail.logs.length} entree(s)
                            </small>
                          </div>
                          {selectedPipelineRunDetail.logs.length ? (
                            <div className="pipeline-run-log-list">
                              {selectedPipelineRunDetail.logs.map((entry, index) => (
                                <article
                                  key={`${selectedPipelineRunDetail.id}:${entry.timestamp}:${index}`}
                                  className={`pipeline-run-log-entry ${entry.level}`}
                                >
                                  <div className="info-row compact">
                                    <strong>{entry.stepName || "pipeline"}</strong>
                                    <small className="muted-line">
                                      {formatDateTime(entry.timestamp)}
                                    </small>
                                  </div>
                                  <p>{entry.message}</p>
                                </article>
                              ))}
                            </div>
                          ) : (
                            <small className="muted-line">Aucun log pour ce run.</small>
                          )}
                        </article>

                        {selectedPipelineRunDetail.finalOutput ? (
                          <article className="pipeline-run-section">
                            <strong>Sortie finale</strong>
                            <pre className="pipeline-run-output">
                              {selectedPipelineRunDetail.finalOutput}
                            </pre>
                          </article>
                        ) : null}
                      </div>
                    ) : (
                      <article className="callout">
                        <strong>Chargement du detail...</strong>
                        <p>Lecture des etapes, deliveries et logs pour le run selectionne.</p>
                      </article>
                    )
                  ) : null}
                </>
              ) : (
                <EmptyState
                  title="Aucun log de run"
                  body="Lance un pipeline depuis cette page pour inspecter les etapes, sorties et erreurs."
                />
              )}
            </section>
          </div>

          <div className="pipeline-workbench-main">
            <ResourceToolbar
              title="Pipeline Workbench"
              detail={
                pipelineEditorMode === "edit"
                  ? `Canvas de ${editingPipelineId}`
                  : "Nouveau pipeline multi-etapes"
              }
            >
              <StatusPill status={pipelineEditorMode === "edit" ? "running" : "active"}>
                {pipelineEditorMode}
              </StatusPill>
            </ResourceToolbar>

            <div className="pipeline-builder-hero">
              <div>
                <strong>Canvas draggable, modal de configuration, outputs visibles, logs lisibles.</strong>
                <p>
                  Clique un noeud pour l’editer dans un popup. Drag les etapes pour organiser le flow.
                  Relie deux noeuds pour creer un lien, ou double-clique un edge pour le supprimer.
                </p>
              </div>
              <div className="button-row">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={!currentUserCanOperate}
                  onClick={() => setPipelineOutputTargets(suggestedPipelineOutputTargets)}
                >
                  Outputs suggeres
                </button>
                {pipelineEditorMode === "edit" && editingPipeline ? (
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={!canOperatePipelineRecord(editingPipeline)}
                    onClick={() => void handleDeletePipeline(editingPipeline.id)}
                  >
                    Supprimer
                  </button>
                ) : null}
                <button
                  type="button"
                  className="ghost-button"
                  disabled={
                    !currentUserCanOperate ||
                    (pipelineEditorMode === "edit" &&
                      editingPipeline !== null &&
                      !canOperatePipelineRecord(editingPipeline))
                  }
                  onClick={() => void handleSavePipeline()}
                >
                  {pipelineEditorMode === "edit" ? "Sauvegarder" : "Creer"}
                </button>
              </div>
            </div>

            <div className="pipeline-metadata-grid">
              <label>
                Nom
                <input
                  className="input"
                  value={pipelineForm.name}
                  onChange={(event) =>
                    setPipelineForm((current) => ({ ...current, name: event.target.value }))
                  }
                />
              </label>
              <label>
                Owner
                <select
                  className="select"
                  value={
                    currentUserCanManageAdminViews
                      ? pipelineForm.ownerId
                      : selectedDashboardUser?.id || pipelineForm.ownerId
                  }
                  disabled={!currentUserCanManageAdminViews}
                  onChange={(event) =>
                    setPipelineForm((current) => ({ ...current, ownerId: event.target.value }))
                  }
                >
                  <option value="">Choisir</option>
                  {visibleUsers.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Team
                <select
                  className="select"
                  value={pipelineForm.teamId}
                  onChange={(event) =>
                    setPipelineForm((current) => {
                      const nextTeamId = event.target.value;
                      const nextAgentOptions = getTeamOwnedAgents(nextTeamId);
                      const fallbackAgentId =
                        nextAgentOptions[0]?.id || current.steps[0]?.agentId || "main";
                      const nextTeamChannelIds = new Set(
                        getTeamScopedOutputChannels(nextTeamId).map((channel) => channel.id),
                      );
                      return {
                        ...current,
                        teamId: nextTeamId,
                        outputTargets: splitList(current.outputTargets)
                          .filter((channelId) => nextTeamChannelIds.has(channelId))
                          .join(","),
                        steps: current.steps.map((step) => {
                          const nextAgentId = nextAgentOptions.some((agent) => agent.id === step.agentId)
                            ? step.agentId
                            : fallbackAgentId;
                          return {
                            ...step,
                            agentId: nextAgentId,
                            outputTargets: step.outputTargets.filter((channelId) =>
                              nextTeamChannelIds.has(channelId),
                            ),
                            skillIds: filterRequestedSkillsForAgentProvider(
                              nextAgentId,
                              modelProviderFromRef(
                                step.modelRef || getEffectiveAgentModelRef(nextAgentId),
                              ),
                              step.skillIds,
                            ),
                          };
                        }),
                      };
                    })
                  }
                >
                  <option value="">Aucune</option>
                  {visibleTeams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Status
                <select
                  className="select"
                  value={pipelineForm.status}
                  disabled={!currentUserCanManageAdminViews}
                  onChange={(event) =>
                    setPipelineForm((current) => ({
                      ...current,
                      status: event.target.value as PipelineForm["status"],
                    }))
                  }
                >
                  <option value="draft">draft</option>
                  <option value="queued">queued</option>
                  <option value="running">running</option>
                  <option value="paused">paused</option>
                  <option value="failed">failed</option>
                  <option value="done">done</option>
                </select>
              </label>
              <label>
                Politique de delivery
                <select
                  className="select"
                  value={pipelineOutputDeliveryMode}
                  onChange={(event) =>
                    setPipelineForm((current) => ({
                      ...current,
                      outputDeliveryMode: event.target.value as PipelineForm["outputDeliveryMode"],
                    }))
                  }
                >
                  <option value="final-only">Sortie finale uniquement</option>
                  <option value="step-only">Sorties d'etape uniquement</option>
                  <option value="step-and-final">Sorties d'etape + finale</option>
                </select>
              </label>
              <label className="field-span-2">
                Description
                <textarea
                  className="textarea"
                  rows={3}
                  value={pipelineForm.description}
                  onChange={(event) =>
                    setPipelineForm((current) => ({ ...current, description: event.target.value }))
                  }
                />
              </label>
            </div>

            <section className="pipeline-output-palette">
              <div className="info-row compact">
                <strong>Outputs pipeline</strong>
                <small className="muted-line">{describePipelineOutputDeliveryMode(pipelineOutputDeliveryMode)}</small>
              </div>
              <ChannelRouteMultiSelector
                channels={pipelineOutputChoices}
                channelTemplateById={channelTemplateById}
                selectedIds={pipelineRequestedOutputTargets}
                emptySelectionLabel="Aucune destination finale explicite"
                onChange={setPipelineOutputTargets}
              />
            </section>

            <PipelineFlowCanvas
              editingPipelineId={editingPipelineId}
              steps={pipelineForm.steps}
              selectedStepId={selectedDraftStep?.id || ""}
              nodePositions={pipelineNodePositions}
              outputDeliveryMode={pipelineOutputDeliveryMode}
              viewport={pipelineViewport}
              outputLabelsByStepId={pipelineFlowOutputLabelsByStepId}
              modelLabelsByStepId={pipelineFlowModelLabelsByStepId}
              onViewportChange={setPipelineViewport}
              onNodeClick={openPipelineDraftStepModal}
              onNodePositionsChange={handlePipelineFlowNodePositionsChange}
              onConnect={(connection) => {
                if (!connection.source || !connection.target || connection.source === connection.target) {
                  return;
                }
                const sourceStep = pipelineForm.steps.find((step) => step.id === connection.source);
                if (!sourceStep) {
                  return;
                }
                const nextStepIds = [...new Set([...sourceStep.nextStepIds, connection.target])];
                updatePipelineDraftStepConnections(sourceStep.id, nextStepIds);
              }}
              onEdgeDoubleClick={(edge) => {
                updatePipelineDraftStep(edge.source, (current) => {
                  const nextStepIds = current.nextStepIds.filter((entry) => entry !== edge.target);
                  return {
                    ...current,
                    nextStepIds,
                    routingMode:
                      nextStepIds.length === 0
                        ? "terminal"
                        : current.routingMode === "conditional"
                          ? "conditional"
                          : nextStepIds.length > 1
                            ? "fan-out"
                            : "linear",
                  };
                });
              }}
              onAddStep={() => addPipelineDraftStep()}
              onReset={resetPipelineBuilder}
            />
          </div>
        </section>

        {selectedDraftStep && pipelineStepModalOpen ? (
          <div className="pipeline-step-modal-backdrop" role="presentation" onClick={closePipelineDraftStepModal}>
            <div className="pipeline-step-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
              <div className="pipeline-step-modal-header">
                <div>
                  <strong>
                    Etape {selectedDraftStepIndex + 1} · {getPipelineDraftStepTitle(selectedDraftStep, selectedDraftStepIndex)}
                  </strong>
                  <p>
                    Agent {selectedDraftStep.agentId} · modele {selectedDraftStepEffectiveModelRef || "inherit"} · outputs{" "}
                    {selectedDraftStepEffectiveOutputs.length || 0}
                  </p>
                </div>
                <div className="button-row">
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={!currentUserCanOperate}
                    onClick={() => duplicatePipelineDraftStep(selectedDraftStep.id)}
                  >
                    Dupliquer
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={!currentUserCanOperate}
                    onClick={() => addPipelineDraftStep(selectedDraftStep.id)}
                  >
                    + apres
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={!currentUserCanOperate}
                    onClick={() => removePipelineDraftStep(selectedDraftStep.id)}
                  >
                    Supprimer l'etape
                  </button>
                  <button type="button" className="ghost-button" onClick={closePipelineDraftStepModal}>
                    Fermer
                  </button>
                </div>
              </div>

              <div className="pipeline-step-modal-body">
                <div className="form-grid">
                  <label className="field-span-2">
                    Nom
                    <input
                      className="input"
                      value={selectedDraftStep.name}
                      onChange={(event) =>
                        updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Agent
                    <select
                      className="select"
                      value={selectedDraftStep.agentId}
                      onChange={(event) =>
                        updatePipelineDraftStep(selectedDraftStep.id, (current) => {
                          const nextAgentId = event.target.value;
                          const nextAllowedProviders = getEffectiveAgentProviderIds(nextAgentId);
                          const currentModelProvider = modelProviderFromRef(current.modelRef);
                          const nextModelRef =
                            currentModelProvider && !nextAllowedProviders.includes(currentModelProvider)
                              ? ""
                              : current.modelRef;
                          return {
                            ...current,
                            agentId: nextAgentId,
                            modelRef: nextModelRef,
                            outputTargets: filterRequestedOutputTargetsForAgent(
                              nextAgentId,
                              current.outputTargets,
                            ),
                            skillIds: filterRequestedSkillsForAgentProvider(
                              nextAgentId,
                              modelProviderFromRef(
                                nextModelRef || getEffectiveAgentModelRef(nextAgentId),
                              ),
                              current.skillIds,
                            ),
                          };
                        })
                      }
                    >
                      {pipelineScopedAgents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.identity?.name || agent.name || agent.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Routage
                    <select
                      className="select"
                      value={selectedDraftStep.routingMode}
                      onChange={(event) =>
                        updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                          ...current,
                          routingMode: event.target.value as PipelineDraftStep["routingMode"],
                          condition: event.target.value === "conditional" ? current.condition : "",
                        }))
                      }
                    >
                      <option value="linear">linear</option>
                      <option value="fan-out">fan-out</option>
                      <option value="conditional">conditional</option>
                      <option value="terminal">terminal</option>
                    </select>
                  </label>
                  {selectedDraftStep.routingMode === "conditional" ? (
                    <label className="field-span-2">
                      Condition
                      <input
                        className="input"
                        value={selectedDraftStep.condition}
                        onChange={(event) =>
                          updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                            ...current,
                            condition: event.target.value,
                          }))
                        }
                        placeholder='score > 0.8, approved == true, contains "ok", le chiffre est plus grand que 5'
                      />
                      <div className="pipeline-condition-guide">
                        <div className="pipeline-condition-guide-head">
                          <strong>Branche 1 = si vrai</strong>
                          <strong>Branche 2 = sinon</strong>
                        </div>
                        <p>
                          Le runner comprend les comparaisons numeriques, l’egalite, les bools et
                          <code> contains</code>. Exemples: <code>score &gt; 0.8</code>,
                          <code> approved == true</code>,
                          <code> contains "ok"</code>,
                          <code> le chiffre est plus grand que 5</code>.
                        </p>
                      </div>
                    </label>
                  ) : null}
                  <label className="field-span-2">
                    Prompt
                    <textarea
                      className="textarea"
                      rows={6}
                      value={selectedDraftStep.prompt}
                      onChange={(event) =>
                        updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                          ...current,
                          prompt: event.target.value,
                        }))
                      }
                      placeholder="Instruction precise envoyee a l'agent..."
                    />
                  </label>
                </div>

                <section className="pipeline-step-modal-section">
                  <div className="info-row compact">
                    <strong>Liens</strong>
                    <small className="muted-line">
                      {selectedDraftStepEffectiveNextTitles.join(", ") || "fin"}
                    </small>
                  </div>
                  <div className="pipeline-target-grid">
                    {pipelineForm.steps
                      .filter((step) => step.id !== selectedDraftStep.id)
                      .map((candidateStep) => {
                        const selected = selectedDraftStepEffectiveNextIds.includes(candidateStep.id);
                        const candidateIndex = pipelineForm.steps.findIndex((step) => step.id === candidateStep.id);
                        const branchIndex = selectedDraftStepEffectiveNextIds.indexOf(candidateStep.id);
                        const branchHint =
                          selectedDraftStep.routingMode === "conditional" && branchIndex >= 0
                            ? branchIndex === 0
                              ? "si vrai"
                              : branchIndex === 1
                                ? "sinon"
                                : `sinon ${branchIndex}`
                            : "";
                        return (
                          <button
                            key={`step-target-${candidateStep.id}`}
                            type="button"
                            className={`pipeline-target-card ${selected ? "selected" : ""}`}
                            onClick={() => {
                              const nextIds = selected
                                ? selectedDraftStepEffectiveNextIds.filter((entry) => entry !== candidateStep.id)
                                : [...selectedDraftStepEffectiveNextIds, candidateStep.id];
                              updatePipelineDraftStepConnections(selectedDraftStep.id, nextIds);
                            }}
                          >
                            <div className="info-row compact">
                              <strong>{getPipelineDraftStepTitle(candidateStep, candidateIndex)}</strong>
                              <StatusPill status={selected ? "active" : "paused"}>
                                {selected ? branchHint || "liee" : "off"}
                              </StatusPill>
                            </div>
                            <small className="muted-line">
                              {candidateStep.agentId}
                              {branchHint ? ` · ${branchHint}` : ""}
                            </small>
                          </button>
                        );
                      })}
                  </div>
                </section>

                <section className="pipeline-step-modal-section">
                  <div className="info-row compact">
                    <strong>Outputs disponibles</strong>
                    <small className="muted-line">
                      {pipelineStepOutputsEnabled(pipelineOutputDeliveryMode)
                        ? "Seules les destinations cochees ici recevront la sortie de cette etape. Les outputs par defaut de l’agent ne s’appliquent pas dans un pipeline."
                        : "Ce pipeline n’envoie pas de sorties d’etape. Les selections de noeud restent memorisees pour un futur mode step-only ou step-and-final."}
                    </small>
                  </div>
                  {!pipelineStepOutputsEnabled(pipelineOutputDeliveryMode) ? (
                    <article className="pipeline-step-output-note">
                      <strong>Sorties de noeud masquees</strong>
                      <p>
                        Ce pipeline est en <code>{pipelineOutputDeliveryMode}</code>.{" "}
                        {pipelineFinalOutputsEnabled(pipelineOutputDeliveryMode)
                          ? "Les destinations selectionnees dans"
                          : "Aucune destination pipeline finale ne sera utilisee tant que"}{" "}
                        <em> Outputs pipeline</em>
                        {pipelineFinalOutputsEnabled(pipelineOutputDeliveryMode)
                          ? " seront les seules a recevoir un message."
                          : " reste en veille pour un futur mode final-only ou step-and-final."}
                      </p>
                    </article>
                  ) : (
                    <>
                      <ChannelRouteMultiSelector
                        channels={selectedDraftStepOutputChoices}
                        channelTemplateById={channelTemplateById}
                        selectedIds={selectedDraftStep.outputTargets}
                        disabledIds={selectedDraftStepOutputChoices
                          .filter(
                            (channel) =>
                              !(getAgentBinding(selectedDraftStep.agentId)?.channelIds || []).includes(
                                channel.id,
                              ),
                          )
                          .map((channel) => channel.id)}
                        emptySelectionLabel="Aucune sortie d'etape explicite"
                        onChange={(nextIds) =>
                          updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                            ...current,
                            outputTargets: nextIds,
                          }))
                        }
                      />
                    </>
                  )}
                </section>

                <section className="pipeline-step-modal-section">
                  <RuntimeModelPicker
                    label="Modele"
                    selectedModelRef={selectedDraftStep.modelRef}
                    effectiveModelRef={selectedDraftStepEffectiveModelRef}
                    inheritLabel="Heriter agent/runtime"
                    inheritDescription={
                      getEffectiveAgentModelRef(selectedDraftStep.agentId)
                        ? `Agent ${selectedDraftStep.agentId}: ${getEffectiveAgentModelRef(selectedDraftStep.agentId)}`
                        : `Agent ${selectedDraftStep.agentId}: aucun modele explicite`
                    }
                    models={getScopedRuntimeModels(selectedDraftStepEffectiveProviderIds)}
                    allowedProviders={selectedDraftStepEffectiveProviderIds}
                    onChange={(modelRef) =>
                      updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                        ...current,
                        modelRef,
                        skillIds: filterRequestedSkillsForAgentProvider(
                          current.agentId,
                          modelProviderFromRef(
                            sanitizeModelRefForAgent(current.agentId, modelRef) ||
                              getEffectiveAgentModelRef(current.agentId),
                          ),
                          current.skillIds,
                        ),
                      }))
                    }
                  />
                  <div className="pipeline-target-grid">
                    {getSkillOptionsForAgent(selectedDraftStep.agentId)
                      .filter((skill) => selectedDraftStepAllowedSkillIds.includes(skill.name))
                      .map((skill) => {
                        const selected = selectedDraftStep.skillIds.includes(skill.name);
                        return (
                          <button
                            key={`step-skill-${skill.name}`}
                            type="button"
                            className={`pipeline-target-card ${selected ? "selected" : ""}`}
                            onClick={() =>
                              updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                                ...current,
                                skillIds: selected
                                  ? current.skillIds.filter((entry) => entry !== skill.name)
                                  : [...current.skillIds, skill.name].toSorted((left, right) =>
                                      left.localeCompare(right),
                                    ),
                              }))
                            }
                          >
                            <div className="info-row compact">
                              <strong>{skill.name}</strong>
                              <StatusPill status={selected ? "active" : "paused"}>
                                {selected ? "active" : "off"}
                              </StatusPill>
                            </div>
                            <small className="muted-line">
                              {skill.description || skill.filePath || "Skill sans description"}
                            </small>
                          </button>
                        );
                      })}
                  </div>
                </section>

                <ExecutionSettingsPicker
                  title="Execution"
                  description="Override optionnel pour cette etape."
                  providerHint={modelProviderFromRef(selectedDraftStepEffectiveModelRef)}
                  profile={{
                    thinkingLevel: selectedDraftStep.thinkingLevel,
                    fastMode: selectedDraftStep.fastMode,
                    verboseLevel: selectedDraftStep.verboseLevel,
                    reasoningLevel: selectedDraftStep.reasoningLevel,
                  }}
                  effectiveProfile={{
                    thinkingLevel:
                      selectedDraftStep.thinkingLevel ||
                      getAgentExecutionSettings(selectedDraftStep.agentId).thinkingLevel,
                    fastMode:
                      typeof selectedDraftStep.fastMode === "boolean"
                        ? selectedDraftStep.fastMode
                        : getAgentExecutionSettings(selectedDraftStep.agentId).fastMode,
                    verboseLevel:
                      selectedDraftStep.verboseLevel ||
                      getAgentExecutionSettings(selectedDraftStep.agentId).verboseLevel,
                    reasoningLevel:
                      selectedDraftStep.reasoningLevel ||
                      getAgentExecutionSettings(selectedDraftStep.agentId).reasoningLevel,
                  }}
                  effectiveLabel="Valeur effective"
                  onChange={(patch) =>
                    updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                      ...current,
                      ...(Object.prototype.hasOwnProperty.call(patch, "thinkingLevel")
                        ? { thinkingLevel: patch.thinkingLevel || undefined }
                        : {}),
                      ...(Object.prototype.hasOwnProperty.call(patch, "fastMode")
                        ? {
                            fastMode:
                              typeof patch.fastMode === "boolean" ? patch.fastMode : undefined,
                          }
                        : {}),
                      ...(Object.prototype.hasOwnProperty.call(patch, "verboseLevel")
                        ? { verboseLevel: patch.verboseLevel || undefined }
                        : {}),
                      ...(Object.prototype.hasOwnProperty.call(patch, "reasoningLevel")
                        ? { reasoningLevel: patch.reasoningLevel || undefined }
                        : {}),
                    }))
                  }
                />
              </div>
            </div>
          </div>
        ) : null}
      </section>
    );
  }

  function renderPipelines() {
    return renderPipelinesWorkbench();
    const selectedDraftStep = selectedPipelineStep;
    const selectedDraftStepIndex = selectedDraftStep
      ? pipelineForm.steps.findIndex((step) => step.id === selectedDraftStep.id)
      : -1;
    const selectedDraftStepEffectiveModelRef = selectedDraftStep
      ? getEffectiveDraftStepModelRef(selectedDraftStep)
      : "";
    const selectedDraftStepEffectiveOutputs = selectedDraftStep
      ? getEffectiveDraftStepOutputTargets(selectedDraftStep)
      : [];
    const selectedDraftStepEffectiveSkills = selectedDraftStep
      ? getEffectiveDraftStepSkillIds(selectedDraftStep)
      : [];
    const selectedDraftStepAccessibleChannels = selectedDraftStep
      ? outputRouteChannels.filter((channel) =>
          (getAgentBinding(selectedDraftStep.agentId)?.channelIds || []).includes(channel.id),
        )
      : [];
    const selectedDraftStepEffectiveProviderIds = selectedDraftStep
      ? getEffectiveAgentProviderIds(selectedDraftStep.agentId)
      : activeRuntimeProviderIds;
    const selectedDraftStepEffectiveNextIds =
      selectedDraftStep && selectedDraftStepIndex >= 0
        ? getEffectiveDraftStepNextStepIds(
            selectedDraftStep,
            pipelineForm.steps,
            selectedDraftStepIndex,
          )
        : [];
    const selectedDraftStepEffectiveNextTitles = selectedDraftStep
      ? describeDraftStepNextTitles(selectedDraftStep, pipelineForm.steps)
      : [];
    const selectedDraftStepAllowedSkillIds = selectedDraftStep
      ? getAllowedSkillIdsForAgentProvider(
          selectedDraftStep.agentId,
          modelProviderFromRef(selectedDraftStepEffectiveModelRef),
        )
      : [];
    const selectedDraftStepExecution = selectedDraftStep
      ? mergeExecutionSettings(
          {
            thinkingLevel: selectedDraftStep.thinkingLevel,
            fastMode: selectedDraftStep.fastMode,
            verboseLevel: selectedDraftStep.verboseLevel,
            reasoningLevel: selectedDraftStep.reasoningLevel,
          },
          getAgentExecutionSettings(selectedDraftStep.agentId),
        )
      : undefined;
    const pipelineCanvasColumns = buildDraftPipelineCanvasColumns(pipelineForm.steps);
    const selectedPipelineEditor = selectedDraftStep ? (
      <>
        <div className="pipeline-canvas-editor-header">
          <article className="callout">
            <strong>
              Etape selectionnee {selectedDraftStepIndex + 1} ·{" "}
              {getPipelineDraftStepTitle(selectedDraftStep, selectedDraftStepIndex)}
            </strong>
            <p>
              Agent {selectedDraftStep.agentId} · modele{" "}
              {selectedDraftStepEffectiveModelRef || "inherit"} · outputs{" "}
              {selectedDraftStepEffectiveOutputs.join(", ") || "inherit"}
            </p>
            <small className="muted-line">
              Skills {selectedDraftStepEffectiveSkills.join(", ") || "aucune"} ·{" "}
              {selectedDraftStepExecution
                ? formatExecutionSummary(
                    selectedDraftStepExecution,
                    modelProviderFromRef(selectedDraftStepEffectiveModelRef),
                  )
                : "execution inherit"}
            </small>
          </article>
          <div className="button-row">
            <button
              type="button"
              className="ghost-button"
              onClick={() => movePipelineDraftStep(selectedDraftStep.id, -1)}
            >
              Monter
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => movePipelineDraftStep(selectedDraftStep.id, 1)}
            >
              Descendre
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => duplicatePipelineDraftStep(selectedDraftStep.id)}
            >
              Dupliquer
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => addPipelineDraftStep(selectedDraftStep.id)}
            >
              + apres
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => removePipelineDraftStep(selectedDraftStep.id)}
            >
              Supprimer
            </button>
          </div>
        </div>

        <div className="pipeline-canvas-quick-grid">
          <div className="form-grid">
            <label className="field-span-2">
              Nom de l’etape
              <input
                className="input"
                value={selectedDraftStep.name}
                onChange={(event) =>
                  updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder="Collect, Review, Dispatch..."
              />
            </label>
            <label className="field-span-2">
              Prompt de l’etape
              <textarea
                className="textarea"
                value={selectedDraftStep.prompt}
                onChange={(event) =>
                  updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                    ...current,
                    prompt: event.target.value,
                  }))
                }
                placeholder="Instruction envoyee a l’agent pour cette etape."
              />
            </label>
            <label>
              Agent
              <select
                className="select"
                value={selectedDraftStep.agentId}
                onChange={(event) =>
                  updatePipelineDraftStep(selectedDraftStep.id, (current) => {
                    const nextAgentId = event.target.value;
                    const nextAllowedProviders = getEffectiveAgentProviderIds(nextAgentId);
                    const currentModelProvider = modelProviderFromRef(current.modelRef);
                    const nextModelRef =
                      currentModelProvider && !nextAllowedProviders.includes(currentModelProvider)
                        ? ""
                        : current.modelRef;
                    return {
                      ...current,
                      agentId: nextAgentId,
                      modelRef: nextModelRef,
                      outputTargets: filterRequestedOutputTargetsForAgent(
                        nextAgentId,
                        current.outputTargets,
                      ),
                      skillIds: filterRequestedSkillsForAgentProvider(
                        nextAgentId,
                        modelProviderFromRef(
                          nextModelRef || getEffectiveAgentModelRef(nextAgentId),
                        ),
                        current.skillIds,
                      ),
                    };
                  })
                }
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.identity?.name || agent.name || agent.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Routage
              <select
                className="select"
                value={selectedDraftStep.routingMode}
                onChange={(event) =>
                  updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                    ...current,
                    routingMode: event.target.value as PipelineDraftStep["routingMode"],
                    condition: event.target.value === "conditional" ? current.condition : "",
                  }))
                }
              >
                <option value="linear">linear</option>
                <option value="fan-out">fan-out</option>
                <option value="conditional">conditional</option>
                <option value="terminal">terminal</option>
              </select>
            </label>
            {selectedDraftStep.routingMode === "conditional" ? (
              <label>
                Condition
                <input
                  className="input"
                  value={selectedDraftStep.condition}
                  onChange={(event) =>
                    updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                      ...current,
                      condition: event.target.value,
                    }))
                  }
                  placeholder="si score > 0.8, sinon fallback review"
                />
              </label>
            ) : null}
            <label>
              Prochaines etapes
              <input
                className="input"
                value={selectedDraftStepEffectiveNextTitles.join(", ") || "fin"}
                readOnly
              />
            </label>
          </div>
        </div>

        <details className="pipeline-canvas-section" open>
          <summary>Branches et liens</summary>
          <div className="selection-panel">
            <div className="button-row">
              <button
                type="button"
                className="ghost-button"
                onClick={() =>
                  updatePipelineDraftStep(selectedDraftStep.id, (current) => {
                    const currentIndex = pipelineForm.steps.findIndex(
                      (step) => step.id === current.id,
                    );
                    const sequentialNext = pipelineForm.steps[currentIndex + 1];
                    return {
                      ...current,
                      routingMode: "linear",
                      nextStepIds: sequentialNext ? [sequentialNext.id] : [],
                      condition: "",
                    };
                  })
                }
              >
                Connexion sequentielle
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() =>
                  updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                    ...current,
                    nextStepIds: [],
                    routingMode: "terminal",
                    condition: "",
                  }))
                }
              >
                Aucune sortie
              </button>
            </div>

            <div className="selection-grid compact-selection-grid">
              {pipelineForm.steps
                .filter((step) => step.id !== selectedDraftStep.id)
                .map((candidateStep) => {
                  const selectedTarget = selectedDraftStepEffectiveNextIds.includes(
                    candidateStep.id,
                  );
                  const candidateStepIndex = pipelineForm.steps.findIndex(
                    (step) => step.id === candidateStep.id,
                  );
                  return (
                    <button
                      key={`next-${selectedDraftStep.id}-${candidateStep.id}`}
                      type="button"
                      className={`runtime-model-card ${selectedTarget ? "selected" : ""}`}
                      onClick={() =>
                        updatePipelineDraftStep(selectedDraftStep.id, (current) => {
                          const currentStepIndex = pipelineForm.steps.findIndex(
                            (step) => step.id === current.id,
                          );
                          const effectiveCurrentNextIds = getEffectiveDraftStepNextStepIds(
                            current,
                            pipelineForm.steps,
                            currentStepIndex,
                          );
                          const nextStepIds = selectedTarget
                            ? effectiveCurrentNextIds.filter(
                                (nextStepId) => nextStepId !== candidateStep.id,
                              )
                            : [...effectiveCurrentNextIds, candidateStep.id].toSorted(
                                (left, right) => left.localeCompare(right),
                              );

                          return {
                            ...current,
                            nextStepIds,
                            routingMode:
                              nextStepIds.length === 0
                                ? "terminal"
                                : current.routingMode === "conditional"
                                  ? "conditional"
                                  : nextStepIds.length > 1
                                    ? "fan-out"
                                    : "linear",
                          };
                        })
                      }
                    >
                      <div className="info-row compact">
                        <strong>
                          {getPipelineDraftStepTitle(candidateStep, candidateStepIndex)}
                        </strong>
                        <StatusPill status={selectedTarget ? "active" : "paused"}>
                          {selectedTarget ? "liee" : "off"}
                        </StatusPill>
                      </div>
                      <small className="muted-line">{candidateStep.agentId}</small>
                    </button>
                  );
                })}
            </div>
          </div>
        </details>

        <details className="pipeline-canvas-section">
          <summary>Outputs</summary>
          <div className="selection-panel">
            <div className="info-row compact">
              <strong>Outputs du noeud</strong>
              <StatusPill status="active">
                {selectedDraftStepEffectiveOutputs.length} cible(s)
              </StatusPill>
            </div>
            <small className="muted-line">
              Seules les destinations cochees ici recevront une sortie d'etape. Si rien n’est choisi, ce noeud n’envoie rien.
            </small>
            <div className="button-row">
              <button
                type="button"
                className="ghost-button"
                onClick={() =>
                  updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                    ...current,
                    outputTargets: [],
                  }))
                }
              >
                Tout effacer
              </button>
            </div>
            {selectedDraftStepAccessibleChannels.length ? (
              <div className="selection-grid">
                {selectedDraftStepAccessibleChannels.map((channel) => {
                  const selected = selectedDraftStep.outputTargets.includes(channel.id);
                  return (
                    <button
                      key={`${selectedDraftStep.id}:${channel.id}`}
                      type="button"
                      className={`runtime-model-card ${selected ? "selected" : ""}`}
                      onClick={() =>
                        updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                          ...current,
                          outputTargets: selected
                            ? current.outputTargets.filter((entry) => entry !== channel.id)
                            : [...current.outputTargets, channel.id].toSorted((left, right) =>
                                left.localeCompare(right),
                              ),
                        }))
                      }
                    >
                      <div className="info-row compact">
                        <strong>{channel.name}</strong>
                        <StatusPill status={selected ? "active" : "paused"}>
                          {selected ? "actif" : "off"}
                        </StatusPill>
                      </div>
                      <small className="muted-line">
                        {channel.kind} · {channel.target || "target n/a"}
                      </small>
                    </button>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                title="Aucune destination accessible"
                body="Cet agent n’a pas de destination accessible dans le control tower."
              />
            )}
          </div>
        </details>

        <details className="pipeline-canvas-section">
          <summary>Modele et skills</summary>
          <RuntimeModelPicker
            label="Modele du noeud"
            selectedModelRef={selectedDraftStep.modelRef}
            effectiveModelRef={selectedDraftStepEffectiveModelRef}
            inheritLabel="Heriter agent/runtime"
            inheritDescription={
              getEffectiveAgentModelRef(selectedDraftStep.agentId)
                ? `Agent ${selectedDraftStep.agentId}: ${getEffectiveAgentModelRef(selectedDraftStep.agentId)}`
                : `Agent ${selectedDraftStep.agentId}: aucun modele explicite`
            }
            models={getScopedRuntimeModels(selectedDraftStepEffectiveProviderIds)}
            allowedProviders={selectedDraftStepEffectiveProviderIds}
            onChange={(modelRef) =>
              updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                ...current,
                modelRef,
                skillIds: filterRequestedSkillsForAgentProvider(
                  current.agentId,
                  modelProviderFromRef(
                    sanitizeModelRefForAgent(current.agentId, modelRef) ||
                      getEffectiveAgentModelRef(current.agentId),
                  ),
                  current.skillIds,
                ),
              }))
            }
          />

          <div className="selection-panel">
            <div className="info-row compact">
              <strong>Skills du noeud</strong>
              <StatusPill status="active">
                {selectedDraftStepEffectiveSkills.length} active(s)
              </StatusPill>
            </div>
            <small className="muted-line">
              Provider effectif{" "}
              {modelProviderFromRef(selectedDraftStepEffectiveModelRef) || "inherit"} · autorisees{" "}
              {selectedDraftStepAllowedSkillIds.length}
            </small>
            {selectedDraftStepAllowedSkillIds.length ? (
              <div className="selection-grid">
                {getSkillOptionsForAgent(selectedDraftStep.agentId)
                  .filter((skill) => selectedDraftStepAllowedSkillIds.includes(skill.name))
                  .map((skill) => {
                    const selected = selectedDraftStep.skillIds.includes(skill.name);
                    return (
                      <button
                        key={`${selectedDraftStep.id}:${skill.name}`}
                        type="button"
                        className={`runtime-model-card ${selected ? "selected" : ""}`}
                        onClick={() =>
                          updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                            ...current,
                            skillIds: selected
                              ? current.skillIds.filter((entry) => entry !== skill.name)
                              : [...current.skillIds, skill.name].toSorted((left, right) =>
                                  left.localeCompare(right),
                                ),
                          }))
                        }
                      >
                        <div className="info-row compact">
                          <strong>{skill.name}</strong>
                          <StatusPill status={selected ? "active" : "paused"}>
                            {selected ? "active" : "off"}
                          </StatusPill>
                        </div>
                        <small className="muted-line">
                          {skill.description || skill.filePath || "Skill sans description"}
                        </small>
                      </button>
                    );
                  })}
              </div>
            ) : (
              <EmptyState
                title="Aucune skill autorisee"
                body="La policy agent/provider ne laisse aucune skill active pour ce noeud."
              />
            )}
          </div>
        </details>

        <details className="pipeline-canvas-section">
          <summary>Execution</summary>
          <ExecutionSettingsPicker
            title="Variables du noeud"
            description="Override optionnel pour le noeud selectionne."
            providerHint={modelProviderFromRef(selectedDraftStepEffectiveModelRef)}
            profile={{
              thinkingLevel: selectedDraftStep.thinkingLevel,
              fastMode: selectedDraftStep.fastMode,
              verboseLevel: selectedDraftStep.verboseLevel,
              reasoningLevel: selectedDraftStep.reasoningLevel,
            }}
            effectiveProfile={{
              thinkingLevel:
                selectedDraftStep.thinkingLevel ||
                getAgentExecutionSettings(selectedDraftStep.agentId).thinkingLevel,
              fastMode:
                typeof selectedDraftStep.fastMode === "boolean"
                  ? selectedDraftStep.fastMode
                  : getAgentExecutionSettings(selectedDraftStep.agentId).fastMode,
              verboseLevel:
                selectedDraftStep.verboseLevel ||
                getAgentExecutionSettings(selectedDraftStep.agentId).verboseLevel,
              reasoningLevel:
                selectedDraftStep.reasoningLevel ||
                getAgentExecutionSettings(selectedDraftStep.agentId).reasoningLevel,
            }}
            effectiveLabel="Valeur effective"
            onChange={(patch) =>
              updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                ...current,
                ...(Object.prototype.hasOwnProperty.call(patch, "thinkingLevel")
                  ? { thinkingLevel: patch.thinkingLevel || undefined }
                  : {}),
                ...(Object.prototype.hasOwnProperty.call(patch, "fastMode")
                  ? {
                      fastMode: typeof patch.fastMode === "boolean" ? patch.fastMode : undefined,
                    }
                  : {}),
                ...(Object.prototype.hasOwnProperty.call(patch, "verboseLevel")
                  ? { verboseLevel: patch.verboseLevel || undefined }
                  : {}),
                ...(Object.prototype.hasOwnProperty.call(patch, "reasoningLevel")
                  ? { reasoningLevel: patch.reasoningLevel || undefined }
                  : {}),
              }))
            }
          />
        </details>
      </>
    ) : (
      <EmptyState
        title="Aucune etape selectionnee"
        body="Ajoute une etape ou clique un noeud du canvas pour afficher le detail."
      />
    );

    return (
      <section className="stack">
        <section className="panel">
          <ResourceToolbar
            title="Pipeline Builder"
            detail={
              pipelineEditorMode === "edit"
                ? `Edition visuelle du pipeline ${editingPipelineId}`
                : "Editeur visuel multi-etapes et multi-agents"
            }
          >
            <StatusPill status={pipelineEditorMode === "edit" ? "running" : "active"}>
              {pipelineEditorMode}
            </StatusPill>
          </ResourceToolbar>
          <div className="callout provider-callout">
            <strong>Builder visuel</strong>
            <p>
              Chaque etape choisit maintenant directement son agent, ses outputs, son modele, ses
              skills filtrees et ses overrides d’execution. Le builder applique les policies
              agent/provider avant la sauvegarde.
            </p>
            <small className="muted-line">
              Agents impliques {pipelineAgentIds.join(", ") || "aucun"} · outputs suggeres{" "}
              {suggestedPipelineOutputTargets.join(", ") || "aucun"}
            </small>
          </div>
          <div className="form-grid">
            <label>
              Nom
              <input
                className="input"
                value={pipelineForm.name}
                onChange={(event) =>
                  setPipelineForm((current) => ({ ...current, name: event.target.value }))
                }
              />
            </label>
            <label>
              Owner
              <select
                className="select"
                value={pipelineForm.ownerId}
                onChange={(event) =>
                  setPipelineForm((current) => ({ ...current, ownerId: event.target.value }))
                }
              >
                <option value="">Choisir</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Team
              <select
                className="select"
                value={pipelineForm.teamId}
                onChange={(event) =>
                  setPipelineForm((current) => ({ ...current, teamId: event.target.value }))
                }
              >
                <option value="">Aucune</option>
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-span-2">
              Description
              <textarea
                className="input textarea"
                rows={3}
                value={pipelineForm.description}
                onChange={(event) =>
                  setPipelineForm((current) => ({ ...current, description: event.target.value }))
                }
              />
            </label>
            <label>
              Outputs pipeline (csv)
              <input
                className="input"
                value={pipelineForm.outputTargets}
                onChange={(event) =>
                  setPipelineForm((current) => ({ ...current, outputTargets: event.target.value }))
                }
                placeholder="discord:ops,telegram:alerts"
              />
            </label>
            <label>
              Status
              <select
                className="select"
                value={pipelineForm.status}
                onChange={(event) =>
                  setPipelineForm((current) => ({ ...current, status: event.target.value }))
                }
              >
                <option value="draft">draft</option>
                <option value="queued">queued</option>
                <option value="running">running</option>
                <option value="paused">paused</option>
                <option value="failed">failed</option>
                <option value="done">done</option>
              </select>
            </label>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="ghost-button"
              onClick={() =>
                setPipelineForm((current) => ({
                  ...current,
                  outputTargets: suggestedPipelineOutputTargets.join(","),
                }))
              }
            >
              Appliquer les outputs suggeres
            </button>
            <button type="button" className="ghost-button" onClick={() => addPipelineDraftStep()}>
              Ajouter une etape
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => void handleSavePipeline()}
            >
              {pipelineEditorMode === "edit" ? "Sauvegarder le pipeline" : "Creer le pipeline"}
            </button>
            <button type="button" className="ghost-button" onClick={resetPipelineBuilder}>
              {pipelineEditorMode === "edit" ? "Annuler l’edition" : "Reinitialiser"}
            </button>
          </div>

          <section className="pipeline-canvas-shell">
            <div className="pipeline-canvas-board">
              <div className="info-row compact">
                <strong>Canvas pipeline</strong>
                <StatusPill status="active">{pipelineForm.steps.length} etape(s)</StatusPill>
              </div>
              <small className="muted-line">
                Vue graphe cliquable. Les branches et conditions sont affichees directement sur le
                flow et dans la carte des transitions.
              </small>
              <div className="pipeline-canvas-flow" ref={pipelineCanvasFlowRef}>
                {pipelineCanvasLayout.edges.length ? (
                  <svg
                    className="pipeline-canvas-links-layer"
                    width={pipelineCanvasLayout.width}
                    height={pipelineCanvasLayout.height}
                    viewBox={`0 0 ${pipelineCanvasLayout.width} ${pipelineCanvasLayout.height}`}
                    aria-hidden="true"
                  >
                    <defs>
                      <marker
                        id="pipeline-arrow-brand"
                        markerWidth="8"
                        markerHeight="8"
                        refX="6"
                        refY="4"
                        orient="auto"
                      >
                        <path d="M0,0 L8,4 L0,8 Z" fill="rgba(35, 75, 64, 0.42)" />
                      </marker>
                      <marker
                        id="pipeline-arrow-conditional"
                        markerWidth="8"
                        markerHeight="8"
                        refX="6"
                        refY="4"
                        orient="auto"
                      >
                        <path d="M0,0 L8,4 L0,8 Z" fill="rgba(197, 93, 45, 0.52)" />
                      </marker>
                    </defs>
                    {pipelineCanvasLayout.edges.map((edge) => {
                      const midX = (edge.startX + edge.endX) / 2;
                      const midY = (edge.startY + edge.endY) / 2;
                      const usesConditionalTone =
                        edge.routingMode === "conditional" || edge.routingMode === "fan-out";
                      return (
                        <g key={edge.key}>
                          <path
                            d={buildCanvasEdgePath(edge)}
                            className={`pipeline-canvas-edge ${edge.routingMode}`}
                            markerEnd={`url(#${usesConditionalTone ? "pipeline-arrow-conditional" : "pipeline-arrow-brand"})`}
                          />
                          <text
                            x={midX}
                            y={midY - 6}
                            textAnchor="middle"
                            className={`pipeline-canvas-edge-label ${edge.routingMode}`}
                          >
                            {edge.branchLabel}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                ) : null}

                <div className="pipeline-canvas-track" ref={pipelineCanvasTrackRef}>
                  {pipelineCanvasColumns.map((column) => (
                    <div
                      key={`canvas-column-${column.index}`}
                      className={`pipeline-canvas-column ${column.stepIds.length > 1 ? "branched" : ""}`}
                    >
                      <div className="info-row compact">
                        <span className="eyebrow">Stage {column.index + 1}</span>
                        <button
                          type="button"
                          className="pipeline-canvas-add-button"
                          onClick={() => addPipelineDraftStep(column.stepIds.at(-1))}
                        >
                          + etape
                        </button>
                      </div>
                      <div className="pipeline-canvas-column-stack">
                        {column.stepIds.map((stepId) => {
                          const stepIndex = pipelineForm.steps.findIndex(
                            (entry) => entry.id === stepId,
                          );
                          const step = pipelineForm.steps[stepIndex];
                          if (!step) {
                            return null;
                          }
                          const effectiveModelRef = getEffectiveDraftStepModelRef(step);
                          const effectiveOutputs = getEffectiveDraftStepOutputTargets(step);
                          const effectiveSkills = getEffectiveDraftStepSkillIds(step);
                          const connectionDescriptors = getDraftStepConnectionDescriptors(
                            step,
                            pipelineForm.steps,
                          );
                          const incomingDescriptors = getDraftStepIncomingDescriptors(
                            step.id,
                            pipelineForm.steps,
                          );
                          const selected = step.id === selectedDraftStep?.id;

                          return (
                            <div
                              key={`canvas-${step.id}`}
                              className="pipeline-canvas-node-shell"
                              ref={(node) => {
                                pipelineStepRefs.current[step.id] = node;
                              }}
                            >
                              <button
                                type="button"
                                className={`pipeline-canvas-node ${selected ? "selected" : ""}`}
                                onClick={() => focusPipelineDraftStep(step.id)}
                              >
                                <div className="pipeline-canvas-node-head">
                                  <span className="pipeline-canvas-index">{stepIndex + 1}</span>
                                  {incomingDescriptors.length ? (
                                    <div className="pipeline-canvas-incoming-list">
                                      {incomingDescriptors.map((descriptor) => (
                                        <span
                                          key={`${step.id}-incoming-${descriptor.sourceStepId}-${descriptor.branchLabel}`}
                                          className={`pipeline-branch-chip incoming ${descriptor.routingMode} readonly`}
                                        >
                                          <span className="mono">{descriptor.branchLabel}</span>
                                          <strong>{descriptor.sourceTitle}</strong>
                                        </span>
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                                <strong>{getPipelineDraftStepTitle(step, stepIndex)}</strong>
                                <small className="muted-line">
                                  {step.agentId} · {effectiveModelRef || "inherit"}
                                </small>
                                <div className="pipeline-canvas-chip-row">
                                  <span className={`pipeline-flow-chip ${step.routingMode}`}>
                                    {formatRoutingModeLabel(step.routingMode)}
                                  </span>
                                  <span className="pipeline-flow-chip neutral">
                                    {effectiveOutputs.length} output(s)
                                  </span>
                                  <span className="pipeline-flow-chip neutral">
                                    {effectiveSkills.length} skill(s)
                                  </span>
                                </div>
                                {step.routingMode === "conditional" && step.condition.trim() ? (
                                  <span className="pipeline-condition-pill compact">
                                    {step.condition.trim()}
                                  </span>
                                ) : null}
                                <div className="pipeline-canvas-branch-stack">
                                  {connectionDescriptors.map((descriptor, descriptorIndex) =>
                                    descriptor.kind === "terminal" ? (
                                      <span
                                        key={`${step.id}-terminal-${descriptorIndex}`}
                                        className="pipeline-branch-chip terminal readonly"
                                      >
                                        <span className="mono">{descriptor.branchLabel}</span>
                                        <strong>{descriptor.title}</strong>
                                      </span>
                                    ) : (
                                      <span
                                        key={`${step.id}-branch-${descriptor.targetStepId}`}
                                        className={`pipeline-branch-chip ${step.routingMode} readonly`}
                                      >
                                        <span className="mono">{descriptor.branchLabel}</span>
                                        <strong>{descriptor.title}</strong>
                                      </span>
                                    ),
                                  )}
                                </div>
                              </button>
                              <div className="pipeline-canvas-node-actions">
                                <button
                                  type="button"
                                  className="pipeline-canvas-mini-button"
                                  onClick={() => focusPipelineDraftStep(step.id)}
                                >
                                  Configurer
                                </button>
                                <button
                                  type="button"
                                  className="pipeline-canvas-mini-button"
                                  onClick={() => addPipelineDraftStep(step.id)}
                                >
                                  + apres
                                </button>
                              </div>
                            </div>
                          );
                        })}
                        <button
                          type="button"
                          className="pipeline-canvas-stage-button"
                          onClick={() => addPipelineDraftStep(column.stepIds.at(-1))}
                        >
                          Ajouter une etape dans ce stage
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div
                  className={`pipeline-canvas-editor ${
                    pipelineCanvasEditorPosition ? "" : "fallback"
                  }`}
                  style={
                    pipelineCanvasEditorPosition
                      ? {
                          left: pipelineCanvasEditorPosition.left,
                          top: pipelineCanvasEditorPosition.top,
                          width: pipelineCanvasEditorPosition.width,
                        }
                      : undefined
                  }
                >
                  {selectedPipelineEditor}
                </div>
              </div>

              <div className="pipeline-connection-map">
                <div className="info-row compact">
                  <strong>Carte des transitions</strong>
                  <small className="muted-line">
                    Lis les branches, conditions et sorties sans ouvrir chaque menu.
                  </small>
                </div>
                <div className="pipeline-connection-list">
                  {pipelineForm.steps.map((step, index) => {
                    const connectionDescriptors = getDraftStepConnectionDescriptors(
                      step,
                      pipelineForm.steps,
                    );
                    const selected = step.id === selectedDraftStep?.id;
                    return (
                      <div
                        key={`connection-${step.id}`}
                        className={`pipeline-connection-row ${selected ? "selected" : ""}`}
                      >
                        <button
                          type="button"
                          className="pipeline-connection-source"
                          onClick={() => focusPipelineDraftStep(step.id)}
                        >
                          <span className="eyebrow">Step {index + 1}</span>
                          <strong>{getPipelineDraftStepTitle(step, index)}</strong>
                          <small className="muted-line">{step.agentId}</small>
                        </button>
                        <div className="pipeline-connection-route">
                          <span className={`pipeline-flow-chip ${step.routingMode}`}>
                            {formatRoutingModeLabel(step.routingMode)}
                          </span>
                          {step.routingMode === "conditional" && step.condition.trim() ? (
                            <span className="pipeline-condition-pill">{step.condition.trim()}</span>
                          ) : (
                            <small className="muted-line">
                              {connectionDescriptors.length > 1
                                ? `${connectionDescriptors.length} branches`
                                : connectionDescriptors[0]?.kind === "terminal"
                                  ? "sortie terminale"
                                  : "route unique"}
                            </small>
                          )}
                        </div>
                        <div className="pipeline-connection-targets">
                          {connectionDescriptors.map((descriptor, descriptorIndex) =>
                            descriptor.kind === "terminal" ? (
                              <span
                                key={`${step.id}-connection-terminal-${descriptorIndex}`}
                                className="pipeline-connection-pill terminal"
                              >
                                <span className="mono">{descriptor.branchLabel}</span>
                                <strong>{descriptor.title}</strong>
                              </span>
                            ) : (
                              <button
                                key={`${step.id}-connection-${descriptor.targetStepId}`}
                                type="button"
                                className={`pipeline-connection-pill ${step.routingMode}`}
                                onClick={() => {
                                  if (descriptor.targetStepId) {
                                    focusPipelineDraftStep(descriptor.targetStepId);
                                  }
                                }}
                              >
                                <span className="mono">{descriptor.branchLabel}</span>
                                <strong>{descriptor.title}</strong>
                              </button>
                            ),
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="pipeline-canvas-dock">
              {selectedDraftStep ? (
                <>
                  <div className="pipeline-canvas-dock-header">
                    <article className="callout">
                      <strong>
                        Etape selectionnee {selectedDraftStepIndex + 1} ·{" "}
                        {getPipelineDraftStepTitle(selectedDraftStep, selectedDraftStepIndex)}
                      </strong>
                      <p>
                        Agent {selectedDraftStep.agentId} · modele{" "}
                        {selectedDraftStepEffectiveModelRef || "inherit"} · outputs{" "}
                        {selectedDraftStepEffectiveOutputs.join(", ") || "inherit"}
                      </p>
                      <small className="muted-line">
                        Skills {selectedDraftStepEffectiveSkills.join(", ") || "aucune"} ·{" "}
                        {selectedDraftStepExecution
                          ? formatExecutionSummary(
                              selectedDraftStepExecution,
                              modelProviderFromRef(selectedDraftStepEffectiveModelRef),
                            )
                          : "execution inherit"}
                      </small>
                    </article>
                    <div className="button-row">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => movePipelineDraftStep(selectedDraftStep.id, -1)}
                      >
                        Monter
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => movePipelineDraftStep(selectedDraftStep.id, 1)}
                      >
                        Descendre
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => duplicatePipelineDraftStep(selectedDraftStep.id)}
                      >
                        Dupliquer
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => addPipelineDraftStep(selectedDraftStep.id)}
                      >
                        + apres
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => removePipelineDraftStep(selectedDraftStep.id)}
                      >
                        Supprimer
                      </button>
                    </div>
                  </div>

                  <div className="pipeline-canvas-quick-grid">
                    <div className="form-grid">
                      <label className="field-span-2">
                        Nom de l’etape
                        <input
                          className="input"
                          value={selectedDraftStep.name}
                          onChange={(event) =>
                            updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                              ...current,
                              name: event.target.value,
                            }))
                          }
                          placeholder="Collect, Review, Dispatch..."
                        />
                      </label>
                      <label className="field-span-2">
                        Prompt de l’etape
                        <textarea
                          className="textarea"
                          value={selectedDraftStep.prompt}
                          onChange={(event) =>
                            updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                              ...current,
                              prompt: event.target.value,
                            }))
                          }
                          placeholder="Instruction envoyee a l’agent pour cette etape."
                        />
                      </label>
                      <label>
                        Agent
                        <select
                          className="select"
                          value={selectedDraftStep.agentId}
                          onChange={(event) =>
                            updatePipelineDraftStep(selectedDraftStep.id, (current) => {
                              const nextAgentId = event.target.value;
                              const nextAllowedProviders =
                                getEffectiveAgentProviderIds(nextAgentId);
                              const currentModelProvider = modelProviderFromRef(current.modelRef);
                              const nextModelRef =
                                currentModelProvider &&
                                !nextAllowedProviders.includes(currentModelProvider)
                                  ? ""
                                  : current.modelRef;
                              return {
                                ...current,
                                agentId: nextAgentId,
                                modelRef: nextModelRef,
                                outputTargets: filterRequestedOutputTargetsForAgent(
                                  nextAgentId,
                                  current.outputTargets,
                                ),
                                skillIds: filterRequestedSkillsForAgentProvider(
                                  nextAgentId,
                                  modelProviderFromRef(
                                    nextModelRef || getEffectiveAgentModelRef(nextAgentId),
                                  ),
                                  current.skillIds,
                                ),
                              };
                            })
                          }
                        >
                          {agents.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                              {agent.identity?.name || agent.name || agent.id}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Routage
                        <select
                          className="select"
                          value={selectedDraftStep.routingMode}
                          onChange={(event) =>
                            updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                              ...current,
                              routingMode: event.target.value as PipelineDraftStep["routingMode"],
                              condition:
                                event.target.value === "conditional" ? current.condition : "",
                            }))
                          }
                        >
                          <option value="linear">linear</option>
                          <option value="fan-out">fan-out</option>
                          <option value="conditional">conditional</option>
                          <option value="terminal">terminal</option>
                        </select>
                      </label>
                      {selectedDraftStep.routingMode === "conditional" ? (
                        <label>
                          Condition
                          <input
                            className="input"
                            value={selectedDraftStep.condition}
                            onChange={(event) =>
                              updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                                ...current,
                                condition: event.target.value,
                              }))
                            }
                            placeholder="si score > 0.8, sinon fallback review"
                          />
                        </label>
                      ) : null}
                      <label>
                        Prochaines etapes
                        <input
                          className="input"
                          value={selectedDraftStepEffectiveNextTitles.join(", ") || "fin"}
                          readOnly
                        />
                      </label>
                    </div>
                  </div>

                  <details className="pipeline-canvas-section" open>
                    <summary>Branches et liens</summary>
                    <div className="selection-panel">
                      <div className="button-row">
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() =>
                            updatePipelineDraftStep(selectedDraftStep.id, (current) => {
                              const currentIndex = pipelineForm.steps.findIndex(
                                (step) => step.id === current.id,
                              );
                              const sequentialNext = pipelineForm.steps[currentIndex + 1];
                              return {
                                ...current,
                                routingMode: "linear",
                                nextStepIds: sequentialNext ? [sequentialNext.id] : [],
                                condition: "",
                              };
                            })
                          }
                        >
                          Connexion sequentielle
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() =>
                            updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                              ...current,
                              nextStepIds: [],
                              routingMode: "terminal",
                              condition: "",
                            }))
                          }
                        >
                          Aucune sortie
                        </button>
                      </div>

                      <div className="selection-grid compact-selection-grid">
                        {pipelineForm.steps
                          .filter((step) => step.id !== selectedDraftStep.id)
                          .map((candidateStep) => {
                            const selectedTarget = selectedDraftStepEffectiveNextIds.includes(
                              candidateStep.id,
                            );
                            const candidateStepIndex = pipelineForm.steps.findIndex(
                              (step) => step.id === candidateStep.id,
                            );
                            return (
                              <button
                                key={`next-${selectedDraftStep.id}-${candidateStep.id}`}
                                type="button"
                                className={`runtime-model-card ${selectedTarget ? "selected" : ""}`}
                                onClick={() =>
                                  updatePipelineDraftStep(selectedDraftStep.id, (current) => {
                                    const currentStepIndex = pipelineForm.steps.findIndex(
                                      (step) => step.id === current.id,
                                    );
                                    const effectiveCurrentNextIds =
                                      getEffectiveDraftStepNextStepIds(
                                        current,
                                        pipelineForm.steps,
                                        currentStepIndex,
                                      );
                                    const nextStepIds = selectedTarget
                                      ? effectiveCurrentNextIds.filter(
                                          (nextStepId) => nextStepId !== candidateStep.id,
                                        )
                                      : [...effectiveCurrentNextIds, candidateStep.id].toSorted(
                                          (left, right) => left.localeCompare(right),
                                        );

                                    return {
                                      ...current,
                                      nextStepIds,
                                      routingMode:
                                        nextStepIds.length === 0
                                          ? "terminal"
                                          : current.routingMode === "conditional"
                                            ? "conditional"
                                            : nextStepIds.length > 1
                                              ? "fan-out"
                                              : "linear",
                                    };
                                  })
                                }
                              >
                                <div className="info-row compact">
                                  <strong>
                                    {getPipelineDraftStepTitle(candidateStep, candidateStepIndex)}
                                  </strong>
                                  <StatusPill status={selectedTarget ? "active" : "paused"}>
                                    {selectedTarget ? "liee" : "off"}
                                  </StatusPill>
                                </div>
                                <small className="muted-line">{candidateStep.agentId}</small>
                              </button>
                            );
                          })}
                      </div>
                    </div>
                  </details>

                  <details className="pipeline-canvas-section">
                    <summary>Outputs</summary>
                    <div className="selection-panel">
                      <div className="info-row compact">
                        <strong>Outputs du noeud</strong>
                        <StatusPill status="active">
                          {selectedDraftStepEffectiveOutputs.length} cible(s)
                        </StatusPill>
                      </div>
                      <small className="muted-line">
                        Seules les destinations cochees ici recevront une sortie d'etape. Si rien n’est choisi, ce noeud n’envoie rien.
                      </small>
                      <div className="button-row">
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() =>
                            updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                              ...current,
                              outputTargets: [],
                            }))
                          }
                        >
                          Tout effacer
                        </button>
                      </div>
                      {selectedDraftStepAccessibleChannels.length ? (
                        <div className="selection-grid">
                          {selectedDraftStepAccessibleChannels.map((channel) => {
                            const selected = selectedDraftStep.outputTargets.includes(channel.id);
                            return (
                              <button
                                key={`${selectedDraftStep.id}:${channel.id}`}
                                type="button"
                                className={`runtime-model-card ${selected ? "selected" : ""}`}
                                onClick={() =>
                                  updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                                    ...current,
                                    outputTargets: selected
                                      ? current.outputTargets.filter(
                                          (entry) => entry !== channel.id,
                                        )
                                      : [...current.outputTargets, channel.id].toSorted(
                                          (left, right) => left.localeCompare(right),
                                        ),
                                  }))
                                }
                              >
                                <div className="info-row compact">
                                  <strong>{channel.name}</strong>
                                  <StatusPill status={selected ? "active" : "paused"}>
                                    {selected ? "actif" : "off"}
                                  </StatusPill>
                                </div>
                                <small className="muted-line">
                                  {channel.kind} · {channel.target || "target n/a"}
                                </small>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <EmptyState
                          title="Aucune destination accessible"
                          body="Cet agent n’a pas de destination accessible dans le control tower."
                        />
                      )}
                    </div>
                  </details>

                  <details className="pipeline-canvas-section">
                    <summary>Modele et skills</summary>
                    <RuntimeModelPicker
                      label="Modele du noeud"
                      selectedModelRef={selectedDraftStep.modelRef}
                      effectiveModelRef={selectedDraftStepEffectiveModelRef}
                      inheritLabel="Heriter agent/runtime"
                      inheritDescription={
                        getEffectiveAgentModelRef(selectedDraftStep.agentId)
                          ? `Agent ${selectedDraftStep.agentId}: ${getEffectiveAgentModelRef(selectedDraftStep.agentId)}`
                          : `Agent ${selectedDraftStep.agentId}: aucun modele explicite`
                      }
                      models={getScopedRuntimeModels(selectedDraftStepEffectiveProviderIds)}
                      allowedProviders={selectedDraftStepEffectiveProviderIds}
                      onChange={(modelRef) =>
                        updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                          ...current,
                          modelRef,
                          skillIds: filterRequestedSkillsForAgentProvider(
                            current.agentId,
                            modelProviderFromRef(
                              sanitizeModelRefForAgent(current.agentId, modelRef) ||
                                getEffectiveAgentModelRef(current.agentId),
                            ),
                            current.skillIds,
                          ),
                        }))
                      }
                    />

                    <div className="selection-panel">
                      <div className="info-row compact">
                        <strong>Skills du noeud</strong>
                        <StatusPill status="active">
                          {selectedDraftStepEffectiveSkills.length} active(s)
                        </StatusPill>
                      </div>
                      <small className="muted-line">
                        Provider effectif{" "}
                        {modelProviderFromRef(selectedDraftStepEffectiveModelRef) || "inherit"} ·
                        autorisees {selectedDraftStepAllowedSkillIds.length}
                      </small>
                      {selectedDraftStepAllowedSkillIds.length ? (
                        <div className="selection-grid">
                          {getSkillOptionsForAgent(selectedDraftStep.agentId)
                            .filter((skill) =>
                              selectedDraftStepAllowedSkillIds.includes(skill.name),
                            )
                            .map((skill) => {
                              const selected = selectedDraftStep.skillIds.includes(skill.name);
                              return (
                                <button
                                  key={`${selectedDraftStep.id}:${skill.name}`}
                                  type="button"
                                  className={`runtime-model-card ${selected ? "selected" : ""}`}
                                  onClick={() =>
                                    updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                                      ...current,
                                      skillIds: selected
                                        ? current.skillIds.filter((entry) => entry !== skill.name)
                                        : [...current.skillIds, skill.name].toSorted(
                                            (left, right) => left.localeCompare(right),
                                          ),
                                    }))
                                  }
                                >
                                  <div className="info-row compact">
                                    <strong>{skill.name}</strong>
                                    <StatusPill status={selected ? "active" : "paused"}>
                                      {selected ? "active" : "off"}
                                    </StatusPill>
                                  </div>
                                  <small className="muted-line">
                                    {skill.description ||
                                      skill.filePath ||
                                      "Skill sans description"}
                                  </small>
                                </button>
                              );
                            })}
                        </div>
                      ) : (
                        <EmptyState
                          title="Aucune skill autorisee"
                          body="La policy agent/provider ne laisse aucune skill active pour ce noeud."
                        />
                      )}
                    </div>
                  </details>

                  <details className="pipeline-canvas-section">
                    <summary>Execution</summary>
                    <ExecutionSettingsPicker
                      title="Variables du noeud"
                      description="Override optionnel pour le noeud selectionne."
                      providerHint={modelProviderFromRef(selectedDraftStepEffectiveModelRef)}
                      profile={{
                        thinkingLevel: selectedDraftStep.thinkingLevel,
                        fastMode: selectedDraftStep.fastMode,
                        verboseLevel: selectedDraftStep.verboseLevel,
                        reasoningLevel: selectedDraftStep.reasoningLevel,
                      }}
                      effectiveProfile={{
                        thinkingLevel:
                          selectedDraftStep.thinkingLevel ||
                          getAgentExecutionSettings(selectedDraftStep.agentId).thinkingLevel,
                        fastMode:
                          typeof selectedDraftStep.fastMode === "boolean"
                            ? selectedDraftStep.fastMode
                            : getAgentExecutionSettings(selectedDraftStep.agentId).fastMode,
                        verboseLevel:
                          selectedDraftStep.verboseLevel ||
                          getAgentExecutionSettings(selectedDraftStep.agentId).verboseLevel,
                        reasoningLevel:
                          selectedDraftStep.reasoningLevel ||
                          getAgentExecutionSettings(selectedDraftStep.agentId).reasoningLevel,
                      }}
                      effectiveLabel="Valeur effective"
                      onChange={(patch) =>
                        updatePipelineDraftStep(selectedDraftStep.id, (current) => ({
                          ...current,
                          ...(Object.prototype.hasOwnProperty.call(patch, "thinkingLevel")
                            ? { thinkingLevel: patch.thinkingLevel || undefined }
                            : {}),
                          ...(Object.prototype.hasOwnProperty.call(patch, "fastMode")
                            ? {
                                fastMode:
                                  typeof patch.fastMode === "boolean" ? patch.fastMode : undefined,
                              }
                            : {}),
                          ...(Object.prototype.hasOwnProperty.call(patch, "verboseLevel")
                            ? { verboseLevel: patch.verboseLevel || undefined }
                            : {}),
                          ...(Object.prototype.hasOwnProperty.call(patch, "reasoningLevel")
                            ? { reasoningLevel: patch.reasoningLevel || undefined }
                            : {}),
                        }))
                      }
                    />
                  </details>
                  <small className="muted-line">
                    Le dock apparait seulement quand une etape est selectionnee dans le canvas.
                  </small>
                </>
              ) : (
                <EmptyState
                  title="Aucune etape selectionnee"
                  body="Ajoute une etape ou clique un noeud du canvas pour afficher le detail."
                />
              )}
            </div>
          </section>

          <div className="pipeline-builder-step-list">
            {pipelineForm.steps.map((step, index) => {
              const stepAccessibleChannels = getAgentAccessibleOutputChannels(
                step.agentId,
                pipelineForm.teamId,
              );
              const stepEffectiveProviderIds = getEffectiveAgentProviderIds(step.agentId);
              const stepEffectiveModelRef = getEffectiveDraftStepModelRef(step);
              const stepAllowedSkillIds = getAllowedSkillIdsForAgentProvider(
                step.agentId,
                modelProviderFromRef(stepEffectiveModelRef),
              );
              const effectiveStepSkillIds = getEffectiveDraftStepSkillIds(step);
              const effectiveStepOutputTargets = getEffectiveDraftStepOutputTargets(step);

              return (
                <article
                  key={step.id}
                  className={`pipeline-builder-step-card ${
                    selectedDraftStep?.id === step.id ? "selected-entity-card" : ""
                  }`}
                  onClick={() => setSelectedPipelineStepId(step.id)}
                >
                  <div className="pipeline-step-header">
                    <div className="stack compact">
                      <span className="eyebrow">Step {index + 1}</span>
                      <strong>{getPipelineDraftStepTitle(step, index)}</strong>
                    </div>
                    <div className="button-row">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => movePipelineDraftStep(step.id, -1)}
                      >
                        Monter
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => movePipelineDraftStep(step.id, 1)}
                      >
                        Descendre
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => duplicatePipelineDraftStep(step.id)}
                      >
                        Dupliquer
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => addPipelineDraftStep(step.id)}
                      >
                        Ajouter apres
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => removePipelineDraftStep(step.id)}
                      >
                        Supprimer
                      </button>
                    </div>
                  </div>

                  <div className="form-grid">
                    <label>
                      Nom de l’etape
                      <input
                        className="input"
                        value={step.name}
                        onChange={(event) =>
                          updatePipelineDraftStep(step.id, (current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                        placeholder="Collect, Review, Dispatch..."
                      />
                    </label>
                    <label className="field-span-2">
                      Prompt de l’etape
                      <textarea
                        className="textarea"
                        value={step.prompt}
                        onChange={(event) =>
                          updatePipelineDraftStep(step.id, (current) => ({
                            ...current,
                            prompt: event.target.value,
                          }))
                        }
                        placeholder="Instruction envoyee a l’agent pour cette etape."
                      />
                    </label>
                    <label>
                      Agent
                      <select
                        className="select"
                        value={step.agentId}
                        onChange={(event) =>
                          updatePipelineDraftStep(step.id, (current) => {
                            const nextAgentId = event.target.value;
                            const nextAllowedProviders = getEffectiveAgentProviderIds(nextAgentId);
                            const currentModelProvider = modelProviderFromRef(current.modelRef);
                            const nextModelRef =
                              currentModelProvider &&
                              !nextAllowedProviders.includes(currentModelProvider)
                                ? ""
                                : current.modelRef;
                            return {
                              ...current,
                              agentId: nextAgentId,
                              modelRef: nextModelRef,
                              outputTargets: filterRequestedOutputTargetsForAgent(
                                nextAgentId,
                                current.outputTargets,
                              ),
                              skillIds: filterRequestedSkillsForAgentProvider(
                                nextAgentId,
                                modelProviderFromRef(
                                  nextModelRef || getEffectiveAgentModelRef(nextAgentId),
                                ),
                                current.skillIds,
                              ),
                            };
                          })
                        }
                      >
                        {pipelineScopedAgents.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.identity?.name || agent.name || agent.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Flow suivant
                      <input
                        className="input"
                        value={
                          describeDraftStepNextTitles(step, pipelineForm.steps).join(", ") || "fin"
                        }
                        readOnly
                      />
                    </label>
                    <label>
                      Routage
                      <input className="input" value={step.routingMode} readOnly />
                    </label>
                  </div>

                  <div className="selection-panel">
                    <div className="info-row compact">
                      <strong>Outputs de l’etape</strong>
                      <StatusPill status="active">
                        {effectiveStepOutputTargets.length} cible(s)
                      </StatusPill>
                    </div>
                    <small className="muted-line">
                      Seules les destinations cochees ici recevront une sortie d'etape. Si rien n’est choisi, cette etape n’envoie rien.
                    </small>
                    <div className="button-row">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() =>
                          updatePipelineDraftStep(step.id, (current) => ({
                            ...current,
                            outputTargets: [],
                          }))
                        }
                      >
                        Tout effacer
                      </button>
                    </div>
                    {stepAccessibleChannels.length ? (
                      <div className="selection-grid">
                        {stepAccessibleChannels.map((channel) => {
                          const selected = step.outputTargets.includes(channel.id);
                          return (
                            <button
                              key={`${step.id}:${channel.id}`}
                              type="button"
                              className={`runtime-model-card ${selected ? "selected" : ""}`}
                              onClick={() =>
                                updatePipelineDraftStep(step.id, (current) => ({
                                  ...current,
                                  outputTargets: selected
                                    ? current.outputTargets.filter((entry) => entry !== channel.id)
                                    : [...current.outputTargets, channel.id].toSorted(
                                        (left, right) => left.localeCompare(right),
                                      ),
                                }))
                              }
                            >
                              <div className="info-row compact">
                                <strong>{channel.name}</strong>
                                <StatusPill status={selected ? "active" : "paused"}>
                                  {selected ? "actif" : "off"}
                                </StatusPill>
                              </div>
                              <small className="muted-line">
                                {channel.kind} · {channel.target || "target n/a"}
                              </small>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <EmptyState
                        title="Aucune destination accessible"
                        body="Cet agent n’a pas de destination accessible dans le control tower."
                      />
                    )}
                  </div>

                  <RuntimeModelPicker
                    label="Modele de l’etape"
                    selectedModelRef={step.modelRef}
                    effectiveModelRef={stepEffectiveModelRef}
                    inheritLabel="Heriter agent/runtime"
                    inheritDescription={
                      getEffectiveAgentModelRef(step.agentId)
                        ? `Agent ${step.agentId}: ${getEffectiveAgentModelRef(step.agentId)}`
                        : `Agent ${step.agentId}: aucun modele explicite`
                    }
                    models={getScopedRuntimeModels(stepEffectiveProviderIds)}
                    allowedProviders={stepEffectiveProviderIds}
                    onChange={(modelRef) =>
                      updatePipelineDraftStep(step.id, (current) => ({
                        ...current,
                        modelRef,
                        skillIds: filterRequestedSkillsForAgentProvider(
                          current.agentId,
                          modelProviderFromRef(
                            sanitizeModelRefForAgent(current.agentId, modelRef) ||
                              getEffectiveAgentModelRef(current.agentId),
                          ),
                          current.skillIds,
                        ),
                      }))
                    }
                  />

                  <div className="selection-panel">
                    <div className="info-row compact">
                      <strong>Skills de l’etape</strong>
                      <StatusPill status="active">
                        {effectiveStepSkillIds.length} active(s)
                      </StatusPill>
                    </div>
                    <small className="muted-line">
                      Provider effectif {modelProviderFromRef(stepEffectiveModelRef) || "inherit"} ·
                      autorisees {stepAllowedSkillIds.length}
                    </small>
                    {stepAllowedSkillIds.length ? (
                      <div className="selection-grid">
                        {getSkillOptionsForAgent(step.agentId)
                          .filter((skill) => stepAllowedSkillIds.includes(skill.name))
                          .map((skill) => {
                            const selected = step.skillIds.includes(skill.name);
                            return (
                              <button
                                key={`${step.id}:${skill.name}`}
                                type="button"
                                className={`runtime-model-card ${selected ? "selected" : ""}`}
                                onClick={() =>
                                  updatePipelineDraftStep(step.id, (current) => ({
                                    ...current,
                                    skillIds: selected
                                      ? current.skillIds.filter((entry) => entry !== skill.name)
                                      : [...current.skillIds, skill.name].toSorted((left, right) =>
                                          left.localeCompare(right),
                                        ),
                                  }))
                                }
                              >
                                <div className="info-row compact">
                                  <strong>{skill.name}</strong>
                                  <StatusPill status={selected ? "active" : "paused"}>
                                    {selected ? "active" : "off"}
                                  </StatusPill>
                                </div>
                                <small className="muted-line">
                                  {skill.description || skill.filePath || "Skill sans description"}
                                </small>
                              </button>
                            );
                          })}
                      </div>
                    ) : (
                      <EmptyState
                        title="Aucune skill autorisee"
                        body="La policy agent/provider ne laisse aucune skill active pour cette etape."
                      />
                    )}
                  </div>

                  <ExecutionSettingsPicker
                    title="Variables de l’etape"
                    description="Override optionnel pour cette etape du pipeline."
                    providerHint={modelProviderFromRef(stepEffectiveModelRef)}
                    profile={{
                      thinkingLevel: step.thinkingLevel,
                      fastMode: step.fastMode,
                      verboseLevel: step.verboseLevel,
                      reasoningLevel: step.reasoningLevel,
                    }}
                    effectiveProfile={{
                      thinkingLevel:
                        step.thinkingLevel || getAgentExecutionSettings(step.agentId).thinkingLevel,
                      fastMode:
                        typeof step.fastMode === "boolean"
                          ? step.fastMode
                          : getAgentExecutionSettings(step.agentId).fastMode,
                      verboseLevel:
                        step.verboseLevel || getAgentExecutionSettings(step.agentId).verboseLevel,
                      reasoningLevel:
                        step.reasoningLevel ||
                        getAgentExecutionSettings(step.agentId).reasoningLevel,
                    }}
                    effectiveLabel="Valeur effective"
                    onChange={(patch) =>
                      updatePipelineDraftStep(step.id, (current) => ({
                        ...current,
                        ...(Object.prototype.hasOwnProperty.call(patch, "thinkingLevel")
                          ? { thinkingLevel: patch.thinkingLevel || undefined }
                          : {}),
                        ...(Object.prototype.hasOwnProperty.call(patch, "fastMode")
                          ? {
                              fastMode:
                                typeof patch.fastMode === "boolean" ? patch.fastMode : undefined,
                            }
                          : {}),
                        ...(Object.prototype.hasOwnProperty.call(patch, "verboseLevel")
                          ? { verboseLevel: patch.verboseLevel || undefined }
                          : {}),
                        ...(Object.prototype.hasOwnProperty.call(patch, "reasoningLevel")
                          ? { reasoningLevel: patch.reasoningLevel || undefined }
                          : {}),
                      }))
                    }
                  />
                </article>
              );
            })}
          </div>

          <section className="pipeline-outline-panel">
            <ResourceToolbar
              title="Node Navigator"
              detail="Navigation compacte du flow pendant l’edition canvas"
            />
            <div className="pipeline-outline-grid">
              {pipelineForm.steps.map((step, index) => (
                <button
                  key={`outline-${step.id}`}
                  type="button"
                  className={`pipeline-outline-card ${
                    selectedDraftStep?.id === step.id ? "selected-entity-card" : ""
                  }`}
                  onClick={() => focusPipelineDraftStep(step.id)}
                >
                  <span className="eyebrow">Step {index + 1}</span>
                  <strong>{getPipelineDraftStepTitle(step, index)}</strong>
                  <small className="muted-line">
                    {step.agentId} · {step.routingMode} · vers{" "}
                    {describeDraftStepNextTitles(step, pipelineForm.steps).join(", ") || "fin"}
                  </small>
                </button>
              ))}
            </div>
          </section>
        </section>

        <section className="panel">
          <ResourceToolbar title="Pipelines" detail="Inventaire operateur des pipelines" />
          <div className="card-grid">
            {pipelines.length === 0 ? (
              <EmptyState
                title="Aucun pipeline"
                body="Le store compagnon est vide pour l'instant."
              />
            ) : (
              pipelines.map((pipeline) => (
                <article
                  key={pipeline.id}
                  className={`entity-card ${editingPipelineId === pipeline.id ? "selected-entity-card" : ""}`}
                >
                  <div className="info-row compact">
                    <strong>{pipeline.name}</strong>
                    <StatusPill status={pipeline.status}>{pipeline.status}</StatusPill>
                  </div>
                  <p>{pipeline.description}</p>
                  <small className="muted-line">
                    owner {ownerName(pipeline.ownerId)} · team{" "}
                    {teamName(pipeline.teamId)}
                  </small>
                  <small className="muted-line">
                    {pipeline.steps.length} etapes · outputs{" "}
                    {pipeline.outputTargets.join(", ") || "n/a"}
                  </small>
                  <div className="pipeline-step-list">
                    {pipeline.steps.map((step) => (
                      <article key={step.id} className="pipeline-step-card">
                        <div className="info-row compact">
                          <strong>{step.name}</strong>
                          <StatusPill status={step.status}>{step.status}</StatusPill>
                        </div>
                        <small className="muted-line">
                          agent {step.agentId} · output{" "}
                          {getEffectivePipelineStepOutputTargets(step).join(", ") || "n/a"} · skills{" "}
                          {getEffectivePipelineStepSkillIds(step).join(", ") || "n/a"}
                        </small>
                        <small className="muted-line">
                          {step.routingMode || "linear"} · vers{" "}
                          {describePipelineStepNextTitles(step, pipeline.steps).join(", ") || "fin"}
                          {step.condition ? ` · ${step.condition}` : ""}
                        </small>
                        <RuntimeModelPicker
                          label="Modele de l’etape"
                          selectedModelRef={step.modelRef}
                          effectiveModelRef={getEffectivePipelineStepModelRef(step)}
                          inheritLabel="Heriter agent/runtime"
                          inheritDescription={
                            getEffectiveAgentModelRef(step.agentId)
                              ? `Agent ${step.agentId}: ${getEffectiveAgentModelRef(step.agentId)}`
                              : `Agent ${step.agentId}: aucun modele explicite`
                          }
                          models={getScopedRuntimeModels(
                            getEffectiveAgentProviderIds(step.agentId),
                          )}
                          allowedProviders={getEffectiveAgentProviderIds(step.agentId)}
                          onChange={(modelRef) =>
                            void handlePipelineStepModelAssignment(pipeline, step.id, modelRef)
                          }
                        />
                        <ExecutionSettingsPicker
                          title="Variables de l’etape"
                          description="Override optionnel pour cette etape du pipeline."
                          providerHint={modelProviderFromRef(
                            getEffectivePipelineStepModelRef(step),
                          )}
                          profile={{
                            thinkingLevel: step.thinkingLevel,
                            fastMode: step.fastMode,
                            verboseLevel: step.verboseLevel,
                            reasoningLevel: step.reasoningLevel,
                          }}
                          effectiveProfile={getEffectivePipelineStepExecutionSettings(step)}
                          effectiveLabel="Valeur effective"
                          onChange={(patch) =>
                            void handlePipelineStepExecutionSettingsAssignment(
                              pipeline,
                              step.id,
                              patch,
                            )
                          }
                        />
                      </article>
                    ))}
                  </div>
                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => startPipelineEdit(pipeline)}
                    >
                      Modifier
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={pipelineRunBusyId === pipeline.id}
                      onClick={() => void handleRunPipeline(pipeline)}
                    >
                      {pipelineRunBusyId === pipeline.id ? "Execution..." : "Executer"}
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={async () => {
                        const deleted = await mutateResource(
                          "delete",
                          "pipelines",
                          {},
                          pipeline.id,
                        );
                        if (deleted && editingPipelineId === pipeline.id) {
                          resetPipelineBuilder();
                        }
                      }}
                    >
                      Supprimer
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </section>
    );
  }

  function renderCron() {
    const cronDraftTargetLabel =
      cronForm.targetType === "pipeline"
        ? selectedCronPipeline
          ? `Pipeline · ${selectedCronPipeline.name}`
          : "Pipeline non choisi"
        : cronForm.agentId
          ? `Requete agent · ${cronForm.agentId}`
          : "Agent non choisi";
    const cronDraftStatusLabel = cronForm.schedule.trim() ? "Sera actif" : "Cree en pause";
    const cronDraftExpressionLabel = cronForm.schedule.trim() || "Aucune expression generee";
    const cronDraftOutputsLabel = suggestedCronOutputChannels.length
      ? `${suggestedCronOutputChannels.length} sortie${suggestedCronOutputChannels.length > 1 ? "s" : ""} heritee${suggestedCronOutputChannels.length > 1 ? "s" : ""}`
      : "Aucune sortie heritee";
    return (
      <section className="stack">
        <section className="panel">
          <ResourceToolbar
            title="Cron Kanban"
            detail="Ajouter des jobs dans la couche control tower"
          />
          <div className="callout provider-callout">
            <strong>Automatisation via cron uniquement</strong>
            <p>
              Les pipelines restent declenchables a la main ou via API. Toute planification vit ici,
              dans <code>Cron Jobs</code>, soit vers un pipeline, soit vers une requete simple agent.
            </p>
            <small className="muted-line">
              Planification optionnelle. Si tu la laisses vide, le job sera cree en pause. Les
              sorties et le statut sont derives automatiquement cote runtime.
            </small>
            <div className="pipeline-selection-strip">
              {suggestedCronOutputChannels.length ? (
                suggestedCronOutputChannels.map((channel) => (
                  <span key={`cron-suggested-${channel.id}`} className="inline-tag">
                    {buildChannelRouteSummary(channel, channelTemplateById.get(channel.kind))}
                  </span>
                ))
              ) : (
                <span className="inline-tag">Les sorties seront heritees automatiquement</span>
              )}
            </div>
          </div>
          <div className="cron-composer">
            <div className="cron-builder-card">
              <div className="form-grid">
                <label>
                  Nom
                  <input
                    className="input"
                    value={cronForm.name}
                    onChange={(event) =>
                      setCronForm((current) => ({ ...current, name: event.target.value }))
                    }
                  />
                </label>
                <label>
                  Type
                  <select
                    className="select"
                    value={cronForm.targetType}
                    onChange={(event) =>
                      setCronForm((current) => ({
                        ...current,
                        targetType: event.target.value as "pipeline" | "request",
                        pipelineId: event.target.value === "pipeline" ? current.pipelineId : "",
                        agentId: event.target.value === "request" ? current.agentId : "",
                      }))
                    }
                  >
                    <option value="pipeline">pipeline</option>
                    <option value="request">request</option>
                  </select>
                </label>
                <label>
                  Owner
                  <select
                    className="select"
                    value={
                      currentUserCanManageAdminViews
                        ? cronForm.ownerId
                        : selectedDashboardUser?.id || cronForm.ownerId
                    }
                    disabled={!currentUserCanManageAdminViews}
                    onChange={(event) =>
                      setCronForm((current) => ({ ...current, ownerId: event.target.value }))
                    }
                  >
                    <option value="">Choisir</option>
                    {visibleUsers.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name}
                      </option>
                    ))}
                  </select>
                </label>
                {cronForm.targetType === "request" ? (
                  <label>
                    Agent
                    <select
                      className="select"
                      value={cronForm.agentId}
                      onChange={(event) =>
                        setCronForm((current) => ({ ...current, agentId: event.target.value }))
                      }
                    >
                      <option value="">Choisir</option>
                      {visibleAgents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.id}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label>
                    Pipeline
                    <select
                      className="select"
                      value={cronForm.pipelineId}
                      onChange={(event) =>
                        setCronForm((current) => ({ ...current, pipelineId: event.target.value }))
                      }
                    >
                      <option value="">Choisir</option>
                      {visiblePipelines.map((pipeline) => (
                        <option key={pipeline.id} value={pipeline.id}>
                          {pipeline.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="field-span-2">
                  Mode de lancement
                  <select
                    className="select"
                    value={cronScheduleBuilder.mode}
                    onChange={(event) => {
                      const nextBuilder = switchCronScheduleMode(
                        cronForm.schedule,
                        event.target.value as CronScheduleMode,
                      );
                      setCronForm((current) => ({
                        ...current,
                        schedule: nextBuilder.expression,
                      }));
                    }}
                  >
                    <option value="none">Sans recurrence</option>
                    <option value="every">Toutes les X minutes/heures</option>
                    <option value="daily">Chaque jour</option>
                    <option value="weekdays">Lun-Ven</option>
                    <option value="weekly">Chaque semaine</option>
                    <option value="monthly">Chaque mois</option>
                    <option value="custom">Expression libre</option>
                  </select>
                </label>
                <div className="field-span-2 cron-preset-stack">
                  <div className="cron-preset-row">
                    <button
                      type="button"
                      className={`ghost-button cron-preset-button ${cronScheduleBuilder.mode === "none" ? "active" : ""}`}
                      onClick={() => applyCronPreset("none")}
                    >
                      Manuel
                    </button>
                    <button
                      type="button"
                      className={`ghost-button cron-preset-button ${cronScheduleBuilder.mode === "every" ? "active" : ""}`}
                      onClick={() => applyCronPreset("every", { interval: 15, unit: "minutes" })}
                    >
                      Toutes les 15 min
                    </button>
                    <button
                      type="button"
                      className={`ghost-button cron-preset-button ${cronScheduleBuilder.mode === "daily" ? "active" : ""}`}
                      onClick={() => applyCronPreset("daily", { time: "09:00" })}
                    >
                      Chaque jour 09:00
                    </button>
                    <button
                      type="button"
                      className={`ghost-button cron-preset-button ${cronScheduleBuilder.mode === "weekdays" ? "active" : ""}`}
                      onClick={() => applyCronPreset("weekdays", { time: "09:00" })}
                    >
                      Lun-Ven 09:00
                    </button>
                    <button
                      type="button"
                      className={`ghost-button cron-preset-button ${cronScheduleBuilder.mode === "weekly" ? "active" : ""}`}
                      onClick={() => applyCronPreset("weekly", { time: "09:00", weekday: "1" })}
                    >
                      Chaque lundi 09:00
                    </button>
                  </div>
                  <small className="muted-line">{describeCronScheduleMode(cronScheduleBuilder.mode)}</small>
                </div>
                <div className="field-span-2 cron-schedule-builder">
                  {cronScheduleBuilder.mode === "every" ? (
                    <>
                      <label>
                        Intervalle
                        <input
                          className="input"
                          type="number"
                          min={1}
                          max={cronScheduleBuilder.unit === "minutes" ? 59 : 23}
                          value={cronScheduleBuilder.interval}
                          onChange={(event) =>
                            updateCronSchedule({
                              interval: Number(event.target.value || 1),
                            })
                          }
                        />
                      </label>
                      <label>
                        Unite
                        <select
                          className="select"
                          value={cronScheduleBuilder.unit}
                          onChange={(event) =>
                            updateCronSchedule({
                              unit: event.target.value as CronEveryUnit,
                              interval:
                                event.target.value === "hours"
                                  ? Math.min(cronScheduleBuilder.interval, 23)
                                  : Math.min(cronScheduleBuilder.interval, 59),
                            })
                          }
                        >
                          <option value="minutes">minutes</option>
                          <option value="hours">heures</option>
                        </select>
                      </label>
                    </>
                  ) : null}
                  {["daily", "weekdays", "weekly", "monthly"].includes(cronScheduleBuilder.mode) ? (
                    <label>
                      Heure
                      <input
                        className="input"
                        type="time"
                        value={cronScheduleBuilder.time}
                        onChange={(event) =>
                          updateCronSchedule({
                            time: event.target.value,
                          })
                        }
                      />
                    </label>
                  ) : null}
                  {cronScheduleBuilder.mode === "weekly" ? (
                    <label>
                      Jour
                      <select
                        className="select"
                        value={cronScheduleBuilder.weekday}
                        onChange={(event) =>
                          updateCronSchedule({
                            weekday: event.target.value,
                          })
                        }
                      >
                        {CRON_WEEKDAY_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {cronScheduleBuilder.mode === "monthly" ? (
                    <label>
                      Jour du mois
                      <input
                        className="input"
                        type="number"
                        min={1}
                        max={31}
                        value={cronScheduleBuilder.dayOfMonth}
                        onChange={(event) =>
                          updateCronSchedule({
                            dayOfMonth: Number(event.target.value || 1),
                          })
                        }
                      />
                    </label>
                  ) : null}
                  {cronScheduleBuilder.mode === "custom" ? (
                    <label className="field-span-2">
                      Expression libre
                      <input
                        className="input"
                        value={cronScheduleBuilder.customExpression}
                        onChange={(event) =>
                          updateCronSchedule({
                            customExpression: event.target.value,
                          })
                        }
                        placeholder="0 9 * * 1-5 ou every 30m"
                      />
                    </label>
                  ) : null}
                </div>
                <label className="field-span-2">
                  Description
                  <textarea
                    className="input textarea"
                    rows={3}
                    value={cronForm.description}
                    onChange={(event) =>
                      setCronForm((current) => ({ ...current, description: event.target.value }))
                    }
                  />
                </label>
                <label className="field-span-2">
                  {cronForm.targetType === "pipeline" ? "Pipeline input" : "Request"}
                  <textarea
                    className="input textarea"
                    rows={3}
                    value={cronForm.input}
                    onChange={(event) =>
                      setCronForm((current) => ({ ...current, input: event.target.value }))
                    }
                    placeholder={
                      cronForm.targetType === "pipeline"
                        ? "Payload transmis au pipeline lors du declenchement."
                        : "Message envoye a l’agent quand le job se declenche."
                    }
                  />
                </label>
              </div>
            </div>
            <aside className="cron-preview-panel">
              <div className="cron-preview-head">
                <div>
                  <span className="eyebrow-label">Apercu du job</span>
                  <h4>Execution derivee automatiquement</h4>
                </div>
                <StatusPill status={cronForm.schedule.trim() ? "running" : "paused"}>
                  {cronDraftStatusLabel}
                </StatusPill>
              </div>
              <div className="cron-preview-grid">
                <article className="cron-preview-card">
                  <span>Cible</span>
                  <strong>{cronDraftTargetLabel}</strong>
                  <small>{cronTargetMissing ? "Selection requise avant creation" : "Cible prete"}</small>
                </article>
                <article className="cron-preview-card">
                  <span>Sorties</span>
                  <strong>{cronDraftOutputsLabel}</strong>
                  <small>
                    {suggestedCronOutputChannels.length
                      ? "Heritees depuis la cible selectionnee"
                      : "Le runtime n’a encore rien a heriter"}
                  </small>
                </article>
              </div>
              <div className="cron-expression-box">
                <span className="eyebrow-label">Planification</span>
                <strong>{describeCronScheduleHuman(cronForm.schedule)}</strong>
                <code>{cronDraftExpressionLabel}</code>
              </div>
              <div className="pipeline-selection-strip">
                {suggestedCronOutputChannels.length ? (
                  suggestedCronOutputChannels.map((channel) => (
                    <span key={`cron-preview-${channel.id}`} className="inline-tag">
                      {buildChannelRouteSummary(channel, channelTemplateById.get(channel.kind))}
                    </span>
                  ))
                ) : (
                  <span className="inline-tag">Aucune route de sortie prete</span>
                )}
              </div>
              <div className="button-row">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={cronTargetMissing || !currentUserCanOperate}
                  onClick={() =>
                    void mutateResource("create", "cronJobs", {
                      name: cronForm.name,
                      description: cronForm.description,
                      ownerId:
                        currentUserCanManageAdminViews
                          ? cronForm.ownerId
                          : selectedDashboardUser?.id || cronForm.ownerId,
                      targetType: cronForm.targetType,
                      agentId: cronForm.targetType === "request" ? cronForm.agentId || undefined : undefined,
                      pipelineId:
                        cronForm.targetType === "pipeline" ? cronForm.pipelineId || undefined : undefined,
                      schedule: cronForm.schedule.trim() || undefined,
                      input: cronForm.input.trim() || undefined,
                    })
                  }
                >
                  Creer le cron job
                </button>
              </div>
            </aside>
          </div>
        </section>

        <section className="panel">
          <ResourceToolbar title="Cron Jobs" detail="Natifs OpenClaw et control tower" />
          <div className="card-grid">
            {visibleCronJobs.map((job) => (
              <article key={`${job.source}-${job.id}`} className="entity-card">
                <div className="info-row compact">
                  <strong>{job.name}</strong>
                  <StatusPill status={job.activityStatus}>{job.activityStatus}</StatusPill>
                </div>
                <p>{job.description || "Job sans description."}</p>
                <small className="muted-line">
                  {job.source} · {describeCronJobTarget(job)}
                </small>
                <small className="muted-line">
                  schedule {describeCronJobSchedule(job)} · next {formatDateTime(job.state?.nextRunAtMs)} · last{" "}
                  {formatDateTime(job.state?.lastRunAtMs || job.updatedAt)}
                </small>
                {job.input ? <small className="muted-line">input {job.input}</small> : null}
                {job.source === "control-tower" && (
                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={!currentUserCanOperate}
                      onClick={() =>
                        void mutateResource(
                          "patch",
                          "cronJobs",
                          { status: job.status === "running" ? "paused" : "running" },
                          job.id,
                        )
                      }
                    >
                      {job.status === "running" ? "Mettre en pause" : "Activer"}
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={!currentUserCanOperate}
                      onClick={() => void mutateResource("delete", "cronJobs", {}, job.id)}
                    >
                      Supprimer
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      </section>
    );
  }

  function renderUsers() {
    const userTeamOptions = teams.map((team) => ({
      id: team.id,
      label: team.name,
      meta: `${team.agentIds.length} agent(s) · ${getTeamOwnedOutputChannelIds(team.id).size} destination(s)`,
    }));
    const projectTeamOptions = teams.map((team) => ({
      id: team.id,
      label: team.name,
      meta: `${team.memberIds.length} membre(s) · ${team.agentIds.length} agent(s)`,
    }));
    const externalIdentityProviderOptions = Array.from(
      new Set([
        ...EXTERNAL_IDENTITY_PROVIDER_PRESETS,
        ...channelEntries.map((entry) => normalizeExternalIdentityProvider(entry.id)),
        ...users.flatMap((user) =>
          user.externalIdentities.map((identity) => parseExternalIdentityDraft(identity).provider),
        ),
        ...userForm.externalIdentities.map((identity) => normalizeExternalIdentityProvider(identity.provider)),
      ]),
    )
      .filter(Boolean)
      .toSorted((left, right) => left.localeCompare(right))
      .map((provider) => ({
        id: provider,
        label: humanizeExternalIdentityProvider(provider),
      }));
    const editingUser = userEditorMode === "edit"
      ? users.find((entry) => entry.id === editingUserId) || null
      : null;
    const editingProject = projectEditorMode === "edit"
      ? projects.find((entry) => entry.id === editingProjectId) || null
      : null;
    const userDraftTeamLabels = userForm.teamIds.map(teamName);
    const userDraftEffectiveAgentLabels = getEffectiveAgentIdsForScope(
      userForm.teamIds,
      editingUser?.agentIds || [],
    ).map(agentName);
    const userDraftEffectiveChannelLabels = getEffectiveChannelIdsForScope(
      userForm.teamIds,
      editingUser?.channelIds || [],
    ).map(channelName);
    const userDraftExternalIdentities = sanitizeExternalIdentityDrafts(userForm.externalIdentities);
    const userDraftExternalIdentityConflicts = users.filter((user) => {
      if (user.id === editingUserId) {
        return false;
      }
      return user.externalIdentities.some((pattern) =>
        userDraftExternalIdentities.some(
          (identity) =>
            matchExternalIdentityPatternLocal(pattern, identity).matched ||
            matchExternalIdentityPatternLocal(identity, pattern).matched,
        ),
      );
    });
    const userDraftContactLabel =
      [userForm.email, userForm.phone, userForm.location].filter(Boolean).join(" · ") || "n/a";
    const projectMemberOptions = users
      .filter((user) => !projectForm.teamId || resolveUserTeamIdsLocal(user).includes(projectForm.teamId))
      .map((user) => ({
        id: user.id,
        label: user.name,
        meta: `${user.role} · ${user.email}`,
      }));
    const projectAgentOptions = agents
      .filter((agent) => !projectForm.teamId || getAgentAccessTeamIds(agent.id, getAgentBinding(agent.id)?.teamId || agent.teamId || "").includes(projectForm.teamId))
      .map((agent) => ({
        id: agent.id,
        label: agent.identity?.name || agent.name || agent.id,
        meta: teamName(getAgentBinding(agent.id)?.teamId || agent.teamId),
      }));
    const projectDraftMemberLabels = projectForm.memberIds.map(ownerName);
    const projectDraftAgentLabels = projectForm.agentIds.map(agentName);
    const projectDraftMemoryMode = describeProjectMemoryMode(projectForm.memberIds.length);

    return (
      <section className="stack">
        <section className="panel">
          <ResourceToolbar
            title={userEditorMode === "edit" ? "Utilisateur" : "Nouvel utilisateur"}
            detail="Profil, equipes, roles et identites externes"
          >
            {userEditorMode === "edit" ? (
              <button type="button" className="ghost-button" onClick={resetUserEditor}>
                Nouveau user
              </button>
            ) : null}
          </ResourceToolbar>
          <div className="summary-card-grid">
            <article className="agent-summary-card">
              <span>Role dashboard</span>
              <strong>{userForm.role}</strong>
              <small>{userForm.status}</small>
            </article>
            <article className="agent-summary-card">
              <span>Equipes</span>
              <strong>{userForm.teamIds.length}</strong>
              <small>{summarizeLabels(userDraftTeamLabels, 2, "aucune equipe")}</small>
            </article>
            <article className="agent-summary-card">
              <span>Agents visibles</span>
              <strong>{userDraftEffectiveAgentLabels.length}</strong>
              <small>{summarizeLabels(userDraftEffectiveAgentLabels, 2, "aucun agent")}</small>
            </article>
            <article className="agent-summary-card">
              <span>Destinations visibles</span>
              <strong>{userDraftEffectiveChannelLabels.length}</strong>
              <small>
                {summarizeLabels(userDraftEffectiveChannelLabels, 2, "aucune destination")}
              </small>
            </article>
          </div>
          <div className="form-grid">
            <label>
              Nom
              <input
                className="input"
                value={userForm.name}
                onChange={(event) =>
                  setUserForm((current) => ({ ...current, name: event.target.value }))
                }
              />
            </label>
            <label>
              Email
              <input
                className="input"
                value={userForm.email}
                onChange={(event) =>
                  setUserForm((current) => ({ ...current, email: event.target.value }))
                }
              />
            </label>
            <label>
              Titre / fonction
              <input
                className="input"
                value={userForm.title}
                onChange={(event) =>
                  setUserForm((current) => ({ ...current, title: event.target.value }))
                }
                placeholder="Sales lead, CFO, founder..."
              />
            </label>
            <label>
              Telephone
              <input
                className="input"
                value={userForm.phone}
                onChange={(event) =>
                  setUserForm((current) => ({ ...current, phone: event.target.value }))
                }
                placeholder="+33 6 00 00 00 00"
              />
            </label>
            <label>
              Localisation
              <input
                className="input"
                value={userForm.location}
                onChange={(event) =>
                  setUserForm((current) => ({ ...current, location: event.target.value }))
                }
                placeholder="Paris, remote, Montreal..."
              />
            </label>
            <label>
              Role dashboard
              <select
                className="select"
                value={userForm.role}
                onChange={(event) =>
                  setUserForm((current) => ({
                    ...current,
                    role: event.target.value as DashboardUser["role"],
                  }))
                }
              >
                <option value="admin">admin</option>
                <option value="operator">operator</option>
                <option value="member">member</option>
                <option value="viewer">viewer</option>
              </select>
            </label>
            <label>
              Statut
              <select
                className="select"
                value={userForm.status}
                onChange={(event) =>
                  setUserForm((current) => ({
                    ...current,
                    status: event.target.value as DashboardUser["status"],
                  }))
                }
              >
                <option value="active">active</option>
                <option value="invited">invited</option>
                <option value="disabled">disabled</option>
              </select>
            </label>
            <label className="field-span-2">
              Notes user
              <textarea
                className="input textarea"
                rows={4}
                value={userForm.notes}
                onChange={(event) =>
                  setUserForm((current) => ({ ...current, notes: event.target.value }))
                }
                placeholder="Contexte utile, preferences, contraintes, infos perso/pro..."
              />
            </label>
          </div>
          <ExternalIdentityEditor
            drafts={userForm.externalIdentities}
            providerOptions={externalIdentityProviderOptions}
            onChange={(nextDrafts) =>
              setUserForm((current) => ({
                ...current,
                externalIdentities: nextDrafts,
              }))
            }
          />
          <EntityMultiSelector
            title="Equipes"
            detail="L'acces aux agents et aux destinations est derive des equipes selectionnees."
            selectedIds={userForm.teamIds}
            options={userTeamOptions}
            searchPlaceholder="Rechercher une equipe..."
            onChange={(nextIds) => setUserForm((current) => ({ ...current, teamIds: nextIds }))}
            emptyTitle="Aucune equipe"
            emptyBody="Cree au moins une equipe pour rattacher un utilisateur."
          />
          <div className="detail-pairs compact-grid">
            <span>Contact</span>
            <span>{userDraftContactLabel}</span>
            <span>Identites</span>
            <span>{summarizeLabels(userDraftExternalIdentities, 3, "aucune identite")}</span>
            <span>Acces derive</span>
            <span>
              {userDraftEffectiveAgentLabels.length} agent(s) · {userDraftEffectiveChannelLabels.length} destination(s)
            </span>
            <span>Memoire projet</span>
            <span>
              {getProjectsForUser(editingUser?.id || "")
                .map((project) => `${project.name} (${describeProjectMemoryMode(project.memberIds.length)})`)
                .join(", ") || "aucun projet rattache"}
            </span>
            <span>Mode</span>
            <span>
              {userEditorMode === "edit"
                ? `edition ${editingUser?.name || editingUserId}`
                : "creation d'un nouveau profil"}
            </span>
          </div>
          {userDraftExternalIdentityConflicts.length ? (
            <article className="callout danger-callout">
              <strong>Conflit d'identite externe</strong>
              <p>
                Cette saisie match deja {userDraftExternalIdentityConflicts.map((user) => user.name).join(", ")}.
                Elytras bloquerait ou rendrait ambigu le mapping inbound.
              </p>
            </article>
          ) : null}
          <article className="callout">
            <strong>Modele d'acces</strong>
            <p>
              Les users n'embarquent plus leurs agents et destinations en direct. Le role est
              global, mais le perimetre operatif vient des equipes.
            </p>
          </article>
          <article className="callout">
            <strong>Memoire projet</strong>
            <p>
              Ici, un projet memoire est un conteneur user/project. S'il n'y a qu'un seul user humain,
              la memoire est personnelle. A partir de deux users humains, elle devient vraiment partagee.
            </p>
          </article>
          <div className="button-row">
            <button
              type="button"
              className="ghost-button"
              onClick={() => void handleSaveUser()}
            >
              {userEditorMode === "edit" ? "Sauvegarder l'utilisateur" : "Ajouter l'utilisateur"}
            </button>
          </div>
        </section>

        <section className="panel">
          <ResourceToolbar title="Utilisateurs" detail="Profils, perimetres et identites" />
          <article className="callout">
            <strong>Couverture bots inbound</strong>
            <p>
              {inboxGovernanceStats.total} conversation(s) bot visibles · {inboxGovernanceStats.allowed} autorisee(s) ·{" "}
              {inboxGovernanceStats.blocked} mappee(s) mais bloquee(s) · {inboxGovernanceStats.unresolved} non mappee(s) ·{" "}
              {inboxGovernanceStats.ambiguous} ambigue(s)
            </p>
          </article>
          <div className="card-grid">
            {users.map((user) => {
              const resolvedTeamIds = resolveUserTeamIdsLocal(user);
              const userProjects = getProjectsForUser(user.id);
              const userProjectLabels = userProjects.map(
                (project) => `${project.name} (${describeProjectMemoryMode(project.memberIds.length)})`,
              );
              const effectiveAgentIds = getUserEffectiveAgentIds(user);
              const effectiveChannelIds = getUserEffectiveChannelIds(user);
              const explicitGrantEntries = getSubjectGrantEntries("user", user.id);
              const inboundCoverage = inboundCoverageByUserId.get(user.id);
              const inboundSessionKeys = Array.from(inboundCoverage?.sessionKeys || []);
              const inboundAllowedKeys = Array.from(inboundCoverage?.allowedSessionKeys || []);
              const inboundBlockedKeys = Array.from(inboundCoverage?.blockedSessionKeys || []);
              const inboundConflictKeys = Array.from(inboundCoverage?.conflictSessionKeys || []);
              const inboundAgentLabels = Array.from(inboundCoverage?.agentIds || []).map(agentName);
              const inboundChannelLabels = Array.from(inboundCoverage?.channelIds || []).map(channelName);
              const profileLabel =
                [user.title, user.location, user.phone].filter(Boolean).join(" · ") || "profil n/a";
              return (
                <article key={user.id} className="entity-card">
                  <div className="info-row compact">
                    <strong>{user.name}</strong>
                    <StatusPill status={user.status}>{user.role}</StatusPill>
                  </div>
                  <p>{user.email}</p>
                  <div className="detail-pairs compact-grid">
                    <span>Profil</span>
                    <span>{profileLabel}</span>
                    <span>Teams</span>
                    <span>{summarizeLabels(resolvedTeamIds.map(teamName), 3)}</span>
                    <span>Memoire projet</span>
                    <span>{summarizeLabels(userProjectLabels, 2, "aucun")}</span>
                    <span>Agents</span>
                    <span>{summarizeLabels(effectiveAgentIds.map(agentName), 2)}</span>
                    <span>Destinations</span>
                    <span>{summarizeLabels(effectiveChannelIds.map(channelName), 2)}</span>
                    <span>Grants</span>
                    <span>
                      {explicitGrantEntries.length
                        ? summarizeLabels(
                            explicitGrantEntries.map(
                              (grant) =>
                                `${grant.permission} ${grant.resourceType}:${describeGrantResourceTarget(grant)}`,
                            ),
                            2,
                          )
                        : "aucun"}
                    </span>
                    <span>Identites</span>
                    <span>{summarizeLabels(user.externalIdentities, 2, "aucune")}</span>
                  </div>
                  {user.notes ? <small className="muted-line">notes {user.notes}</small> : null}
                  <small className="muted-line">
                    inbound {inboundSessionKeys.length} session(s) · ok {inboundAllowedKeys.length} · bloquees{" "}
                    {inboundBlockedKeys.length} · conflits {inboundConflictKeys.length}
                  </small>
                  <small className="muted-line">
                    bots {summarizeLabels(inboundChannelLabels, 2)} · agents {summarizeLabels(inboundAgentLabels, 2)}
                  </small>
                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => startUserEdit(user)}
                    >
                      Modifier
                    </button>
                    {inboundSessionKeys.length ? (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => openInboxSessionFromGovernance(inboundSessionKeys[0]!)}
                      >
                        Voir inbox
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={async () => {
                        const ok = await mutateResource("delete", "users", {}, user.id);
                        if (ok && editingUserId === user.id) {
                          resetUserEditor();
                        }
                      }}
                    >
                      Supprimer
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="panel">
          <ResourceToolbar
            title={projectEditorMode === "edit" ? "Projet memoire" : "Nouveau projet memoire"}
            detail="Memoire partagee user/project sans melanger la gouvernance team"
          >
            {projectEditorMode === "edit" ? (
              <button type="button" className="ghost-button" onClick={resetProjectEditor}>
                Nouveau projet
              </button>
            ) : null}
          </ResourceToolbar>
          <div className="summary-card-grid">
            <article className="agent-summary-card">
              <span>Equipe porteuse</span>
              <strong>{teamName(projectForm.teamId)}</strong>
              <small>{projectEditorMode === "edit" ? editingProject?.id || "edit" : "nouveau"}</small>
            </article>
            <article className="agent-summary-card">
              <span>Membres</span>
              <strong>{projectForm.memberIds.length}</strong>
              <small>{summarizeLabels(projectDraftMemberLabels, 2, "aucun membre")}</small>
            </article>
            <article className="agent-summary-card">
              <span>Agents</span>
              <strong>{projectForm.agentIds.length}</strong>
              <small>{summarizeLabels(projectDraftAgentLabels, 2, "aucun agent")}</small>
            </article>
            <article className="agent-summary-card">
              <span>Memoire</span>
              <strong>{projectForm.name || "projet"}</strong>
              <small>{projectDraftMemoryMode === "partagee" ? "scope user/project partage" : "scope user/project personnel"}</small>
            </article>
          </div>
          <div className="form-grid">
            <label>
              Nom
              <input
                className="input"
                value={projectForm.name}
                onChange={(event) =>
                  setProjectForm((current) => ({ ...current, name: event.target.value }))
                }
              />
            </label>
            <label>
              Equipe porteuse
              <select
                className="select"
                value={projectForm.teamId}
                onChange={(event) =>
                  setProjectForm((current) => ({
                    ...current,
                    teamId: event.target.value,
                    memberIds: [],
                  }))
                }
              >
                <option value="">Choisir...</option>
                {projectTeamOptions.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-span-2">
              Description
              <textarea
                className="input textarea"
                rows={3}
                value={projectForm.description}
                onChange={(event) =>
                  setProjectForm((current) => ({ ...current, description: event.target.value }))
                }
                placeholder="Contexte du projet, objectifs, livrables..."
              />
            </label>
            <label className="field-span-2">
              Notes
              <textarea
                className="input textarea"
                rows={3}
                value={projectForm.notes}
                onChange={(event) =>
                  setProjectForm((current) => ({ ...current, notes: event.target.value }))
                }
                placeholder="Regles memoire, sujets a suivre, indices de retrieval..."
              />
            </label>
          </div>
          <EntityMultiSelector
            title="Membres projet"
            detail="Ces users peuvent alimenter et relire la memoire du projet."
            selectedIds={projectForm.memberIds}
            options={projectMemberOptions}
            searchPlaceholder="Rechercher un membre..."
            onChange={(nextIds) => setProjectForm((current) => ({ ...current, memberIds: nextIds }))}
            emptyTitle="Aucun membre"
            emptyBody="Choisis d'abord une equipe, puis selectionne les users concernes."
          />
          <EntityMultiSelector
            title="Agents du projet"
            detail="Ces agents peuvent utiliser la memoire de ce projet."
            selectedIds={projectForm.agentIds}
            options={projectAgentOptions}
            searchPlaceholder="Rechercher un agent..."
            onChange={(nextIds) => setProjectForm((current) => ({ ...current, agentIds: nextIds }))}
            emptyTitle="Aucun agent"
            emptyBody="Aucun agent visible pour l'equipe selectionnee."
          />
          <article className="callout">
            <strong>Memoire vs gouvernance</strong>
            <p>
              L'equipe garde le RBAC et l'organisation. Le projet, lui, ne sert qu'a isoler et
              partager la memoire de travail entre users et agents autorises. Les agents seuls ne
              rendent pas un projet "partage": il faut au moins deux users humains membres.
            </p>
          </article>
          <div className="button-row">
            <button type="button" className="ghost-button" onClick={() => void handleSaveProject()}>
              {projectEditorMode === "edit" ? "Sauvegarder le projet" : "Ajouter le projet"}
            </button>
          </div>
          <div className="card-grid">
            {projects.map((project) => (
              <article key={project.id} className="entity-card">
                <div className="info-row compact">
                  <strong>{project.name}</strong>
                  <StatusPill status={project.memberIds.length > 1 ? "active" : "paused"}>
                    {describeProjectMemoryMode(project.memberIds.length)}
                  </StatusPill>
                </div>
                <p>{project.description || "Aucune description."}</p>
                <div className="detail-pairs compact-grid">
                  <span>Equipe</span>
                  <span>{teamName(project.teamId)}</span>
                  <span>Type memoire</span>
                  <span>{describeProjectMemoryMode(project.memberIds.length)}</span>
                  <span>Membres</span>
                  <span>{summarizeLabels(project.memberIds.map(ownerName), 3, "aucun")}</span>
                  <span>Agents</span>
                  <span>{summarizeLabels(project.agentIds.map(agentName), 3, "aucun")}</span>
                  <span>Notes</span>
                  <span>{project.notes || "n/a"}</span>
                </div>
                <div className="button-row">
                  <button type="button" className="ghost-button" onClick={() => startProjectEdit(project)}>
                    Modifier
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={async () => {
                      const ok = await mutateResource("delete", "projects", {}, project.id);
                      if (ok && editingProjectId === project.id) {
                        resetProjectEditor();
                      }
                    }}
                  >
                    Supprimer
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </section>
    );
  }

  function renderAccess() {
    const teamMemberOptions = users.map((user) => ({
      id: user.id,
      label: user.name,
      meta: `${user.role} · ${user.email}`,
    }));
    const teamAgentOptions = agents.map((agent) => ({
      id: agent.id,
      label: agent.identity?.name || agent.name || agent.id,
      description: agent.purpose
        ? agent.purpose.length > 110
          ? `${agent.purpose.slice(0, 107)}...`
          : agent.purpose
        : "Mission non renseignee.",
      meta: `proprio ${teamName(getAgentBinding(agent.id)?.teamId || agent.teamId)} · ${getAgentAccessTeamIds(
        agent.id,
        getAgentBinding(agent.id)?.teamId || agent.teamId,
      ).length} equipe(s)`,
    }));
    const editingTeam = teamEditorMode === "edit"
      ? teams.find((team) => team.id === editingTeamId) || null
      : null;
    const draftTeamMemberRecords = users.filter((user) => teamForm.memberIds.includes(user.id));
    const draftTeamMemberLabels = teamForm.memberIds.map(ownerName);
    const draftTeamAgentLabels = teamForm.agentIds.map(agentName);
    const draftTeamChannelLabels = teamForm.channelIds.map(channelName);
    const draftTeamIdentityLabels = Array.from(
      new Set(draftTeamMemberRecords.flatMap((user) => user.externalIdentities)),
    ).toSorted((left, right) => left.localeCompare(right));
    const draftTeamTransportLabels = Array.from(
      new Set(
        outputRouteChannels
          .filter((channel) => teamForm.channelIds.includes(channel.id))
          .map((channel) => `${channel.kind}:${normalizeChannelAccountId(channel.accountId)}`),
      ),
    ).toSorted((left, right) => left.localeCompare(right));
    const grantSubjectOptions =
      grantForm.subjectType === "user"
        ? users.map((user) => ({
            id: user.id,
            label: user.name,
            meta: `${user.role} · ${user.email}`,
          }))
        : teams.map((team) => ({
            id: team.id,
            label: team.name,
            meta: `${team.agentIds.length} agent(s) · ${getTeamOwnedOutputChannelIds(team.id).size} destination(s)`,
          }));
    const grantResourceIdOptions = (() => {
      switch (grantForm.resourceType) {
        case "agent":
          return agents.map((agent) => ({
            id: agent.id,
            label: agent.identity?.name || agent.name || agent.id,
            meta: teamName(getAgentBinding(agent.id)?.teamId || agent.teamId),
          }));
        case "channel":
          return outputRouteChannels.map((channel) => ({
            id: channel.id,
            label: channel.name,
            meta: `${channel.kind} · ${channel.accountId || "default"} · ${channel.deliveryTarget || channel.target}`,
          }));
        case "pipeline":
          return pipelines.map((pipeline) => ({
            id: pipeline.id,
            label: pipeline.name,
            meta: `${pipeline.steps.length} etape(s) · ${teamName(pipeline.teamId)}`,
          }));
        case "cron":
          return cronJobs.map((job) => ({
            id: job.id,
            label: job.name,
            meta: `${job.source} · ${describeCronJobTarget(job)}`,
          }));
        case "provider":
          return providerBridges.length
            ? providerBridges.map((bridge) => ({
                id: bridge.id,
                label: bridge.name,
                meta: bridge.runtimeBaseUrl,
              }))
            : [{ id: CLIPROXY_PROVIDER_ID, label: CLIPROXY_PROVIDER_ID, meta: "provider runtime" }];
        case "skill":
          return (skillsCatalog?.skills || []).map((skill) => ({
            id: skill.id,
            label: skill.name || skill.dirName,
            meta: `${skill.scope} · ${skill.kind}`,
          }));
        case "workspace":
          return workspaces.map((workspace) => ({
            id: workspace.agentId,
            label: agentName(workspace.agentId),
            meta: workspace.path,
          }));
        default:
          return [{ id: "*", label: "*", meta: "Toutes les ressources" }];
      }
    })();
    const selectedGrantSubjectUser =
      grantForm.subjectType === "user"
        ? users.find((user) => user.id === grantForm.subjectId) || null
        : null;
    const selectedGrantSubjectTeam =
      grantForm.subjectType === "team"
        ? teams.find((team) => team.id === grantForm.subjectId) || null
        : null;
    const selectedGrantSubjectTeamIds = selectedGrantSubjectUser
      ? resolveUserTeamIdsLocal(selectedGrantSubjectUser)
      : selectedGrantSubjectTeam
        ? [selectedGrantSubjectTeam.id]
        : [];
    const selectedGrantSubjectAgentIds = selectedGrantSubjectUser
      ? getUserEffectiveAgentIds(selectedGrantSubjectUser)
      : selectedGrantSubjectTeam
        ? getTeamAccessibleAgentIds([selectedGrantSubjectTeam.id])
        : [];
    const selectedGrantSubjectChannelIds = selectedGrantSubjectUser
      ? getUserEffectiveChannelIds(selectedGrantSubjectUser)
      : selectedGrantSubjectTeam
        ? getTeamAccessibleChannelIds([selectedGrantSubjectTeam.id])
        : [];
    const selectedGrantSubjectEntries = grantForm.subjectId
      ? getSubjectGrantEntries(grantForm.subjectType, grantForm.subjectId)
      : [];

    return (
      <section className="stack">
        <section className="panel">
          <ResourceToolbar
            title="Inbound Governance"
            detail="Bots, mappings et droits effectifs"
          />
          <article className="callout">
            <strong>Etat global</strong>
            <p>
              {inboxGovernanceStats.total} conversation(s) bot visibles · {inboxGovernanceStats.allowed} autorisee(s) ·{" "}
              {inboxGovernanceStats.blocked} mappee(s) mais bloquee(s) · {inboxGovernanceStats.unresolved} non mappee(s) ·{" "}
              {inboxGovernanceStats.ambiguous} ambigue(s)
            </p>
          </article>
          <div className="card-grid">
            {inboxGovernanceSessions.length ? (
              inboxGovernanceSessions.map((session) => {
                const principal = session.inboundPrincipal;
                const mappedUserName =
                  principal?.status === "resolved"
                    ? principal.userName || principal.userId || "n/a"
                    : principal?.status === "ambiguous"
                      ? (principal.ambiguousUserIds || []).map(ownerName).join(", ") || "ambigue"
                      : "non mappe";
                const currentDestinationLabels = (principal?.matchedChannelIds || [])
                  .map(channelName)
                  .join(", ");
                const targetAgentLabel = agentName(principal?.targetAgentId || session.agentId);
                const inboundGrantAgentIds = getInboundGrantAgentIds(principal, session.agentId);
                const preferredInboundTeam = getPreferredInboundTeam(principal);
                return (
                  <article key={session.key} className="entity-card">
                    <div className="info-row compact">
                      <strong>{session.displayName || session.derivedTitle || session.key}</strong>
                      <StatusPill status={inboundPrincipalTone(principal)}>
                        {describeInboundPrincipalState(principal) || "n/a"}
                      </StatusPill>
                    </div>
                    <p>{session.lastMessagePreview || "Aucun apercu recent."}</p>
                    <small className="muted-line">
                      {session.channel || "channel n/a"} · {session.chatType || "session"} · {formatDateTime(session.updatedAt)}
                    </small>
                    <small className="muted-line">
                      externe {principal?.matchedExternalId || principal?.candidateExternalIds.join(", ") || "n/a"}
                    </small>
                    <small className="muted-line">
                      user {mappedUserName} · agent {targetAgentLabel}
                    </small>
                    <small className="muted-line">
                      equipes autorisantes {principal?.authorizingTeamNames?.join(", ") || "aucune"}
                    </small>
                    <small className="muted-line">
                      destination {currentDestinationLabels || "non geree"} · acces{" "}
                      {formatInboundAccessSource(principal?.accessSource)}
                    </small>
                    <small className="muted-line">
                      {describeInboundPrincipalAccess(principal)}
                      {principal?.reason ? ` ${principal.reason}` : ""}
                    </small>
                    <div className="button-row">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => openInboxSessionFromGovernance(session.key)}
                      >
                        Ouvrir chat
                      </button>
                      {principal?.status === "resolved" && principal.userId ? (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => openUserEditorFromChat(principal.userId)}
                        >
                          Modifier user
                        </button>
                      ) : null}
                      {principal?.status === "resolved" && principal.userStatus !== "active" ? (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => void activateInboundUser(principal)}
                        >
                          Activer le user
                        </button>
                      ) : null}
                      {principal?.status === "resolved" && principal.userRole === "viewer" ? (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => void promoteInboundUserFromViewer(principal)}
                        >
                          Passer en member
                        </button>
                      ) : null}
                      {principal?.status === "resolved" &&
                      !principal.canUseChannel &&
                      principal.matchedChannelIds.length ? (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() =>
                            void (
                              preferredInboundTeam
                                ? attachInboundResourcesToPreferredTeam(
                                    principal,
                                    "channel",
                                    principal.matchedChannelIds,
                                  )
                                : grantInboundResources(
                                    principal,
                                    "channel",
                                    principal.matchedChannelIds,
                                  )
                            )
                          }
                        >
                          {preferredInboundTeam
                            ? `Ajouter destination a ${preferredInboundTeam.name}`
                            : "Autoriser destination (grant)"}
                        </button>
                      ) : null}
                      {principal?.status === "resolved" &&
                      principal.canUseChannel &&
                      !principal.canUseAgent &&
                      inboundGrantAgentIds.length ? (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() =>
                            void (
                              preferredInboundTeam
                                ? attachInboundResourcesToPreferredTeam(
                                    principal,
                                    "agent",
                                    inboundGrantAgentIds,
                                  )
                                : grantInboundResources(
                                    principal,
                                    "agent",
                                    inboundGrantAgentIds,
                                  )
                            )
                          }
                        >
                          {preferredInboundTeam
                            ? `Ajouter agent a ${preferredInboundTeam.name}`
                            : "Autoriser agent (grant)"}
                        </button>
                      ) : null}
                      {principal?.status === "unresolved" ? (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() =>
                            seedUserEditorFromInboundIdentity(
                              principal.candidateExternalIds[0] || "",
                            )
                          }
                        >
                          Nouveau user
                        </button>
                      ) : null}
                      {inboundPrincipalNeedsRbacReview(principal) ? (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => setView("access")}
                        >
                          Verifier RBAC
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })
            ) : (
              <EmptyState
                title="Aucune conversation bot"
                body="Aucune session inbound visible pour le scope courant."
              />
            )}
          </div>
        </section>

        <div className="panel-grid mission-layout">
          <section className="panel">
            <ResourceToolbar
              title={teamEditorMode === "edit" ? "Equipe" : "Nouvelle equipe"}
              detail="Membres, agents joignables et destinations"
            >
              {teamEditorMode === "edit" ? (
                <button type="button" className="ghost-button" onClick={resetTeamEditor}>
                  Nouvelle equipe
                </button>
              ) : null}
            </ResourceToolbar>
            <div className="summary-card-grid">
              <article className="agent-summary-card">
                <span>Membres</span>
                <strong>{teamForm.memberIds.length}</strong>
                <small>{summarizeLabels(draftTeamMemberLabels, 2, "aucun membre")}</small>
              </article>
              <article className="agent-summary-card">
                <span>Agents joignables</span>
                <strong>{teamForm.agentIds.length}</strong>
                <small>{summarizeLabels(draftTeamAgentLabels, 2, "aucun agent")}</small>
              </article>
              <article className="agent-summary-card">
                <span>Destinations</span>
                <strong>{teamForm.channelIds.length}</strong>
                <small>{summarizeLabels(draftTeamChannelLabels, 2, "aucune destination")}</small>
              </article>
              <article className="agent-summary-card">
                <span>Mode</span>
                <strong>{teamEditorMode === "edit" ? "edition" : "creation"}</strong>
                <small>{editingTeam?.name || "nouveau draft equipe"}</small>
              </article>
            </div>
            <div className="form-grid">
              <label>
                Nom
                <input
                  className="input"
                  value={teamForm.name}
                  onChange={(event) =>
                    setTeamForm((current) => ({ ...current, name: event.target.value }))
                  }
                />
              </label>
              <label>
                Couleur
                <input
                  className="input"
                  value={teamForm.color}
                  onChange={(event) =>
                    setTeamForm((current) => ({ ...current, color: event.target.value }))
                  }
                />
              </label>
              <label>
                Email de contact
                <input
                  className="input"
                  value={teamForm.contactEmail}
                  onChange={(event) =>
                    setTeamForm((current) => ({ ...current, contactEmail: event.target.value }))
                  }
                  placeholder="ops@company.com"
                />
              </label>
              <label>
                Site web
                <input
                  className="input"
                  value={teamForm.website}
                  onChange={(event) =>
                    setTeamForm((current) => ({ ...current, website: event.target.value }))
                  }
                  placeholder="https://..."
                />
              </label>
              <label className="field-span-2">
                Description
                <textarea
                  className="input textarea"
                  rows={3}
                  value={teamForm.description}
                  onChange={(event) =>
                    setTeamForm((current) => ({ ...current, description: event.target.value }))
                  }
                />
              </label>
              <label className="field-span-2">
                Notes equipe
                <textarea
                  className="input textarea"
                  rows={4}
                  value={teamForm.notes}
                  onChange={(event) =>
                    setTeamForm((current) => ({ ...current, notes: event.target.value }))
                  }
                  placeholder="Mission, process, contexte client, doc operationnelle..."
                />
              </label>
            </div>
            <EntityMultiSelector
              title="Membres"
              detail="Les users de l'equipe heritent de son perimetre."
              selectedIds={teamForm.memberIds}
              options={teamMemberOptions}
              searchPlaceholder="Rechercher un membre..."
              onChange={(nextIds) => setTeamForm((current) => ({ ...current, memberIds: nextIds }))}
              emptyTitle="Aucun user"
              emptyBody="Cree un user avant d'assigner des membres a l'equipe."
            />
            <EntityMultiSelector
              title="Agents"
              detail="Equipe proprietaire + agents partages autorises a parler avec cette equipe."
              selectedIds={teamForm.agentIds}
              options={teamAgentOptions}
              searchPlaceholder="Rechercher un agent..."
              onChange={(nextIds) => setTeamForm((current) => ({ ...current, agentIds: nextIds }))}
              emptyTitle="Aucun agent"
              emptyBody="Cree au moins un agent pour le rattacher a une equipe."
            />
            <ChannelRouteMultiSelector
              channels={outputRouteChannels}
              channelTemplateById={channelTemplateById}
              selectedIds={teamForm.channelIds}
              onChange={(nextIds) => setTeamForm((current) => ({ ...current, channelIds: nextIds }))}
              emptySelectionLabel="Aucune destination"
              emptyResultsTitle="Aucune destination"
              emptyResultsBody="Aucune destination de sortie n'est configuree pour le moment."
              searchPlaceholder="Rechercher une destination equipe..."
            />
            <div className="detail-pairs compact-grid">
              <span>Identites membres</span>
              <span>{summarizeLabels(draftTeamIdentityLabels, 3, "aucune identite")}</span>
              <span>Transports relies</span>
              <span>{summarizeLabels(draftTeamTransportLabels, 2, "aucun transport")}</span>
              <span>Diffusion</span>
              <span>
                {teamForm.memberIds.length}
                {" user(s) -> "}
                {teamForm.agentIds.length}
                {" agent(s) -> "}
                {teamForm.channelIds.length}
                {" destination(s)"}
              </span>
              <span>Preview</span>
              <span>
                {editingTeam ? `edition ${editingTeam.name}` : "nouvelle equipe en préparation"}
              </span>
            </div>
            <article className="callout">
              <strong>Semantique team-first</strong>
              <p>
                Les agents selectionnes ici deviennent joignables pour les users de cette equipe.
                L'equipe proprietaire de chaque agent reste definie dans Agent Studio.
              </p>
            </article>
            <div className="button-row">
              <button
                type="button"
                className="ghost-button"
                onClick={() => void handleSaveTeam()}
              >
                {teamEditorMode === "edit" ? "Sauvegarder l'equipe" : "Ajouter l'equipe"}
              </button>
            </div>
          </section>

          <section className="panel">
            <ResourceToolbar
              title="Grant Access"
              detail="RBAC dashboard sur agents, skills et ressources"
            />
            <article className="callout">
              <strong>Scope effectif du sujet</strong>
              <p>
                {grantForm.subjectType === "user"
                  ? selectedGrantSubjectUser
                    ? `${selectedGrantSubjectUser.name} herite de ses equipes puis de ses grants directs.`
                    : "Choisis un user pour previsualiser son scope."
                  : selectedGrantSubjectTeam
                    ? `${selectedGrantSubjectTeam.name} porte le scope partage de l'equipe.`
                    : "Choisis une equipe pour previsualiser son scope."}
              </p>
              <small className="muted-line">
                teams {selectedGrantSubjectTeamIds.map(teamName).join(", ") || "n/a"}
              </small>
              <small className="muted-line">
                agents {selectedGrantSubjectAgentIds.map(agentName).join(", ") || "n/a"}
              </small>
              <small className="muted-line">
                destinations {selectedGrantSubjectChannelIds.map(channelName).join(", ") || "n/a"}
              </small>
              <small className="muted-line">
                grants explicites{" "}
                {selectedGrantSubjectEntries.length
                  ? selectedGrantSubjectEntries
                      .map(
                        (grant) =>
                          `${grant.permission} ${grant.resourceType}:${describeGrantResourceTarget(grant)}`,
                      )
                      .join(" · ")
                  : "aucun"}
              </small>
            </article>
            <div className="form-grid">
              <label>
                Subject type
                <select
                  className="select"
                  value={grantForm.subjectType}
                  onChange={(event) =>
                    setGrantForm((current) => ({
                      ...current,
                      subjectType: event.target.value as "user" | "team",
                      subjectId: "",
                    }))
                  }
                >
                  <option value="user">user</option>
                  <option value="team">team</option>
                </select>
              </label>
              <label>
                Subject id
                <select
                  className="select"
                  value={grantForm.subjectId}
                  onChange={(event) =>
                    setGrantForm((current) => ({ ...current, subjectId: event.target.value }))
                  }
                >
                  <option value="">Choisir...</option>
                  {grantSubjectOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Resource type
                <select
                  className="select"
                  value={grantForm.resourceType}
                  onChange={(event) =>
                    setGrantForm((current) => ({
                      ...current,
                      resourceType: event.target.value as
                        | "agent"
                        | "skill"
                        | "channel"
                        | "pipeline"
                        | "workspace"
                        | "provider"
                        | "cron"
                        | "*",
                      resourceId: event.target.value === "*" ? "*" : "",
                    }))
                  }
                >
                  <option value="agent">agent</option>
                  <option value="skill">skill</option>
                  <option value="channel">channel</option>
                  <option value="pipeline">pipeline</option>
                  <option value="workspace">workspace</option>
                  <option value="provider">provider</option>
                  <option value="cron">cron</option>
                  <option value="*">*</option>
                </select>
              </label>
              <label>
                Resource id
                <select
                  className="select"
                  value={grantForm.resourceId}
                  onChange={(event) =>
                    setGrantForm((current) => ({ ...current, resourceId: event.target.value }))
                  }
                >
                  <option value="">
                    {grantForm.resourceType === "*" ? "Toutes les ressources" : "Choisir..."}
                  </option>
                  {grantResourceIdOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Permission
                <select
                  className="select"
                  value={grantForm.permission}
                  onChange={(event) =>
                    setGrantForm((current) => ({ ...current, permission: event.target.value }))
                  }
                >
                  <option value="view">view</option>
                  <option value="operate">operate</option>
                  <option value="admin">admin</option>
                </select>
              </label>
            </div>
            <div className="button-row">
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !grantForm.subjectId ||
                  (!grantForm.resourceId && grantForm.resourceType !== "*")
                }
                onClick={() =>
                  void mutateResource("create", "grants", {
                    subjectType: grantForm.subjectType,
                    subjectId: grantForm.subjectId,
                    resourceType: grantForm.resourceType,
                    resourceId: grantForm.resourceId,
                    permission: grantForm.permission,
                  })
                }
              >
                Ajouter le grant
              </button>
            </div>
          </section>
        </div>

        <section className="panel">
          <ResourceToolbar title="Equipes" detail="Membres, agents et destinations" />
          <div className="card-grid">
            {teams.map((team) => {
              const effectiveTeamChannelIds = Array.from(getTeamOwnedOutputChannelIds(team.id));
              const inboundCoverage = inboundCoverageByTeamId.get(team.id);
              const inboundSessionKeys = Array.from(inboundCoverage?.sessionKeys || []);
              const inboundAllowedKeys = Array.from(inboundCoverage?.allowedSessionKeys || []);
              const inboundBlockedKeys = Array.from(inboundCoverage?.blockedSessionKeys || []);
              const inboundConflictKeys = Array.from(inboundCoverage?.conflictSessionKeys || []);
              const teamContactLabel =
                [team.contactEmail, team.website].filter(Boolean).join(" · ") || "contact n/a";
              const teamIdentityLabels = Array.from(
                new Set(
                  team.memberIds.flatMap((memberId) => {
                    const user = users.find((entry) => entry.id === memberId);
                    return user?.externalIdentities || [];
                  }),
                ),
              ).toSorted((left, right) => left.localeCompare(right));
              const teamTransportLabels = Array.from(
                new Set(
                  effectiveTeamChannelIds.map((channelId) => {
                    const channel = outputRouteChannels.find((entry) => entry.id === channelId);
                    return channel
                      ? `${channel.kind}:${normalizeChannelAccountId(channel.accountId)}`
                      : channelName(channelId);
                  }),
                ),
              ).toSorted((left, right) => left.localeCompare(right));
              return (
                <article key={team.id} className="entity-card">
                  <div className="info-row compact">
                    <strong>{team.name}</strong>
                    <StatusPill status="active">{team.color}</StatusPill>
                  </div>
                  <p>{team.description}</p>
                  <div className="detail-pairs compact-grid">
                    <span>Contact</span>
                    <span>{teamContactLabel}</span>
                    <span>Membres</span>
                    <span>{summarizeLabels(team.memberIds.map(ownerName), 3)}</span>
                    <span>Agents</span>
                    <span>{summarizeLabels(team.agentIds.map(agentName), 3)}</span>
                    <span>Destinations</span>
                    <span>{summarizeLabels(effectiveTeamChannelIds.map(channelName), 2)}</span>
                    <span>Identites</span>
                    <span>{summarizeLabels(teamIdentityLabels, 2, "aucune identite")}</span>
                    <span>Transports</span>
                    <span>{summarizeLabels(teamTransportLabels, 2, "aucun transport")}</span>
                  </div>
                  {team.notes ? <small className="muted-line">notes {team.notes}</small> : null}
                  <small className="muted-line">
                    inbound {inboundSessionKeys.length} session(s) · ok {inboundAllowedKeys.length} · bloquees{" "}
                    {inboundBlockedKeys.length} · conflits {inboundConflictKeys.length}
                  </small>
                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => startTeamEdit(team)}
                    >
                      Modifier
                    </button>
                    {inboundSessionKeys.length ? (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => openInboxSessionFromGovernance(inboundSessionKeys[0]!)}
                      >
                        Voir inbox
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={async () => {
                        const ok = await mutateResource("delete", "teams", {}, team.id);
                        if (ok && editingTeamId === team.id) {
                          resetTeamEditor();
                        }
                      }}
                    >
                      Supprimer
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="panel">
          <ResourceToolbar
            title="Access Grants"
            detail="Permissions effectives dans le dashboard"
          />
          <div className="card-grid">
            {grants.map((grant) => (
              <article key={grant.id} className="entity-card">
                <div className="info-row compact">
                  <strong>
                    {grant.subjectType}:{grant.subjectId}
                  </strong>
                  <StatusPill status="active">{grant.permission}</StatusPill>
                </div>
                <p>
                  {grant.resourceType}:{grant.resourceId}
                </p>
                <div className="button-row">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => void mutateResource("delete", "grants", {}, grant.id)}
                  >
                    Supprimer
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="panel">
          <ResourceToolbar
            title="Agent Bindings"
            detail="Couche metadata et delegation du control tower"
          />
          <div className="card-grid">
            {(snapshot?.agentBindings || []).map((binding: AgentBinding) => (
              <article key={binding.id} className="entity-card">
                <div className="info-row compact">
                  <strong>{binding.agentId}</strong>
                  <StatusPill status="active">{teamName(binding.teamId)}</StatusPill>
                </div>
                <p>{binding.purpose}</p>
                <small className="muted-line">
                  team {teamName(binding.teamId)} · channels{" "}
                  {binding.channelIds.map(channelName).join(", ") || "n/a"}
                </small>
                <small className="muted-line">
                  outputs {describeDefaultOutputs(binding)} · resume{" "}
                  {binding.resumePolicy || "manual"} · dispatch {binding.dispatchPolicy || "manual"}
                </small>
                <small className="muted-line">
                  providers {describeAgentProviders(binding)} · skills{" "}
                  {describeAgentSkills(binding)}
                </small>
                <small className="muted-line">
                  comptes {describeAgentProviderAccounts(binding)}
                </small>
                <small className="muted-line">
                  provider policies {describeProviderSkillPolicies(binding)}
                </small>
                <small className="muted-line">tags {binding.tags.join(", ") || "n/a"}</small>
                <small className="muted-line">
                  modele{" "}
                  {binding.preferredModelRef ||
                    runtimeDefaults.agentPrimaryModelRef ||
                    "defaut runtime non defini"}
                </small>
                <small className="muted-line">
                  {formatExecutionSummary(
                    binding,
                    modelProviderFromRef(
                      binding.preferredModelRef || runtimeDefaults.agentPrimaryModelRef,
                    ),
                  )}
                </small>
              </article>
            ))}
          </div>
        </section>
      </section>
    );
  }

  function renderBody() {
    switch (view) {
      case "mission-control":
        return renderMissionControl();
      case "agents":
        return renderAgents();
      case "chat":
        return renderChat();
      case "files":
        return renderFiles();
      case "memory":
        return renderMemory();
      case "runtime":
        return renderRuntime();
      case "workspaces":
        return renderWorkspaces();
      case "skills":
        return renderSkills();
      case "providers":
        return renderProviders();
      case "channels":
        return renderChannels();
      case "pipelines":
        return renderPipelines();
      case "cron":
        return renderCron();
      case "users":
        return renderUsers();
      case "access":
        return renderAccess();
      default:
        return null;
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand-block">
            <div className="brand-mark" aria-hidden="true" />
            <div className="row-gap brand-copy">
              <span className="eyebrow">OpenClaw Runtime</span>
              <h1>Control Tower</h1>
              <p>Overlay Elytras pour gouvernance, memoire projet et operations agent-centriques.</p>
            </div>
          </div>
          <div className="sidebar-summary-grid">
            <article className="sidebar-context-card">
              <span>Etat</span>
              <strong>{snapshotReady ? "Connecte" : "Sync"}</strong>
              <small>{gatewayDisplayUrl}</small>
            </article>
            <article className="sidebar-context-card">
              <span>Acteur</span>
              <strong>{dashboardActorLabel}</strong>
              <small>{dashboardActorHint}</small>
            </article>
            <article className="sidebar-context-card">
              <span>Equipe</span>
              <strong>{dashboardTeamScopeLabel}</strong>
              <small>{visibleAgents.length} agent(s)</small>
            </article>
            <article className="sidebar-context-card">
              <span>Memoire</span>
              <strong>{dashboardProjectScopeLabel}</strong>
              <small>{visibleOutputRouteChannels.length} destination(s)</small>
            </article>
          </div>
        </div>

        <div className="sidebar-section stack compact">
          <label>
            <span className="eyebrow">Contexte dashboard</span>
            <select
              className="select"
              value={selectedDashboardUserId}
              onChange={(event) => setSelectedDashboardUserId(event.target.value)}
            >
              <option value={DASHBOARD_ROOT_USER_ID}>Admin local Elytras</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} · {user.role}
                </option>
              ))}
            </select>
          </label>
          {!currentUserCanManageAdminViews && selectedDashboardAvailableTeamIds.length > 1 ? (
            <label>
              <span className="eyebrow">Scope equipe</span>
              <select
                className="select"
                value={selectedDashboardTeamScopeId}
                onChange={(event) => setSelectedDashboardTeamScopeId(event.target.value)}
              >
                <option value={DASHBOARD_ALL_TEAMS_SCOPE_ID}>Toutes mes equipes</option>
                {selectedDashboardAvailableTeamIds.map((teamId) => (
                  <option key={teamId} value={teamId}>
                    {teamName(teamId)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            <span className="eyebrow">Memoire projet</span>
            <select
              className="select"
              value={selectedDashboardProjectId}
              onChange={(event) => setSelectedDashboardProjectId(event.target.value)}
            >
              <option value={DASHBOARD_NO_PROJECT_ID}>Aucun projet partage</option>
              {selectedDashboardAvailableProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} · {teamName(project.teamId)}
                </option>
              ))}
            </select>
          </label>
          <div className="side-note sidebar-context-note">
            <strong>{dashboardActorLabel}</strong>
            <div className="detail-pairs">
              <span>Role</span>
              <span>{dashboardActorHint}</span>
              <span>Teams</span>
              <span>{dashboardTeamScopeLabel}</span>
              <span>Memoire</span>
              <span>{dashboardProjectScopeLabel}</span>
            </div>
            {currentUserReadOnly ? (
              <small className="muted-line">
                Mode lecture seule: les mutations sont bloquees pour ce contexte.
              </small>
            ) : null}
          </div>
        </div>

        <div className="nav-list">
          {visibleNavItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${view === item.id ? "active" : ""}`}
              onClick={() => setView(item.id)}
            >
              <span>{item.label}</span>
              <small>{item.hint}</small>
            </button>
          ))}
        </div>

        <details className="sidebar-disclosure">
          <summary>
            <span>Connexion gateway</span>
            <small>URL, token, refresh et docs</small>
          </summary>
          <div className="stack compact">
            <label>
              <span className="eyebrow">Gateway URL</span>
              <input
                className="input"
                value={config.baseUrl}
                onChange={(event) =>
                  setConfig((current) => ({ ...current, baseUrl: event.target.value }))
                }
              />
            </label>
            <label>
              <span className="eyebrow">Gateway Token</span>
              <input
                className="input"
                value={config.token}
                onChange={(event) =>
                  setConfig((current) => ({ ...current, token: event.target.value }))
                }
              />
            </label>
            <div className="button-row">
              <button type="button" className="ghost-button" onClick={() => void refresh()}>
                Refresh
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => window.open(OPENCLAW_DOCS_URL, "_blank")}
              >
                Docs OpenClaw
              </button>
            </div>
            <small className="muted-line">
              {snapshotReady
                ? "Dashboard branche au gateway OpenClaw. Polling 2.5 s sur les surfaces live."
                : "Connexion en cours."}
            </small>
          </div>
        </details>
      </aside>

      <main className="main">
        <section className="hero hero-compact">
          <div className="stack hero-copy">
            <span className="pill">Vue active</span>
            <h2>{activeViewMeta.label}</h2>
            <p>{activeViewMeta.hint}. {heroSummaryText}</p>
          </div>
          <div className="hero-summary-grid">
            <article className="hero-summary-card">
              <span>Gateway</span>
              <strong>{snapshotReady ? "up" : "sync"}</strong>
              <small>{gatewayDisplayUrl}</small>
            </article>
            <article className="hero-summary-card">
              <span>User</span>
              <strong>{dashboardActorLabel}</strong>
              <small>{dashboardActorHint}</small>
            </article>
            <article className="hero-summary-card">
              <span>Equipe</span>
              <strong>{dashboardTeamScopeLabel}</strong>
              <small>{selectedDashboardScopedTeam ? "scope filtre" : "scope courant"}</small>
            </article>
            <article className="hero-summary-card">
              <span>Memoire</span>
              <strong>{dashboardProjectScopeLabel}</strong>
              <small>{activeViewMeta.label}</small>
            </article>
          </div>
        </section>

        {flash ? <div className="banner success">{flash}</div> : null}
        {error ? <div className="banner danger">{error}</div> : null}

        {loading && !snapshot ? (
          <section className="panel">
            <EmptyState
              title="Chargement"
              body="Initialisation du dashboard et connexion au gateway OpenClaw."
            />
          </section>
        ) : (
          renderBody()
        )}
      </main>
    </div>
  );
}
