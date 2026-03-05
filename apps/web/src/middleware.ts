import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE = "elytras_session";

function getSecret(): Uint8Array {
  const s = process.env.ELYTRAS_JWT_SECRET;
  if (!s) {throw new Error("ELYTRAS_JWT_SECRET not set");}
  return new TextEncoder().encode(s);
}

type Session = {
  userId: string;
  role: "admin" | "user";
};

async function getSession(req: NextRequest): Promise<Session | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {return null;}
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as unknown as Session;
  } catch {
    return null;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Routes publiques — pas de vérification
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon")
  ) {
    return NextResponse.next();
  }

  const session = await getSession(req);

  // Routes protégées : /dashboard, /admin, /api/* (hors /api/auth)
  if (pathname.startsWith("/dashboard") || pathname.startsWith("/api/")) {
    if (!session) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
      }
      return NextResponse.redirect(new URL("/login", req.url));
    }
  }

  // Routes admin uniquement
  if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
    if (!session) {
      return pathname.startsWith("/api/")
        ? NextResponse.json({ error: "Non authentifié" }, { status: 401 })
        : NextResponse.redirect(new URL("/login", req.url));
    }
    if (session.role !== "admin") {
      return pathname.startsWith("/api/")
        ? NextResponse.json({ error: "Accès refusé" }, { status: 403 })
        : NextResponse.redirect(new URL("/dashboard", req.url));
    }

    // Feature flag : /admin inaccessible en mode Solo
    if (process.env.ELYTRAS_EDITION === "solo") {
      return pathname.startsWith("/api/")
        ? NextResponse.json({ error: "Édition Solo — admin non disponible" }, { status: 403 })
        : NextResponse.redirect(new URL("/dashboard", req.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
