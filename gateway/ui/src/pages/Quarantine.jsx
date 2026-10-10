// Quarantine: everything the quarantine engine held back, and every frozen device.
//   Release  = it was a false alarm: becomes a normal version (and the file's latest backup)
//   Reject   = it really was damage: kept as evidence, never restorable
//   Unfreeze = the device is clean again: its new changes are accepted normally

import { useEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router";
import { History, ShieldCheck, Snowflake } from "lucide-react";
import { api } from "../api.js";
import { usePolling } from "../usePolling.js";
import { formatDateTime, formatSize, timeAgo } from "../format.js";
import PageHeader from "../components/PageHeader.jsx";
import LoadState from "../components/LoadState.jsx";
import Modal from "../components/Modal.jsx";
import { primaryButton, secondaryButton } from "../components/buttons.js";

const dangerButton =
  "inline-flex h-10 items-center justify-center gap-2 rounded-md bg-alert px-4 text-sm font-medium text-night " +
  "transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

const checkboxClass = "h-4 w-4 shrink-0 cursor-pointer accent-signal";

// ---------- Frozen devices ----------

function FrozenDevice({ device, onUnfreeze }) {
  return (
    <li className="flex flex-col gap-4 rounded-lg border border-alert/40 bg-surface p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 gap-3">
        <Snowflake size={20} className="mt-0.5 shrink-0 text-alert" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-medium">
            {device.name} <span className="font-normal text-dim">({device.client})</span>
          </p>
          <p className="mt-0.5 text-sm text-alert">
            Frozen {timeAgo(device.frozenAt)}: {device.frozenReason}
          </p>
          <p className="mt-1 text-sm text-dim">
            New changes from this device are held here. Restores still work and only use good versions.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Link to={`/restore?device=${device.id}`} className={secondaryButton}>
          <History size={16} aria-hidden="true" />
          Restore files
        </Link>
        <button type="button" className={primaryButton} onClick={() => onUnfreeze(device)}>
          Unfreeze
        </button>
      </div>
    </li>
  );
}

function UnfreezeDialog({ device, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function unfreeze() {
    setBusy(true);
    setError("");
    try {
      await api.post(`/devices/${device.id}/unfreeze`);
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Unfreeze ${device.name}?`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={primaryButton} onClick={unfreeze} disabled={busy}>
            {busy ? "Unfreezing" : "Unfreeze"}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>Only unfreeze once you know the device is clean: the ransomware has been removed, or it was a false alarm.</p>
        <p className="text-dim">
          New changes will be accepted normally again. Files already in quarantine stay here for you to release or reject.
          If damage starts again, the device freezes again on its own.
        </p>
        {error && <p className="text-alert">{error}</p>}
      </div>
    </Modal>
  );
}

// ---------- Held files ----------

function HeldFile({ item, checked, onToggle }) {
  return (
    <li>
      <label className="flex cursor-pointer gap-3 px-5 py-3 hover:bg-raised/40">
        <input type="checkbox" className={`${checkboxClass} mt-1`} checked={checked} onChange={() => onToggle(item.id)} />
        <div className="grid min-w-0 flex-1 gap-1 md:grid-cols-[minmax(0,1fr)_auto] md:gap-6">
          <div className="min-w-0">
            <p className="truncate font-mono text-sm text-fg" title={item.path}>
              {item.path}
            </p>
            <p className="mt-1 flex flex-wrap gap-1.5">
              {item.reasons.map((r) => (
                <span key={r} className="rounded border border-series-quarantine/40 px-1.5 py-0.5 text-xs text-fg">
                  {r}
                </span>
              ))}
            </p>
          </div>
          <div className="flex gap-4 text-sm text-dim md:flex-col md:items-end md:gap-0.5">
            <span title={formatDateTime(item.receivedAt)}>{timeAgo(item.receivedAt)}</span>
            <span>
              {item.type === "deleted" ? (
                <span className="text-series-delete">deleted</span>
              ) : (
                <>
                  {formatSize(item.size)}
                  {item.entropy != null && (
                    <span title="How random the content is, out of 8. Normal documents are well below 7.5; encrypted data is close to 8.">
                      {" "}· randomness {item.entropy.toFixed(2)}
                    </span>
                  )}
                </>
              )}
              , v{item.versionNo}
            </span>
          </div>
        </div>
      </label>
    </li>
  );
}

function DeviceGroup({ name, client, items, selected, onToggle, onToggleAll }) {
  const allChecked = items.every((i) => selected.has(i.id));
  const someChecked = !allChecked && items.some((i) => selected.has(i.id));
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">
          {name} <span className="text-base font-normal text-dim">({client})</span>
        </h2>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-dim hover:text-fg">
          <input
            type="checkbox"
            className={checkboxClass}
            checked={allChecked}
            ref={(el) => el && (el.indeterminate = someChecked)}
            onChange={() => onToggleAll(items.map((i) => i.id), !allChecked)}
          />
          Select all {items.length}
        </label>
      </div>
      <ul className="divide-y divide-edge overflow-hidden rounded-lg border border-edge bg-surface">
        {items.map((item) => (
          <HeldFile key={item.id} item={item} checked={selected.has(item.id)} onToggle={onToggle} />
        ))}
      </ul>
    </section>
  );
}

const REVIEW_TEXT = {
  release: {
    title: (n) => `Release ${n} file${n === 1 ? "" : "s"}?`,
    button: "Release",
    body: (
      <>
        <p>Only release files you&rsquo;ve checked are fine, such as a file saved with the wrong extension.</p>
        <p className="text-dim">
          Released files become normal versions. If one is newer than the file&rsquo;s last good version, it becomes the
          latest backup and will be used by restores.
        </p>
      </>
    ),
  },
  reject: {
    title: (n) => `Reject ${n} file${n === 1 ? "" : "s"}?`,
    button: "Reject",
    body: (
      <>
        <p>Rejected files are kept as evidence of what happened, but can never be restored or become the latest backup.</p>
        <p className="text-dim">This can&rsquo;t be undone. The good versions from before are not affected.</p>
      </>
    ),
  },
};

function ReviewDialog({ action, ids, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const text = REVIEW_TEXT[action];

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await api.post(`/quarantine/${action}`, { ids });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={text.title(ids.length)}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={action === "reject" ? dangerButton : primaryButton} onClick={confirm} disabled={busy}>
            {busy ? "Working" : text.button}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {text.body}
        {error && <p className="text-alert">{error}</p>}
      </div>
    </Modal>
  );
}

// ---------- Alert history ----------

function AlertHistory({ alerts }) {
  if (!alerts?.length) return null;
  return (
    <section className="mt-12">
      <h2 className="mb-3 font-medium">Alert history</h2>
      <ul className="divide-y divide-edge rounded-lg border border-edge bg-surface text-sm">
        {alerts.slice(0, 30).map((a) => (
          <li key={a.id} className="flex flex-col gap-0.5 px-5 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
            <p className={a.acknowledgedAt ? "text-dim" : "text-fg"}>{a.message}</p>
            <p className="shrink-0 text-xs text-dim" title={formatDateTime(a.createdAt)}>
              {timeAgo(a.createdAt)}
              {a.acknowledgedAt ? `, dismissed by ${a.acknowledgedBy}` : ", open"}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- Page ----------

export default function Quarantine() {
  const { alerts, reloadAlerts } = useOutletContext();
  const held = usePolling("/quarantine", 15000);
  const devices = usePolling("/devices", 15000);
  const [selected, setSelected] = useState(() => new Set());
  const [review, setReview] = useState(null); // "release" | "reject"
  const [unfreezing, setUnfreezing] = useState(null);

  // Forget selections for items that are no longer in quarantine
  useEffect(() => {
    if (!held.data) return;
    const present = new Set(held.data.map((i) => i.id));
    setSelected((s) => {
      const next = new Set([...s].filter((id) => present.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [held.data]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const item of held.data ?? []) {
      if (!map.has(item.deviceId)) map.set(item.deviceId, { name: item.device, client: item.client, items: [] });
      map.get(item.deviceId).items.push(item);
    }
    return [...map.entries()];
  }, [held.data]);

  const frozen = (devices.data ?? []).filter((d) => d.status === "frozen");

  function toggle(id) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll(ids, on) {
    setSelected((s) => {
      const next = new Set(s);
      for (const id of ids) on ? next.add(id) : next.delete(id);
      return next;
    });
  }
  function refreshAll() {
    held.reload();
    devices.reload();
    reloadAlerts();
  }

  if (!held.data || !devices.data) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader title="Quarantine" />
        <LoadState
          loading={held.loading || devices.loading}
          error={held.error || devices.error}
          onRetry={refreshAll}
        />
      </div>
    );
  }

  const count = held.data.length;

  return (
    <div className="mx-auto max-w-6xl pb-24">
      <PageHeader title="Quarantine">
        {count === 0
          ? "Nothing is waiting for review."
          : `${count} file version${count === 1 ? " was" : "s were"} held back from ${groups.length} device${groups.length === 1 ? "" : "s"}. They are never used for restores until you release them.`}
      </PageHeader>

      {frozen.length > 0 && (
        <ul className="mb-10 space-y-3">
          {frozen.map((d) => (
            <FrozenDevice key={d.id} device={d} onUnfreeze={setUnfreezing} />
          ))}
        </ul>
      )}

      {count === 0 ? (
        <div className="rounded-lg border border-dashed border-edge px-6 py-12 text-center">
          <ShieldCheck size={28} className="mx-auto text-good" aria-hidden="true" />
          <p className="mt-3 font-medium">Quarantine is empty</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-dim">
            Every new file version is checked for signs of ransomware. Anything suspicious shows up here.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map(([deviceId, g]) => (
            <DeviceGroup key={deviceId} {...g} selected={selected} onToggle={toggle} onToggleAll={toggleAll} />
          ))}
        </div>
      )}

      <AlertHistory alerts={alerts} />

      {/* Action bar: appears while something is selected */}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-edge bg-surface/95 backdrop-blur lg:left-64">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-8">
            <p className="text-sm">
              {selected.size} selected{" "}
              <button type="button" className="ml-2 text-dim underline-offset-2 hover:text-fg hover:underline" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </p>
            <div className="flex gap-2">
              <button type="button" className={secondaryButton} onClick={() => setReview("release")}>
                Release
              </button>
              <button type="button" className={dangerButton} onClick={() => setReview("reject")}>
                Reject
              </button>
            </div>
          </div>
        </div>
      )}

      {review && (
        <ReviewDialog
          action={review}
          ids={[...selected]}
          onClose={() => setReview(null)}
          onDone={() => {
            setReview(null);
            setSelected(new Set());
            refreshAll();
          }}
        />
      )}
      {unfreezing && (
        <UnfreezeDialog
          device={unfreezing}
          onClose={() => setUnfreezing(null)}
          onDone={() => {
            setUnfreezing(null);
            refreshAll();
          }}
        />
      )}
    </div>
  );
}