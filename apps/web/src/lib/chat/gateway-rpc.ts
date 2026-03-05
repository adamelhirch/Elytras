import { randomUUID } from "node:crypto";

export type GatewayRpcEvent = {
  event: string;
  payload: unknown;
};

type EventListener = (evt: GatewayRpcEvent) => void;

type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message?: string };
};

type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
};

const PROTOCOL_VERSION = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

function resolveGatewayWsUrl(): string {
  const raw = process.env.OPENCLAW_GATEWAY_URL?.trim() || "ws://127.0.0.1:18789";
  if (raw.startsWith("http://")) {
    return `ws://${raw.slice("http://".length)}`;
  }
  if (raw.startsWith("https://")) {
    return `wss://${raw.slice("https://".length)}`;
  }
  return raw;
}

export class GatewayRpcClient {
  private ws: WebSocket;
  private listeners = new Set<EventListener>();
  private pending = new Map<string, PendingRequest>();
  private connectChallengeNonce: string | null = null;
  private challengeWaiter: ((nonce: string) => void) | null = null;
  private connected = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;

    this.ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      this.handleMessage(event.data);
    });

    this.ws.addEventListener("close", () => {
      this.rejectAllPending(new Error("gateway websocket closed"));
    });

    this.ws.addEventListener("error", () => {
      // les erreurs détaillées remontent via close / timeout
    });
  }

  static async connect(): Promise<GatewayRpcClient> {
    const ws = new WebSocket(resolveGatewayWsUrl());
    await waitForWebSocketOpen(ws, 10_000);

    const client = new GatewayRpcClient(ws);
    await client.waitForConnectChallenge(10_000);

    const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || process.env.GATEWAY_AUTH_TOKEN?.trim() || undefined;

    await client.requestRaw(
      "connect",
      {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          displayName: "Elytras dashboard API",
          version: "dev",
          platform: "web",
          mode: "backend",
        },
        auth: token
          ? {
              token,
            }
          : undefined,
        role: "operator",
        scopes: ["operator.admin"],
        caps: ["tool-events"],
      },
      { allowBeforeConnect: true },
    );

    client.connected = true;
    return client;
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return (await this.requestRaw(method, params)) as T;
  }

  close() {
    this.listeners.clear();
    this.rejectAllPending(new Error("gateway websocket client closed"));
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }

  private async requestRaw(
    method: string,
    params?: unknown,
    options?: { allowBeforeConnect?: boolean },
  ): Promise<unknown> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway websocket is not open");
    }

    if (!options?.allowBeforeConnect && !this.connected) {
      throw new Error("gateway websocket handshake not completed");
    }

    const id = randomUUID();
    const frame = {
      type: "req",
      id,
      method,
      params,
    };

    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway request timeout: ${method}`));
      }, DEFAULT_TIMEOUT_MS);

      this.pending.set(id, {
        resolve,
        reject,
        timeout,
      });
    });

    this.ws.send(JSON.stringify(frame));
    return await promise;
  }

  private handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    const frameType = (parsed as { type?: unknown }).type;

    if (frameType === "res") {
      const frame = parsed as GatewayResponseFrame;
      const pending = this.pending.get(frame.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(frame.id);
      if (frame.ok) {
        pending.resolve(frame.payload);
      } else {
        pending.reject(new Error(frame.error?.message ?? "gateway request failed"));
      }
      return;
    }

    if (frameType === "event") {
      const frame = parsed as GatewayEventFrame;

      if (frame.event === "connect.challenge") {
        const nonce = extractNonce(frame.payload);
        if (nonce) {
          this.connectChallengeNonce = nonce;
          this.challengeWaiter?.(nonce);
          this.challengeWaiter = null;
        }
      }

      for (const listener of this.listeners) {
        listener({
          event: frame.event,
          payload: frame.payload,
        });
      }
    }
  }

  private async waitForConnectChallenge(timeoutMs: number): Promise<string> {
    if (this.connectChallengeNonce) {
      return this.connectChallengeNonce;
    }

    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.challengeWaiter) {
          this.challengeWaiter = null;
        }
        reject(new Error("gateway connect challenge timeout"));
      }, timeoutMs);

      this.challengeWaiter = (nonce) => {
        clearTimeout(timer);
        resolve(nonce);
      };
    });
  }

  private rejectAllPending(err: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
  }
}

function waitForWebSocketOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("failed to connect to gateway websocket"));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("gateway websocket closed during handshake"));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("gateway websocket open timeout"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };

    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
}

function extractNonce(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const nonce = (payload as { nonce?: unknown }).nonce;
  if (typeof nonce !== "string" || nonce.trim().length === 0) {
    return null;
  }
  return nonce.trim();
}
