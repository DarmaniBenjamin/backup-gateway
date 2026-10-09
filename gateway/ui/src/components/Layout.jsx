// App frame: sidebar navigation on the left (a drop-down menu on phones) and the page on the right.

import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { HardDrive, History, LayoutDashboard, ListChecks, LogOut, Menu, ScrollText, ShieldCheck, X } from "lucide-react";
import { useAuth } from "../auth-context.js";
import Logo from "./Logo.jsx";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/devices", label: "Devices", icon: HardDrive },
  { to: "/restore", label: "Restore", icon: History },
  { to: "/jobs", label: "Jobs", icon: ListChecks },
  { to: "/integrity", label: "Integrity", icon: ShieldCheck },
  { to: "/audit", label: "Audit log", icon: ScrollText },
];

function NavItem({ item, onNavigate }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        [
          "flex h-10 items-center gap-3 rounded-md px-3 text-sm transition-colors",
          isActive ? "bg-raised text-fg" : "text-dim hover:bg-raised/60 hover:text-fg",
        ].join(" ")
      }
    >
      {({ isActive }) => (
        <>
          <Icon size={18} className={isActive ? "text-signal" : ""} aria-hidden="true" />
          {item.label}
        </>
      )}
    </NavLink>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setMenuOpen(false), [location.pathname]);

  const nav = (
    <nav className="flex flex-col gap-1" aria-label="Main">
      {NAV.map((item) => (
        <NavItem key={item.to} item={item} onNavigate={() => setMenuOpen(false)} />
      ))}
    </nav>
  );

  const account = (
    <div className="flex items-center justify-between gap-2 border-t border-edge pt-4">
      <div className="min-w-0">
        <p className="truncate text-sm text-fg">{user?.username}</p>
        <p className="text-xs text-dim">Administrator</p>
      </div>
      <button
        type="button"
        onClick={logout}
        className="flex h-9 items-center gap-2 rounded-md px-3 text-sm text-dim hover:bg-raised hover:text-fg"
      >
        <LogOut size={16} aria-hidden="true" />
        Log out
      </button>
    </div>
  );

  return (
    <div className="min-h-dvh lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col justify-between border-r border-edge bg-surface p-4 lg:flex lg:sticky lg:top-0 lg:h-dvh">
        <div>
          <div className="mb-8 flex items-center gap-3 px-2 pt-1">
            <Logo />
            <span className="font-semibold tracking-tight">Backup Gateway</span>
          </div>
          {nav}
        </div>
        {account}
      </aside>

      {/* Phone / tablet top bar */}
      <header className="sticky top-0 z-20 border-b border-edge bg-surface lg:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <Logo size={24} />
            <span className="font-semibold tracking-tight">Backup Gateway</span>
          </div>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            className="flex h-10 w-10 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-fg"
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
        {menuOpen && (
          <div className="space-y-4 border-t border-edge px-4 pb-4 pt-3">
            {nav}
            {account}
          </div>
        )}
      </header>

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}