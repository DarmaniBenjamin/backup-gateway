// Every backed-up version of one file, newest first. Pick one to restore it.

import { useEffect, useState } from "react";
import { api } from "../api.js";
import { formatDateTime, formatSize } from "../format.js";
import Modal from "./Modal.jsx";
import LoadState from "./LoadState.jsx";
import { secondaryButton } from "./buttons.js";

export default function VersionsModal({ deviceId, path, onRestore, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .get(`/devices/${deviceId}/versions?path=${encodeURIComponent(path)}`)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [deviceId, path]);

  return (
    <Modal title="Versions" onClose={onClose}>
      <p className="mb-4 break-all font-mono text-sm text-fg">{path}</p>
      {!data ? (
        <LoadState loading={!error} error={error} />
      ) : (
        <ul className="-mx-5 divide-y divide-edge border-y border-edge">
          {data.versions.map((v) => (
            <li key={v.versionNo} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <p className="text-sm text-fg">
                  Version {v.versionNo}
                  {v.type === "deleted" && <span className="ml-2 text-series-delete">deleted</span>}
                </p>
                <p className="text-xs text-dim">
                  {formatDateTime(v.backedUpAt)}
                  {v.type !== "deleted" && `, ${formatSize(v.size)}`}
                </p>
                {v.sha256 && (
                  <p className="truncate font-mono text-xs text-dim" title={`SHA-256 ${v.sha256}`}>
                    {v.sha256.slice(0, 16)}
                  </p>
                )}
              </div>
              {v.type !== "deleted" && (
                <button type="button" className={secondaryButton} onClick={() => onRestore(v.versionNo)}>
                  Restore
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}