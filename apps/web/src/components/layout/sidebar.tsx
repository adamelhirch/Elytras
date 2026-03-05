import { getSession } from "@/lib/auth/session";

export async function Sidebar() {
  const session = await getSession();

  return (
    <nav className="w-56 border-r border-white/10 p-4 flex flex-col gap-1">
      <div className="mb-4 px-2">
        <div className="text-sm font-semibold text-white truncate">
          {session?.displayName ?? session?.email}
        </div>
        <div className="text-xs text-gray-500 capitalize">{session?.role}</div>
      </div>

      <p className="text-xs text-gray-500 font-semibold uppercase tracking-widest mb-2 px-2">
        Mon espace
      </p>
      <NavLink href="/dashboard" label="Accueil" />
      <NavLink href="/dashboard/chat" label="Chat" />
      <NavLink href="/dashboard/agents" label="Agents" />
      <NavLink href="/dashboard/skills" label="Skills" />
      <NavLink href="/dashboard/gateways" label="Gateways" />
      <NavLink href="/dashboard/settings" label="Paramètres" />

      {session?.role === "admin" && (
        <>
          <p className="text-xs text-gray-500 font-semibold uppercase tracking-widest mt-4 mb-2 px-2">
            Admin
          </p>
          <NavLink href="/admin" label="Administration" />
        </>
      )}

      <div className="flex-1" />
      <form action="/api/auth/logout" method="POST">
        <button
          type="submit"
          className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-500 hover:text-white hover:bg-white/10 transition-colors"
        >
          Déconnexion
        </button>
      </form>
    </nav>
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
