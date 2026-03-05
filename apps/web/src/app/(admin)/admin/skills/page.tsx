import { db, skills, groupSkillPermissions } from "@elytras/db";
import { sql } from "drizzle-orm";
import Link from "next/link";

export default async function AdminSkillsPage() {
  const list = await db.select().from(skills).orderBy(skills.name);
  const globalCount = list.filter((s) => s.enabledGlobal).length;

  // Nombre de groupes par skill
  const groupCounts = await db
    .select({ skillId: groupSkillPermissions.skillId, count: sql<number>`count(*)::int` })
    .from(groupSkillPermissions)
    .groupBy(groupSkillPermissions.skillId);
  const countMap = Object.fromEntries(groupCounts.map((r) => [r.skillId, r.count]));

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Skills</h1>
          <p className="text-gray-400 text-sm mt-1">
            {list.length} skill(s) — {globalCount} actif(s) globalement
          </p>
        </div>
        <Link
          href="/admin/skills/new"
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          + Nouveau skill
        </Link>
      </div>

      {list.length === 0 ? (
        <div className="rounded-xl border border-white/10 p-12 text-center text-gray-600">
          Aucun skill configuré.{" "}
          <Link href="/admin/skills/new" className="text-indigo-400 hover:underline">
            Créer le premier skill
          </Link>
        </div>
      ) : (
        <div className="rounded-xl border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-white/5">
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Nom</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Description</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Global</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Groupes</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Créé le</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {list.map((skill) => {
                const gc = countMap[skill.id] ?? 0;
                return (
                  <tr
                    key={skill.id}
                    className="border-b border-white/5 hover:bg-white/5 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/skills/${skill.id}`}
                        className="text-white hover:text-indigo-400 font-medium transition-colors"
                      >
                        {skill.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs max-w-xs truncate">
                      {skill.description ?? <span className="text-gray-700">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${
                          skill.enabledGlobal
                            ? "bg-emerald-500/20 text-emerald-400"
                            : "bg-white/10 text-gray-500"
                        }`}
                      >
                        {skill.enabledGlobal ? "activé" : "désactivé"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {skill.enabledGlobal ? (
                        <span className="text-gray-600 text-xs">tous</span>
                      ) : gc === 0 ? (
                        <Link href="/admin/groups" className="text-xs text-amber-500 hover:underline">
                          Aucun groupe
                        </Link>
                      ) : (
                        <Link href="/admin/groups" className="text-xs text-indigo-400 hover:underline">
                          {gc} groupe(s)
                        </Link>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {new Date(skill.createdAt).toLocaleDateString("fr-FR")}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/admin/skills/${skill.id}`}
                        className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                      >
                        Gérer →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
