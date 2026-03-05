import { requireAuth } from "@/lib/auth/session";
import { listSkillsForUser } from "@elytras/db";

export default async function UserSkillsPage() {
  const session = await requireAuth();
  const visible = await listSkillsForUser(session.userId);

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-2xl font-bold text-white mb-1">Mes skills</h1>
      <p className="text-gray-400 text-sm mb-8">
        Les skills disponibles pour vos agents. Citez-les dans le chat avec{" "}
        <code className="text-indigo-400 bg-white/5 px-1 rounded text-xs">/nom-du-skill</code>.
      </p>

      {visible.length === 0 ? (
        <p className="text-gray-600 text-sm">Aucun skill disponible pour votre compte.</p>
      ) : (
        <div className="grid gap-3">
          {visible.map((skill) => (
            <div
              key={skill.id}
              className="flex items-start gap-4 px-5 py-4 rounded-xl bg-white/5 border border-white/10"
            >
              <div className="w-8 h-8 rounded-lg bg-violet-500/20 text-violet-300 flex items-center justify-center shrink-0 text-sm">
                ⚡
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-white">{skill.name}</div>
                {skill.description && (
                  <div className="text-xs text-gray-500 mt-0.5">{skill.description}</div>
                )}
              </div>
              <span
                className={`text-xs px-2 py-0.5 rounded ${
                  skill.enabledGlobal
                    ? "bg-emerald-500/20 text-emerald-400"
                    : "bg-violet-500/20 text-violet-400"
                }`}
              >
                {skill.enabledGlobal ? "global" : "groupe"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
