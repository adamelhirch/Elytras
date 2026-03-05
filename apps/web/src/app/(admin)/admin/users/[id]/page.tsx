import { db, users, groups, groupMembers } from "@elytras/db";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import { UserGroupsPanel } from "@/components/admin/user-groups-panel";
import { UserEditor } from "@/components/admin/user-editor";

type Props = { params: Promise<{ id: string }> };

export default async function AdminUserDetailPage({ params }: Props) {
  const { id } = await params;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!user) {notFound();}

  // Groupes actuels de l'utilisateur
  const userGroupRows = await db
    .select({ memberId: groupMembers.id, groupId: groups.id, groupName: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .where(eq(groupMembers.userId, id));

  const assignedGroupIds = new Set(userGroupRows.map((g) => g.groupId));

  // Tous les groupes disponibles
  const allGroups = await db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(groups.name);

  return (
    <div className="p-8 max-w-2xl space-y-10">
      <div>
        <Link
          href="/admin/users"
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors mb-3 inline-block"
        >
          ← Utilisateurs
        </Link>
        <h1 className="text-2xl font-bold text-white">
          {user.displayName ?? user.email}
        </h1>
        <p className="text-gray-400 text-sm mt-1">{user.email}</p>
      </div>

      {/* Infos & rôle */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-3">Profil</h2>
        <UserEditor
          userId={user.id}
          displayName={user.displayName}
          role={user.role}
          active={user.active}
        />
      </div>

      {/* Groupes */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-3">Groupes</h2>
        <UserGroupsPanel
          userId={id}
          assignedGroups={userGroupRows.map((g) => ({ memberId: g.memberId, groupId: g.groupId, groupName: g.groupName }))}
          availableGroups={allGroups.filter((g) => !assignedGroupIds.has(g.id))}
        />
      </div>
    </div>
  );
}
