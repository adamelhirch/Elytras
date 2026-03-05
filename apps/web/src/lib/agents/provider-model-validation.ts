import { aiProviders, db, getProviderModels } from "@elytras/db";
import { eq } from "drizzle-orm";

export type ProviderModelValidationResult =
  | { ok: true; aiProviderId: string | null; model: string | null }
  | { ok: false; status: number; error: string };

export async function validateProviderModelPair(input: {
  aiProviderId: string | null | undefined;
  model: string | null | undefined;
}): Promise<ProviderModelValidationResult> {
  const aiProviderId = input.aiProviderId ?? null;
  const model = input.model ?? null;

  if (!aiProviderId && !model) {
    return { ok: true, aiProviderId: null, model: null };
  }

  if (!aiProviderId || !model) {
    return {
      ok: false,
      status: 400,
      error: "aiProviderId et model doivent être fournis ensemble",
    };
  }

  const [provider] = await db
    .select({
      id: aiProviders.id,
      providerType: aiProviders.providerType,
      modelAllowlist: aiProviders.modelAllowlist,
      isActive: aiProviders.isActive,
    })
    .from(aiProviders)
    .where(eq(aiProviders.id, aiProviderId))
    .limit(1);

  if (!provider || !provider.isActive) {
    return {
      ok: false,
      status: 422,
      error: "Provider IA introuvable ou inactif",
    };
  }

  const providerModels = getProviderModels(provider.providerType);
  const knownModelIds = new Set(providerModels.map((m) => m.id));

  if (!knownModelIds.has(model)) {
    return {
      ok: false,
      status: 422,
      error: "Le modèle sélectionné n'existe pas pour ce provider",
    };
  }

  const allowlist = provider.modelAllowlist ?? [];
  if (allowlist.length > 0 && !allowlist.includes(model)) {
    return {
      ok: false,
      status: 422,
      error: "Le modèle sélectionné n'est pas autorisé par ce provider",
    };
  }

  return { ok: true, aiProviderId, model };
}
