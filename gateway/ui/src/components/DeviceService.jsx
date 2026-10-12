// The Service card on a device's page: pause its backups, uninstall its agent from here (now, or
// the next time it connects), or remove a device that's gone. Backups already made are kept until a
// removed device is deleted for good: by hand, or by itself after the days set on the Devices page
// (unless it's kept).

import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { CircleCheck, LoaderCircle, Pause, Play, PowerOff, Trash2, Unplug } from "lucide-react";
import { api } from "../api.js";
import { usePolling } from "../usePolling.js";
import { formatDateTime, formatSize, timeAgo } from "../format.js";
import Modal from "./Modal.jsx";
import { inputClass, secondaryButton } from "./buttons.js";

const dangerButton =
  "inline-flex h-10 items-center justify-center gap-2 rounded-md border border-alert/60 px-4 text-sm text-alert " +
  "hover:bg-alert/10 disabled:cursor-not-allowed disabled:opacity-50";

export function Confirm({ deviceName, title, children, action, onClose, onDone, path }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ok = typed.trim().toLowerCase() === deviceName.trim().toLowerCase();
  async function go() {
    setBusy(true);
    setError("");
    try {
      await api.post(path, { confirm: typed });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Keep it
          </button>
          <button type="button" className={`${dangerButton} bg-alert/10`} disabled={!ok || busy} onClick={go}>
            {busy && <LoaderCircle size={15} className="animate-spin" />}
            {action}
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="space-y-2 text-dim">{children}</div>
        <label className="block">
          <span className="mb-1.5 block text-fg">
            Type <span className="font-mono">{deviceName}</span> to confirm
          </span>
          <input className={inputClass} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        {error && <p className="text-alert" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

function Progress({ r, live }) {
  const steps = [
    { label: "Asked", at: r.requestedAt, done: true },
    { label: live || r.deliveredAt ? "Sent to the device" : "Waiting for the device to connect", at: r.deliveredAt, done: !!r.deliveredAt },
    { label: "Uninstalling", at: r.confirmedAt, done: !!r.confirmedAt },
    { label: "Removed", at: r.finishedAt, done: r.state === "done" },
  ];
  return (
    <ol className="grid gap-3 sm:grid-cols-4">
      {steps.map((s, i) => {
        const current = !s.done && (i === 0 || steps[i - 1].done);
        return (
          <li key={s.label} className={`rounded-md border px-3 py-2.5 text-sm ${s.done ? "border-good/40" : current ? "border-signal/60" : "border-edge"}`}>
            <p className={`flex items-center gap-1.5 ${s.done ? "text-good" : current ? "text-fg" : "text-dim"}`}>
              {s.done ? <CircleCheck size={14} aria-hidden="true" /> : current ? <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
              {s.label}
            </p>
            {s.at && <p className="mt-0.5 text-xs text-dim" title={formatDateTime(s.at)}>{timeAgo(s.at)}</p>}
          </li>
        );
      })}
    </ol>
  );
}

// For a removed device: what deleting it for good means
export function DeleteText({ storedBytes }) {
  return (
    <>
      <p>
        This deletes its backups on this gateway{storedBytes ? ` (${formatSize(storedBytes)})` : ""}, every version, and its jobs and alerts. It can&rsquo;t be
        undone, and nothing of it can be restored after.
      </p>
      <p>
        Off-site copies already made aren&rsquo;t deleted from there: in a bucket they run out with its retention, and a Google Drive folder you delete
        yourself.
      </p>
    </>
  );
}

export default function DeviceService({ deviceId, deviceName, onChanged }) {
  const { data, reload } = usePolling(`/devices/${deviceId}/service`, 5000);
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(null); // "uninstall" | "forget"
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  if (!data) return null;
  const r = data.removal;
  const running = r && ["waiting", "refused", "uninstalling"].includes(r.state);

  async function act(kind, fn) {
    setBusy(kind);
    setError("");
    try {
      await fn();
      reload();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }
  const done = () => {
    setConfirm(null);
    reload();
    onChanged?.();
  };

  if (data.status !== "active") {
    return (
      <section className="mb-10">
        <h2 className="mb-3 font-medium">Service</h2>
        <div className="rounded-lg border border-edge px-5 py-4 text-sm">
          <p className="text-fg">
            {r?.state === "done" ? `The agent was uninstalled ${timeAgo(r.finishedAt)}, and the device removed.` : "This device was removed from the gateway."}
          </p>
          <p className="mt-1 text-dim">
            It can't connect any more. Its backups are kept: restore them to another device from the <Link to="/restore" className="text-signal hover:underline">Restore</Link> page.
          </p>
          {data.autoDelete?.days > 0 && (r?.state === "done" || r?.state === "forgotten") && (
            <div className="mt-4 flex flex-col gap-3 border-t border-edge pt-4 md:flex-row md:items-center md:justify-between">
              <p className={data.autoDelete.keep ? "text-dim" : "text-warn"}>
                {data.autoDelete.keep
                  ? "Its backups are kept: they won't be deleted automatically."
                  : `Its backups will be deleted automatically on ${new Date(data.autoDelete.at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}.`}
              </p>
              <button
                type="button"
                className={`${secondaryButton} h-10 px-4`}
                disabled={busy === "keep"}
                onClick={() => act("keep", () => api.post(`/devices/${deviceId}/keep`, { keep: !data.autoDelete.keep }))}
              >
                {data.autoDelete.keep ? "Delete them automatically again" : "Keep its backups"}
              </button>
            </div>
          )}
          {error && <p className="mt-3 text-warn">{error}</p>}
          <div className="mt-4 flex flex-col gap-3 border-t border-edge pt-4 md:flex-row md:items-center md:justify-between">
            <p className="text-dim">Not needed any more? Delete the device and its backups{data.storedBytes ? ` (${formatSize(data.storedBytes)})` : ""} for good.</p>
            <button type="button" className={dangerButton} onClick={() => setConfirm("delete")}>
              <Trash2 size={15} />
              Delete for good
            </button>
          </div>
        </div>
        {confirm === "delete" && (
          <Confirm
            deviceName={deviceName}
            title={`Delete ${deviceName} for good?`}
            action="Delete device and backups"
            path={`/devices/${deviceId}/delete`}
            onClose={() => setConfirm(null)}
            onDone={() => navigate("/devices")}
          >
            <DeleteText storedBytes={data.storedBytes} />
          </Confirm>
        )}
      </section>
    );
  }

  return (
    <section className="mb-10">
      <h2 className="mb-3 font-medium">Service</h2>
      <div className="divide-y divide-edge rounded-lg border border-edge bg-surface">
        {data.canPause && (
          <div className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center md:justify-between">
            <div className="text-sm">
              <p className="text-fg">{data.paused ? "Backups are paused" : "Backups are running"}</p>
              <p className="mt-0.5 text-dim">
                {data.paused
                  ? "Nothing new is sent until you resume. Everything already backed up is kept and can be restored."
                  : "Pause to stop sending new changes, for example while a client's service is on hold."}
              </p>
            </div>
            <button
              type="button"
              className={secondaryButton}
              disabled={!!busy || running}
              onClick={() => act("pause", () => api.post(`/devices/${deviceId}/pause`, { paused: !data.paused }))}
            >
              {busy === "pause" ? <LoaderCircle size={15} className="animate-spin" /> : data.paused ? <Play size={15} /> : <Pause size={15} />}
              {data.paused ? "Resume backups" : "Pause backups"}
            </button>
          </div>
        )}

        <div className="px-5 py-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="text-sm">
              <p className="text-fg">Uninstall the agent</p>
              <p className="mt-0.5 max-w-2xl text-dim">
                When the client stops the service. The device removes the agent by itself, in the background, and if it&rsquo;s offline it does
                it the next time it connects. Its own files aren&rsquo;t touched, and its backups stay here.
              </p>
            </div>
            {!running && (
              <button type="button" className={dangerButton} disabled={!data.readiness.ok} onClick={() => setConfirm("uninstall")}>
                <PowerOff size={15} />
                Uninstall agent
              </button>
            )}
          </div>
          {!data.readiness.ok && !running && (
            <p className="mt-3 text-sm text-warn">
              This agent was installed before it could uninstall itself. Turn on automatic updates on its Agent card above (one command, once), or
              remove it below without uninstalling.
            </p>
          )}
          {r && (
            <div className="mt-4 space-y-3">
              {r.state === "failed" ? (
                <p className="text-sm text-alert">Uninstalling failed {timeAgo(r.finishedAt)}: {r.message}</p>
              ) : (
                <Progress r={r} live={data.live} />
              )}
              {r.state === "refused" && (
                <p className="text-sm text-warn">
                  The device has its folder lock on, so it won&rsquo;t uninstall until it&rsquo;s unlocked. Unlock it with its key (Folder lock, above) and it
                  uninstalls straight after.
                </p>
              )}
              {r.state === "waiting" && data.readiness.updateFirst && (
                <p className="text-sm text-dim">It updates its agent to {data.uninstallFrom} first (that version knows how to uninstall), then uninstalls.</p>
              )}
              {r.state === "uninstalling" && <p className="text-sm text-dim">Once the device goes quiet, it&rsquo;s marked removed.</p>}
              <p className="text-xs text-dim">
                Asked by {r.requestedBy} {timeAgo(r.requestedAt)}.
              </p>
              {["waiting", "refused", "failed"].includes(r.state) && (
                <div className="flex flex-wrap gap-2">
                  {r.state === "failed" && (
                    <button type="button" className={dangerButton} onClick={() => setConfirm("uninstall")}>
                      Try again
                    </button>
                  )}
                  <button type="button" className={secondaryButton} disabled={!!busy} onClick={() => act("cancel", () => api.post(`/devices/${deviceId}/uninstall/cancel`))}>
                    {r.state === "failed" ? "Dismiss" : "Cancel the uninstall"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div className="text-sm">
            <p className="text-fg">Remove without uninstalling</p>
            <p className="mt-0.5 text-dim">For a computer that&rsquo;s gone, broken or wiped. It&rsquo;s cut off from the gateway; its backups stay here.</p>
          </div>
          <button type="button" className={secondaryButton} disabled={r?.state === "uninstalling"} onClick={() => setConfirm("forget")}>
            <Unplug size={15} />
            Remove device
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-sm text-alert">{error}</p>}

      {confirm === "uninstall" && (
        <Confirm
          deviceName={deviceName}
          title={`Uninstall the agent from ${deviceName}?`}
          action="Uninstall agent"
          path={`/devices/${deviceId}/uninstall`}
          onClose={() => setConfirm(null)}
          onDone={done}
        >
          <p>
            The device removes the backup agent, its settings and its keys. {data.live ? "It's connected, so this starts in a few seconds." : "It's offline now, so it does this the next time it connects."}
          </p>
          <p>The files on the device aren&rsquo;t touched. Its backups stay on this gateway (and off-site), and can still be restored to another device.</p>
          <p>To back it up again later, it has to be added again as a new device.</p>
        </Confirm>
      )}
      {confirm === "forget" && (
        <Confirm
          deviceName={deviceName}
          title={`Remove ${deviceName} without uninstalling?`}
          action="Remove device"
          path={`/devices/${deviceId}/forget`}
          onClose={() => setConfirm(null)}
          onDone={done}
        >
          <p>The gateway stops accepting this device. If its agent is still installed somewhere, it keeps running there but can&rsquo;t connect or send anything.</p>
          <p>Its backups stay here, and can still be restored to another device.</p>
        </Confirm>
      )}
    </section>
  );
}
