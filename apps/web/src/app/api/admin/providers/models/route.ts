import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/session";
import { getProviderModels } from "@elytras/db";

/** GET /api/admin/providers/models?type=<providerType> — liste les modèles disponibles */
export async function GET(req: NextRequest) {
  await requireAdmin();

  const providerType = req.nextUrl.searchParams.get("type");
  if (!providerType) {
    return NextResponse.json({ error: "type requis" }, { status: 400 });
  }

  const models = getProviderModels(providerType);
  return NextResponse.json({ models });
}
