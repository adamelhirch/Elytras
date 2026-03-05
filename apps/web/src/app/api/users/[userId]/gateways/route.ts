import { NextRequest, NextResponse } from "next/server";
import { db, gateways } from "@elytras/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/session";

type Params = { params: Promise<{ userId: string }> };

/** GET /api/users/:userId/gateways — gateways d'un user (owner ou admin) */
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await requireAuth();
  const { userId } = await params;

  // Un user ne peut voir que ses propres gateways, sauf admin
  if (session.role !== "admin" && session.userId !== userId) {
    return NextResponse.json({ error: "Interdit" }, { status: 403 });
  }

  const list = await db
    .select()
    .from(gateways)
    .where(eq(gateways.userId, userId))
    .orderBy(gateways.createdAt);

  return NextResponse.json(list);
}

/** POST /api/users/:userId/gateways — crée un gateway pour soi-même */
export async function POST(req: NextRequest, { params }: Params) {
  const session = await requireAuth();
  const { userId } = await params;

  if (session.role !== "admin" && session.userId !== userId) {
    return NextResponse.json({ error: "Interdit" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body?.name || !body?.channelType) {
    return NextResponse.json({ error: "name et channelType requis" }, { status: 400 });
  }

  const [created] = await db
    .insert(gateways)
    .values({
      userId,
      name: body.name,
      channelType: body.channelType,
      status: "inactive",
    })
    .returning();

  return NextResponse.json(created, { status: 201 });
}
