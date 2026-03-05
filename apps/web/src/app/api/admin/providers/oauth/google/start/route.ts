import { randomBytes, createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/session";
import { SignJWT } from "jose";
import { GOOGLE_REDIRECT_URI } from "../constants";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

// ---------------------------------------------------------------------------
// Résolution des credentials OAuth Google
// Ordre de priorité :
//   1. Variables d'environnement ELYTRAS_GEMINI_OAUTH_CLIENT_ID / _SECRET
//   2. Extraction depuis le bundle du CLI Gemini installé (comme OpenClaw)
// ---------------------------------------------------------------------------

function findInPath(name: string): string | null {
  const exts = process.platform === "win32" ? [".cmd", ".bat", ".exe", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p)) {return p;}
    }
  }
  return null;
}

function findFile(dir: string, name: string, depth: number): string | null {
  if (depth <= 0) {return null;}
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name === name) {return p;}
      if (e.isDirectory() && !e.name.startsWith(".")) {
        const found = findFile(p, name, depth - 1);
        if (found) {return found;}
      }
    }
  } catch {}
  return null;
}

function extractGeminiCliCredentials(): { clientId: string; clientSecret: string } | null {
  try {
    const geminiPath = findInPath("gemini");
    if (!geminiPath) {return null;}

    const resolvedPath = realpathSync(geminiPath);
    const binDir = dirname(geminiPath);
    const candidates = [
      dirname(dirname(resolvedPath)),
      join(dirname(resolvedPath), "node_modules", "@google", "gemini-cli"),
      join(binDir, "node_modules", "@google", "gemini-cli"),
      join(dirname(binDir), "node_modules", "@google", "gemini-cli"),
      join(dirname(binDir), "lib", "node_modules", "@google", "gemini-cli"),
    ];

    for (const geminiCliDir of candidates) {
      const searchPaths = [
        join(geminiCliDir, "node_modules", "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js"),
        join(geminiCliDir, "node_modules", "@google", "gemini-cli-core", "dist", "code_assist", "oauth2.js"),
      ];
      let content: string | null = null;
      for (const p of searchPaths) {
        if (existsSync(p)) { content = readFileSync(p, "utf8"); break; }
      }
      if (!content) {
        const found = findFile(geminiCliDir, "oauth2.js", 10);
        if (found) {content = readFileSync(found, "utf8");}
      }
      if (content) {
        const idMatch = content.match(/(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)/);
        const secretMatch = content.match(/(GOCSPX-[A-Za-z0-9_-]+)/);
        if (idMatch && secretMatch) {
          return { clientId: idMatch[1], clientSecret: secretMatch[1] };
        }
      }
    }
  } catch {}
  return null;
}

function resolveOAuthClientConfig(): { clientId: string; clientSecret?: string } {
  // 1. Variables d'environnement (override explicite)
  const envClientId = process.env.ELYTRAS_GEMINI_OAUTH_CLIENT_ID?.trim();
  if (envClientId) {
    return {
      clientId: envClientId,
      clientSecret: process.env.ELYTRAS_GEMINI_OAUTH_CLIENT_SECRET?.trim(),
    };
  }

  // 2. Extraire depuis le CLI Gemini installé sur le serveur
  const extracted = extractGeminiCliCredentials();
  if (extracted) {return extracted;}

  throw new Error(
    "Credentials OAuth Google introuvables. Installez le CLI Gemini (`npm i -g @google/gemini-cli`) sur le serveur, ou définissez ELYTRAS_GEMINI_OAUTH_CLIENT_ID.",
  );
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function getJwtSecret(): Uint8Array {
  const secret = process.env.ELYTRAS_JWT_SECRET;
  if (!secret) {throw new Error("ELYTRAS_JWT_SECRET is not set");}
  return new TextEncoder().encode(secret);
}

/**
 * POST /api/admin/providers/oauth/google/start
 *
 * Génère une URL d'autorisation Google avec PKCE.
 * Stocke le verifier PKCE dans un cookie httpOnly signé (10 min).
 * Retourne l'URL à ouvrir dans le navigateur.
 */
export async function POST() {
  await requireAdmin();

  let clientId: string;
  let clientSecret: string | undefined;
  try {
    ({ clientId, clientSecret } = resolveOAuthClientConfig());
    void clientSecret; // stocké dans le cookie verifier pour exchange
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Client OAuth non configuré" },
      { status: 500 },
    );
  }

  const { verifier, challenge } = generatePkce();

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: GOOGLE_REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
    access_type: "offline",
    prompt: "consent",
  });
  const authUrl = `${AUTH_URL}?${params.toString()}`;

  // Signer le verifier (+ clientId/secret) dans un JWT httpOnly (expire 10 min)
  const verifierToken = await new SignJWT({ verifier, clientId, clientSecret: clientSecret ?? null })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(getJwtSecret());

  const res = NextResponse.json({ authUrl, redirectUri: GOOGLE_REDIRECT_URI });
  res.cookies.set("elytras_oauth_verifier", verifierToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10, // 10 min
    path: "/",
  });
  return res;
}
