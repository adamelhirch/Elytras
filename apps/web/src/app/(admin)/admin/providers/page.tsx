import { db, aiProviders, PROVIDER_META, getProviderModels } from "@elytras/db";
import Link from "next/link";

export default async function AdminProvidersPage() {
  const list = await db
    .select({
      id: aiProviders.id,
      name: aiProviders.name,
      providerType: aiProviders.providerType,
      userId: aiProviders.userId,
      isActive: aiProviders.isActive,
      modelAllowlist: aiProviders.modelAllowlist,
      createdAt: aiProviders.createdAt,
    })
    .from(aiProviders)
    .orderBy(aiProviders.createdAt);

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Providers IA</h1>
          <p className="text-gray-400 text-sm mt-1">
            {list.length} provider(s) configuré(s)
          </p>
        </div>
        <Link
          href="/admin/providers/new"
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          + Nouveau provider
        </Link>
      </div>

      {list.length === 0 ? (
        <div className="rounded-xl border border-white/10 p-12 text-center text-gray-600">
          Aucun provider configuré.{" "}
          <Link href="/admin/providers/new" className="text-indigo-400 hover:underline">
            Ajouter Anthropic, Google ou OpenAI
          </Link>
        </div>
      ) : (
        <div className="rounded-xl border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-white/5">
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Nom</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Type</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Modèles</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Portée</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Statut</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const meta = PROVIDER_META[p.providerType] ?? PROVIDER_META.custom;
                const totalModels = getProviderModels(p.providerType).length;
                const selectedCount = p.modelAllowlist?.length ?? 0;
                const modelLabel =
                  totalModels === 0
                    ? <span className="text-gray-700">auto</span>
                    : selectedCount > 0
                      ? <span className="tabular-nums">{selectedCount} / {totalModels}</span>
                      : <span className="tabular-nums text-gray-500">{totalModels} (tous)</span>;

                return (
                  <tr key={p.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                    <td className="px-4 py-3 text-white font-medium">{p.name}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${meta.color}`}>
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {modelLabel}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs ${p.userId ? "bg-white/10 text-gray-400" : "bg-indigo-500/20 text-indigo-400"}`}>
                        {p.userId ? "user" : "global"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${p.isActive ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"}`}>
                        {p.isActive ? "actif" : "inactif"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/admin/providers/${p.id}`}
                        className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                      >
                        Modifier →
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
