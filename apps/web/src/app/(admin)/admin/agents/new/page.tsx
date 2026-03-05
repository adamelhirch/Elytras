import { AgentEditor } from "@/components/agents/agent-editor";

export default function NewAdminAgentPage() {
  return (
    <div className="p-8 max-w-4xl">
      <h1 className="text-2xl font-bold text-white mb-1">Nouvel agent</h1>
      <p className="text-gray-400 text-sm mb-8">
        Créez un agent global, configurez son provider, son modèle et son contexte.
      </p>
      <AgentEditor mode="admin" />
    </div>
  );
}
