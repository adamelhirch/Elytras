import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { db, listAgentsForUser, users } from "@elytras/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/session";
import { GatewayRpcClient } from "@/lib/chat/gateway-rpc";
import {
  buildNewSessionBaseKey,
  isSessionKeyOwnedByUser,
  parseAgentIdFromSessionKey,
} from "@/lib/chat/session-key";

type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: "delta" | "final" | "aborted" | "error";
  errorMessage?: string;
  message?: {
    content?: Array<{ type?: string; text?: string }>;
  };
};

type AgentEventPayload = {
  runId?: string;
  sessionKey?: string;
  stream?: string;
  seq?: number;
  ts?: number;
  data?: Record<string, unknown>;
};

type UnknownRecord = Record<string, unknown>;

function readEventText(payload: ChatEventPayload): string {
  const content = payload.message?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as UnknownRecord;
}

function pickString(record: UnknownRecord | undefined, keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function pickNumber(record: UnknownRecord | undefined, keys: string[]): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function truncate(value: string, max = 220): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1)}…`;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeProfileMd(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\r\n/g, "\n").trim();
  return normalized ? normalized : null;
}

function buildBodyForAgent(userMessage: string, profileMd: string | null): string | undefined {
  if (!profileMd) {
    return undefined;
  }
  const maxProfileChars = 12_000;
  const clippedProfile =
    profileMd.length > maxProfileChars
      ? `${profileMd.slice(0, maxProfileChars)}\n\n[Profile tronqué]`
      : profileMd;

  return [
    "<user_profile_shared_across_agents>",
    clippedProfile,
    "</user_profile_shared_across_agents>",
    "",
    userMessage,
  ].join("\n");
}

function previewUnknown(value: unknown, max = 320): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    const compact = compactWhitespace(value);
    return compact ? truncate(compact, max) : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value) || typeof value === "object") {
    try {
      const serialized = JSON.stringify(value);
      if (!serialized) {
        return undefined;
      }
      return truncate(serialized, max);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function summarizeTarget(args: UnknownRecord | undefined): string | undefined {
  return pickString(args, [
    "path",
    "filePath",
    "file_path",
    "filepath",
    "targetPath",
    "outputPath",
    "inputPath",
    "source",
    "destination",
    "url",
    "uri",
    "href",
    "cmd",
    "command",
    "script",
    "bash",
    "query",
    "q",
  ]);
}

function summarizeToolActivity(params: {
  name?: string;
  meta?: string;
  args?: UnknownRecord;
}): string | undefined {
  const name = params.name?.toLowerCase() ?? "";
  const args = params.args;
  const pieces: string[] = [];

  const path = pickString(args, [
    "path",
    "filePath",
    "file_path",
    "filepath",
    "targetPath",
    "outputPath",
    "inputPath",
    "source",
    "destination",
  ]);
  const url = pickString(args, ["url", "uri", "href"]);
  const command = pickString(args, ["cmd", "command", "script", "bash"]);
  const query = pickString(args, ["q", "query", "prompt"]);
  const skill = pickString(args, ["skill", "skillName", "skillId", "skill_id"]);

  if (name.includes("browser") || name.includes("playwright")) {
    if (url) {
      pieces.push(`url: ${truncate(url, 180)}`);
    }
    if (path) {
      pieces.push(`cible: ${truncate(path, 180)}`);
    }
  }

  if (
    name === "read" ||
    name.includes("read") ||
    name.includes("open") ||
    name.includes("file")
  ) {
    if (path) {
      pieces.push(`fichier: ${truncate(path, 180)}`);
    }
  }

  if (
    name === "write" ||
    name === "create" ||
    name === "edit" ||
    name === "apply_patch" ||
    name.includes("write") ||
    name.includes("create") ||
    name.includes("save") ||
    name.includes("edit")
  ) {
    if (path) {
      pieces.push(`fichier: ${truncate(path, 180)}`);
    }
  }

  if (
    name === "exec" ||
    name === "bash" ||
    name.includes("command") ||
    name.includes("shell") ||
    name.includes("exec")
  ) {
    if (command) {
      pieces.push(`cmd: ${truncate(command, 180)}`);
    }
  }

  if (name.includes("skill") && skill) {
    pieces.push(`skill: ${truncate(skill, 120)}`);
  }

  if (pieces.length === 0) {
    if (path) {
      pieces.push(truncate(path, 180));
    } else if (url) {
      pieces.push(truncate(url, 180));
    } else if (command) {
      pieces.push(`cmd: ${truncate(command, 180)}`);
    } else if (query) {
      pieces.push(`query: ${truncate(query, 120)}`);
    }
  }

  if (params.meta && params.meta.trim()) {
    pieces.push(truncate(params.meta, 240));
  }

  const unique = [...new Set(pieces)];
  return unique.length > 0 ? unique.join(" · ") : undefined;
}

export async function POST(req: NextRequest) {
  const session = await requireAuth();
  const [agentList, userRow] = await Promise.all([
    listAgentsForUser(session.userId),
    db
      .select({ profileMd: users.profileMd })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);
  const allowedAgentIds = new Set(agentList.map((agent) => agent.id));
  const profileMd = normalizeProfileMd(userRow?.profileMd);

  const body = await req.json().catch(() => null);
  if (!body?.message || typeof body.message !== "string") {
    return new Response(JSON.stringify({ error: "message requis" }), { status: 400 });
  }

  const userMessage = body.message as string;
  const requestedSessionKey =
    typeof body.sessionKey === "string" && body.sessionKey.trim() ? body.sessionKey.trim() : null;
  const requestedAgentId =
    typeof body.agentId === "string" && body.agentId.trim() ? body.agentId.trim() : null;

  if (requestedAgentId && !allowedAgentIds.has(requestedAgentId)) {
    return new Response(JSON.stringify({ error: "agent interdit" }), { status: 403 });
  }

  if (requestedSessionKey && !isSessionKeyOwnedByUser(requestedSessionKey, session.userId)) {
    return new Response(JSON.stringify({ error: "sessionKey interdit" }), { status: 403 });
  }

  const requestedSessionAgentId = requestedSessionKey
    ? parseAgentIdFromSessionKey(requestedSessionKey)
    : null;
  if (
    requestedSessionAgentId &&
    requestedSessionAgentId !== "main" &&
    !allowedAgentIds.has(requestedSessionAgentId)
  ) {
    return new Response(JSON.stringify({ error: "session liée à un agent interdit" }), {
      status: 403,
    });
  }

  const hasAgentMismatch =
    requestedAgentId &&
    requestedSessionAgentId &&
    requestedSessionAgentId !== requestedAgentId;
  const baseSessionKey =
    requestedSessionKey && !hasAgentMismatch
      ? requestedSessionKey
      :
    buildNewSessionBaseKey(session.userId, requestedAgentId ?? "main");

  const encoder = new TextEncoder();
  let streamClosed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        if (streamClosed) {
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const close = () => {
        if (streamClosed) {
          return;
        }
        streamClosed = true;
        controller.close();
      };

      const gateway = await GatewayRpcClient.connect().catch((err) => {
        send({ type: "error", error: String(err) });
        close();
        return null;
      });
      if (!gateway) {
        return;
      }

      try {
        const resolveOrReset = async (key: string): Promise<{ key: string }> => {
          try {
            return await gateway.request<{ key: string }>("sessions.resolve", {
              key,
              agentId: requestedAgentId ?? undefined,
            });
          } catch (error) {
            const reset = await gateway
              .request<{ key?: string }>("sessions.reset", {
                key,
                reason: "new",
              })
              .catch(() => {
                throw error;
              });
            return { key: reset.key ?? key };
          }
        };

        let resolved = await resolveOrReset(baseSessionKey);
        let sessionKey = resolved.key;

        const resolvedAgentId = parseAgentIdFromSessionKey(sessionKey);
        if (requestedAgentId && resolvedAgentId && resolvedAgentId !== requestedAgentId) {
          const reboundKey = buildNewSessionBaseKey(session.userId, requestedAgentId);
          resolved = await resolveOrReset(reboundKey);
          sessionKey = resolved.key;
        }

        if (!isSessionKeyOwnedByUser(sessionKey, session.userId)) {
          send({ type: "error", error: "session résolue hors namespace user" });
          return;
        }

        const finalResolvedAgentId = parseAgentIdFromSessionKey(sessionKey);
        if (
          finalResolvedAgentId &&
          finalResolvedAgentId !== "main" &&
          !allowedAgentIds.has(finalResolvedAgentId)
        ) {
          send({ type: "error", error: "session liée à un agent interdit" });
          return;
        }

        const runId = randomUUID();
        send({ type: "meta", sessionKey, runId, state: "started" });

        let settled = false;
        let resolveStreamEnd: (() => void) | null = null;
        const streamEnded = new Promise<void>((resolve) => {
          resolveStreamEnd = resolve;
        });

        const finalize = () => {
          if (settled) {
            return;
          }
          settled = true;
          resolveStreamEnd?.();
        };

        const unsubscribe = gateway.onEvent((evt) => {
          if (evt.event === "agent") {
            const payload = evt.payload as AgentEventPayload;
            if (payload.runId !== runId || payload.sessionKey !== sessionKey) {
              return;
            }
            // Assistant text already flows via chat delta; forward runtime/tool activity only.
            if (payload.stream === "assistant") {
              return;
            }
            const data = payload.data ?? {};
            const phase = typeof data.phase === "string" ? data.phase : undefined;
            const name = typeof data.name === "string" ? data.name : undefined;
            const meta = typeof data.meta === "string" ? data.meta : undefined;
            const args = asRecord(data.args);
            const summarizedMeta = summarizeToolActivity({ name, meta, args });
            const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
            const isError = data.isError === true;
            const status = pickString(data, ["status", "state"]);
            const durationMs = pickNumber(data, ["durationMs", "duration_ms", "elapsedMs"]);
            const target = summarizeTarget(args);
            const argsPreview = previewUnknown(data.args, 460);
            const resultPreview = previewUnknown(data.result, 460);
            let error =
              typeof data.error === "string"
                ? data.error
                : typeof data.reason === "string"
                  ? data.reason
                  : undefined;
            if (!error) {
              const result = asRecord(data.result);
              error = pickString(result, ["error", "reason", "message"]);
            }

            send({
              type: "activity",
              runId,
              sessionKey,
              activity: {
                stream: payload.stream,
                seq: payload.seq,
                ts: payload.ts,
                phase,
                name,
                meta: summarizedMeta,
                toolCallId,
                isError,
                error,
                status,
                durationMs,
                target,
                argsPreview,
                resultPreview,
              },
            });
            return;
          }

          if (evt.event !== "chat") {
            return;
          }
          const payload = evt.payload as ChatEventPayload;
          if (payload.runId !== runId || payload.sessionKey !== sessionKey) {
            return;
          }

          if (payload.state === "delta") {
            const delta = readEventText(payload);
            if (delta) {
              send({ type: "delta", delta, runId, sessionKey, state: payload.state });
            }
            return;
          }

          if (payload.state === "error") {
            send({
              type: "error",
              error: payload.errorMessage ?? "gateway chat error",
              runId,
              sessionKey,
              state: payload.state,
            });
            send({ type: "done", runId, sessionKey, state: payload.state });
            finalize();
            return;
          }

          if (payload.state === "aborted") {
            send({ type: "aborted", runId, sessionKey, state: payload.state });
            send({ type: "done", runId, sessionKey, state: payload.state });
            finalize();
            return;
          }

          if (payload.state === "final") {
            const finalText = readEventText(payload);
            if (finalText) {
              send({ type: "delta", delta: finalText, runId, sessionKey, state: payload.state });
            }
            send({ type: "done", runId, sessionKey, state: payload.state });
            finalize();
          }
        });

        req.signal.addEventListener("abort", () => {
          void gateway.request("chat.abort", { sessionKey, runId }).catch(() => undefined);
          finalize();
        });

        const bodyForAgent = buildBodyForAgent(userMessage, profileMd);
        await gateway.request("chat.send", {
          sessionKey,
          message: userMessage,
          ...(bodyForAgent ? { bodyForAgent } : {}),
          idempotencyKey: runId,
          deliver: false,
        });

        await streamEnded;
        unsubscribe();
      } catch (err) {
        send({ type: "error", error: String(err) });
      } finally {
        gateway.close();
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: "POST, OPTIONS",
    },
  });
}
