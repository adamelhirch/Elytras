import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";

export const SESSION_COOKIE = "elytras_session";

export type SessionPayload = {
  userId: string;
  email: string;
  role: "admin" | "user";
  displayName: string | null;
};

function getSecret(): Uint8Array {
  const secret = process.env.ELYTRAS_JWT_SECRET;
  if (!secret) {throw new Error("ELYTRAS_JWT_SECRET is not set");}
  return new TextEncoder().encode(secret);
}

export async function createSession(
  response: NextResponse,
  user: SessionPayload,
): Promise<void> {
  const token = await new SignJWT({
    userId: user.userId,
    email: user.email,
    role: user.role,
    displayName: user.displayName,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getSecret());

  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7, // 7 jours
    path: "/",
  });
}

export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) {return null;}

  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

export async function requireAuth(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) {redirect("/login");}
  return session;
}

export async function requireAdmin(): Promise<SessionPayload> {
  const session = await requireAuth();
  if (session.role !== "admin") {redirect("/dashboard");}
  return session;
}
