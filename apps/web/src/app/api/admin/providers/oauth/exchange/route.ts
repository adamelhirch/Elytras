import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/session";
import { db, aiProviders } from "@elytras/db";
import { encrypt } from "@/lib/crypto";
import { eq } from "drizzle-orm";
import { loadOAuthState, clearOAuthState } from "../state";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseCallbackUrl(input: string): { code: string; state?: string } {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    if (!code) {throw new Error("Paramètre 'code' manquant dans l'URL");}
    return { code, state: url.searchParams.get("state") ?? undefined };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Paramètre")) {throw e;}
    if (trimmed.length > 10) {return { code: trimmed };}
    throw new Error("URL de callback invalide. Collez l'URL complète ou le code brut.", { cause: e });
  }
}

async function getGoogleUserInfo(accessToken: string): Promise<{ email?: string; projectId?: string }> {
  const [emailRes, projectRes] = await Promise.allSettled([
    fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
      .then((r) => r.ok ? r.json() as Promise<{ email?: string }> : null),
    fetch(CODE_ASSIST_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY", pluginType: "GEMINI" } }),
    }).then((r) => r.ok ? r.json() as Promise<{ cloudaicompanionProject?: string | { id?: string } }> : null),
  ]);

  const emailData = emailRes.status === "fulfilled" ? emailRes.value : null;
  const projectData = projectRes.status === "fulfilled" ? projectRes.value : null;

  let projectId: string | undefined;
  const proj = projectData?.cloudaicompanionProject;
  if (typeof proj === "string") {projectId = proj;}
  else if (typeof proj === "object" && proj?.id) {projectId = proj.id;}
  projectId = projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? undefined;

  return { email: emailData?.email, projectId };
}

// ── Exchange handlers ─────────────────────────────────────────────────────────

async function exchangeGoogle(
  callbackInput: string,
  state: Awaited<ReturnType<typeof loadOAuthState>>,
) {
  const { code, state: stateParam } = parseCallbackUrl(callbackInput);
  const { clientId, clientSecret, verifier, providerId } = state;
  if (!clientId || !verifier) {throw new Error("State OAuth invalide.");}
  if (stateParam && stateParam !== verifier) {throw new Error("State OAuth invalide (mismatch).");}

  const redirectUri = providerId === "google-antigravity"
    ? "http://localhost:51121/oauth-callback"
    : "http://localhost:8085/oauth2callback";

  const body = new URLSearchParams({
    client_id: clientId,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (clientSecret) {body.set("client_secret", clientSecret);}

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
  });
  if (!res.ok) {throw new Error(`Échange Google échoué : ${await res.text()}`);}

  const tokens = await res.json() as { access_token: string; refresh_token?: string; expires_in: number };
  if (!tokens.refresh_token) {
    throw new Error(
      "Aucun refresh_token reçu. Révoquez l'accès sur myaccount.google.com/permissions et réessayez."
    );
  }

  const { email, projectId } = await getGoogleUserInfo(tokens.access_token);

  return {
    credential: {
      type: "oauth",
      provider: state.providerId,
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: Date.now() + tokens.expires_in * 1000 - 5 * 60 * 1000,
      ...(email ? { email } : {}),
      ...(projectId ? { projectId } : {}),
    },
    email: email ?? null,
    defaultName: email ? `${state.providerType === "google-antigravity" ? "Antigravity" : "Gemini"} (${email})` : state.providerId,
  };
}

async function exchangeAnthropic(
  codeInput: string,
  state: Awaited<ReturnType<typeof loadOAuthState>>,
) {
  const { code, state: stateParam } = parseCallbackUrl(codeInput);
  const CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
  const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";

  const res = await fetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state: stateParam ?? state.verifier,
      redirect_uri: REDIRECT_URI,
      code_verifier: state.verifier,
    }),
  });
  if (!res.ok) {throw new Error(`Échange Anthropic échoué : ${await res.text()}`);}

  const tokens = await res.json() as { access_token: string; refresh_token: string; expires_in: number };

  return {
    credential: {
      type: "oauth",
      provider: "anthropic",
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: Date.now() + tokens.expires_in * 1000 - 5 * 60 * 1000,
    },
    email: null as string | null,
    defaultName: "Anthropic (Claude Pro)",
  };
}

async function exchangeOpenAICodex(
  callbackInput: string,
  state: Awaited<ReturnType<typeof loadOAuthState>>,
) {
  const { code, state: stateParam } = parseCallbackUrl(callbackInput);
  const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
  const REDIRECT_URI = "http://localhost:1455/auth/callback";
  if (!state.verifier) {throw new Error("State OAuth invalide.");}
  if (stateParam && stateParam !== state.verifier) {throw new Error("State OAuth invalide (mismatch).");}

  const res = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: state.verifier ?? "",
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) {throw new Error(`Échange OpenAI Codex échoué : ${await res.text()}`);}

  const tokens = await res.json() as { access_token: string; refresh_token: string; expires_in: number };

  return {
    credential: {
      type: "oauth",
      provider: "openai-codex",
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: Date.now() + tokens.expires_in * 1000 - 5 * 60 * 1000,
    },
    email: null as string | null,
    defaultName: "OpenAI Codex",
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

/**
 * POST /api/admin/providers/oauth/exchange
 * Body: { input: string, dbProviderId?: string }
 *   - input : URL de callback collée, ou code brut
 */
export async function POST(req: NextRequest) {
  await requireAdmin();

  let state: Awaited<ReturnType<typeof loadOAuthState>>;
  try {
    state = await loadOAuthState();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Session OAuth expirée." }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const input = (body?.input as string | undefined)?.trim();
  if (!input) {
    return NextResponse.json({ error: "input requis (code ou URL de callback)" }, { status: 400 });
  }

  // dbProviderId peut venir du body OU du state
  const dbProviderId = (body?.dbProviderId as string | undefined) ?? state.dbProviderId;

  let result: { credential: object; email: string | null; defaultName: string };
  try {
    switch (state.providerId) {
      case "google-gemini-cli":
      case "google-antigravity":
        result = await exchangeGoogle(input, state);
        break;
      case "anthropic":
        result = await exchangeAnthropic(input, state);
        break;
      case "openai-codex":
        result = await exchangeOpenAICodex(input, state);
        break;
      default:
        return NextResponse.json({ error: `Exchange non supporté pour ${state.providerId}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Échange OAuth échoué" }, { status: 502 });
  }

  const credentialEncrypted = await encrypt(JSON.stringify(result.credential));
  let resultId: string;

  if (dbProviderId) {
    const [updated] = await db
      .update(aiProviders)
      .set({ credentialEncrypted, updatedAt: new Date(), isActive: true })
      .where(eq(aiProviders.id, dbProviderId))
      .returning({ id: aiProviders.id });
    if (!updated) {return NextResponse.json({ error: "Provider introuvable" }, { status: 404 });}
    resultId = updated.id;
  } else {
    const [created] = await db
      .insert(aiProviders)
      .values({
        name: result.defaultName,
        providerType: state.providerType as typeof aiProviders.$inferInsert["providerType"],
        credentialEncrypted,
        isActive: true,
      })
      .returning({ id: aiProviders.id });
    resultId = created.id;
  }

  await clearOAuthState();

  return NextResponse.json({ id: resultId, email: result.email });
}
