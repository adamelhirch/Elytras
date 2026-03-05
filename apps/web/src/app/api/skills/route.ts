import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/session";
import { listSkillsForUser } from "@elytras/db";

/**
 * GET /api/skills — skills disponibles pour le user connecté
 * Accès via enabledGlobal ou via groupe
 */
export async function GET() {
  const session = await requireAuth();
  const visible = await listSkillsForUser(session.userId);

  return NextResponse.json(
    visible.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      enabledGlobal: s.enabledGlobal,
    })),
  );
}
