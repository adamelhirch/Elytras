import { NextResponse } from "next/server";

// Les permissions agents sont désormais gérées via les groupes (/api/admin/groups)
export async function GET() {
  return NextResponse.json({ error: "Obsolète — utilisez les groupes" }, { status: 410 });
}
export async function PUT() {
  return NextResponse.json({ error: "Obsolète — utilisez les groupes" }, { status: 410 });
}
export async function DELETE() {
  return NextResponse.json({ error: "Obsolète — utilisez les groupes" }, { status: 410 });
}
