export default function AdminPage() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-white mb-2">Administration</h1>
      <p className="text-gray-400 text-sm">
        Gérez les utilisateurs, gateways, agents, skills et providers IA.
      </p>

      <div className="mt-8 grid grid-cols-2 md:grid-cols-3 gap-4">
        <AdminCard title="Utilisateurs" href="/admin/users" description="Créer et gérer les comptes" />
        <AdminCard title="Gateways" href="/admin/gateways" description="Connexions canal par user" />
        <AdminCard title="Agents" href="/admin/agents" description="Agents IA partagés" />
        <AdminCard title="Skills" href="/admin/skills" description="Catalogue et permissions" />
        <AdminCard title="Providers IA" href="/admin/providers" description="Anthropic, Google, OpenAI…" />
        <AdminCard title="Secrets" href="/admin/secrets" description="Vault des clés et tokens" />
      </div>
    </div>
  );
}

function AdminCard({
  title,
  href,
  description,
}: {
  title: string;
  href: string;
  description: string;
}) {
  return (
    <a
      href={href}
      className="block p-5 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
    >
      <div className="font-semibold text-white">{title}</div>
      <div className="text-gray-500 text-xs mt-1">{description}</div>
    </a>
  );
}
