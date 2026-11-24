import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { createCtApiMiddlewarePlugin } from "./dev-api";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_OPENCLAW_BASE_URL || "http://127.0.0.1:18789";

  return {
    plugins: [react(), createCtApiMiddlewarePlugin()],
    server: {
      proxy: {
        "/openclaw": {
          target,
          changeOrigin: true,
          ws: true,
        },
        "/__openclaw__": {
          target,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
