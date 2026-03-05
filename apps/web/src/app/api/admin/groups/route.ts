import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/session";
import { db, groups } from "@elytras/db";

export async function GET() {
  await requireAdmin();
  const list = await db.select().from(groups).orderBy(groups.name);
  return NextResponse.json(list);
}

export async function POST(req: NextRequest) {
  await requireAdmin();
  const body = await req.json().catch(() => null);
  if (!body?.name) {return NextResponse.json({ error: "name requis" }, { status: 400 });}

  const [group] = await db
    .insert(groups)
    .values({ name: body.name as string, description: body.description ?? null })
    .returning();

  return NextResponse.json(group, { status: 201 });
}
