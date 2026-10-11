// Audit log: who did what, and from where. Every login, restore, code and check is recorded.

import { useMemo, useState } from "react";
import { usePolling } from "../usePolling.js";
import { formatDateTime } from "../format.js";
import PageHeader from "../components/PageHeader.jsx";
import LoadState from "../components/LoadState.jsx";

const ACTIONS = {
  login: { label: "Logged in" },
  logout: { label: "Logged out" },
  "login.failed": { label: "Failed login", warn: true },
  "login.blocked": { label: "Login blocked (too many attempts)", warn: true },
  "restore.created": { label: "Started a restore" },
  "enrollment-code.created": { label: "Created an enrollment code" },
  "verify.run": { label: "Ran an integrity check" },
  "admin.created": { label: "Admin account created" },
  "admin.password-reset": { label: "Admin password reset" },
};

function describe(entry) {
  const d = entry.details;
  if (!d) return "";
  switch (entry.action) {
    case "restore.created":
      return `Job #${d.jobId}: ${d.label}, ${d.files} file${d.files === 1 ? "" : "s"} to ${d.target} (${d.mode})`;
    case "enrollment-code.created":
      return `For ${d.clientName}`;
    case "verify.run":
      return `${d.checked} chunks checked, ${d.damaged} damaged`;
    case "admin.created":
    case "admin.password-reset":
      return d.username;
    default:
      return JSON.stringify(d);
  }
}

const FILTERS = [
  { key: "all", label: "Everything" },
  { key: "warn", label: "Failed logins" },
  { key: "restore", label: "Restores" },
];

export default function Audit() {
  const { data, error, loading, reload } = usePolling("/audit", 30000);
  const [filter, setFilter] = useState("all");

  const rows = useMemo(() => {
    if (!data) return [];
    if (filter === "warn") return data.filter((e) => ACTIONS[e.action]?.warn);
    if (filter === "restore") return data.filter((e) => e.action === "restore.created");
    return data;
  }, [data, filter]);

  return (
    <div className="w-full">
      <PageHeader title="Audit log">Every login, restore, enrollment code and integrity check, newest first.</PageHeader>

      <div className="mb-4 flex rounded-md border border-edge p-0.5 sm:inline-flex" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={`h-8 flex-1 whitespace-nowrap rounded px-3 text-sm ${filter === f.key ? "bg-raised text-fg" : "text-dim hover:text-fg"}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {!data ? (
        <LoadState loading={loading} error={error} onRetry={reload} />
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-edge px-5 py-8 text-center text-sm text-dim">Nothing to show.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-edge bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-edge text-xs text-dim">
              <tr>
                <th className="px-4 py-2 font-normal">When</th>
                <th className="px-4 py-2 font-normal">Who</th>
                <th className="px-4 py-2 font-normal">What</th>
                <th className="px-4 py-2 font-normal">Details</th>
                <th className="px-4 py-2 font-normal">From</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {rows.map((e) => {
                const a = ACTIONS[e.action];
                return (
                  <tr key={e.id} className="align-top">
                    <td className="whitespace-nowrap px-4 py-2.5 text-dim">{formatDateTime(e.at)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5">{e.actor}</td>
                    <td className={`whitespace-nowrap px-4 py-2.5 ${a?.warn ? "text-alert" : "text-fg"}`}>{a?.label ?? e.action}</td>
                    <td className="min-w-64 px-4 py-2.5 text-dim">{describe(e)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-dim">{e.ip ?? "this computer"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}