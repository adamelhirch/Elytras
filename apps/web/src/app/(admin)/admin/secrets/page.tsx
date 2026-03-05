import { db, secrets } from "@elytras/db";

export default async function AdminSecretsPage() {
  const list = await db
    .select({
      id: secrets.id,
      ownerId: secrets.ownerId,
      ownerType: secrets.ownerType,
      name: secrets.name,
      providerHint: secrets.providerHint,
      createdAt: secrets.createdAt,
    })
    .from(secrets)
    .orderBy(secrets.createdAt);

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Secrets</h1>
          <p className="text-gray-400 text-sm mt-1">
            {list.length} secret(s) stocké(s) — valeurs chiffrées AES-256-GCM
          </p>
        </div>
      </div>

      <div className="mb-4 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-sm">
        Les valeurs ne sont jamais affichées en clair. Pour révéler un secret, utilisez l&apos;API
        avec les droits admin.
      </div>

      {list.length === 0 ? (
        <div className="rounded-xl border border-white/10 p-12 text-center text-gray-600">
          Aucun secret stocké.
        </div>
      ) : (
        <div className="rounded-xl border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-white/5">
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Nom</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Type</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Provider</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Owner</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Créé le</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td className="px-4 py-3 font-mono text-sm text-gray-200">{s.name}</td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 rounded text-xs bg-white/10 text-gray-400">
                      {s.ownerType}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {s.providerHint ?? <span className="text-gray-700">—</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-xs font-mono truncate max-w-[160px]">
                    {s.ownerId}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {new Date(s.createdAt).toLocaleDateString("fr-FR")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
