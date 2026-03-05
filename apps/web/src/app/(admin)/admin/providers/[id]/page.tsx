import { db, aiProviders } from "@elytras/db";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { ProviderEditor } from "@/components/admin/provider-editor";

type Props = { params: Promise<{ id: string }> };

export default async function AdminProviderDetailPage({ params }: Props) {
  const { id } = await params;

  const [p] = await db
    .select({
      id: aiProviders.id,
      name: aiProviders.name,
      providerType: aiProviders.providerType,
      modelAllowlist: aiProviders.modelAllowlist,
      isActive: aiProviders.isActive,
      hasCredential: aiProviders.credentialEncrypted,
    })
    .from(aiProviders)
    .where(eq(aiProviders.id, id));

  if (!p) {notFound();}

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold text-white mb-1">{p.name}</h1>
      <p className="text-gray-400 text-sm mb-8">Modifier la configuration de ce provider.</p>
      <ProviderEditor
        provider={{
          id: p.id,
          name: p.name,
          providerType: p.providerType,
          modelAllowlist: p.modelAllowlist ?? [],
          isActive: p.isActive,
          hasCredential: !!p.hasCredential,
        }}
      />
    </div>
  );
}
