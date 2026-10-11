// Choose what to back up on a device, like the Synology client: a live tree of the device's
// folders with tick boxes. Tick a folder to back it up (everything inside comes with it), untick
// a sub-folder to skip just that one. Folders are listed live by the device itself, and only
// inside the allowed areas set on that device.
//
// How it's saved: every ticked top folder is a backup folder; every unticked sub-folder inside
// one is an exclusion like "/Downloads" on that backup folder.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Folder, HardDrive, LoaderCircle } from "lucide-react";
import { api } from "../api.js";
import Modal from "./Modal.jsx";
import { primaryButton, secondaryButton } from "./buttons.js";

const MAX_EXCLUDES = 50;

// Path helpers that work for both Linux/Mac ("/") and Windows ("\", case-insensitive) devices
function pathTools(windows) {
  const sep = windows ? "\\" : "/";
  const key = (p) => (windows ? p.toLowerCase() : p);
  const withSep = (p) => (p.endsWith(sep) ? p : p + sep);
  const same = (a, b) => key(a) === key(b);
  const under = (child, parent) => !same(child, parent) && key(child).startsWith(key(withSep(parent)));
  const rel = (child, root) => child.slice(withSep(root).length).split(sep).join("/");
  const abs = (root, relPath) => withSep(root) + relPath.split("/").join(sep);
  return { sep, key, same, under, rel, abs };
}

function versionAtLeast(v, min) {
  const a = String(v ?? "0").split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
  return true;
}

function Checkbox({ state, disabled, onChange, label }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "partial";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={state === "on"}
      disabled={disabled}
      onChange={onChange}
      className="h-4 w-4 shrink-0 cursor-pointer accent-signal disabled:cursor-not-allowed disabled:opacity-40"
    />
  );
}

export default function FolderTree({ device, folders, onClose, onSaved }) {
  const t = useMemo(() => pathTools(device.platform === "win32"), [device.platform]);

  // What's backed up now, as { path, folderId, name, patterns (name rules, kept as they are), excluded (full paths) }
  const initial = useMemo(
    () =>
      folders.map((f) => ({
        path: f.path,
        folderId: f.id,
        name: f.name,
        patterns: f.excludes.filter((e) => !e.startsWith("/")),
        excluded: f.excludes.filter((e) => e.startsWith("/")).map((e) => t.abs(f.path, e.slice(1))),
      })),
    [folders, t]
  );
  const [roots, setRoots] = useState(initial);

  // Folder listings from the device: path ("" = allowed areas) -> { loading, entries, error, truncated }
  const [lists, setLists] = useState({});
  const [open, setOpen] = useState(() => new Set());
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    async (path) => {
      setLists((l) => ({ ...l, [path]: { loading: true } }));
      try {
        const listing = await api.post(`/devices/${device.id}/browse`, { path });
        setLists((l) => ({ ...l, [path]: { entries: listing.entries, truncated: listing.truncated } }));
      } catch (err) {
        setLists((l) => ({ ...l, [path]: { error: err.message } }));
      }
    },
    [device.id]
  );

  useEffect(() => {
    load("");
  }, [load]);

  function toggleOpen(path) {
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!lists[path] || lists[path].error) load(path);
      }
      return next;
    });
  }

  // ---- Tick state ----

  const rootFor = (p, list = roots) => list.find((r) => t.same(r.path, p) || t.under(p, r.path));

  function stateOf(p) {
    const r = rootFor(p);
    if (r) {
      const ex = r.excluded.find((e) => t.same(e, p) || t.under(p, e));
      if (ex) return t.same(ex, p) ? "off" : "blocked"; // blocked: a folder above it is skipped
      return r.excluded.some((e) => t.under(e, p)) ? "partial" : "on";
    }
    return roots.some((x) => t.under(x.path, p)) ? "partial" : "off";
  }

  function addRoot(list, p) {
    const before = initial.find((r) => t.same(r.path, p));
    return [
      ...list.filter((x) => !t.under(x.path, p)), // folders inside it are now covered by it
      { path: p, folderId: before?.folderId ?? null, name: before?.name, patterns: before?.patterns ?? [], excluded: [] },
    ];
  }

  function toggle(p) {
    const state = stateOf(p);
    if (state === "blocked") return;
    setRoots((list) => {
      const r = rootFor(p, list);
      const update = (fn) => list.map((x) => (x === r ? { ...x, excluded: fn(x.excluded) } : x));
      if (state === "on") {
        if (t.same(r.path, p)) return list.filter((x) => x !== r);
        return update((ex) => [...ex.filter((e) => !t.under(e, p)), p]);
      }
      if (state === "partial") {
        if (r) return update((ex) => ex.filter((e) => !t.under(e, p)));
        return addRoot(list, p);
      }
      // off
      if (r) return update((ex) => ex.filter((e) => !t.same(e, p)));
      return addRoot(list, p);
    });
  }

  // ---- What changes on save ----

  const excludesOf = (r) => [...r.patterns, ...r.excluded.map((e) => `/${t.rel(e, r.path)}`)];
  const changes = useMemo(() => {
    const remove = initial.filter((i) => !roots.some((r) => r.folderId === i.folderId));
    const add = roots.filter((r) => !r.folderId);
    const update = roots.filter((r) => {
      if (!r.folderId) return false;
      const before = initial.find((i) => i.folderId === r.folderId);
      return JSON.stringify(excludesOf(before)) !== JSON.stringify(excludesOf(r));
    });
    return { remove, add, update };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots, initial]);
  const changeCount = changes.remove.length + changes.add.length + changes.update.length;
  const tooMany = roots.find((r) => excludesOf(r).length > MAX_EXCLUDES);
  const usesSubFolderSkips = roots.some((r) => r.excluded.length > 0);
  const agentTooOld = usesSubFolderSkips && !versionAtLeast(device.agentVersion, "0.10.0");

  async function save() {
    setSaving(true);
    setError("");
    try {
      // Removals first, so a bigger folder can replace the smaller ones inside it
      for (const r of changes.remove) await api.post(`/devices/${device.id}/folders/${r.folderId}/remove`);
      for (const r of changes.update) await api.post(`/devices/${device.id}/folders/${r.folderId}/excludes`, { excludes: excludesOf(r) });
      for (const r of changes.add) await api.post(`/devices/${device.id}/folders`, { path: r.path, excludes: excludesOf(r) });
      onSaved();
    } catch (err) {
      setError(`${err.message} Some changes may already be saved — the list on the page shows what's backed up now.`);
      setSaving(false);
    }
  }

  // ---- Tree ----

  // A plain render function (not a component), so rows keep their focus when ticks change
  function renderNode(entry, depth, isArea = false) {
    const p = entry.path;
    const state = stateOf(p);
    const expanded = open.has(p);
    const list = lists[p];
    const r = rootFor(p);
    const isRoot = r && t.same(r.path, p);
    let tag = null;
    if (isRoot && r.folderId) tag = <span className="text-xs text-good">Backed up</span>;
    else if (isRoot) tag = <span className="text-xs text-signal">New</span>;
    else if (state === "off" && r) tag = <span className="text-xs text-warn">Skipped</span>;
    const Icon = isArea ? HardDrive : Folder;

    return (
      <li key={p}>
        <div className="flex items-center gap-2 py-1.5 pr-3 hover:bg-raised/50" style={{ paddingLeft: `${depth * 20 + 8}px` }}>
          <button
            type="button"
            aria-label={expanded ? `Close ${entry.name}` : `Open ${entry.name}`}
            aria-expanded={expanded}
            onClick={() => toggleOpen(p)}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dim hover:bg-raised hover:text-fg"
          >
            <ChevronRight size={15} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
          </button>
          <Checkbox
            state={state === "blocked" ? "off" : state}
            disabled={state === "blocked" || saving}
            onChange={() => toggle(p)}
            label={`Back up ${entry.name}`}
          />
          <Icon size={15} className="shrink-0 text-dim" aria-hidden="true" />
          <button
            type="button"
            onClick={() => toggleOpen(p)}
            className={`min-w-0 flex-1 truncate text-left ${isArea ? "font-mono text-sm" : "text-sm"} ${
              state === "blocked" ? "text-dim" : "text-fg"
            }`}
            title={p}
          >
            {entry.name}
          </button>
          {tag}
        </div>
        {expanded && (
          <div>
            {(!list || list.loading) && (
              <p className="flex items-center gap-2 py-1.5 text-sm text-dim" style={{ paddingLeft: `${(depth + 1) * 20 + 40}px` }}>
                <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> Asking the device…
              </p>
            )}
            {list?.error && (
              <p className="py-1.5 text-sm text-alert" style={{ paddingLeft: `${(depth + 1) * 20 + 40}px` }}>
                {list.error}{" "}
                <button type="button" className="underline" onClick={() => load(p)}>
                  Try again
                </button>
              </p>
            )}
            {list?.entries?.length === 0 && (
              <p className="py-1.5 text-sm text-dim" style={{ paddingLeft: `${(depth + 1) * 20 + 40}px` }}>
                No folders inside
              </p>
            )}
            {list?.entries?.length > 0 && (
              <ul>
                {list.entries.map((e) => renderNode(e, depth + 1))}
              </ul>
            )}
            {list?.truncated && (
              <p className="py-1.5 text-xs text-dim" style={{ paddingLeft: `${(depth + 1) * 20 + 40}px` }}>
                Showing the first 1,000 folders.
              </p>
            )}
          </div>
        )}
      </li>
    );
  }

  const areas = lists[""];

  // ---- Review step ----
  if (reviewing) {
    const nameOf = (p) => p.split(t.sep).filter(Boolean).pop() || p;
    return (
      <Modal
        title="Save these changes?"
        onClose={onClose}
        wide
        footer={
          <>
            <button type="button" className={secondaryButton} onClick={() => setReviewing(false)} disabled={saving}>
              Back
            </button>
            <button type="button" className={primaryButton} onClick={save} disabled={saving}>
              {saving && <LoaderCircle size={16} className="animate-spin" />}
              {saving ? "Saving" : "Save"}
            </button>
          </>
        }
      >
        <div className="space-y-5 text-sm">
          {changes.add.length > 0 && (
            <section>
              <h3 className="font-medium text-fg">Start backing up</h3>
              <ul className="mt-1.5 space-y-1">
                {changes.add.map((r) => (
                  <li key={r.path}>
                    <span className="break-all font-mono text-good">{r.path}</span>
                    {r.excluded.length > 0 && <span className="text-dim"> — skipping {r.excluded.map(nameOf).join(", ")}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {changes.update.length > 0 && (
            <section>
              <h3 className="font-medium text-fg">Change what&rsquo;s skipped</h3>
              <ul className="mt-1.5 space-y-1">
                {changes.update.map((r) => (
                  <li key={r.path}>
                    <span className="break-all font-mono text-fg">{r.path}</span>
                    <span className="text-dim">
                      {" "}
                      — {r.excluded.length ? `skipping ${r.excluded.map(nameOf).join(", ")}` : "nothing skipped"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {changes.remove.length > 0 && (
            <section>
              <h3 className="font-medium text-fg">Stop backing up</h3>
              <ul className="mt-1.5 space-y-1">
                {changes.remove.map((r) => (
                  <li key={r.folderId} className="break-all font-mono text-warn">
                    {r.path}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-dim">Nothing is deleted on the device, and everything already backed up is kept and can still be restored.</p>
            </section>
          )}
          <p className="text-dim">
            Skipped folders stop being backed up from now on; their earlier backups are kept. The device applies the changes within
            a few seconds.
          </p>
          {error && <p className="rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-alert">{error}</p>}
        </div>
      </Modal>
    );
  }

  // ---- Tree step ----
  return (
    <Modal
      title={`Choose what to back up on ${device.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="mr-auto hidden self-center text-sm text-dim sm:block">
            {changeCount === 0 ? "No changes yet" : `${changeCount} change${changeCount === 1 ? "" : "s"}`}
          </span>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={changeCount === 0 || !!tooMany}
            onClick={() => setReviewing(true)}
          >
            Review changes
          </button>
        </>
      }
    >
      <div className="text-sm">
        <p className="mb-3 text-dim">
          Tick a folder to back it up with everything inside it. Open it and untick a sub-folder to skip just that one.
        </p>

        <div className="max-h-[55dvh] overflow-y-auto rounded-md border border-edge bg-night/40 py-1">
          {(!areas || areas.loading) && (
            <p className="flex items-center gap-2 px-4 py-3 text-dim">
              <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> Asking the device for its folders…
            </p>
          )}
          {areas?.error && (
            <p className="px-4 py-3 text-alert">
              {areas.error}{" "}
              <button type="button" className="underline" onClick={() => load("")}>
                Try again
              </button>
            </p>
          )}
          {areas?.entries && (
            <ul>
              {areas.entries.map((e) => renderNode(e, 0, true))}
            </ul>
          )}
        </div>

        <p className="mt-3 text-dim">
          The top level shows the allowed areas: the only places this device lets the gateway back up. They&rsquo;re set on the
          device itself.
        </p>
        {agentTooOld && (
          <p className="mt-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-warn">
            This device runs agent {device.agentVersion ?? "(unknown)"}, which can&rsquo;t skip single sub-folders yet — they would
            still be backed up. Update the agent to 0.10 or newer first.
          </p>
        )}
        {tooMany && (
          <p className="mt-3 text-alert">
            &ldquo;{tooMany.path}&rdquo; has more than {MAX_EXCLUDES} skipped sub-folders. Tick fewer folders above it instead.
          </p>
        )}
      </div>
    </Modal>
  );
}
