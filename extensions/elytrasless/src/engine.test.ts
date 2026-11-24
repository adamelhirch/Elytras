import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createElytraslessContextEngine } from "./engine.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("elytrasless engine", () => {
  it("injects resolved Telegram caller context from session metadata when the session key stays on main", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "elytrasless-engine-"));
    tempDirs.push(root);
    const storePath = path.join(root, "control-tower-store.json");
    const sessionsPath = path.join(root, "state", "agents", "jarvis", "sessions", "sessions.json");

    await fs.mkdir(path.dirname(sessionsPath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          users: [
            {
              id: "adamelhirch-admin",
              name: "Adam",
              role: "admin",
              status: "active",
              teamIds: ["operations"],
              externalIdentities: ["telegram:5309671037"],
            },
          ],
          teams: [
            {
              id: "operations",
              name: "Operations",
              memberIds: ["adamelhirch-admin"],
              agentIds: ["jarvis"],
            },
          ],
          projects: [
            {
              id: "adamhub",
              name: "AdamHub",
              teamId: "operations",
              memberIds: ["adamelhirch-admin"],
              agentIds: ["jarvis"],
            },
          ],
          agentBindings: [{ agentId: "jarvis", teamId: "operations" }],
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      sessionsPath,
      JSON.stringify(
        {
          "agent:jarvis:main": {
            origin: {
              provider: "telegram",
              surface: "telegram",
              chatType: "direct",
              from: "telegram:5309671037",
              to: "telegram:5309671037",
              accountId: "default",
            },
            deliveryContext: {
              channel: "telegram",
              to: "telegram:5309671037",
              accountId: "default",
              projectId: "adamhub",
            },
            lastChannel: "telegram",
            lastTo: "telegram:5309671037",
            chatType: "direct",
            projectId: "adamhub",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const engine = createElytraslessContextEngine({
      config: {
        storePath,
        dataRoot: path.join(root, "elytras"),
        injectUserContext: true,
        injectTeamContext: true,
        injectProjectContext: true,
        auditLogPath: path.join(root, "elytras", ".elytrasless", "events.jsonl"),
        maxInjectedChars: 8000,
      },
      logger: {
        debug() {},
        error() {},
        info() {},
        warn() {},
      },
      baseEngine: {
        info: { id: "base", name: "base" },
        async ingest() {
          return { ingested: true };
        },
        async assemble() {
          return {
            messages: [],
            estimatedTokens: 0,
          };
        },
        async compact() {
          return {
            ok: true,
            compacted: false,
          };
        },
      },
    });

    const assembled = await engine.assemble({
      sessionId: "session-1",
      sessionKey: "agent:jarvis:main",
      messages: [],
    });

    expect(assembled.systemPromptAddition).toContain("[ELYTRAS TENANCY CONTEXT]");
    expect(assembled.systemPromptAddition).toContain("Resolution: resolved");
    expect(assembled.systemPromptAddition).toContain("User: Adam (adamelhirch-admin)");
    expect(assembled.systemPromptAddition).toContain("Team: Operations (operations)");
    expect(assembled.systemPromptAddition).toContain("Project: AdamHub (adamhub)");
    expect(assembled.systemPromptAddition).toContain(
      "Matched external identity: telegram:5309671037",
    );
  });

  it("finds the OpenClaw session store when the Elytras store lives under .openclaw/elytras/runtime", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "elytrasless-openclaw-root-"));
    tempDirs.push(root);
    const openclawRoot = path.join(root, ".openclaw");
    const storePath = path.join(openclawRoot, "elytras", "runtime", "control-tower-store.json");
    const sessionsPath = path.join(openclawRoot, "agents", "jarvis", "sessions", "sessions.json");

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.mkdir(path.dirname(sessionsPath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          users: [
            {
              id: "adam-user",
              name: "Adam",
              role: "admin",
              status: "active",
              teamIds: ["operations"],
              externalIdentities: ["discord:user:1061608021572206642"],
            },
          ],
          teams: [
            {
              id: "operations",
              name: "Operations",
              memberIds: ["adam-user"],
              agentIds: ["jarvis"],
            },
          ],
          projects: [],
          agentBindings: [{ agentId: "jarvis", teamId: "operations" }],
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      sessionsPath,
      JSON.stringify(
        {
          "agent:jarvis:main": {
            origin: {
              provider: "discord",
              surface: "discord",
              chatType: "direct",
              from: "discord:1061608021572206642",
              to: "channel:1489312975952281694",
              accountId: "default",
            },
            deliveryContext: {
              channel: "discord",
              to: "channel:1489312975952281694",
              accountId: "default",
            },
            lastChannel: "discord",
            lastTo: "channel:1489312975952281694",
            chatType: "direct",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const engine = createElytraslessContextEngine({
      config: {
        storePath,
        dataRoot: path.join(openclawRoot, "elytras"),
        injectUserContext: false,
        injectTeamContext: false,
        injectProjectContext: false,
        auditLogPath: path.join(openclawRoot, "elytras", ".elytrasless", "events.jsonl"),
        maxInjectedChars: 8000,
      },
      logger: {
        debug() {},
        error() {},
        info() {},
        warn() {},
      },
      baseEngine: {
        info: { id: "base", name: "base" },
        async ingest() {
          return { ingested: true };
        },
        async assemble() {
          return {
            messages: [],
            estimatedTokens: 0,
          };
        },
        async compact() {
          return {
            ok: true,
            compacted: false,
          };
        },
      },
    });

    const assembled = await engine.assemble({
      sessionId: "session-2",
      sessionKey: "agent:jarvis:main",
      messages: [],
    });

    expect(assembled.systemPromptAddition).toContain("Resolution: resolved");
    expect(assembled.systemPromptAddition).toContain("User: Adam (adam-user)");
    expect(assembled.systemPromptAddition).toContain(
      "Matched external identity: discord:user:1061608021572206642",
    );
  });
});
