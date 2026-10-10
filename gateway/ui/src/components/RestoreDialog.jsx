// Confirms a restore before it starts: shows exactly what will come back, lets you choose
// which device receives the files, and whether to keep originals (copy) or replace them (overwrite).

import { useEffect, useState } from "react";
import { Link } from "react-router";
import { CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react";
import { api } from "../api.js";
import { formatDateTime, formatSize } from "../format.js";
import Modal from "./Modal.jsx";
import LoadState from "./LoadState.jsx";
import { primaryButton, secondaryButton } from "./buttons.js";

export default function RestoreDialog({ request, devices, onClose }) {
  // request = { device, path, version?, at? }
  const [target, setTarget] = useState(request.device);
  const [mode, setMode] = useState("copy");
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);

  useEffect(() => {
    setPreview(null);
    setError("");
    api
      .post("/restore/preview", { ...request, to: target, mode })
      .then(setPreview)
      .catch((err) => setError(err.message));
  }, [request, target, mode]);

  async function start() {
    setBusy(true);
    setError("");
    try {
      setCreated(await api.post("/restore", { ...request, to: target, mode }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Modal title="Restore started" onClose={onClose} footer={<button type="button" className={primaryButton} onClick={onClose}>Done</button>}>
        <p className="flex items-start gap-3 text-sm">
          <CircleCheck size={20} className="mt-0.5 shrink-0 text-good" aria-hidden="true" />
          <span>
            Restore job #{created.jobId} is queued: {created.fileCount} file{created.fileCount === 1 ? "" : "s"},{" "}
            {formatSize(created.totalSize)}. The device picks it up within 30 seconds.
          </span>
        </p>
        <p className="mt-4 text-sm text-dim">
          Follow its progress on the <Link to="/jobs" className="text-signal hover:underline" onClick={onClose}>Jobs</Link> page.
        </p>
      </Modal>
    );
  }

  const source = devices.find((d) => d.id === request.device);
  const targets = devices.filter((d) => d.encryptionReady && d.status !== "revoked");

  return (
    <Modal
      title="Restore files"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={primaryButton} onClick={start} disabled={busy || !preview}>
            {busy && <LoaderCircle size={16} className="animate-spin" />}
            Start restore
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <div>
          <p className="text-sm text-dim">What</p>
          <p className="mt-0.5 break-words text-fg">
            {request.path ? <span className="font-mono text-sm">{request.path}</span> : "All files"}
            {request.version
              ? `, version ${request.version}`
              : request.at
                ? `, as of ${formatDateTime(request.at)}`
                : ", latest versions"}
          </p>
          <p className="text-sm text-dim">from {source?.name}</p>
        </div>

        <div>
          <label htmlFor="target" className="text-sm text-dim">
            Restore onto
          </label>
          <select
            id="target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="mt-1 h-11 w-full rounded-md border border-edge bg-raised px-3 text-base text-fg focus:border-signal focus:outline-none sm:text-sm"
          >
            {targets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.client}){d.id === request.device ? ", the original device" : ""}
              </option>
            ))}
          </select>
        </div>

        <fieldset>
          <legend className="text-sm text-dim">How</legend>
          <div className="mt-2 space-y-2">
            <label className="flex cursor-pointer gap-3 rounded-md border border-edge p-3 has-[:checked]:border-signal">
              <input type="radio" name="mode" value="copy" checked={mode === "copy"} onChange={() => setMode("copy")} className="mt-1 accent-[var(--color-signal)]" />
              <span>
                <span className="block text-sm text-fg">Copy into a _Restored folder</span>
                <span className="block text-sm text-dim">Current files are left untouched. The safe choice.</span>
              </span>
            </label>
            <label className="flex cursor-pointer gap-3 rounded-md border border-edge p-3 has-[:checked]:border-alert">
              <input type="radio" name="mode" value="overwrite" checked={mode === "overwrite"} onChange={() => setMode("overwrite")} className="mt-1 accent-[var(--color-alert)]" />
              <span>
                <span className="block text-sm text-fg">Put back in the original place</span>
                <span className="block text-sm text-dim">Replaces the current files. Use after an attack.</span>
              </span>
            </label>
          </div>
        </fieldset>

        {mode === "overwrite" && (
          <p className="flex gap-2 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-alert">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            Files on the device will be replaced. Their current versions stay in the backup, so this can be undone.
          </p>
        )}

        <div className="border-t border-edge pt-4">
          {error ? (
            <p role="alert" className="rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-alert">
              {error}
            </p>
          ) : !preview ? (
            <LoadState loading />
          ) : (
            <>
              <p className="text-sm text-fg">
                {preview.fileCount} file{preview.fileCount === 1 ? "" : "s"}, {formatSize(preview.totalSize)}
              </p>
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-sm">
                {preview.files.slice(0, 50).map((f) => (
                  <li key={f.relPath} className="flex justify-between gap-3 text-dim">
                    <span className="truncate font-mono text-xs leading-5 text-fg">{f.relPath}</span>
                    <span className="shrink-0">v{f.versionNo}</span>
                  </li>
                ))}
              </ul>
              {preview.fileCount > 50 && <p className="mt-1 text-xs text-dim">and {preview.fileCount - 50} more</p>}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}