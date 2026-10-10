// Integrity check: the gateway decrypts every stored chunk and confirms it still matches its
// fingerprint. Finds disk damage or tampering before you need a restore.

import { useEffect, useState } from "react";
import { CircleCheck, LoaderCircle, ShieldCheck, TriangleAlert } from "lucide-react";
import { api } from "../api.js";
import { formatDateTime, timeAgo } from "../format.js";
import PageHeader from "../components/PageHeader.jsx";
import LoadState from "../components/LoadState.jsx";
import { primaryButton } from "../components/buttons.js";

function DeviceResult({ d }) {
  const ok = d.problems.length === 0;
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{d.name}</p>
          <p className="text-sm text-dim">{d.client}</p>
        </div>
        {ok ? (
          <span className="inline-flex items-center gap-2 text-sm text-good">
            <CircleCheck size={16} aria-hidden="true" />
            All {d.chunks.toLocaleString()} chunks readable
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 text-sm text-alert">
            <TriangleAlert size={16} aria-hidden="true" />
            {d.problems.length} of {d.chunks.toLocaleString()} chunks bad
          </span>
        )}
      </div>
      {!ok && (
        <ul className="mt-3 space-y-2">
          {d.problems.map((p) => (
            <li key={p.chunk} className="rounded-md border border-alert/30 bg-alert/5 px-3 py-2 text-sm">
              <p className="text-fg">
                Chunk <span className="font-mono text-xs">{p.chunk.slice(0, 16)}</span> is {p.reason}
              </p>
              <p className="mt-0.5 text-dim">
                Affects: <span className="break-all font-mono text-xs text-fg">{p.affects.join(", ")}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export default function Integrity() {
  const [report, setReport] = useState(undefined); // undefined = loading, null = never run
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);

  useEffect(() => {
    api
      .get("/verify/last")
      .then(setReport)
      .catch((err) => setError(err.message));
  }, []);

  async function runCheck() {
    setRunning(true);
    setError("");
    try {
      setReport(await api.post("/verify"));
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  const runButton = (
    <button type="button" className={primaryButton} onClick={runCheck} disabled={running}>
      {running ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <ShieldCheck size={16} aria-hidden="true" />}
      {running ? "Checking" : "Run integrity check"}
    </button>
  );

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Integrity" action={runButton}>
        Decrypts every stored chunk and confirms it is exactly what was backed up.
      </PageHeader>

      {error && (
        <p role="alert" className="mb-6 rounded-md border border-alert/40 bg-alert/10 px-4 py-3 text-sm text-alert">
          {error}
        </p>
      )}

      {report === undefined && !error ? (
        <LoadState loading />
      ) : report === null ? (
        <div className="rounded-lg border border-dashed border-edge px-6 py-12 text-center">
          <p className="font-medium">No check has been run yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-dim">
            Run one now, and again regularly. It catches a failing disk before you find out during a restore.
          </p>
        </div>
      ) : report ? (
        <div className={running ? "opacity-40 transition-opacity" : "transition-opacity"} aria-busy={running}>
          {running && <p className="mb-4 text-sm text-dim">Showing the previous check while the new one runs.</p>}
          <div className="mb-6">
            <p className={`text-2xl font-semibold tracking-tight ${report.damaged ? "text-alert" : "text-fg"}`}>
              {report.damaged === 0
                ? `All ${report.checked.toLocaleString()} chunks are intact.`
                : `${report.damaged} of ${report.checked.toLocaleString()} chunks are damaged.`}
            </p>
            <p className="mt-1 text-sm text-dim" title={formatDateTime(report.checkedAt)}>
              Checked {timeAgo(report.checkedAt)}.
              {report.damaged > 0 &&
                " Damaged chunks were removed. The versions listed below can no longer be restored from this gateway, but if the same data is backed up again it will be uploaded fresh."}
            </p>
          </div>
          {report.devices.length > 0 && (
            <ul className="divide-y divide-edge rounded-lg border border-edge bg-surface">
              {report.devices.map((d) => (
                <DeviceResult key={d.id} d={d} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}