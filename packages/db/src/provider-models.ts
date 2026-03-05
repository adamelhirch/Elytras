/**
 * Fonctions serveur uniquement — nécessite @mariozechner/pi-ai.
 * Ne pas importer côté client React.
 */
import { getModels } from "@mariozechner/pi-ai";
import type { ProviderModel } from "./provider-meta";

export { KNOWN_PROVIDER_TYPES, PROVIDER_META } from "./provider-meta";
export type { KnownProviderType, ProviderModel } from "./provider-meta";

export function getProviderModels(providerType: string): ProviderModel[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return getModels(providerType as any).map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextWindow: m.contextWindow,
    }));
  } catch {
    return [];
  }
}
