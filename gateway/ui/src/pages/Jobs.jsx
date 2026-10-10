// Restore jobs, newest first. Refreshes every 5 seconds while a job is still waiting or running.

import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ChevronDown, CircleCheck, CircleX, Clock, LoaderCircle } from "lucide-react";
import { usePolling } from "../usePolling.js";
import { formatDateTime, timeAgo } from "../format.js";
import PageHeader from "../components/PageHeader.jsx";
import LoadState from "../components/LoadState.jsx";

const STATUS = {
  queued: { label: "Waiting for device", icon: Clock, tone: "text-dim" },
  running: { label: "Running", icon: LoaderCircle, tone: "text-signal", spin: true },
  done: { label: "Done", icon: CircleCheck, tone: "text-good" },
  failed: { label: "Finished with errors", icon: CircleX, tone: "text-alert" },
  cancelled: { label: "Cancelled", icon: CircleX, tone: "text-dim" },
};

function JobStatus({ status }) {
  const s = STATUS[status] ?? STATUS.queued;
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-2 text-sm ${s.tone}`}>
      <Icon size={16} className={s.spin ? "animate-spin" : ""} aria-hidden="true" />
      {s.label}
    </span>
  );
}

function JobRow({ job }) {
  const [open, setOpen] = useState(false);
  const errors = job.result?.errors ?? [];
  return (
    <li className="px-5 py-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-dim">Job #{job.id}</p>
          <p className="mt-0.5 break-words text-fg">{job.label}</p>
          <p className="mt-1 text-sm text-dim">
            To {job.device} ({job.client}),{" "}
            {job.mode === "overwrite" ? "put back in the original place" : "copied into _Restored"}
          </p>
        </div>
        <div className="shrink-0 md:text-right">
          <JobStatus status={job.status} />
          <p className="mt-1 text-sm text-dim">
            {job.result
              ? `${job.result.restored} of ${job.fileCount} file${job.fileCount === 1 ? "" : "s"} restored`
              : `${job.fileCount} file${job.fileCount === 1 ? "" : "s"}`}
          </p>
          <p className="text-xs text-dim" title={formatDateTime(job.createdAt)}>
            {job.finishedAt ? `Finished ${timeAgo(job.finishedAt)}` : `Created ${timeAgo(job.createdAt)}`}
          </p>
        </div>
      </div>
      {errors.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="inline-flex items-center gap-1 text-sm text-alert hover:underline"
          >
            <ChevronDown size={16} className={`transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
            {errors.length} file{errors.length === 1 ? "" : "s"} could not be restored
          </button>
          {open && (
            <ul className="mt-2 space-y-1 rounded-md border border-alert/30 bg-alert/5 p-3 font-mono text-xs text-fg">
              {errors.map((e, i) => (
                <li key={i} className="break-all">
                  {e}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

export default function Jobs() {
  const [fast, setFast] = useState(false);
  const { data, error, loading, reload } = usePolling("/jobs", fast ? 5000 : 30000);

  // Refresh quickly only while something is still happening
  useEffect(() => {
    setFast(!!data?.some((j) => j.status === "queued" || j.status === "running"));
  }, [data]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Jobs">Restores you have started, and how they went.</PageHeader>
      {!data ? (
        <LoadState loading={loading} error={error} onRetry={reload} />
      ) : data.length === 0 ? (
        <div className="rounded-lg border border-dashed border-edge px-6 py-12 text-center">
          <p className="font-medium">No restores yet</p>
          <p className="mt-1 text-sm text-dim">
            Start one from the <Link to="/restore" className="text-signal hover:underline">Restore</Link> page.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-edge rounded-lg border border-edge bg-surface">
          {data.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </ul>
      )}
    </div>
  );
}