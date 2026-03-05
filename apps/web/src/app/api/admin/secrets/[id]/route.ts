import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth/session";
import { db, secrets } from "@elytras/db";
import { eq } from "drizzle-orm";

type Ctx = { params: Promise<{ id: string }> };

/** DELETE /api/admin/secrets/[id] */
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  await requireAdmin();
  const { id } = await params;
  await db.delete(secrets).where(eq(secrets.id, id));
  return new Response(null, { status: 204 });
}
