"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { AgentSelector } from "./agent-selector";
import { ChatMessage } from "./chat-message";
import { ChatInput } from "./chat-input";

export type Agent = {
  id: string;
  name: string;
  description?: string;
  model?: string;
  avatarUrl?: string;
};

export type Skill = {
  id: string;
  name: string;
  description?: string;
  content: string;
};

export type Message = {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  agentId?: string;
  agentName?: string;
  streaming?: boolean;
  attachments?: Attachment[];
};

export type Attachment = {
  name: string;
  content: string;
  type: "file" | "skill";
};

type SessionSummary = {
  key: string;
  updatedAt?: number;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
};

type Props = {
  agents: Agent[];
  skills: Skill[];
};

type HistoryMessage = {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
};

type ActivityPayload = {
  stream?: string;
  seq?: number;
  ts?: number;
  phase?: string;
  name?: string;
  meta?: string;
  toolCallId?: string;
  isError?: boolean;
  error?: string;
  status?: string;
  durationMs?: number;
  target?: string;
  argsPreview?: string;
  resultPreview?: string;
};

type ActivityItem = {
  id: string;
  ts: number;
  label: string;
  detail?: string;
  stream: string;
  phase?: string;
  toolName?: string;
  toolCallId?: string;
  status?: string;
  durationMs?: number;
  target?: string;
  argsPreview?: string;
  resultPreview?: string;
  error?: string;
  level: "info" | "done" | "error";
  icon: string;
};

function isBlankContent(value: string): boolean {
  return value.replace(/[\s\u200B-\u200D\uFEFF]/g, "").length === 0;
}

type PersistedActivityState = {
  runId?: string | null;
  panelOpen?: boolean;
  activities?: ActivityItem[];
};

function activityStorageKey(agentId: string | undefined, sessionKey: string | null): string | null {
  if (!agentId) {
    return null;
  }
  return `elytras:chat:activity:${agentId}:${sessionKey ?? "none"}`;
}

function iconForAction(action: string): string {
  if (action.includes("Lecture fichier")) {
    return "R";
  }
  if (action.includes("Écriture fichier")) {
    return "W";
  }
  if (action.includes("navigateur")) {
    return "WEB";
  }
  if (action.includes("skill")) {
    return "SKL";
  }
  if (action.includes("terminal")) {
    return "CMD";
  }
  if (action.includes("Recherche")) {
    return "SRCH";
  }
  return "ACT";
}

function compactPreview(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function toolExecutionKey(activity: ActivityPayload): string {
  if (activity.toolCallId) {
    return activity.toolCallId;
  }
  return `${activity.stream ?? "unknown"}:${activity.name ?? "unknown"}`;
}

function formatDuration(durationMs: number | undefined): string | undefined {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }
  if (durationMs < 1_000) {
    return `${Math.round(durationMs)}ms`;
  }
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 2 : 1)}s`;
}

function shortToolCallId(toolCallId: string | undefined): string | undefined {
  if (!toolCallId) {
    return undefined;
  }
  if (toolCallId.length <= 12) {
    return toolCallId;
  }
  return toolCallId.slice(0, 12);
}

function historyMessageToText(message: HistoryMessage): string {
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function mergeAssistantStream(previous: string, incoming: string): string {
  if (!incoming) {
    return previous;
  }

  // Some providers send cumulative snapshots while others send true deltas.
  if (incoming.startsWith(previous)) {
    return incoming;
  }
  if (previous.endsWith(incoming)) {
    return previous;
  }

  const maxOverlap = Math.min(previous.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.endsWith(incoming.slice(0, overlap))) {
      return previous + incoming.slice(overlap);
    }
  }

  return previous + incoming;
}

function sessionTitle(session: SessionSummary): string {
  return session.label || session.derivedTitle || session.displayName || session.key;
}

function sessionPreview(session: SessionSummary): string {
  const value = session.lastMessagePreview;
  if (!value) {
    return "";
  }

  const plain = value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  return plain || value;
}

function describeToolName(name: string): string {
  const tool = name.trim().toLowerCase();
  if (!tool) {
    return "Action agent";
  }
  if (tool.includes("playwright") || tool.includes("browser")) {
    if (tool.includes("navigate") || tool.includes("open")) {
      return "Ouverture navigateur";
    }
    if (tool.includes("click") || tool.includes("fill") || tool.includes("type")) {
      return "Interaction navigateur";
    }
    if (tool.includes("screenshot") || tool.includes("snapshot")) {
      return "Capture navigateur";
    }
    return "Action navigateur";
  }
  if (tool === "read" || tool.includes("read") || tool.includes("open_file")) {
    return "Lecture fichier";
  }
  if (
    tool === "write" ||
    tool === "create" ||
    tool === "edit" ||
    tool === "apply_patch" ||
    tool.includes("write") ||
    tool.includes("create") ||
    tool.includes("save") ||
    tool.includes("edit")
  ) {
    return "Écriture fichier";
  }
  if (tool.includes("skill")) {
    return "Utilisation skill";
  }
  if (tool.includes("search") || tool.includes("web")) {
    return "Recherche web";
  }
  if (tool === "exec" || tool === "bash" || tool.includes("command") || tool.includes("shell")) {
    return "Commande terminal";
  }
  return name;
}

function inferSkillFromDetail(detail?: string): boolean {
  if (!detail) {
    return false;
  }
  const normalized = detail.toLowerCase();
  return normalized.includes("/skills/") || normalized.includes(" skill");
}

function activityToItem(activity: ActivityPayload, durationMs?: number): ActivityItem {
  const ts = typeof activity.ts === "number" ? activity.ts : Date.now();
  const stream = activity.stream ?? "unknown";
  const phase = activity.phase?.toLowerCase();
  const detail = compactPreview(activity.meta ?? activity.name);
  const target = compactPreview(activity.target);
  const argsPreview = compactPreview(activity.argsPreview);
  const resultPreview = compactPreview(activity.resultPreview);
  const status = compactPreview(activity.status);
  const error = compactPreview(activity.error);
  const id = `${stream}:${activity.seq ?? ts}:${activity.toolCallId ?? activity.name ?? ""}`;

  if (stream === "lifecycle") {
    if (phase === "start") {
      return {
        id,
        ts,
        label: "Run démarré",
        stream,
        phase,
        level: "info",
        icon: "RUN",
      };
    }
    if (phase === "end") {
      return {
        id,
        ts,
        label: "Run terminé",
        stream,
        phase,
        level: "done",
        icon: "OK",
      };
    }
    if (phase === "error") {
      return {
        id,
        ts,
        label: "Run en erreur",
        detail: error,
        stream,
        phase,
        error,
        level: "error",
        icon: "ERR",
      };
    }
    return {
      id,
      ts,
      label: `Run: ${activity.phase ?? "événement"}`,
      detail,
      stream,
      phase,
      level: "info",
      icon: "RUN",
    };
  }

  if (stream === "tool") {
    const namedAction = describeToolName(activity.name ?? "outil");
    const action =
      namedAction === (activity.name ?? "outil") && inferSkillFromDetail(detail)
        ? "Utilisation skill"
        : namedAction;
    const icon = iconForAction(action);
    if (phase === "start") {
      return {
        id,
        ts,
        label: `${action} démarré`,
        detail,
        stream,
        phase,
        toolName: activity.name,
        toolCallId: activity.toolCallId,
        status,
        target,
        argsPreview,
        resultPreview,
        level: "info",
        icon,
      };
    }
    if (phase === "end" || phase === "done" || phase === "complete" || phase === "result") {
      return {
        id,
        ts,
        label: `${action} terminé`,
        detail,
        stream,
        phase,
        toolName: activity.name,
        toolCallId: activity.toolCallId,
        status,
        durationMs,
        target,
        argsPreview,
        resultPreview,
        level: "done",
        icon,
      };
    }
    if (phase === "error" || phase === "failed" || activity.isError) {
      return {
        id,
        ts,
        label: `${action} en erreur`,
        detail: error ?? detail,
        stream,
        phase,
        toolName: activity.name,
        toolCallId: activity.toolCallId,
        status,
        durationMs,
        target,
        argsPreview,
        resultPreview,
        error,
        level: "error",
        icon: "ERR",
      };
    }
    return {
      id,
      ts,
      label: `${action}: ${activity.phase ?? "événement"}`,
      detail,
      stream,
      phase,
      toolName: activity.name,
      toolCallId: activity.toolCallId,
      status,
      durationMs,
      target,
      argsPreview,
      resultPreview,
      level: activity.isError ? "error" : "info",
      icon,
    };
  }

  if (stream === "error") {
    return {
      id,
      ts,
      label: "Erreur agent",
      detail: error ?? detail,
      stream,
      phase,
      error,
      level: "error",
      icon: "ERR",
    };
  }

  return {
    id,
    ts,
    label: `Événement ${stream}`,
    detail: detail ?? error ?? activity.name,
    stream,
    phase,
    toolName: activity.name,
    toolCallId: activity.toolCallId,
    status,
    durationMs,
    target,
    argsPreview,
    resultPreview,
    error,
    level: activity.isError ? "error" : "info",
    icon: "EVT",
  };
}

export function ChatInterface({ agents, skills }: Props) {
  const defaultAgent = agents[0];
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(defaultAgent ?? null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentSessionKey, setCurrentSessionKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [activityPanelOpen, setActivityPanelOpen] = useState(true);
  const [expandedActivityIds, setExpandedActivityIds] = useState<Record<string, boolean>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const toolStartRef = useRef<Record<string, number>>({});
  const currentActivityStorageKey = activityStorageKey(selectedAgent?.id, currentSessionKey);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const createSessionForAgent = useCallback(async (agentId: string): Promise<string> => {
    const createRes = await fetch("/api/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
    if (!createRes.ok) {
      throw new Error(`HTTP ${createRes.status}`);
    }
    const created = (await createRes.json()) as { sessionKey: string };
    return created.sessionKey;
  }, []);

  const loadSessions = useCallback(
    async (agent: Agent, preferredSessionKey?: string | null) => {
      setLoadingSessions(true);
      try {
        const listRes = await fetch(
          `/api/chat/sessions?agentId=${encodeURIComponent(agent.id)}&limit=100`,
          {
            cache: "no-store",
          },
        );
        if (!listRes.ok) {
          throw new Error(`HTTP ${listRes.status}`);
        }
        const listData = (await listRes.json()) as { sessions?: SessionSummary[] };
        const available = Array.isArray(listData.sessions) ? listData.sessions : [];

        if (available.length === 0) {
          const createdSessionKey = await createSessionForAgent(agent.id);
          setSessions([{ key: createdSessionKey, updatedAt: Date.now() }]);
          setCurrentSessionKey(createdSessionKey);
          return;
        }

        setSessions(available);
        const preferredExists =
          preferredSessionKey && available.some((entry) => entry.key === preferredSessionKey);
        setCurrentSessionKey(preferredExists ? preferredSessionKey : available[0]?.key ?? null);
      } catch {
        setSessions([]);
        setCurrentSessionKey(null);
      } finally {
        setLoadingSessions(false);
      }
    },
    [createSessionForAgent],
  );

  useEffect(() => {
    if (!selectedAgent) {
      setSessions([]);
      setCurrentSessionKey(null);
      setMessages([]);
      return;
    }

    setCurrentSessionKey(null);
    setSessions([]);
    setMessages([]);
    void loadSessions(selectedAgent, null);
  }, [selectedAgent, loadSessions]);

  const loadHistory = useCallback(async (sessionKey: string, agent: Agent | null) => {
    setLoadingHistory(true);
    try {
      const res = await fetch(
        `/api/chat/sessions/${encodeURIComponent(sessionKey)}/history?limit=200`,
        {
          cache: "no-store",
        },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as { messages?: HistoryMessage[] };
      const normalized: Message[] = Array.isArray(data.messages)
        ? data.messages
            .filter((item) => item.role === "user" || item.role === "assistant")
            .map((item) => ({
              id: crypto.randomUUID(),
              role: item.role as "user" | "assistant",
              content: historyMessageToText(item),
              agentId: item.role === "assistant" ? agent?.id : undefined,
              agentName: item.role === "assistant" ? agent?.name : undefined,
            }))
            .filter((item) => item.role !== "assistant" || !isBlankContent(item.content))
        : [];
      setMessages(normalized);
    } catch {
      setMessages([]);
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    if (!currentSessionKey) {
      setMessages([]);
      return;
    }
    void loadHistory(currentSessionKey, selectedAgent);
  }, [currentSessionKey, selectedAgent, loadHistory]);

  useEffect(() => {
    if (typeof window === "undefined" || !currentActivityStorageKey || streaming) {
      return;
    }
    const raw = window.localStorage.getItem(currentActivityStorageKey);
    if (!raw) {
      setActivities([]);
      setLastRunId(null);
      setActivityPanelOpen(true);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as PersistedActivityState;
      const restoredActivities = Array.isArray(parsed.activities)
        ? parsed.activities
            .filter(
              (item): item is ActivityItem =>
                !!item &&
                typeof item.id === "string" &&
                typeof item.ts === "number" &&
                typeof item.label === "string" &&
                (item.level === "info" || item.level === "done" || item.level === "error"),
            )
            .map((item) => ({
              ...item,
              icon: typeof item.icon === "string" ? item.icon : "EVT",
              stream: typeof item.stream === "string" ? item.stream : "unknown",
            }))
        : [];
      setActivities(restoredActivities);
      setExpandedActivityIds({});
      setLastRunId(typeof parsed.runId === "string" ? parsed.runId : null);
      if (typeof parsed.panelOpen === "boolean") {
        setActivityPanelOpen(parsed.panelOpen);
      } else {
        setActivityPanelOpen(true);
      }
    } catch {
      setActivities([]);
      setExpandedActivityIds({});
      setLastRunId(null);
      setActivityPanelOpen(true);
    }
  }, [currentActivityStorageKey, streaming]);

  useEffect(() => {
    if (typeof window === "undefined" || !currentActivityStorageKey) {
      return;
    }
    const payload: PersistedActivityState = {
      runId: currentRunId ?? lastRunId,
      panelOpen: activityPanelOpen,
      activities: activities.slice(-80),
    };
    window.localStorage.setItem(currentActivityStorageKey, JSON.stringify(payload));
  }, [activities, activityPanelOpen, currentActivityStorageKey, currentRunId, lastRunId]);

  const sendMessage = useCallback(
    async (text: string, attachments: Attachment[] = []) => {
      if (!text.trim() || streaming || !selectedAgent) {return;}

      let fullMessage = text;
      if (attachments.length > 0) {
        const ctx = attachments
          .map((a) =>
            a.type === "file"
              ? `\n\n<file name="${a.name}">\n${a.content}\n</file>`
              : `\n\n[Skill: ${a.name}]`,
          )
          .join("");
        fullMessage += ctx;
      }

      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        attachments,
      };

      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        agentId: selectedAgent.id,
        agentName: selectedAgent.name,
        streaming: true,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setStreaming(true);
      setCurrentRunId(null);
      setLastRunId(null);
      setActivities([]);
      setExpandedActivityIds({});
      setActivityPanelOpen(true);
      toolStartRef.current = {};

      abortRef.current = new AbortController();
      let activeSessionKey = currentSessionKey;

      try {
        if (!activeSessionKey) {
          const createdSessionKey = await createSessionForAgent(selectedAgent.id);
          activeSessionKey = createdSessionKey;
          setCurrentSessionKey(createdSessionKey);
          setSessions((prev) => {
            if (prev.some((entry) => entry.key === createdSessionKey)) {
              return prev;
            }
            return [{ key: createdSessionKey, updatedAt: Date.now() }, ...prev];
          });
        }

        const res = await fetch("/api/chat/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: fullMessage,
            agentId: selectedAgent.id,
            sessionKey: activeSessionKey,
          }),
          signal: abortRef.current.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let assistantContent = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) {break;}

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) {continue;}
            try {
              const payload = JSON.parse(line.slice(6)) as {
                type?: string;
                delta?: string;
                error?: string;
                runId?: string;
                sessionKey?: string;
                activity?: ActivityPayload;
              };

              if (payload.type === "meta") {
                if (payload.runId) {
                  setCurrentRunId(payload.runId);
                  setLastRunId(payload.runId);
                }
                const nextSessionKey = payload.sessionKey;
                if (nextSessionKey && nextSessionKey !== activeSessionKey) {
                  activeSessionKey = nextSessionKey;
                  setCurrentSessionKey(nextSessionKey);
                  setSessions((prev) => {
                    if (prev.some((item) => item.key === nextSessionKey)) {
                      return prev;
                    }
                    return [{ key: nextSessionKey, updatedAt: Date.now() }, ...prev];
                  });
                }
                continue;
              }

              if (payload.type === "activity") {
                if (!payload.activity) {
                  continue;
                }
                let computedDuration = payload.activity.durationMs;
                const phase = payload.activity.phase?.toLowerCase();
                const key = toolExecutionKey(payload.activity);
                const ts =
                  typeof payload.activity.ts === "number" ? payload.activity.ts : Date.now();
                if (phase === "start") {
                  toolStartRef.current[key] = ts;
                } else if (computedDuration === undefined) {
                  const startedAt = toolStartRef.current[key];
                  if (typeof startedAt === "number") {
                    if (
                      phase === "end" ||
                      phase === "done" ||
                      phase === "complete" ||
                      phase === "result" ||
                      phase === "error" ||
                      phase === "failed"
                    ) {
                      computedDuration = Math.max(0, ts - startedAt);
                      delete toolStartRef.current[key];
                    }
                  }
                }
                const item = activityToItem(payload.activity, computedDuration);
                setActivities((prev) => {
                  if (prev.some((entry) => entry.id === item.id)) {
                    return prev;
                  }
                  const next = [...prev, item];
                  return next.length > 80 ? next.slice(next.length - 80) : next;
                });
                if (item.level === "error") {
                  setExpandedActivityIds((prev) => ({ ...prev, [item.id]: true }));
                }
                continue;
              }

              if (payload.type === "delta") {
                const chunk = payload.delta ?? "";
                assistantContent = mergeAssistantStream(assistantContent, chunk);
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsg.id ? { ...m, content: assistantContent } : m,
                  ),
                );
              } else if (payload.type === "error") {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsg.id
                      ? { ...m, role: "error" as const, content: payload.error ?? "error", streaming: false }
                      : m,
                  ),
                );
              } else if (payload.type === "done" || payload.type === "aborted") {
                setMessages((prev) =>
                  prev
                    .map((m) => (m.id === assistantMsg.id ? { ...m, streaming: false } : m))
                    .filter(
                      (m) => !(m.id === assistantMsg.id && m.role === "assistant" && isBlankContent(m.content)),
                    ),
                );
              }
            } catch {
              // skip invalid chunks
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {return;}
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, role: "error" as const, content: String(err), streaming: false }
              : m,
          ),
        );
      } finally {
        setStreaming(false);
        setCurrentRunId(null);
        setMessages((prev) =>
          prev
            .map((m) => (m.id === assistantMsg.id ? { ...m, streaming: false } : m))
            .filter((m) => !(m.id === assistantMsg.id && m.role === "assistant" && isBlankContent(m.content))),
        );
        if (selectedAgent) {
          void loadSessions(selectedAgent, activeSessionKey);
        }
      }
    },
    [selectedAgent, currentSessionKey, streaming, createSessionForAgent, loadSessions],
  );

  function stopStreaming() {
    abortRef.current?.abort();
    if (currentSessionKey) {
      void fetch(`/api/chat/sessions/${encodeURIComponent(currentSessionKey)}/abort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: currentRunId ?? undefined }),
      });
    }
    setStreaming(false);
    setCurrentRunId(null);
    toolStartRef.current = {};
  }

  async function createSession() {
    if (!selectedAgent) {
      return;
    }
    const createdSessionKey = await createSessionForAgent(selectedAgent.id).catch(() => null);
    if (!createdSessionKey) {
      return;
    }
    setSessions((prev) => [{ key: createdSessionKey, updatedAt: Date.now() }, ...prev]);
    setCurrentSessionKey(createdSessionKey);
  }

  async function deleteSession(sessionKey: string) {
    if (!selectedAgent) {
      return;
    }
    if (streaming && currentSessionKey === sessionKey) {
      stopStreaming();
    }
    const res = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionKey)}`, {
      method: "DELETE",
    }).catch(() => null);
    if (!res?.ok) {
      return;
    }
    const preferredSession =
      currentSessionKey && currentSessionKey !== sessionKey ? currentSessionKey : null;
    await loadSessions(selectedAgent, preferredSession);
  }

  return (
    <div className="flex h-full">
      <aside className="w-72 border-r border-white/10 bg-[#0f1117]/80">
        <div className="p-3 border-b border-white/10 flex items-center justify-between">
          <div className="text-sm text-gray-300">Sessions</div>
          <button
            onClick={createSession}
            disabled={!selectedAgent}
            className="px-2 py-1 text-xs rounded bg-white/10 hover:bg-white/15 text-gray-200 disabled:opacity-40"
          >
            Nouvelle
          </button>
        </div>
        <div className="overflow-y-auto h-[calc(100%-49px)]">
          {loadingSessions && <div className="px-3 py-2 text-xs text-gray-500">Chargement…</div>}
          {!loadingSessions && sessions.length === 0 && (
            <div className="px-3 py-2 text-xs text-gray-500">Aucune session</div>
          )}
          {sessions.map((entry) => (
            <div
              key={entry.key}
              className={`group flex items-start gap-2 border-b border-white/5 px-2 py-2 ${
                currentSessionKey === entry.key ? "bg-white/10" : "hover:bg-white/5"
              }`}
            >
              <button
                onClick={() => setCurrentSessionKey(entry.key)}
                className="min-w-0 flex-1 text-left px-1"
              >
                <div className="text-sm text-gray-200 truncate">{sessionTitle(entry)}</div>
                {entry.lastMessagePreview && (
                  <div className="text-xs text-gray-500 truncate">{sessionPreview(entry)}</div>
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  void deleteSession(entry.key);
                }}
                className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-gray-400 hover:bg-white/10 hover:text-gray-200"
                aria-label="Supprimer la session"
                title="Supprimer la session"
              >
                Suppr
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex flex-col h-full flex-1">
        <div className="flex items-center gap-3 px-6 py-3 border-b border-white/10 bg-[#0f1117]/80 backdrop-blur">
          <AgentSelector
            agents={agents}
            selected={selectedAgent}
            onSelect={(agent) => setSelectedAgent(agent)}
          />
          {selectedAgent?.model && (
            <span className="text-xs text-gray-600 font-mono hidden sm:block">{selectedAgent.model}</span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
          {(streaming || activities.length > 0) && (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[11px] uppercase tracking-wide text-gray-400">
                  Thinking / activité agent
                </div>
                <div className="flex items-center gap-2">
                  {(currentRunId || lastRunId) && (
                    <div className="text-[11px] text-gray-500 font-mono">
                      run {(currentRunId ?? lastRunId)?.slice(0, 8)}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setActivityPanelOpen((open) => !open)}
                    className="rounded border border-white/10 px-2 py-1 text-[11px] text-gray-400 hover:bg-white/5"
                  >
                    {activityPanelOpen ? "Masquer" : `Afficher (${activities.length})`}
                  </button>
                </div>
              </div>
              {activityPanelOpen ? (
                <div className="mt-2 max-h-44 overflow-y-auto space-y-1.5 pr-1">
                  {activities.length === 0 ? (
                    <div className="text-xs text-gray-500">Initialisation du run…</div>
                  ) : (
                    activities.map((activity) => {
                      const duration = formatDuration(activity.durationMs);
                      const shortId = shortToolCallId(activity.toolCallId);
                      const hasDetails = Boolean(
                        activity.detail || activity.argsPreview || activity.resultPreview || activity.error,
                      );
                      const expanded =  expandedActivityIds[activity.id];

                      return (
                        <div
                          key={activity.id}
                          className="rounded-md border border-white/10 bg-white/[0.02] px-2.5 py-1.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <div className="inline-flex h-5 min-w-[2.3rem] items-center justify-center rounded bg-white/10 px-1 text-[10px] font-mono text-gray-300">
                                {activity.icon}
                              </div>
                              <div
                                className={`min-w-0 truncate text-xs ${
                                  activity.level === "error"
                                    ? "text-red-300"
                                    : activity.level === "done"
                                      ? "text-emerald-300"
                                      : "text-gray-200"
                                }`}
                              >
                                {activity.label}
                              </div>
                            </div>
                            <div className="text-[11px] text-gray-600">
                              {new Date(activity.ts).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                                second: "2-digit",
                              })}
                            </div>
                          </div>

                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
                            {activity.toolName && (
                              <span className="rounded bg-white/10 px-1.5 py-0.5 text-gray-400">
                                tool {activity.toolName}
                              </span>
                            )}
                            {shortId && (
                              <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-gray-400">
                                id {shortId}
                              </span>
                            )}
                            {activity.status && (
                              <span className="rounded bg-white/10 px-1.5 py-0.5 text-gray-400">
                                status {activity.status}
                              </span>
                            )}
                            {duration && (
                              <span className="rounded bg-white/10 px-1.5 py-0.5 text-gray-400">
                                durée {duration}
                              </span>
                            )}
                            {activity.target && (
                              <span
                                className="max-w-[70%] truncate rounded bg-white/10 px-1.5 py-0.5 text-gray-400"
                                title={activity.target}
                              >
                                cible {activity.target}
                              </span>
                            )}
                          </div>

                          {hasDetails && (
                            <div className="mt-1.5">
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedActivityIds((prev) => ({
                                    ...prev,
                                    [activity.id]: !prev[activity.id],
                                  }))
                                }
                                className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-gray-400 hover:bg-white/5"
                              >
                                {expanded ? "Masquer détails" : "Afficher détails"}
                              </button>
                            </div>
                          )}

                          {expanded && (
                            <div className="mt-1.5 space-y-1.5 text-[11px]">
                              {activity.detail && (
                                <div className="rounded border border-white/10 bg-black/20 px-2 py-1 text-gray-400 break-words">
                                  résumé: {activity.detail}
                                </div>
                              )}
                              {activity.argsPreview && (
                                <div>
                                  <div className="mb-0.5 text-[10px] uppercase tracking-wide text-gray-500">args</div>
                                  <pre className="max-h-28 overflow-auto rounded border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-gray-400 whitespace-pre-wrap break-words">
                                    {activity.argsPreview}
                                  </pre>
                                </div>
                              )}
                              {activity.resultPreview && (
                                <div>
                                  <div className="mb-0.5 text-[10px] uppercase tracking-wide text-gray-500">result</div>
                                  <pre className="max-h-28 overflow-auto rounded border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-gray-400 whitespace-pre-wrap break-words">
                                    {activity.resultPreview}
                                  </pre>
                                </div>
                              )}
                              {activity.error && (
                                <div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-red-300 break-words">
                                  erreur: {activity.error}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              ) : (
                <div className="mt-2 text-xs text-gray-500">
                  {streaming
                    ? "Run en cours…"
                    : `${activities.length} événement${activities.length > 1 ? "s" : ""} du dernier run`}
                </div>
              )}
            </div>
          )}

          {loadingHistory && <div className="text-sm text-gray-500">Chargement de l’historique…</div>}
          {!loadingHistory && messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-center">
              <h2 className="text-xl font-semibold text-white mb-2">
                {selectedAgent ? `Parlez à ${selectedAgent.name}` : "Sélectionnez un agent"}
              </h2>
              {selectedAgent?.description && (
                <p className="text-gray-500 text-sm max-w-sm">{selectedAgent.description}</p>
              )}
            </div>
          )}

          {messages.map((msg) => (
            <ChatMessage key={msg.id} message={msg} />
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="border-t border-white/10 p-4">
          <ChatInput
            onSend={sendMessage}
            onStop={stopStreaming}
            streaming={streaming}
            disabled={!selectedAgent}
            agents={agents}
            skills={skills}
            onMentionAgent={setSelectedAgent}
          />
        </div>
      </div>
    </div>
  );
}
