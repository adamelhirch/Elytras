import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { requireAdmin } from "@/lib/auth/session";
import { db, aiProviders } from "@elytras/db";
import { encrypt } from "@/lib/crypto";
import { GOOGLE_REDIRECT_URI } from "../constants";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";

type GoogleTokens = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

type VerifierPayload = {
  verifier: string;
  clientId: string;
  clientSecret: string | null;
};

function getJwtSecret(): Uint8Array {
  const secret = process.env.ELYTRAS_JWT_SECRET;
  if (!secret) {throw new Error("ELYTRAS_JWT_SECRET is not set");}
  return new TextEncoder().encode(secret);
}

/** Extrait code et state depuis une URL de callback collée par l'user */
function parseCallbackUrl(input: string, expectedState: string): { code: string } {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code) {throw new Error("Paramètre 'code' manquant dans l'URL");}
    if (state && state !== expectedState) {throw new Error("State OAuth invalide — réessayez");}
    return { code };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Paramètre")) {throw e;}
    if (e instanceof Error && e.message.startsWith("State")) {throw e;}
    if (trimmed.length > 10) {return { code: trimmed };}
    throw new Error("URL de callback invalide. Collez l'URL complète (http://localhost:8085/...)", { cause: e });
  }
}

async function exchangeCode(
  code: string,
  verifier: string,
  clientId: string,
  clientSecret: string | null,
): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    grant_type: "authorization_code",
    redirect_uri: GOOGLE_REDIRECT_URI,
    code_verifier: verifier,
  });
  if (clientSecret) {body.set("client_secret", clientSecret);}

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Accept: "*/*",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Échange de tokens Google échoué : ${text}`);
  }

  const data = (await res.json()) as GoogleTokens;
  if (!data.refresh_token) {
    throw new Error(
      "Aucun refresh_token reçu. Le compte a peut-être déjà accordé l'accès — révoquez l'accès sur myaccount.google.com/permissions et réessayez.",
    );
  }
  return data;
}

async function getUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { email?: string };
      return data.email;
    }
  } catch {
    // non bloquant
  }
  return undefined;
}

async function discoverProjectId(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(CODE_ASSIST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY", pluginType: "GEMINI" } }),
    });
    if (!res.ok) {return undefined;}
    const data = (await res.json()) as {
      cloudaicompanionProject?: string | { id?: string };
    };
    const proj = data.cloudaicompanionProject;
    if (typeof proj === "string") {return proj;}
    if (typeof proj === "object" && proj?.id) {return proj.id;}
  } catch {
    // non bloquant
  }
  return process.env.GOOGLE_CLOUD_PROJECT ?? undefined;
}

/**
 * POST /api/admin/providers/oauth/google/exchange
 *
 * Body : { callbackUrl: string, providerId?: string }
 *   - callbackUrl : URL complète de callback Google collée par l'user
 *     (ou juste le code brut)
 *   - providerId : si fourni, met à jour ce provider existant ;
 *     sinon crée un nouveau provider "google" avec le nom "Google (Gemini) OAuth"
 *
 * Lit le verifier PKCE depuis le cookie httpOnly posé par /start,
 * échange le code contre des tokens, récupère email + projectId,
 * chiffre les tokens (JSON) et les stocke en DB dans credentialEncrypted.
 */
export async function POST(req: NextRequest) {
  await requireAdmin();

  // Lire et vérifier le verifier PKCE depuis le cookie
  const cookieStore = await cookies();
  const verifierToken = cookieStore.get("elytras_oauth_verifier")?.value;
  if (!verifierToken) {
    return NextResponse.json(
      { error: "Session OAuth expirée. Relancez le flow depuis le début." },
      { status: 400 },
    );
  }

  let verifier: string;
  let clientId: string;
  let clientSecret: string | null;
  try {
    const { payload } = await jwtVerify(verifierToken, getJwtSecret());
    const p = payload as unknown as VerifierPayload;
    verifier = p.verifier;
    clientId = p.clientId;
    clientSecret = p.clientSecret;
  } catch {
    return NextResponse.json(
      { error: "Token OAuth invalide ou expiré. Relancez le flow." },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body?.callbackUrl) {
    return NextResponse.json({ error: "callbackUrl requis" }, { status: 400 });
  }

  // Extraire le code depuis l'URL collée
  let code: string;
  try {
    ({ code } = parseCallbackUrl(body.callbackUrl as string, verifier));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "URL invalide" },
      { status: 400 },
    );
  }

  // Échanger le code contre des tokens
  let tokens: GoogleTokens;
  try {
    tokens = await exchangeCode(code, verifier, clientId, clientSecret);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Échange OAuth échoué" },
      { status: 502 },
    );
  }

  const [email, projectId] = await Promise.all([
    getUserEmail(tokens.access_token),
    discoverProjectId(tokens.access_token),
  ]);

  // Construire le credential à stocker (format OAuthCredential compatible)
  const credential = {
    type: "oauth",
    provider: "google-gemini-cli",
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + tokens.expires_in * 1000 - 5 * 60 * 1000,
    ...(email ? { email } : {}),
    ...(projectId ? { projectId } : {}),
  };

  const credentialEncrypted = await encrypt(JSON.stringify(credential));

  // Créer ou mettre à jour le provider en DB
  const providerId = body.providerId as string | undefined;
  let resultId: string;

  if (providerId) {
    const [updated] = await db
      .update(aiProviders)
      .set({
        credentialEncrypted,
        updatedAt: new Date(),
        isActive: true,
      })
      .where(eq(aiProviders.id, providerId))
      .returning({ id: aiProviders.id });
    if (!updated) {
      return NextResponse.json({ error: "Provider introuvable" }, { status: 404 });
    }
    resultId = updated.id;
  } else {
    const [created] = await db
      .insert(aiProviders)
      .values({
        name: email ? `Google Gemini (${email})` : "Google (Gemini) OAuth",
        providerType: "google",
        credentialEncrypted,
        isActive: true,
      })
      .returning({ id: aiProviders.id });
    resultId = created.id;
  }

  // Supprimer le cookie verifier — il ne sert plus
  const res = NextResponse.json({
    id: resultId,
    email: email ?? null,
    projectId: projectId ?? null,
  });
  res.cookies.set("elytras_oauth_verifier", "", { maxAge: 0, path: "/" });
  return res;
}
