import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/session";
import { db, aiProviders } from "@elytras/db";
import { encrypt } from "@/lib/crypto";
import { eq } from "drizzle-orm";
import { loadOAuthState, clearOAuthState } from "../state";

const CLIENT_ID = atob("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");

/**
 * GET /api/admin/providers/oauth/poll
 * GitHub Copilot device code polling.
 */
export async function GET() {
  await requireAdmin();

  let state: Awaited<ReturnType<typeof loadOAuthState>>;
  try {
    state = await loadOAuthState();
  } catch {
    return NextResponse.json({ status: "expired" });
  }

  if (state.providerId !== "github-copilot" || !state.deviceCode) {
    return NextResponse.json({ error: "Aucun device flow actif" }, { status: 400 });
  }

  if (state.expiresAt && Date.now() > state.expiresAt) {
    return NextResponse.json({ status: "expired" });
  }

  const domain = state.deviceDomain ?? "github.com";

  const res = await fetch(`https://${domain}/login/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      device_code: state.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });

  const data = await res.json() as {
    access_token?: string;
    error?: string;
    interval?: number;
  };

  if (data.error === "authorization_pending") {
    return NextResponse.json({ status: "pending" });
  }
  if (data.error === "slow_down") {
    return NextResponse.json({ status: "pending", interval: (state.interval ?? 5) + 5 });
  }
  if (data.error) {
    return NextResponse.json({ status: "error", error: data.error });
  }
  if (!data.access_token) {
    return NextResponse.json({ status: "pending" });
  }

  // Obtenir le token Copilot depuis le token GitHub
  const copilotRes = await fetch(`https://api.${domain}/copilot_internal/v2/token`, {
    headers: { Authorization: `token ${data.access_token}`, Accept: "application/json" },
  });
  if (!copilotRes.ok) {
    return NextResponse.json({ status: "error", error: `Copilot token error: ${await copilotRes.text()}` });
  }
  const copilotToken = await copilotRes.json() as { token: string; expires_at: number };

  const credential = {
    type: "oauth",
    provider: "github-copilot",
    access: copilotToken.token,
    refresh: data.access_token,
    expires: copilotToken.expires_at * 1000,
    ...(domain !== "github.com" ? { enterpriseUrl: domain } : {}),
  };

  const credentialEncrypted = await encrypt(JSON.stringify(credential));
  const { dbProviderId, providerType } = state;

  let resultId: string;
  if (dbProviderId) {
    const [updated] = await db
      .update(aiProviders)
      .set({ credentialEncrypted, updatedAt: new Date(), isActive: true })
      .where(eq(aiProviders.id, dbProviderId))
      .returning({ id: aiProviders.id });
    if (!updated) {return NextResponse.json({ status: "error", error: "Provider introuvable" });}
    resultId = updated.id;
  } else {
    const [created] = await db
      .insert(aiProviders)
      .values({
        name: "GitHub Copilot",
        providerType: providerType as typeof aiProviders.$inferInsert["providerType"],
        credentialEncrypted,
        isActive: true,
      })
      .returning({ id: aiProviders.id });
    resultId = created.id;
  }

  await clearOAuthState();
  return NextResponse.json({ status: "success", id: resultId });
}
