import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import baseLcmPlugin from "./src/lcm/plugin/index.js";
import { normalizeElytraslessConfig } from "./src/config.js";
import { createElytraslessContextEngine } from "./src/engine.js";

function normalizePluginConfig(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export default definePluginEntry({
  id: "elytrasless",
  kind: "context-engine",
  name: "Elytrasless",
  description: "Elytras-scoped LCM context engine and memory overlay",
  configSchema: {
    parse(value: unknown) {
      return normalizePluginConfig(value);
    },
  },
  register(api: OpenClawPluginApi) {
    const config = normalizeElytraslessConfig(api.pluginConfig, api.resolvePath);
    const wrappedApi: OpenClawPluginApi = {
      ...api,
      registerContextEngine(id, factory) {
        if (id === "lossless-claw" || id === "elytrasless") {
          api.registerContextEngine("elytrasless", async () =>
            createElytraslessContextEngine({
              baseEngine: await factory(),
              config,
              logger: api.logger,
            }),
          );
          return;
        }
        if (id === "default") {
          api.registerContextEngine("default", async () =>
            createElytraslessContextEngine({
              baseEngine: await factory(),
              config,
              logger: api.logger,
            }),
          );
          return;
        }
        api.registerContextEngine(id, factory);
      },
    };
    baseLcmPlugin.register(wrappedApi);
  },
});
