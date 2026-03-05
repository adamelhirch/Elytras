import { NextRequest, NextResponse } from "next/server";
import { db, agents, agentFiles, getAgentForUser } from "@elytras/db";
import { eq } from "drizzle-orm";
import { requireAdmin, requireAuth } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

/** GET /api/agents/:id/files */
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await requireAuth();
  const { id } = await params;

  const agent = await getAgentForUser(session.userId, id);
  if (!agent) {return NextResponse.json({ error: "Not found" }, { status: 404 });}

  const files = await db
    .select()
    .from(agentFiles)
    .where(eq(agentFiles.agentId, id))
    .orderBy(agentFiles.createdAt);
  return NextResponse.json(files);
}

/** POST /api/agents/:id/files — ajouter un fichier contexte (admin only) */
export async function POST(req: NextRequest, { params }: Params) {
  await requireAdmin();
  const { id } = await params;

  const [agent] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  if (!agent) {return NextResponse.json({ error: "Not found" }, { status: 404 });}

  const body = await req.json().catch(() => null);
  if (!body?.filename || !body?.content) {
    return NextResponse.json({ error: "filename et content requis" }, { status: 400 });
  }

  const [file] = await db
    .insert(agentFiles)
    .values({
      agentId: id,
      filename: body.filename,
      content: body.content,
      role: body.role ?? "context",
    })
    .returning();

  return NextResponse.json(file, { status: 201 });
}
