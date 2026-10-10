// Every backed-up version of one file, newest first. Pick one to restore it.
// Versions held by the quarantine engine are shown with the reason, but can't be restored
// until they're released on the Quarantine page.

import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../api.js";
import { formatDateTime, formatSize } from "../format.js";
import Modal from "./Modal.jsx";
import LoadState from "./LoadState.jsx";
import { secondaryButton } from "./buttons.js";

const STATUS_LABEL = {
  quarantined: { text: "Quarantined", className: "text-series-quarantine" },
  rejected: { text: "Rejected", className: "text-alert" },
};

export default function VersionsModal({ deviceId, path, onRestore, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .get(`/devices/${deviceId}/versions?path=${encodeURIComponent(path)}`)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [deviceId, path]);

  const held = data?.versions.some((v) => v.status === "quarantined");

  return (
    <Modal title="Versions" onClose={onClose}>
      <p className="mb-4 break-all font-mono text-sm text-fg">{path}</p>
      {!data ? (
        <LoadState loading={!error} error={error} />
      ) : (
        <>
          <ul className="-mx-5 divide-y divide-edge border-y border-edge">
            {data.versions.map((v) => {
              const status = STATUS_LABEL[v.status];
              return (
                <li key={v.versionNo} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className={`text-sm ${status ? "text-dim" : "text-fg"}`}>
                      Version {v.versionNo}
                      {v.type === "deleted" && <span className="ml-2 text-series-delete">deleted</span>}
                      {status && <span className={`ml-2 font-medium ${status.className}`}>{status.text}</span>}
                    </p>
                    <p className="text-xs text-dim">
                      {formatDateTime(v.backedUpAt)}
                      {v.type !== "deleted" && `, ${formatSize(v.size)}`}
                    </p>
                    {status && v.reasons.length > 0 && <p className="mt-0.5 text-xs text-dim">{v.reasons.join(" · ")}</p>}
                    {v.sha256 && (
                      <p className="truncate font-mono text-xs text-dim" title={`SHA-256 ${v.sha256}`}>
                        {v.sha256.slice(0, 16)}
                      </p>
                    )}
                  </div>
                  {v.type !== "deleted" && !status && (
                    <button type="button" className={secondaryButton} onClick={() => onRestore(v.versionNo)}>
                      Restore
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {held && (
            <p className="mt-4 text-sm text-dim">
              Quarantined versions are never restored or used as the latest backup. Review them on the{" "}
              <Link to="/quarantine" className="text-signal underline-offset-2 hover:underline" onClick={onClose}>
                Quarantine
              </Link>{" "}
              page.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}