import { NextRequest, NextResponse } from "next/server";
import { signIn } from "@/lib/auth/sign-in";
import { createSession } from "@/lib/auth/session";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.email || !body?.password) {
    return NextResponse.json({ error: "Email et mot de passe requis" }, { status: 400 });
  }

  const user = await signIn(body.email as string, body.password as string);
  if (!user) {
    return NextResponse.json({ error: "Identifiants invalides" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true, role: user.role });
  await createSession(response, user);
  return response;
}
