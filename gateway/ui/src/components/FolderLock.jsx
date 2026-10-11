// Folder lock panel on a device's page. The device itself checks the unlock key; this gateway
// never keeps it. Lock the first time = a new key, shown once. Unlocked = 30 minutes to change
// the folders, then the device locks them again by itself.

import { useState } from "react";
import { Check, Copy, Lock, LockOpen, TriangleAlert } from "lucide-react";
import { api } from "../api.js";
import { formatDateTime, timeAgo } from "../format.js";
import Modal from "./Modal.jsx";
import { inputClass, primaryButton, secondaryButton } from "./buttons.js";

function KeyDialog({ title, action, deviceId, onClose, onDone, children }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post(`/devices/${deviceId}/lock`, { action, key });
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
            Cancel
          </button>
          <button type="submit" form="lock-key" className={primaryButton} disabled={busy || !key.trim()}>
            {busy ? "Checking with the device…" : title}
          </button>
        </>
      }
    >
      <form id="lock-key" onSubmit={submit} className="space-y-3 text-sm">
        {children}
        <label htmlFor="unlock-key" className="block text-dim">
          Unlock key
        </label>
        <input
          id="unlock-key"
          className={`${inputClass} font-mono uppercase`}
          placeholder="BGFL-XXXX-XXXX-XXXX-XXXX-XXXX"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        {error && (
          <p role="alert" className="text-alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

function NewKeyDialog({ keyText, onClose }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(keyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // select it by hand
    }
  }
  return (
    <Modal
      title="Folders locked: save the unlock key"
      onClose={() => saved && onClose()}
      footer={
        <button type="button" className={primaryButton} disabled={!saved} onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-dim">
          The device now keeps backing up exactly these folders and refuses any change without this key. It&rsquo;s shown{" "}
          <span className="text-fg">only this once</span> and isn&rsquo;t kept on the gateway. Put it in your password manager.
        </p>
        <div className="flex items-center gap-2 rounded-md border border-secure/40 bg-secure/10 px-4 py-3">
          <code className="min-w-0 flex-1 break-all font-mono text-sm text-fg select-all">{keyText}</code>
          <button type="button" onClick={copy} className={`${secondaryButton} shrink-0`} aria-label="Copy unlock key">
            {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="text-dim">Without it, the folders on this device can only be changed by reinstalling its agent.</p>
        <label className="flex cursor-pointer items-center gap-2 text-fg">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="size-4 accent-signal" />
          I&rsquo;ve saved the unlock key
        </label>
      </div>
    </Modal>
  );
}

export default function FolderLock({ deviceId, lock, live, folderCount, onChanged }) {
  const [dialog, setDialog] = useState(null); // "unlock" | "remove" | { key }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function lockNow() {
    setBusy(true);
    setError("");
    try {
      const result = await api.post(`/devices/${deviceId}/lock`, { action: "lock" });
      if (result.key) setDialog({ key: result.key });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const done = () => {
    setDialog(null);
    onChanged();
  };

  const enabled = !!lock?.enabled;
  const locked = enabled && lock.locked;
  const unlocked = enabled && !lock.locked;
  if (!enabled && folderCount === 0) return null;

  return (
    <section
      className={`mb-6 rounded-lg border px-5 py-4 ${locked ? "border-good/40 bg-good/5" : unlocked ? "border-warn/40 bg-warn/10" : "border-edge bg-surface"}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 gap-3">
          {locked ? (
            <Lock size={20} className="mt-0.5 shrink-0 text-good" aria-hidden="true" />
          ) : (
            <LockOpen size={20} className={`mt-0.5 shrink-0 ${unlocked ? "text-warn" : "text-dim"}`} aria-hidden="true" />
          )}
          <div className="min-w-0 text-sm">
            {locked && (
              <>
                <p className="font-medium text-fg">Folders locked</p>
                <p className="text-dim" title={formatDateTime(lock.lockedAt)}>
                  Since {timeAgo(lock.lockedAt)}. The device only accepts folder changes after it&rsquo;s unlocked with the key.
                </p>
              </>
            )}
            {unlocked && (
              <>
                <p className="font-medium text-fg">Unlocked until {formatDateTime(lock.unlockedUntil)}</p>
                <p className="text-dim">Change the folders now. The device locks them again by itself after that, as they are then.</p>
              </>
            )}
            {!enabled && (
              <>
                <p className="font-medium text-fg">Lock these folders</p>
                <p className="text-dim">
                  Once they&rsquo;re right, lock them on the device. Changing them later needs the unlock key, even for someone
                  with access to this gateway.
                </p>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {locked && (
            <button type="button" className={secondaryButton} disabled={!live} onClick={() => setDialog("unlock")}>
              <LockOpen size={16} aria-hidden="true" />
              Unlock
            </button>
          )}
          {unlocked && (
            <>
              <button type="button" className={secondaryButton} disabled={!live} onClick={() => setDialog("remove")}>
                Turn off the lock
              </button>
              <button type="button" className={primaryButton} disabled={!live || busy} onClick={lockNow}>
                <Lock size={16} aria-hidden="true" />
                Lock again
              </button>
            </>
          )}
          {!enabled && (
            <button type="button" className={primaryButton} disabled={!live || busy} onClick={lockNow}>
              <Lock size={16} aria-hidden="true" />
              {busy ? "Locking…" : "Lock folders"}
            </button>
          )}
        </div>
      </div>
      {locked && lock.refusedAt && (
        <p className="mt-3 flex gap-2 text-sm text-warn">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            The gateway asked this device for different folders {timeAgo(lock.refusedAt)}, and it kept the locked ones. If you
            didn&rsquo;t change them, someone may have tampered with this gateway: check before unlocking, because unlocking
            applies the list shown here. The device is backing up:
            {(lock.folders ?? []).map((f) => (
              <span key={f.name} className="mt-1 block break-all font-mono text-xs text-fg">
                {f.name}: {f.path}
              </span>
            ))}
          </span>
        </p>
      )}
      {!live && <p className="mt-3 text-sm text-dim">The device must be connected to lock or unlock.</p>}
      {error && (
        <p role="alert" className="mt-3 text-sm text-alert">
          {error}
        </p>
      )}

      {dialog === "unlock" && (
        <KeyDialog title="Unlock folders" action="unlock" deviceId={deviceId} onClose={() => setDialog(null)} onDone={done}>
          <p className="text-dim">For 30 minutes, then the device locks them again by itself. After 5 wrong keys it waits 15 minutes.</p>
        </KeyDialog>
      )}
      {dialog === "remove" && (
        <KeyDialog title="Turn off the lock" action="remove" deviceId={deviceId} onClose={() => setDialog(null)} onDone={done}>
          <p className="text-dim">The folders can then be changed freely from this gateway until you lock them again (with a new key).</p>
        </KeyDialog>
      )}
      {dialog?.key && <NewKeyDialog keyText={dialog.key} onClose={() => setDialog(null)} />}
    </section>
  );
}
