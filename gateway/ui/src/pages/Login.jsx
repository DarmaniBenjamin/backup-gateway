// Login screen. After a successful login it returns to the page you were trying to open.

import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { LoaderCircle } from "lucide-react";
import { useAuth } from "../auth-context.js";
import Logo from "../components/Logo.jsx";

export default function Login() {
  const { user, checking, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (checking) return null;
  if (user) return <Navigate to={location.state?.from || "/"} replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login(username.trim(), password);
      navigate(location.state?.from || "/", { replace: true });
    } catch (err) {
      setError(err.message);
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "h-11 w-full rounded-md border border-edge bg-raised px-3 text-base text-fg placeholder:text-dim/60 " +
    "focus:border-signal focus:outline-none sm:text-sm";

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <Logo size={36} />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Backup Gateway</h1>
            <p className="text-sm text-dim">Sign in to manage client backups</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-edge bg-surface p-6" noValidate>
          <div>
            <label htmlFor="username" className="mb-1.5 block text-sm text-dim">
              Username
            </label>
            <input
              id="username"
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm text-dim">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </div>

          {error && (
            <p role="alert" className="rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !username || !password}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-signal font-medium text-signal-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />}
            {busy ? "Signing in" : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-xs leading-relaxed text-dim">
          Forgot your password? On the gateway, run <code className="font-mono text-fg">npm run create-admin -- yourname</code> to set a new one.
        </p>
      </div>
    </div>
  );
}