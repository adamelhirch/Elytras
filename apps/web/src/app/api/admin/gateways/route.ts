import { NextRequest, NextResponse } from "next/server";
import { db, gateways, getAgentForUser } from "@elytras/db";
import { requireAdmin } from "@/lib/auth/session";

/** GET /api/admin/gateways — liste tous les gateways (admin) */
export async function GET() {
  await requireAdmin();
  const all = await db.select().from(gateways).orderBy(gateways.createdAt);
  return NextResponse.json(all);
}

/** POST /api/admin/gateways — crée un gateway pour n'importe quel user (admin) */
export async function POST(req: NextRequest) {
  await requireAdmin();
  const body = await req.json().catch(() => null);
  if (!body?.userId || !body?.name || !body?.channelType) {
    return NextResponse.json({ error: "userId, name et channelType requis" }, { status: 400 });
  }

  const defaultAgentId = body.defaultAgentId ?? null;
  if (defaultAgentId) {
    const allowed = await getAgentForUser(body.userId, defaultAgentId);
    if (!allowed) {
      return NextResponse.json({ error: "defaultAgentId inaccessible pour cet utilisateur" }, { status: 403 });
    }
  }

  const [created] = await db
    .insert(gateways)
    .values({
      userId: body.userId,
      name: body.name,
      channelType: body.channelType,
      status: "inactive",
      defaultAgentId,
    })
    .returning();

  return NextResponse.json(created, { status: 201 });
}
