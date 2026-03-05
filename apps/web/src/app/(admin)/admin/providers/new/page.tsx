import { ProviderEditor } from "@/components/admin/provider-editor";

export default function NewProviderPage() {
  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold text-white mb-1">Nouveau provider IA</h1>
      <p className="text-gray-400 text-sm mb-8">
        Configurez un compte Anthropic, Google, OpenAI, Azure, Ollama, GitHub Copilot ou un provider custom.
      </p>
      <ProviderEditor />
    </div>
  );
}
