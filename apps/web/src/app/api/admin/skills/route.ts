import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/session";
import { db, skills } from "@elytras/db";
import { eq } from "drizzle-orm";

/** GET /api/admin/skills — liste tous les skills */
export async function GET() {
  await requireAdmin();
  const list = await db.select().from(skills).orderBy(skills.createdAt);
  return NextResponse.json(list);
}

/** POST /api/admin/skills — créer un skill */
export async function POST(req: NextRequest) {
  await requireAdmin();

  const body = await req.json().catch(() => null);
  if (!body?.name || !body?.skillMdContent) {
    return NextResponse.json({ error: "name et skillMdContent requis" }, { status: 400 });
  }

  const [skill] = await db
    .insert(skills)
    .values({
      name: body.name as string,
      description: (body.description as string | undefined) ?? null,
      skillMdContent: body.skillMdContent as string,
      enabledGlobal: body.enabledGlobal !== false,
    })
    .returning();

  return NextResponse.json(skill, { status: 201 });
}
