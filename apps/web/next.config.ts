import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Permet d'importer @elytras/db depuis le workspace pnpm
  transpilePackages: ["@elytras/db"],
  // Standalone pour le build Docker (inclut toutes les deps dans .next/standalone)
  output: "standalone",
  // Pointe vers la racine du monorepo pour que le file tracing suive les vrais fichiers
  // et non les symlinks pnpm — nécessaire pour que `next` soit inclus dans le standalone
  outputFileTracingRoot: path.join(__dirname, "../../"),
};

export default nextConfig;
