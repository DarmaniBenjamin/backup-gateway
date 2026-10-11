// App frame: a glass top bar with the pages as tabs (a slide-in menu on smaller screens),
// an alert pill and your account on the right, and the page below.
// Alerts are checked here for every page: they appear as a banner above the page and as the
// pill in the top bar. Pages get the alerts (and a refresh function) through the outlet context.

import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { ChevronDown, LogOut, Menu, ShieldAlert, X } from "lucide-react";
import { useAuth } from "../auth-context.js";
import { usePolling } from "../usePolling.js";
import Logo from "./Logo.jsx";
import AlertBanner from "./AlertBanner.jsx";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/devices", label: "Devices" },
  { to: "/restore", label: "Restore" },
  { to: "/quarantine", label: "Quarantine" },
  { to: "/jobs", label: "Jobs" },
  { to: "/integrity", label: "Integrity" },
  { to: "/audit", label: "Audit log" },
];

function AccountMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-9 items-center gap-2 rounded-full border border-edge bg-raised pl-1 pr-2.5 text-sm hover:border-signal/50"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-signal/20 font-display text-xs font-semibold text-signal">
          {user?.username?.[0]?.toUpperCase()}
        </span>
        <span className="hidden sm:inline">{user?.username}</span>
        <ChevronDown size={14} className="text-dim" aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-11 z-40 w-48 rounded-lg border border-edge bg-solid p-1.5 shadow-2xl">
          <p className="px-3 py-2 text-xs text-dim">Signed in as {user?.username}</p>
          <button
            type="button"
            role="menuitem"
            onClick={onLogout}
            className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-sm text-fg hover:bg-raised"
          >
            <LogOut size={15} aria-hidden="true" />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const { data: alerts, reload: reloadAlerts } = usePolling("/alerts", 15000);
  const openAlerts = (alerts ?? []).filter((a) => !a.acknowledgedAt).length;

  useEffect(() => setMenuOpen(false), [location.pathname]);

  // While the phone menu is open: Escape closes it, and the page behind doesn't scroll
  useEffect(() => {
    if (!menuOpen) return;
    const esc = (e) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("keydown", esc);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", esc);
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  const tabClass = ({ isActive }) =>
    [
      "relative flex h-full items-center px-3.5 text-sm transition-colors",
      isActive
        ? "text-fg after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-signal"
        : "text-dim hover:text-fg",
    ].join(" ");

  return (
    <div className="min-h-dvh">
      <header className="glass sticky top-0 z-30 border-b border-edge">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6">
          <Link to="/" className="flex shrink-0 items-center gap-2.5">
            <Logo size={30} />
            <span className="font-display text-[17px] font-semibold">Backup Gateway</span>
          </Link>

          <nav className="hidden h-full items-stretch lg:flex" aria-label="Main">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={tabClass}>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            {openAlerts > 0 && (
              <Link
                to="/quarantine"
                className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-alert/40 bg-alert/15 px-3 text-xs font-medium text-alert hover:bg-alert/25"
              >
                <ShieldAlert size={14} aria-hidden="true" />
                {openAlerts} alert{openAlerts === 1 ? "" : "s"}
              </Link>
            )}
            <AccountMenu user={user} onLogout={logout} />
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-expanded={menuOpen}
              aria-label="Open menu"
              className="flex h-9 w-9 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-fg lg:hidden"
            >
              <Menu size={20} />
            </button>
          </div>
        </div>
      </header>

      {/* Phone / tablet menu: slides in over the page from the right, nothing moves underneath */}
      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
            className="absolute inset-0 h-full w-full cursor-default bg-night/70 backdrop-blur-sm"
          />
          <nav
            className="absolute inset-y-0 right-0 flex w-72 max-w-[85%] animate-drawer flex-col border-l border-edge bg-solid p-4 shadow-2xl"
            aria-label="Main"
          >
            <div className="mb-4 flex items-center justify-between">
              <span className="flex items-center gap-2.5">
                <Logo size={26} />
                <span className="font-display font-semibold">Backup Gateway</span>
              </span>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label="Close menu"
                autoFocus
                className="flex h-9 w-9 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-fg"
              >
                <X size={20} />
              </button>
            </div>
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `flex h-11 items-center rounded-md px-3 text-sm ${isActive ? "bg-raised text-fg" : "text-dim hover:bg-raised/60 hover:text-fg"}`
                }
              >
                {item.label}
              </NavLink>
            ))}
            <button
              type="button"
              onClick={logout}
              className="mt-auto flex h-11 items-center gap-2 rounded-md px-3 text-sm text-dim hover:bg-raised hover:text-fg"
            >
              <LogOut size={16} aria-hidden="true" />
              Log out {user?.username}
            </button>
          </nav>
        </div>
      )}

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        <AlertBanner alerts={alerts} onChange={reloadAlerts} />
        <Outlet context={{ alerts, reloadAlerts }} />
      </main>
    </div>
  );
}
