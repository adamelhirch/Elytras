/**
 * Helpers partagés pour les routes OAuth génériques.
 * Gère le state PKCE + session stocké en cookie JWT signé.
 */
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const COOKIE_NAME = "elytras_oauth_state";
const COOKIE_TTL = 60 * 15; // 15 min

export type OAuthState = {
  providerId: string;       // pi-ai provider id ("anthropic", "github-copilot", etc.)
  dbProviderId?: string;    // id DB du provider à mettre à jour (si édition)
  providerType: string;     // type enum DB ("anthropic", "google-gemini-cli", etc.)
  verifier?: string;        // PKCE verifier (pour les flows code)
  clientId?: string;        // client_id Google (google-gemini-cli / google-antigravity)
  clientSecret?: string;    // client_secret Google (optionnel)
  deviceCode?: string;      // device_code (pour github-copilot)
  deviceDomain?: string;    // domain GHE optionnel (github-copilot)
  interval?: number;        // polling interval (github-copilot)
  expiresAt?: number;       // expiry device code (github-copilot)
};

function getJwtSecret(): Uint8Array {
  const secret = process.env.ELYTRAS_JWT_SECRET;
  if (!secret) {throw new Error("ELYTRAS_JWT_SECRET is not set");}
  return new TextEncoder().encode(secret);
}

export async function saveOAuthState(state: OAuthState): Promise<void> {
  const token = await new SignJWT(state as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${COOKIE_TTL}s`)
    .sign(getJwtSecret());

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: COOKIE_TTL,
    path: "/",
  });
}

export async function loadOAuthState(): Promise<OAuthState> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) {throw new Error("Session OAuth expirée. Relancez le flow.");}

  const { payload } = await jwtVerify(token, getJwtSecret());
  return payload as unknown as OAuthState;
}

export async function clearOAuthState(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, "", { maxAge: 0, path: "/" });
}
