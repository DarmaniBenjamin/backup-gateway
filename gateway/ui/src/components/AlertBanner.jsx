// Shown across the top of every page while there are alerts nobody has dismissed yet:
// a device was frozen, or suspicious files were quarantined.

import { useState } from "react";
import { Link } from "react-router";
import { ShieldAlert, Snowflake, X } from "lucide-react";
import { api } from "../api.js";
import { timeAgo } from "../format.js";

const SHOW = 2; // the rest are summarised in one line

export default function AlertBanner({ alerts, onChange }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");
  const open = (alerts ?? []).filter((a) => !a.acknowledgedAt);
  if (open.length === 0) return null;

  async function dismiss(id) {
    setBusy(id);
    setError("");
    try {
      await api.post(`/alerts/${id}/ack`);
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mb-6 space-y-2" role="region" aria-label="Alerts">
      {open.slice(0, SHOW).map((a) => {
        const Icon = a.kind === "frozen" ? Snowflake : ShieldAlert;
        return (
          <div key={a.id} className="flex items-start gap-3 rounded-lg border border-alert/40 bg-alert/10 py-3 pl-4 pr-2">
            <Icon size={18} className="mt-0.5 shrink-0 text-alert" aria-hidden="true" />
            <div className="min-w-0 flex-1 text-sm">
              <p className="text-fg">{a.message}</p>
              <p className="mt-0.5 text-dim">
                {a.client ? `${a.client}, ` : ""}
                {timeAgo(a.createdAt)}.{" "}
                <Link to="/quarantine" className="text-signal underline-offset-2 hover:underline">
                  Review
                </Link>
              </p>
            </div>
            <button
              type="button"
              onClick={() => dismiss(a.id)}
              disabled={busy === a.id}
              aria-label="Dismiss alert"
              title="Dismiss"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-fg disabled:opacity-50"
            >
              <X size={16} />
            </button>
          </div>
        );
      })}
      {open.length > SHOW && (
        <p className="text-sm text-dim">
          {open.length - SHOW} more alert{open.length - SHOW === 1 ? "" : "s"} on the{" "}
          <Link to="/quarantine" className="text-signal underline-offset-2 hover:underline">Quarantine</Link> page.
        </p>
      )}
      {error && <p className="text-sm text-alert">{error}</p>}
    </div>
  );
}