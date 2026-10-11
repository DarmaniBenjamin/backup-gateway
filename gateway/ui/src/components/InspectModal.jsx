// Inspect a quarantined file safely: what it really is compared with its last good version,
// a preview of its first bytes as plain text or a hex dump, and its SHA-256 for a VirusTotal
// lookup. The gateway decrypts the start of the file in memory; nothing is opened, rendered,
// run or downloaded, so even real malware can't do anything here.

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { api } from "../api.js";
import { formatDateTime, formatSize } from "../format.js";
import Modal from "./Modal.jsx";
import LoadState from "./LoadState.jsx";
import { primaryButton, secondaryButton } from "./buttons.js";

const dangerButton =
  "inline-flex h-10 items-center justify-center gap-2 rounded-md bg-alert px-4 text-sm font-medium text-night " +
  "transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

function Row({ label, held, good, tone }) {
  return (
    <>
      <dt className="text-dim">{label}</dt>
      <dd className={`min-w-0 break-words ${tone ?? "text-fg"}`}>{held}</dd>
      <dd className="min-w-0 break-words text-fg">{good ?? <span className="text-dim">—</span>}</dd>
    </>
  );
}

function randomness(e) {
  if (e == null) return null;
  return `${e.toFixed(2)} of 8${e >= 7.5 ? " (looks encrypted)" : ""}`;
}

function Preview({ title, preview }) {
  if (!preview) return null;
  return (
    <section>
      <h3 className="mb-1.5 text-sm text-dim">
        {title}: {preview.kind === "text" ? "as text" : "as a hex dump"}
        {preview.truncated && " (start of the file only)"}
      </h3>
      <pre className="max-h-64 overflow-auto whitespace-pre rounded-md border border-edge bg-night/80 p-3 font-mono text-xs leading-relaxed text-fg">
        {preview.text}
      </pre>
    </section>
  );
}

export default function InspectModal({ id, onClose, onDecide }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get(`/quarantine/${id}/inspect`).then(setData).catch((err) => setError(err.message));
  }, [id]);

  const held = data?.held;
  const good = data?.lastGood;
  const changedType = held && good && held.contentType !== good.contentType;

  return (
    <Modal
      title="Inspect quarantined file"
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Close
          </button>
          <button type="button" className={primaryButton} disabled={!data} onClick={() => onDecide("release", id)}>
            Release
          </button>
          <button type="button" className={dangerButton} disabled={!data} onClick={() => onDecide("reject", id)}>
            Reject
          </button>
        </>
      }
    >
      {!data ? (
        <LoadState loading={!error} error={error} />
      ) : (
        <div className="space-y-6 text-sm">
          <div>
            <p className="break-all font-mono text-fg">{data.path}</p>
            <p className="mt-1 text-dim">
              {data.device} ({data.client})
            </p>
            {held.reasons.length > 0 && (
              <p className="mt-2 flex flex-wrap gap-1.5">
                {held.reasons.map((r) => (
                  <span key={r} className="rounded border border-warn/40 px-1.5 py-0.5 text-xs text-warn">
                    {r}
                  </span>
                ))}
              </p>
            )}
          </div>

          <dl className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] gap-x-5 gap-y-2.5">
            <dt />
            <dd className="text-xs text-warn">This version (held, v{held.versionNo})</dd>
            <dd className="text-xs text-good">{good ? `Last good version (v${good.versionNo})` : "Last good version"}</dd>
            <Row
              label="What it really is"
              held={held.contentType}
              good={good?.contentType}
              tone={changedType ? "font-semibold text-alert" : undefined}
            />
            <Row label="Size" held={held.type === "deleted" ? "—" : formatSize(held.size)} good={good && formatSize(good.size)} />
            <Row label="Randomness" held={randomness(held.entropy) ?? "—"} good={good && randomness(good.entropy)} />
            <Row label="Backed up" held={formatDateTime(held.receivedAt)} good={good && formatDateTime(good.receivedAt)} />
          </dl>
          {changedType && (
            <p className="rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-alert">
              The content changed type: it was &ldquo;{good.contentType}&rdquo; and is now &ldquo;{held.contentType}&rdquo;. That is
              what ransomware encryption looks like. Unless you know why, reject it.
            </p>
          )}
          {!good && <p className="text-dim">There is no earlier good version of this file to compare with.</p>}

          {held.sha256 && (
            <div>
              <p className="text-dim">SHA-256 fingerprint</p>
              <p className="mt-1 break-all font-mono text-xs text-secure">{held.sha256}</p>
              <a
                href={`https://www.virustotal.com/gui/file/${held.sha256}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 text-signal hover:underline"
              >
                Look it up on VirusTotal
                <ExternalLink size={14} aria-hidden="true" />
              </a>
              <p className="mt-1 text-xs text-dim">Only the fingerprint is sent, never the file. &ldquo;Not found&rdquo; is normal for ordinary documents.</p>
            </div>
          )}

          {held.type === "deleted" ? (
            <p className="text-dim">This is a deletion record: the file was deleted on the device, so there is no content to show.</p>
          ) : (
            <>
              <Preview title="This version" preview={data.preview} />
              <Preview title="Last good version" preview={data.lastGoodPreview} />
              <p className="text-xs text-dim">
                Shown as plain characters only. Nothing in the file is opened or run, and it isn&rsquo;t downloaded. Each inspection
                is recorded in the audit log.
              </p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
