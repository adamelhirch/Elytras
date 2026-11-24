import { describe, expect, it } from "vitest";
import {
  normalizeElytrasStore,
  parseSessionRef,
  resolveScopeForSession,
} from "./store.js";

describe("elytrasless store helpers", () => {
  it("parses direct agent session keys", () => {
    expect(parseSessionRef("agent:jarvis:discord:direct:327749448119746562")).toEqual({
      agentId: "jarvis",
      channel: "discord",
      peerKind: "direct",
      peerId: "327749448119746562",
    });
  });

  it("parses account-scoped direct session keys", () => {
    expect(parseSessionRef("agent:jarvis:telegram:default:direct:5309671037")).toEqual({
      agentId: "jarvis",
      channel: "telegram",
      accountId: "default",
      peerKind: "direct",
      peerId: "5309671037",
    });
  });

  it("parses per-peer direct session keys without a channel", () => {
    expect(parseSessionRef("agent:jarvis:direct:adam")).toEqual({
      agentId: "jarvis",
      peerKind: "direct",
      peerId: "adam",
    });
  });

  it("resolves user and team from runtime sender identity", () => {
    const store = normalizeElytrasStore({
      users: [
        {
          id: "adam",
          name: "Adam",
          teamIds: ["operations"],
          externalIdentities: ["discord:user:327749448119746562"],
        },
      ],
      teams: [
        {
          id: "operations",
          name: "Operations",
          memberIds: ["adam"],
          agentIds: ["jarvis"],
        },
      ],
      projects: [
        {
          id: "adamhub",
          name: "AdamHub",
          teamId: "operations",
          memberIds: ["adam"],
          agentIds: ["jarvis"],
        },
      ],
      agentBindings: [{ agentId: "jarvis", teamId: "operations" }],
    });

    expect(
      resolveScopeForSession({
        store,
        sessionKey: "agent:jarvis:main",
        messageChannel: "discord",
        senderId: "327749448119746562",
        projectId: "adamhub",
      }),
    ).toEqual({
      status: "resolved",
      agentId: "jarvis",
      user: { id: "adam", name: "Adam", role: "member", status: "active" },
      team: { id: "operations", name: "Operations" },
      project: { id: "adamhub", name: "AdamHub", teamId: "operations" },
      matchedExternalIdentity: "discord:user:327749448119746562",
      candidateExternalIds: [
        "327749448119746562",
        "discord:327749448119746562",
        "discord:user:327749448119746562",
        "discord:direct:327749448119746562",
      ],
    });
  });

  it("falls back to direct-session peer resolution when runtime sender is absent", () => {
    const store = normalizeElytrasStore({
      users: [
        {
          id: "scope-qa",
          name: "Scope QA",
          teamIds: ["operations"],
          externalIdentities: ["telegram:user:5309671037"],
        },
      ],
      teams: [
        {
          id: "operations",
          name: "Operations",
          memberIds: ["scope-qa"],
          agentIds: ["jarvis"],
        },
      ],
      projects: [],
      agentBindings: [{ agentId: "jarvis", teamId: "operations" }],
    });

    const resolved = resolveScopeForSession({
      store,
      sessionKey: "agent:jarvis:telegram:direct:5309671037",
    });

    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") {
      return;
    }
    expect(resolved.user.id).toBe("scope-qa");
    expect(resolved.team?.id).toBe("operations");
  });

  it("resolves internal dashboard sessions against Elytras user ids", () => {
    const store = normalizeElytrasStore({
      users: [
        {
          id: "adam",
          name: "Adam",
          role: "admin",
          status: "active",
          teamIds: ["operations"],
          externalIdentities: [],
        },
      ],
      teams: [
        {
          id: "operations",
          name: "Operations",
          memberIds: ["adam"],
          agentIds: ["jarvis"],
        },
      ],
      projects: [],
      agentBindings: [{ agentId: "jarvis", teamId: "operations" }],
    });

    expect(
      resolveScopeForSession({
        store,
        sessionKey: "agent:jarvis:dashboard:direct:adam",
      }),
    ).toEqual({
      status: "resolved",
      agentId: "jarvis",
      user: { id: "adam", name: "Adam", role: "admin", status: "active" },
      team: { id: "operations", name: "Operations" },
      matchedExternalIdentity: "elytras:user:adam",
      candidateExternalIds: [
        "adam",
        "dashboard:adam",
        "dashboard:user:adam",
        "dashboard:direct:adam",
      ],
    });
  });

  it("fails closed when the identity is known but the agent is not authorized for the user's team", () => {
    const store = normalizeElytrasStore({
      users: [
        {
          id: "adam",
          name: "Adam",
          teamIds: ["sales"],
          externalIdentities: ["discord:user:327749448119746562"],
        },
      ],
      teams: [
        {
          id: "sales",
          name: "Sales",
          memberIds: ["adam"],
          agentIds: [],
        },
      ],
      projects: [],
      agentBindings: [{ agentId: "jarvis", teamId: "operations" }],
    });

    expect(
      resolveScopeForSession({
        store,
        sessionKey: "agent:jarvis:discord:direct:327749448119746562",
      }),
    ).toEqual({
      status: "unresolved",
      reason: "unauthorized-team",
      agentId: "jarvis",
      candidateExternalIds: [
        "327749448119746562",
        "discord:327749448119746562",
        "discord:user:327749448119746562",
        "discord:direct:327749448119746562",
      ],
    });
  });

  it("ignores an unauthorized project request and keeps access scoped by team", () => {
    const store = normalizeElytrasStore({
      users: [
        {
          id: "adam",
          name: "Adam",
          teamIds: ["operations"],
          externalIdentities: ["discord:user:327749448119746562"],
        },
      ],
      teams: [
        {
          id: "operations",
          name: "Operations",
          memberIds: ["adam"],
          agentIds: ["jarvis"],
        },
      ],
      projects: [
        {
          id: "finance",
          name: "Finance",
          teamId: "operations",
          memberIds: ["someone-else"],
          agentIds: ["jarvis"],
        },
      ],
      agentBindings: [{ agentId: "jarvis", teamId: "operations" }],
    });

    expect(
      resolveScopeForSession({
        store,
        sessionKey: "agent:jarvis:discord:direct:327749448119746562",
        projectId: "finance",
      }),
    ).toEqual({
      status: "resolved",
      agentId: "jarvis",
      user: { id: "adam", name: "Adam", role: "member", status: "active" },
      team: { id: "operations", name: "Operations" },
      matchedExternalIdentity: "discord:user:327749448119746562",
      candidateExternalIds: [
        "327749448119746562",
        "discord:327749448119746562",
        "discord:user:327749448119746562",
        "discord:direct:327749448119746562",
      ],
    });
  });
});
