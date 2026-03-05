import { db, users } from "@elytras/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/session";
import { UserProfileEditor } from "@/components/settings/user-profile-editor";

export default async function SettingsPage() {
  const session = await requireAuth();
  const [me] = await db
    .select({
      email: users.email,
      profileMd: users.profileMd,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!me) {
    return (
      <div className="p-8">
        <p className="text-red-400">Utilisateur introuvable.</p>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-4xl">
      <h1 className="text-2xl font-bold text-white mb-2">Paramètres utilisateur</h1>
      <p className="text-sm text-gray-400 mb-6">
        Gérez le profil partagé par tous vos agents.
      </p>
      <UserProfileEditor initialProfileMd={me.profileMd} email={me.email} />
    </div>
  );
}
