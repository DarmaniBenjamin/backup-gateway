// One device: which folders it backs up. Choose them in a live folder tree (tick to back up,
// untick a sub-folder to skip it), set name rules for what each skips, or stop backing one up
// (its backups are kept). Also its background behaviour
// (speed limits, pauses, scan mode) and its allowed areas, which can only be changed on the device.

import { useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, FolderTree as FolderTreeIcon, History, ShieldCheck } from "lucide-react";
import { api } from "../api.js";
import { usePolling } from "../usePolling.js";
import { formatDateTime, formatSize, timeAgo } from "../format.js";
import PageHeader from "../components/PageHeader.jsx";
import LoadState from "../components/LoadState.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import Modal from "../components/Modal.jsx";
import FolderTree from "../components/FolderTree.jsx";
import DeviceSettings from "../components/DeviceSettings.jsx";
import FolderLock from "../components/FolderLock.jsx";
import DeviceCopies from "../components/DeviceCopies.jsx";
import DeviceHealth from "../components/DeviceHealth.jsx";
import DeviceRemote from "../components/DeviceRemote.jsx";
import { DeviceAgent } from "../components/AgentUpdates.jsx";
import DeviceService from "../components/DeviceService.jsx";
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

// Which of the device's own off-site copies this folder goes to (all of them unless changed)
function FolderCopies({ deviceId, folder, copies, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!copies.length) return null;
  const on = folder.destinations ?? copies.map((c) => c.id);
  async function toggle(id) {
    setBusy(true);
    setError("");
    try {
      const next = on.includes(id) ? on.filter((x) => x !== id) : [...on, id];
      await api.post(`/devices/${deviceId}/folders/${folder.id}/destinations`, { destinations: next });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-dim">Off-site:</span>
      {copies.map((c) => {
        const active = on.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={active}
            disabled={busy}
            onClick={() => toggle(c.id)}
            title={active ? "Goes to this copy. Click to stop sending this folder there." : "Not sent to this copy. Click to send it."}
            className={`rounded-full border px-2.5 py-0.5 ${active ? "border-secure/50 bg-secure/10 text-secure" : "border-edge text-dim line-through"}`}
          >
            {c.kind === "s3" ? c.bucket : `Google Drive: ${c.folderName ?? c.email}`}
          </button>
        );
      })}
      {error && <span className="text-alert">{error}</span>}
    </div>
  );
}

// Synology: the agent exports the DSM settings daily; offer to back that folder up
function DsmSettings({ deviceId, dsm, folders, locked, live, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!dsm || folders.some((f) => f.path === dsm.dir)) return null;
  async function add() {
    setBusy(true);
    setError("");
    try {
      await api.post(`/devices/${deviceId}/folders`, { path: dsm.dir, excludes: [] });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mb-6 flex flex-col gap-3 rounded-lg border border-secure/40 bg-secure/5 px-5 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-medium text-fg">Back up this NAS&rsquo;s DSM settings</p>
        <p className="text-dim">
          Users, shared folders and their permissions, network and services, exported once a day
          {dsm.lastAt ? ` (last ${timeAgo(dsm.lastAt)})` : ""}. With them, a replacement NAS can be set up the same way.
        </p>
        {dsm.error && <p className="mt-1 text-warn">Last export failed: {dsm.error}</p>}
        {error && <p className="mt-1 text-alert">{error}</p>}
      </div>
      <button type="button" className={primaryButton} disabled={busy || locked || !live} onClick={add} title={locked ? "Unlock the folders first" : undefined}>
        Back up DSM settings
      </button>
    </section>
  );
}

function FolderRow({ folder, onEdit, onRemove, locked, deviceId, copies, onChanged }) {
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
          {folder.excludes.length > 0 && <> · skips {folder.excludes.map((e) => (e.startsWith("/") ? e.slice(1) : e)).join(", ")}</>}
        </p>
        <FolderCopies deviceId={deviceId} folder={folder} copies={copies} onChanged={onChanged} />
      </div>
      <div className="flex gap-2">
        <button type="button" className={secondaryButton} disabled={locked} title={locked ? "Unlock the folders first" : undefined} onClick={() => onEdit(folder)}>
          Skip rules
        </button>
        <button type="button" className={secondaryButton} disabled={locked} title={locked ? "Unlock the folders first" : undefined} onClick={() => onRemove(folder)}>
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
          One rule per line. Use * for &ldquo;anything&rdquo;: <span className="font-mono text-fg">*.mp4</span> skips every MP4
          file, <span className="font-mono text-fg">Cache</span> skips every folder called Cache. A line starting with / skips one
          exact sub-folder: <span className="font-mono text-fg">/Downloads</span> (that&rsquo;s what unticking a folder in the
          tree does).
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
      <div className="w-full">
        <LoadState loading={loading} error={error} onRetry={reload} />
      </div>
    );
  }

  const { device, multiFolder, allowedPaths } = data;
  const active = data.folders.filter((f) => f.status === "active");
  const removed = data.folders.filter((f) => f.status === "removed");
  const lock = data.agentStatus?.lock ?? null;
  const locked = !!lock?.locked;
  const fullAccess = !!data.agentStatus?.fullAccess;
  const canAdd = multiFolder && device.live && !locked;

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
    <div className="w-full">
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
              title={canAdd ? undefined : locked ? "Unlock the folders first" : "The device must be connected"}
              onClick={() => setPicking(true)}
            >
              <FolderTreeIcon size={16} aria-hidden="true" />
              Choose folders
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
        <p className="mb-6 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-fg">
          This device&rsquo;s agent is too old to manage folders here. Update it to version 0.7 or newer and restart it.
        </p>
      )}
      {multiFolder && !device.live && (
        <p className="mb-6 rounded-lg border border-edge bg-surface px-4 py-3 text-sm text-dim">
          The device isn&rsquo;t connected right now. Folder changes are saved and applied when it reconnects; adding a folder
          needs it connected, so you can see its folders.
        </p>
      )}

      <DeviceRemote remote={data.remote} />

      <DeviceHealth health={data.health} />

      {multiFolder && (
        <FolderLock deviceId={device.id} lock={lock} live={device.live} folderCount={active.length} onChanged={reload} />
      )}

      <DsmSettings
        deviceId={device.id}
        dsm={data.agentStatus?.dsmExport}
        folders={active}
        locked={locked}
        live={device.live}
        onChanged={reload}
      />

      <section className="mb-10">
        <h2 className="mb-3 font-medium">Backup folders</h2>
        {active.length === 0 ? (
          <div className="rounded-lg border border-dashed border-edge px-6 py-10 text-center">
            <p className="font-medium">Nothing is being backed up on this device</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-dim">
              Click Choose folders and tick what to back up. The device shows you its folders live.
            </p>
            {canAdd && (
              <button type="button" className={`${primaryButton} mt-5`} onClick={() => setPicking(true)}>
                <FolderTreeIcon size={16} aria-hidden="true" />
                Choose folders
              </button>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-edge rounded-lg border border-edge bg-surface">
            {active.map((f) => (
              <FolderRow
                key={f.id}
                folder={f}
                onEdit={setEditing}
                onRemove={setRemoving}
                locked={locked}
                deviceId={device.id}
                copies={data.offsite?.copies ?? []}
                onChanged={reload}
              />
            ))}
          </ul>
        )}
      </section>

      {data.offsite && <DeviceCopies device={device} offsite={data.offsite} onChanged={reload} />}

      <DeviceAgent deviceId={device.id} deviceName={device.name} />

      <DeviceSettings
        deviceId={device.id}
        settings={data.settings}
        status={data.agentStatus}
        live={device.live}
        disabled={!multiFolder}
        onSaved={reload}
      />

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
                <button type="button" className={secondaryButton} disabled={!multiFolder || locked || readding === f.id} onClick={() => readd(f)}>
                  {readding === f.id ? "Adding" : "Add back"}
                </button>
              </li>
            ))}
          </ul>
          {readdError && <p className="mt-2 text-sm text-alert">{readdError}</p>}
        </section>
      )}

      <DeviceService deviceId={device.id} deviceName={device.name} onChanged={reload} />

      <section>
        <h2 className="flex items-center gap-2 font-medium">
          <ShieldCheck size={18} className="text-good" aria-hidden="true" />
          Allowed areas
        </h2>
        <p className="mb-3 mt-1 max-w-2xl text-sm text-dim">
          {fullAccess
            ? "This device was installed with full access: the whole device can be browsed, backed up and restored to. Lock the folders above so they can't be changed without the key."
            : "The only places this device lets the gateway back up or browse. They\u2019re set on the device itself (AGENT_ALLOWED_PATHS), so even someone with access to this gateway can\u2019t reach anything else."}
        </p>
        {fullAccess ? (
          <p className="text-sm text-fg">Everything on this device</p>
        ) : allowedPaths.length === 0 ? (
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
        <FolderTree
          device={{ ...device, platform: data.platform, fullAccess }}
          folders={active}
          onClose={() => setPicking(false)}
          onSaved={() => {
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
