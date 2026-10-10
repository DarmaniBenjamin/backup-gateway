// One device: which folders it backs up. Add folders with the live folder browser, change what
// each one skips, or stop backing one up (its backups are kept). Also shows the device's
// allowed areas, which can only be changed on the device itself.

import { useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, FolderPlus, History, ShieldCheck } from "lucide-react";
import { api } from "../api.js";
import { usePolling } from "../usePolling.js";
import { formatDateTime, formatSize, timeAgo } from "../format.js";
import PageHeader from "../components/PageHeader.jsx";
import LoadState from "../components/LoadState.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import Modal from "../components/Modal.jsx";
import FolderPicker from "../components/FolderPicker.jsx";
import { inputClass, primaryButton, secondaryButton } from "../components/buttons.js";

const STATE = {
  ok: { label: "Backing up", className: "text-good", dot: "bg-good" },
  missing: { label: "Folder not found", className: "text-alert", dot: "bg-alert" },
  denied: { label: "Not allowed", className: "text-alert", dot: "bg-alert" },
  waiting: { label: "Waiting for the device", className: "text-dim", dot: "bg-dim" },
};

function FolderState({ folder }) {
  const s = STATE[folder.state ?? "waiting"];
  return (
    <span className={`inline-flex items-center gap-2 text-sm ${s.className}`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} aria-hidden="true" />
      {s.label}
    </span>
  );
}

function FolderRow({ folder, onEdit, onRemove }) {
  return (
    <li className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-6">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="font-medium">{folder.name}</p>
          <FolderState folder={folder} />
        </div>
        <p className="mt-0.5 truncate font-mono text-xs text-dim" title={folder.path}>
          {folder.path}
        </p>
        {folder.state && folder.state !== "ok" && folder.error && <p className="mt-1 text-sm text-alert">{folder.error}</p>}
        <p className="mt-1.5 text-sm text-dim">
          {folder.state === "ok" && folder.files != null
            ? `${folder.files.toLocaleString()} file${folder.files === 1 ? "" : "s"}, ${formatSize(folder.bytes)}`
            : "No numbers yet"}
          {folder.excludes.length > 0 && <> · skips {folder.excludes.join(", ")}</>}
        </p>
      </div>
      <div className="flex gap-2">
        <button type="button" className={secondaryButton} onClick={() => onEdit(folder)}>
          Exclusions
        </button>
        <button type="button" className={secondaryButton} onClick={() => onRemove(folder)}>
          Remove
        </button>
      </div>
    </li>
  );
}

function ExcludesDialog({ deviceId, folder, onClose, onDone }) {
  const [text, setText] = useState(folder.excludes.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api.post(`/devices/${deviceId}/folders/${folder.id}/excludes`, {
        excludes: text.split("\n").map((s) => s.trim()).filter(Boolean),
      });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`What "${folder.name}" skips`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={primaryButton} onClick={save} disabled={busy}>
            {busy ? "Saving" : "Save"}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-dim">
          One file or folder name per line. Use * for &ldquo;anything&rdquo;: <span className="font-mono text-fg">*.mp4</span> skips
          every MP4 file, <span className="font-mono text-fg">Cache</span> skips every folder called Cache.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          spellCheck={false}
          aria-label="Exclusion patterns"
          className={`${inputClass} h-auto py-2 font-mono`}
        />
        <p className="text-dim">Newly skipped files stop being backed up, but their existing backups are kept.</p>
        {error && <p className="text-alert">{error}</p>}
      </div>
    </Modal>
  );
}

function RemoveDialog({ deviceId, folder, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await api.post(`/devices/${deviceId}/folders/${folder.id}/remove`);
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Stop backing up "${folder.name}"?`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={primaryButton} onClick={remove} disabled={busy}>
            {busy ? "Removing" : "Stop backing up"}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>
          The device stops watching <span className="break-all font-mono">{folder.path}</span>. Nothing is deleted on the device.
        </p>
        <p className="text-dim">
          Everything already backed up is kept: you can still browse and restore it, and if you add the folder back later its
          history continues.
        </p>
        {error && <p className="text-alert">{error}</p>}
      </div>
    </Modal>
  );
}

export default function DeviceFolders() {
  const { id } = useParams();
  const { data, error, loading, reload } = usePolling(`/devices/${id}/folders`, 5000);
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [readding, setReadding] = useState(null);
  const [readdError, setReaddError] = useState("");

  if (!data) {
    return (
      <div className="mx-auto max-w-6xl">
        <LoadState loading={loading} error={error} onRetry={reload} />
      </div>
    );
  }

  const { device, multiFolder, allowedPaths } = data;
  const active = data.folders.filter((f) => f.status === "active");
  const removed = data.folders.filter((f) => f.status === "removed");
  const canAdd = multiFolder && device.live;

  async function readd(folder) {
    setReadding(folder.id);
    setReaddError("");
    try {
      await api.post(`/devices/${device.id}/folders`, { path: folder.path, excludes: folder.excludes });
      reload();
    } catch (err) {
      setReaddError(err.message);
    } finally {
      setReadding(null);
    }
  }

  const done = (setter) => () => {
    setter(null);
    reload();
  };

  return (
    <div className="mx-auto max-w-6xl">
      <Link to="/devices" className="mb-4 inline-flex items-center gap-1.5 text-sm text-dim hover:text-fg">
        <ArrowLeft size={16} aria-hidden="true" />
        Devices
      </Link>
      <PageHeader
        title={device.name}
        action={
          <div className="flex flex-wrap gap-2">
            <Link to={`/restore?device=${device.id}`} className={secondaryButton}>
              <History size={16} aria-hidden="true" />
              Restore files
            </Link>
            <button
              type="button"
              className={primaryButton}
              disabled={!canAdd}
              title={canAdd ? undefined : "The device must be connected"}
              onClick={() => setPicking(true)}
            >
              <FolderPlus size={16} aria-hidden="true" />
              Add folder
            </button>
          </div>
        }
      >
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          {device.client}
          <StatusBadge status={device.status} />
        </span>
      </PageHeader>

      {!multiFolder && (
        <p className="mb-6 rounded-lg border border-signal/40 bg-signal/10 px-4 py-3 text-sm text-fg">
          This device&rsquo;s agent is too old to manage folders here. Update it to version 0.7 or newer and restart it.
        </p>
      )}
      {multiFolder && !device.live && (
        <p className="mb-6 rounded-lg border border-edge bg-surface px-4 py-3 text-sm text-dim">
          The device isn&rsquo;t connected right now. Folder changes are saved and applied when it reconnects; adding a folder
          needs it connected, so you can browse its folders.
        </p>
      )}

      <section className="mb-10">
        <h2 className="mb-3 font-medium">Backup folders</h2>
        {active.length === 0 ? (
          <div className="rounded-lg border border-dashed border-edge px-6 py-10 text-center">
            <p className="font-medium">Nothing is being backed up on this device</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-dim">Add a folder to start. You can browse the device&rsquo;s folders live.</p>
          </div>
        ) : (
          <ul className="divide-y divide-edge rounded-lg border border-edge bg-surface">
            {active.map((f) => (
              <FolderRow key={f.id} folder={f} onEdit={setEditing} onRemove={setRemoving} />
            ))}
          </ul>
        )}
      </section>

      {removed.length > 0 && (
        <section className="mb-10">
          <h2 className="font-medium">Removed folders</h2>
          <p className="mb-3 text-sm text-dim">No longer backed up. Their backups are kept and can still be restored.</p>
          <ul className="divide-y divide-edge rounded-lg border border-edge bg-surface">
            {removed.map((f) => (
              <li key={f.id} className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <p className="text-fg">{f.name}</p>
                  <p className="truncate font-mono text-xs text-dim" title={f.path}>
                    {f.path}
                  </p>
                  <p className="mt-0.5 text-xs text-dim" title={formatDateTime(f.removedAt)}>
                    Removed {timeAgo(f.removedAt)} by {f.removedBy}
                  </p>
                </div>
                <button type="button" className={secondaryButton} disabled={!multiFolder || readding === f.id} onClick={() => readd(f)}>
                  {readding === f.id ? "Adding" : "Add back"}
                </button>
              </li>
            ))}
          </ul>
          {readdError && <p className="mt-2 text-sm text-alert">{readdError}</p>}
        </section>
      )}

      <section>
        <h2 className="flex items-center gap-2 font-medium">
          <ShieldCheck size={18} className="text-good" aria-hidden="true" />
          Allowed areas
        </h2>
        <p className="mb-3 mt-1 max-w-2xl text-sm text-dim">
          The only places this device lets the gateway back up or browse. They&rsquo;re set on the device itself
          (AGENT_ALLOWED_PATHS), so even someone with access to this gateway can&rsquo;t reach anything else.
        </p>
        {allowedPaths.length === 0 ? (
          <p className="text-sm text-dim">Not reported yet.</p>
        ) : (
          <ul className="space-y-1">
            {allowedPaths.map((p) => (
              <li key={p} className="break-all font-mono text-sm text-fg">
                {p}
              </li>
            ))}
          </ul>
        )}
      </section>

      {picking && (
        <FolderPicker
          device={device}
          onClose={() => setPicking(false)}
          onAdded={() => {
            setPicking(false);
            reload();
          }}
        />
      )}
      {editing && <ExcludesDialog deviceId={device.id} folder={editing} onClose={() => setEditing(null)} onDone={done(setEditing)} />}
      {removing && <RemoveDialog deviceId={device.id} folder={removing} onClose={() => setRemoving(null)} onDone={done(setRemoving)} />}
    </div>
  );
}
