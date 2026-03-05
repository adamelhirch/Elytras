import { getSession } from "@/lib/auth/session";

export default async function DashboardPage() {
  const session = await getSession();
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-white mb-2">
        Bonjour, {session?.displayName ?? session?.email} 👋
      </h1>
      <p className="text-gray-400">Votre espace Elytras</p>

      <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
        <DashCard title="Personas" count={0} href="/dashboard/personas" />
        <DashCard title="Agents" count={0} href="/dashboard/agents" />
        <DashCard title="Gateways" count={0} href="/dashboard/gateways" />
      </div>
    </div>
  );
}

function DashCard({
  title,
  count,
  href,
}: {
  title: string;
  count: number;
  href: string;
}) {
  return (
    <a
      href={href}
      className="block p-6 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
    >
      <div className="text-3xl font-bold text-white">{count}</div>
      <div className="text-gray-400 mt-1 text-sm">{title}</div>
    </a>
  );
}
