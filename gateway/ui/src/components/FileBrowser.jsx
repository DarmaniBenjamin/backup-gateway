// Folders and files of one device, exactly as they were at the chosen restore point.

import { useEffect, useState } from "react";
import { ChevronRight, File, FileX, Folder, History } from "lucide-react";
import { api } from "../api.js";
import { formatDateTime, formatSize } from "../format.js";
import LoadState from "./LoadState.jsx";

export default function FileBrowser({ deviceId, at, path, onOpenFolder, onShowVersions }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setData(null);
    setError("");
    const q = new URLSearchParams({ path });
    if (at) q.set("at", at);
    api
      .get(`/devices/${deviceId}/files?${q}`)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [deviceId, at, path]);

  const parts = path ? path.split("/") : [];

  return (
    <div>
      <nav aria-label="Folder" className="mb-3 flex flex-wrap items-center gap-1 text-sm">
        <button type="button" onClick={() => onOpenFolder("")} className="rounded px-1 text-dim hover:text-fg">
          All files
        </button>
        {parts.map((name, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight size={14} className="text-dim" aria-hidden="true" />
            <button
              type="button"
              onClick={() => onOpenFolder(parts.slice(0, i + 1).join("/"))}
              className={`rounded px-1 ${i === parts.length - 1 ? "text-fg" : "text-dim hover:text-fg"}`}
            >
              {name}
            </button>
          </span>
        ))}
      </nav>

      {!data ? (
        <LoadState loading={!error} error={error} />
      ) : data.folders.length === 0 && data.files.length === 0 ? (
        <p className="rounded-lg border border-dashed border-edge px-5 py-8 text-center text-sm text-dim">
          No files were backed up here {at ? "at this point in time" : "yet"}.
        </p>
      ) : (
        <ul className="divide-y divide-edge overflow-hidden rounded-lg border border-edge bg-surface">
          {data.folders.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => onOpenFolder(f.path)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-raised"
              >
                <Folder size={18} className="shrink-0 text-dim" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="text-sm text-dim">
                  {f.files} file{f.files === 1 ? "" : "s"}, {formatSize(f.size)}
                </span>
              </button>
            </li>
          ))}
          {data.files.map((f) => (
            <li key={f.path} className="flex items-center gap-3 px-4 py-3">
              {f.deleted ? (
                <FileX size={18} className="shrink-0 text-series-delete" aria-label="Deleted" />
              ) : (
                <File size={18} className="shrink-0 text-dim" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                <p className={`truncate ${f.deleted ? "text-dim line-through" : ""}`}>{f.name}</p>
                <p className="text-xs text-dim">
                  {f.deleted ? "Deleted" : formatSize(f.size)}, backed up {formatDateTime(f.backedUpAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onShowVersions(f.path)}
                className="flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm text-dim hover:bg-raised hover:text-fg"
              >
                <History size={16} aria-hidden="true" />
                {f.versionCount} version{f.versionCount === 1 ? "" : "s"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}