import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/session";
import { saveOAuthState } from "../state";
import { generatePkce } from "./pkce";

// ── Google OAuth shared config (gemini-cli + antigravity) ────────────────────
function resolveGoogleClientConfig(): { clientId: string; clientSecret?: string } | null {
  const clientId = process.env.ELYTRAS_GEMINI_OAUTH_CLIENT_ID?.trim();
  if (!clientId) {return null;}
  return { clientId, clientSecret: process.env.ELYTRAS_GEMINI_OAUTH_CLIENT_SECRET?.trim() };
}

function extractGeminiCliCredentials(): { clientId: string; clientSecret: string } | null {
  try {
    const { existsSync, readFileSync, readdirSync, realpathSync } = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");

    const PATH = process.env.PATH ?? "";
    let geminiPath: string | null = null;
    for (const dir of PATH.split(path.delimiter)) {
      const p = path.join(dir, "gemini");
      if (existsSync(p)) { geminiPath = p; break; }
    }
    if (!geminiPath) {return null;}

    const resolvedPath = realpathSync(geminiPath);
    const binDir = path.dirname(geminiPath);
    const candidates = [
      path.dirname(path.dirname(resolvedPath)),
      path.join(path.dirname(resolvedPath), "node_modules", "@google", "gemini-cli"),
      path.join(binDir, "node_modules", "@google", "gemini-cli"),
      path.join(path.dirname(binDir), "node_modules", "@google", "gemini-cli"),
      path.join(path.dirname(binDir), "lib", "node_modules", "@google", "gemini-cli"),
    ];

    function findFile(dir: string, name: string, depth: number): string | null {
      if (depth <= 0) {return null;}
      try {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isFile() && e.name === name) {return p;}
          if (e.isDirectory() && !e.name.startsWith(".")) {
            const found = findFile(p, name, depth - 1);
            if (found) {return found;}
          }
        }
      } catch { /* ignore */ }
      return null;
    }

    for (const geminiCliDir of candidates) {
      let content: string | null = null;
      for (const p of [
        path.join(geminiCliDir, "node_modules", "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js"),
        path.join(geminiCliDir, "node_modules", "@google", "gemini-cli-core", "dist", "code_assist", "oauth2.js"),
      ]) {
        if (existsSync(p)) { content = readFileSync(p, "utf8"); break; }
      }
      if (!content) {
        const found = findFile(geminiCliDir, "oauth2.js", 10);
        if (found) {content = readFileSync(found, "utf8");}
      }
      if (content) {
        const idMatch = content.match(/(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)/);
        const secretMatch = content.match(/(GOCSPX-[A-Za-z0-9_-]+)/);
        if (idMatch && secretMatch) {return { clientId: idMatch[1], clientSecret: secretMatch[1] };}
      }
    }
  } catch { /* ignore */ }
  return null;
}

function getGoogleConfig(): { clientId: string; clientSecret?: string } {
  const env = resolveGoogleClientConfig();
  if (env) {return env;}
  const extracted = extractGeminiCliCredentials();
  if (extracted) {return extracted;}
  throw new Error(
    "Credentials OAuth Google introuvables. Définissez ELYTRAS_GEMINI_OAUTH_CLIENT_ID, ou installez le CLI Gemini sur le serveur."
  );
}

// ── Provider-specific start flows ────────────────────────────────────────────

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

async function startGoogleFlow(
  redirectUri: string,
  providerPiId: string,
  providerType: string,
  dbProviderId: string | undefined,
) {
  const { clientId, clientSecret } = getGoogleConfig();
  const { verifier, challenge } = await generatePkce();

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: GOOGLE_SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
    access_type: "offline",
    prompt: "consent",
  });

  await saveOAuthState({
    providerId: providerPiId,
    providerType,
    dbProviderId,
    verifier,
    clientId,
    clientSecret,
  });

  return NextResponse.json({
    flow: "paste_url",
    authUrl: `${GOOGLE_AUTH_URL}?${params}`,
    redirectUri,
    instructions: `Connectez-vous sur Google, puis copiez l'URL de la page de callback (${redirectUri}) et collez-la ici.`,
  });
}

async function startAnthropicFlow(providerType: string, dbProviderId: string | undefined) {
  const { verifier, challenge } = await generatePkce();
  const CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
  const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";

  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: "org:create_api_key user:profile user:inference",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });

  await saveOAuthState({ providerId: "anthropic", providerType, dbProviderId, verifier, clientId: CLIENT_ID });

  return NextResponse.json({
    flow: "paste_code",
    authUrl: `https://claude.ai/oauth/authorize?${params}`,
    instructions: "Connectez-vous sur claude.ai, autorisez l'accès, puis collez le code d'autorisation affiché (format : code#state).",
  });
}

async function startGitHubCopilotFlow(providerType: string, dbProviderId: string | undefined) {
  const CLIENT_ID = atob("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");
  const domain = "github.com";

  const res = await fetch(`https://${domain}/login/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "copilot" }),
  });
  if (!res.ok) {throw new Error(`GitHub device code error: ${await res.text()}`);}
  const device = await res.json() as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
    expires_in: number;
  };

  await saveOAuthState({
    providerId: "github-copilot",
    providerType,
    dbProviderId,
    deviceCode: device.device_code,
    deviceDomain: domain,
    interval: device.interval,
    expiresAt: Date.now() + device.expires_in * 1000,
  });

  return NextResponse.json({
    flow: "device_code",
    authUrl: device.verification_uri,
    userCode: device.user_code,
    instructions: `Ouvrez ${device.verification_uri} et entrez le code : ${device.user_code}`,
    pollIntervalMs: device.interval * 1000,
  });
}

async function startOpenAICodexFlow(providerType: string, dbProviderId: string | undefined) {
  const { verifier, challenge } = await generatePkce();
  const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
  const REDIRECT_URI = "http://localhost:1455/auth/callback";

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });

  await saveOAuthState({ providerId: "openai-codex", providerType, dbProviderId, verifier, clientId: CLIENT_ID });

  return NextResponse.json({
    flow: "paste_url",
    authUrl: `https://auth.openai.com/oauth/authorize?${params}`,
    redirectUri: REDIRECT_URI,
    instructions: `Connectez-vous sur OpenAI, puis copiez l'URL de callback (${REDIRECT_URI}) et collez-la ici.`,
  });
}

/**
 * POST /api/admin/providers/oauth/start
 * Body: { providerPiId: string, providerType: string, dbProviderId?: string }
 */
export async function POST(req: NextRequest) {
  await requireAdmin();

  const body = await req.json().catch(() => null);
  const { providerPiId, providerType, dbProviderId } = (body ?? {}) as {
    providerPiId: string;
    providerType: string;
    dbProviderId?: string;
  };
  if (!providerPiId || !providerType) {
    return NextResponse.json({ error: "providerPiId et providerType requis" }, { status: 400 });
  }

  try {
    switch (providerPiId) {
      case "google-gemini-cli":
        return await startGoogleFlow(
          "http://localhost:8085/oauth2callback",
          providerPiId, providerType, dbProviderId,
        );
      case "google-antigravity":
        return await startGoogleFlow(
          "http://localhost:51121/oauth-callback",
          providerPiId, providerType, dbProviderId,
        );
      case "anthropic":
        return await startAnthropicFlow(providerType, dbProviderId);
      case "github-copilot":
        return await startGitHubCopilotFlow(providerType, dbProviderId);
      case "openai-codex":
        return await startOpenAICodexFlow(providerType, dbProviderId);
      default:
        return NextResponse.json({ error: `Provider OAuth inconnu : ${providerPiId}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erreur lors du démarrage OAuth" },
      { status: 500 },
    );
  }
}
