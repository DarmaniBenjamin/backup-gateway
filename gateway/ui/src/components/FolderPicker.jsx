// Live folder browser for choosing a new backup folder. The device itself lists its folders
// (names only, never file contents), and only inside the allowed areas set on that device.

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Folder, HardDrive, LoaderCircle } from "lucide-react";
import { api } from "../api.js";
import Modal from "./Modal.jsx";
import { inputClass, primaryButton, secondaryButton } from "./buttons.js";

// Long paths keep their end visible: "…/Users/Anna/Documents"
function shortPath(p) {
  if (p.length <= 56) return p;
  const sep = p.includes("\\") ? "\\" : "/";
  const parts = p.split(sep).filter(Boolean);
  let out = parts.pop();
  while (parts.length && out.length + parts.at(-1).length < 50) out = `${parts.pop()}${sep}${out}`;
  return `…${sep}${out}`;
}

export default function FolderPicker({ device, onClose, onAdded }) {
  const [listing, setListing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState(null); // step 2: the folder picked, plus exclusions
  const [excludes, setExcludes] = useState("");
  const [saving, setSaving] = useState(false);

  const open = useCallback(
    async (path) => {
      setLoading(true);
      setError("");
      try {
        setListing(await api.post(`/devices/${device.id}/browse`, { path }));
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [device.id]
  );

  useEffect(() => {
    open("");
  }, [open]);

  async function add() {
    setSaving(true);
    setError("");
    try {
      const folder = await api.post(`/devices/${device.id}/folders`, {
        path: chosen,
        excludes: excludes.split("\n").map((s) => s.trim()).filter(Boolean),
      });
      onAdded(folder);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  const atRoots = listing?.path === "";
  const blocked = listing?.backedUpAs
    ? `Already backed up as "${listing.backedUpAs}".`
    : listing?.insideFolder
      ? `This is inside the backup folder "${listing.insideFolder}", so it's already covered.`
      : "";

  // Step 2: confirm, with optional exclusions
  if (chosen) {
    const name = chosen.split(/[\\/]/).filter(Boolean).pop() || chosen;
    return (
      <Modal
        title="Back up this folder?"
        onClose={onClose}
        wide
        footer={
          <>
            <button type="button" className={secondaryButton} onClick={() => setChosen(null)} disabled={saving}>
              Back
            </button>
            <button type="button" className={primaryButton} onClick={add} disabled={saving}>
              {saving ? "Adding" : "Start backing up"}
            </button>
          </>
        }
      >
        <div className="space-y-5 text-sm">
          <div>
            <p className="text-dim">Folder on {device.name}</p>
            <p className="mt-1 break-all font-mono text-fg">{chosen}</p>
            <p className="mt-2 text-dim">
              It appears as <span className="text-fg">{name}</span> in Restore. Everything inside it, including sub-folders, is
              backed up, and the device starts within a few seconds.
            </p>
          </div>
          <label className="block">
            <span className="text-fg">Skip these files and folders</span>
            <span className="mt-0.5 block text-dim">Optional. One name or pattern per line, for example *.mp4 or Cache</span>
            <textarea
              value={excludes}
              onChange={(e) => setExcludes(e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder={"*.mp4\nCache"}
              className={`${inputClass} mt-2 h-auto py-2 font-mono`}
            />
          </label>
          {error && <p className="text-alert">{error}</p>}
        </div>
      </Modal>
    );
  }

  // Step 1: browse
  return (
    <Modal
      title={`Choose a folder on ${device.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={loading || !listing || atRoots || !!blocked}
            onClick={() => setChosen(listing.path)}
          >
            Back up this folder
          </button>
        </>
      }
    >
      <div className="text-sm">
        <div className="mb-3 flex items-center gap-2">
          <button
            type="button"
            aria-label="Up one level"
            disabled={!listing || atRoots || loading}
            onClick={() => open(listing.parent)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-edge text-dim hover:bg-raised hover:text-fg disabled:opacity-40"
          >
            <ChevronLeft size={18} />
          </button>
          <p className="min-w-0 flex-1 truncate font-mono text-fg" title={listing?.path}>
            {atRoots || !listing ? "Allowed areas" : shortPath(listing.path)}
          </p>
          {loading && <LoaderCircle size={16} className="shrink-0 animate-spin text-dim" aria-label="Loading" />}
        </div>

        {error && <p className="mb-3 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-alert">{error}</p>}
        {blocked && <p className="mb-3 text-dim">{blocked}</p>}

        {listing && (
          <ul className="max-h-80 divide-y divide-edge overflow-y-auto rounded-md border border-edge">
            {listing.entries.length === 0 && <li className="px-4 py-3 text-dim">No folders in here.</li>}
            {listing.entries.map((e) => {
              const Icon = atRoots ? HardDrive : Folder;
              return (
                <li key={e.path}>
                  <button
                    type="button"
                    onClick={() => open(e.path)}
                    disabled={loading}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-raised/60"
                  >
                    <Icon size={16} className="shrink-0 text-dim" aria-hidden="true" />
                    <span className={`min-w-0 flex-1 truncate ${atRoots ? "font-mono" : ""}`}>{e.name}</span>
                    {e.backedUpAs && <span className="shrink-0 text-xs text-good">Backed up</span>}
                    <ChevronRight size={16} className="shrink-0 text-dim" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {listing?.truncated && <p className="mt-2 text-dim">Showing the first 1,000 folders.</p>}
        <p className="mt-3 text-dim">
          {atRoots
            ? "These are the only places this device allows backups from. Open one to pick a folder inside it."
            : "Open a folder to go inside it, or back up the folder you're in now."}
        </p>
      </div>
    </Modal>
  );
}
