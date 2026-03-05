import { db, groups, groupMembers } from "@elytras/db";
import { sql } from "drizzle-orm";
import Link from "next/link";

export default async function AdminGroupsPage() {
  const list = await db
    .select({
      id: groups.id,
      name: groups.name,
      description: groups.description,
      createdAt: groups.createdAt,
    })
    .from(groups)
    .orderBy(groups.name);

  // Compter les membres par groupe
  const counts = await db
    .select({ groupId: groupMembers.groupId, count: sql<number>`count(*)::int` })
    .from(groupMembers)
    .groupBy(groupMembers.groupId);

  const countMap = Object.fromEntries(counts.map((c) => [c.groupId, c.count]));

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Groupes</h1>
          <p className="text-gray-400 text-sm mt-1">{list.length} groupe(s)</p>
        </div>
        <Link
          href="/admin/groups/new"
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          + Nouveau groupe
        </Link>
      </div>

      {list.length === 0 ? (
        <div className="rounded-xl border border-white/10 p-12 text-center text-gray-600">
          Aucun groupe.{" "}
          <Link href="/admin/groups/new" className="text-indigo-400 hover:underline">
            Créer le premier groupe
          </Link>
        </div>
      ) : (
        <div className="grid gap-3">
          {list.map((g) => (
            <Link
              key={g.id}
              href={`/admin/groups/${g.id}`}
              className="flex items-center gap-4 px-5 py-4 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
            >
              <div className="w-9 h-9 rounded-lg bg-indigo-500/20 text-indigo-300 flex items-center justify-center font-semibold text-sm shrink-0">
                {g.name[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-white font-medium">{g.name}</div>
                {g.description && (
                  <div className="text-gray-500 text-xs mt-0.5 truncate">{g.description}</div>
                )}
              </div>
              <div className="text-xs text-gray-500 shrink-0">
                {countMap[g.id] ?? 0} membre(s)
              </div>
              <span className="text-gray-600 text-xs">→</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
