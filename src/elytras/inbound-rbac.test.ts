import { describe, expect, it } from "vitest";
import { buildTestCtx } from "../auto-reply/reply/test-ctx.js";
import type { OpenClawConfig } from "../config/config.js";
import { evaluateElytrasInboundAccess } from "./inbound-rbac.js";

type ElytrasStore = Parameters<typeof evaluateElytrasInboundAccess>[0]["store"];

const emptyConfig = {} as OpenClawConfig;

function createStore(overrides: Partial<ElytrasStore> = {}): ElytrasStore {
  return {
    users: [],
    teams: [],
    channels: [],
    grants: [],
    agentBindings: [],
    ...overrides,
  };
}

function createDestinationChannel(params: {
  id: string;
  kind?: string;
  target?: string;
  deliveryTarget?: string;
  accountId?: string;
}) {
  return {
    id: params.id,
    kind: params.kind ?? "telegram",
    target: params.target ?? "telegram:42",
    deliveryTarget: params.deliveryTarget ?? "telegram:42",
    accountId: params.accountId ?? "default",
    surfaceType: "destination" as const,
    source: "custom" as const,
  };
}

describe("evaluateElytrasInboundAccess", () => {
  it("allows inbound senders when one team authorizes both the agent and destination", () => {
    const store = createStore({
      users: [
        {
          id: "u-alice",
          name: "Alice",
          role: "member",
          status: "active",
          teamIds: ["team-core"],
          channelIds: [],
          agentIds: [],
          externalIdentities: ["telegram:42"],
        },
      ],
      teams: [
        {
          id: "team-core",
          name: "Core",
          memberIds: ["u-alice"],
          agentIds: ["assistant"],
          channelIds: ["route-telegram-alice"],
        },
      ],
      channels: [
        createDestinationChannel({
          id: "route-telegram-alice",
          deliveryTarget: "telegram:42",
        }),
      ],
    });

    const decision = evaluateElytrasInboundAccess({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:42",
        To: "telegram:42",
        SenderId: "42",
        SessionKey: "agent:assistant:telegram:direct:42",
        AccountId: "default",
      }),
      cfg: emptyConfig,
      store,
    });

    expect(decision).toMatchObject({
      status: "allowed",
      reason: "team",
      userId: "u-alice",
      matchedChannelIds: ["route-telegram-alice"],
      authorizingTeamIds: ["team-core"],
    });
  });

  it("blocks inbound senders when agent and destination are only authorized through different teams", () => {
    const store = createStore({
      users: [
        {
          id: "u-bob",
          name: "Bob",
          role: "member",
          status: "active",
          teamIds: ["team-agent", "team-channel"],
          channelIds: [],
          agentIds: [],
          externalIdentities: ["telegram:77"],
        },
      ],
      teams: [
        {
          id: "team-agent",
          name: "Agent Team",
          memberIds: ["u-bob"],
          agentIds: ["assistant"],
          channelIds: [],
        },
        {
          id: "team-channel",
          name: "Channel Team",
          memberIds: ["u-bob"],
          agentIds: [],
          channelIds: ["route-telegram-bob"],
        },
      ],
      channels: [
        createDestinationChannel({
          id: "route-telegram-bob",
          deliveryTarget: "telegram:77",
        }),
      ],
    });

    const decision = evaluateElytrasInboundAccess({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:77",
        To: "telegram:77",
        SenderId: "77",
        SessionKey: "agent:assistant:telegram:direct:77",
        AccountId: "default",
      }),
      cfg: emptyConfig,
      store,
    });

    expect(decision).toMatchObject({
      status: "blocked",
      reason: "no_common_authorizing_team",
      userId: "u-bob",
      matchedChannelIds: ["route-telegram-bob"],
      authorizingTeamIds: [],
    });
  });

  it("blocks inbound senders that do not match any Elytras external identity", () => {
    const store = createStore({
      users: [
        {
          id: "u-charlie",
          name: "Charlie",
          role: "member",
          status: "active",
          teamIds: ["team-core"],
          channelIds: [],
          agentIds: [],
          externalIdentities: ["telegram:100"],
        },
      ],
      teams: [
        {
          id: "team-core",
          name: "Core",
          memberIds: ["u-charlie"],
          agentIds: ["assistant"],
          channelIds: ["route-telegram-charlie"],
        },
      ],
      channels: [
        createDestinationChannel({
          id: "route-telegram-charlie",
          deliveryTarget: "telegram:100",
        }),
      ],
    });

    const decision = evaluateElytrasInboundAccess({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:100",
        To: "telegram:100",
        SenderId: "999",
        SessionKey: "agent:assistant:telegram:direct:100",
        AccountId: "default",
      }),
      cfg: emptyConfig,
      store,
    });

    expect(decision).toMatchObject({
      status: "blocked",
      reason: "unresolved_sender",
      matchedChannelIds: ["route-telegram-charlie"],
    });
  });

  it("allows explicit agent and destination grants without a shared team", () => {
    const store = createStore({
      users: [
        {
          id: "u-dana",
          name: "Dana",
          role: "member",
          status: "active",
          teamIds: [],
          channelIds: [],
          agentIds: [],
          externalIdentities: ["telegram:501"],
        },
      ],
      channels: [
        createDestinationChannel({
          id: "route-telegram-dana",
          deliveryTarget: "telegram:501",
        }),
      ],
      grants: [
        {
          subjectType: "user",
          subjectId: "u-dana",
          resourceType: "agent",
          resourceId: "assistant",
          permission: "operate",
        },
        {
          subjectType: "user",
          subjectId: "u-dana",
          resourceType: "channel",
          resourceId: "route-telegram-dana",
          permission: "operate",
        },
      ],
    });

    const decision = evaluateElytrasInboundAccess({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:501",
        To: "telegram:501",
        SenderId: "501",
        SessionKey: "agent:assistant:telegram:direct:501",
        AccountId: "default",
      }),
      cfg: emptyConfig,
      store,
    });

    expect(decision).toMatchObject({
      status: "allowed",
      reason: "grant",
      userId: "u-dana",
      matchedChannelIds: ["route-telegram-dana"],
    });
  });
});
