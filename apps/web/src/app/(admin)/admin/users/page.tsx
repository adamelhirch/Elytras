import { db, users, groups, groupMembers } from "@elytras/db";
import { eq } from "drizzle-orm";
import { AddUserButton } from "@/components/admin/add-user-button";
import Link from "next/link";

export default async function AdminUsersPage() {
  const list = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      displayName: users.displayName,
      active: users.active,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.createdAt);

  // Récupérer les groupes de chaque user
  const allMemberships = await db
    .select({
      userId: groupMembers.userId,
      groupId: groups.id,
      groupName: groups.name,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id));

  const userGroups = new Map<string, string[]>();
  for (const m of allMemberships) {
    if (!userGroups.has(m.userId)) {userGroups.set(m.userId, []);}
    userGroups.get(m.userId)!.push(m.groupName);
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Utilisateurs</h1>
          <p className="text-gray-400 text-sm mt-1">{list.length} compte(s) enregistré(s)</p>
        </div>
        <AddUserButton />
      </div>

      <div className="rounded-xl border border-white/10 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/5">
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Nom</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Email</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Rôle</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Groupes</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Statut</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Créé le</th>
            </tr>
          </thead>
          <tbody>
            {list.map((u) => {
              const memberOf = userGroups.get(u.id) ?? [];
              return (
                <tr key={u.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td className="px-4 py-3 text-white">
                    <Link
                      href={`/admin/users/${u.id}`}
                      className="hover:text-indigo-400 transition-colors"
                    >
                      {u.displayName ?? "—"}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-300">
                    <Link href={`/admin/users/${u.id}`} className="hover:text-indigo-400 transition-colors">
                      {u.email}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        u.role === "admin"
                          ? "bg-brand-500/20 text-brand-400"
                          : "bg-white/10 text-gray-400"
                      }`}
                    >
                      {u.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {memberOf.length === 0 ? (
                      <span className="text-gray-600 text-xs">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {memberOf.map((g) => (
                          <span
                            key={g}
                            className="px-2 py-0.5 rounded text-xs bg-indigo-500/20 text-indigo-400"
                          >
                            {g}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        u.active
                          ? "bg-emerald-500/20 text-emerald-400"
                          : "bg-red-500/20 text-red-400"
                      }`}
                    >
                      {u.active ? "actif" : "inactif"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {new Date(u.createdAt).toLocaleDateString("fr-FR")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
