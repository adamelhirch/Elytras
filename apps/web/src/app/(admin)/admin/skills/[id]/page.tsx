import { db, skills, skillIntegrations, groups, groupSkillPermissions } from "@elytras/db";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { SkillEditor } from "@/components/admin/skill-editor";

type Props = { params: Promise<{ id: string }> };

export default async function AdminSkillDetailPage({ params }: Props) {
  const { id } = await params;

  const [skill] = await db.select().from(skills).where(eq(skills.id, id));
  if (!skill) notFound();

  // Groupes qui ont accès à ce skill
  const assignedGroups = await db
    .select({ groupId: groups.id, groupName: groups.name })
    .from(groupSkillPermissions)
    .innerJoin(groups, eq(groupSkillPermissions.groupId, groups.id))
    .where(eq(groupSkillPermissions.skillId, id));

  const integrations = await db
    .select()
    .from(skillIntegrations)
    .where(eq(skillIntegrations.skillId, id));

  return (
    <div className="p-8 max-w-4xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">{skill.name}</h1>
        <p className="text-gray-400 text-sm">Modifier le skill et ses intégrations.</p>
      </div>

      <SkillEditor skill={skill} />

      {/* Groupes avec accès */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-3">Accès via groupes</h2>
        {assignedGroups.length === 0 && !skill.enabledGlobal ? (
          <p className="text-gray-600 text-sm">
            Ce skill n&apos;est assigné à aucun groupe. Activez-le globalement ou assignez-le à un groupe depuis{" "}
            <a href="/admin/groups" className="text-indigo-400 hover:underline">la gestion des groupes</a>.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {skill.enabledGlobal && (
              <span className="px-3 py-1 rounded-lg text-sm bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                ✓ Global (accessible à tous)
              </span>
            )}
            {assignedGroups.map((g) => (
              <a
                key={g.groupId}
                href={`/admin/groups/${g.groupId}`}
                className="px-3 py-1 rounded-lg text-sm bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 hover:bg-indigo-500/30 transition-colors"
              >
                {g.groupName}
              </a>
            ))}
          </div>
        )}
      </div>

      {/* Intégrations */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-3">Intégrations externes</h2>
        {integrations.length === 0 ? (
          <p className="text-gray-600 text-sm">Aucune intégration configurée.</p>
        ) : (
          <div className="space-y-2">
            {integrations.map((intg) => (
              <div
                key={intg.id}
                className="flex items-center gap-4 px-4 py-3 rounded-xl bg-white/5 border border-white/10"
              >
                <span className="text-xs font-mono text-indigo-400">{intg.serviceType}</span>
                <span className="text-gray-400 text-sm flex-1 truncate">
                  {intg.endpoint ?? <span className="text-gray-700">—</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
