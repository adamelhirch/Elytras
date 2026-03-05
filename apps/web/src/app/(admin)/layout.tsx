import { requireAdmin } from "@/lib/auth/session";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdmin();
  return (
    <div className="flex h-screen bg-[#0f1117]">
      <nav className="w-56 border-r border-white/10 p-4 flex flex-col gap-1">
        <p className="text-xs text-gray-500 font-semibold uppercase tracking-widest mb-3">
          Admin
        </p>
        <NavLink href="/admin" label="Vue d'ensemble" />
        <NavLink href="/admin/users" label="Utilisateurs" />
        <NavLink href="/admin/groups" label="Groupes" />
        <NavLink href="/admin/gateways" label="Gateways" />
        <NavLink href="/admin/agents" label="Agents" />
        <NavLink href="/admin/skills" label="Skills" />
        <NavLink href="/admin/providers" label="Providers IA" />
        <NavLink href="/admin/secrets" label="Secrets" />
        <hr className="border-white/10 my-2" />
        <NavLink href="/dashboard/chat" label="💬 Chat" />
      </nav>
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}

function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className="px-3 py-2 rounded-lg text-sm text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
    >
      {label}
    </a>
  );
}
