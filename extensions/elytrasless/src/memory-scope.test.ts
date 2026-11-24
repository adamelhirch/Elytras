import { describe, expect, it } from "vitest";
import { buildElytrasMemoryScopes, formatElytrasMemoryScope } from "./memory-scope.js";

describe("elytrasless memory scope", () => {
  it("builds agent, user-agent, and project-agent scopes for a resolved Elytras caller", () => {
    const scopes = buildElytrasMemoryScopes({
      resolution: {
        status: "resolved",
        agentId: "jarvis",
        user: {
          id: "adam",
          name: "Adam",
          role: "admin",
          status: "active",
        },
        team: {
          id: "operations",
          name: "Operations",
        },
        project: {
          id: "adamhub",
          name: "AdamHub",
          teamId: "operations",
        },
        matchedExternalIdentity: "telegram:5309671037",
        candidateExternalIds: ["telegram:5309671037"],
      },
      sessionKey: "agent:jarvis:telegram:direct:5309671037",
      channel: "telegram",
    });

    expect(scopes).toEqual([
      {
        scopeType: "agent",
        agentId: "jarvis",
        sessionKey: "agent:jarvis:telegram:direct:5309671037",
        channel: "telegram",
        externalIdentity: "telegram:5309671037",
      },
      {
        scopeType: "user-agent",
        agentId: "jarvis",
        userId: "adam",
        sessionKey: "agent:jarvis:telegram:direct:5309671037",
        channel: "telegram",
        externalIdentity: "telegram:5309671037",
      },
      {
        scopeType: "project-agent",
        agentId: "jarvis",
        teamId: "operations",
        projectId: "adamhub",
        sessionKey: "agent:jarvis:telegram:direct:5309671037",
        channel: "telegram",
        externalIdentity: "telegram:5309671037",
      },
    ]);
  });

  it("formats a scope into a stable debug label", () => {
    expect(
      formatElytrasMemoryScope({
        scopeType: "project-agent",
        agentId: "jarvis",
        teamId: "operations",
        projectId: "adamhub",
        channel: "telegram",
      }),
    ).toBe("project-agent · agent=jarvis · team=operations · project=adamhub · channel=telegram");
  });
});
