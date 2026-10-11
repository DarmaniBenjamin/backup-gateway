// Off-site copies. The failsafe: one place (a Backblaze/S3 bucket with Object Lock, or a Google
// Drive) that gets everything from every device. Each device can also have its own copies (its own
// bucket, its own Google Drive), set up on the device's page; they're all listed here too.
// One recovery key opens every copy.

import { useState } from "react";
import { Link } from "react-router";
import { Check, Cloud, HardDrive, Lock, ShieldCheck } from "lucide-react";
import { usePolling } from "../usePolling.js";
import { timeAgo } from "../format.js";
import PageHeader from "../components/PageHeader.jsx";
import LoadState from "../components/LoadState.jsx";
import { CopyCard, DriveReturn, DriveSignIn, GoogleSetup, Note, RecoveryKeyDialog, S3Form, useDriveReturn } from "../components/OffsiteParts.jsx";

function copyLine(c) {
  if (c.paused) return { text: "Paused", tone: "text-warn" };
  if (c.lastError) return { text: c.lastError.message, tone: "text-alert" };
  if (c.running || c.pending?.chunks) return { text: "Sending", tone: "text-secure" };
  if (c.lastSuccessAt) return { text: `Up to date, ${timeAgo(c.lastSuccessAt)}`, tone: "text-good" };
  if (c.uploaded.chunks > 0) return { text: "Checking", tone: "text-dim" };
  return { text: "Starting", tone: "text-dim" };
}

function SetUpFailsafe({ google, onConnected }) {
  const [kind, setKind] = useState("s3");
  return (
    <div>
      <div className="mb-5 inline-flex rounded-md border border-edge p-1" role="tablist" aria-label="Where the failsafe copy goes">
        {[
          ["s3", "Backblaze / S3 bucket", HardDrive],
          ["drive", "Google Drive", Cloud],
        ].map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={kind === id}
            onClick={() => setKind(id)}
            className={`inline-flex items-center gap-2 rounded px-3 py-1.5 text-sm ${kind === id ? "bg-signal text-signal-ink" : "text-dim hover:text-fg"}`}
          >
            <Icon size={16} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
      {kind === "s3" ? (
        <S3Form onConnected={onConnected} />
      ) : (
        <>
          <p className="mb-4 max-w-2xl text-sm text-dim">
            Google Drive can&rsquo;t lock files, so someone who gets into that Google account could delete them. A Backblaze bucket
            with Object Lock is the safer failsafe; Drive works well as a device&rsquo;s own extra copy.
          </p>
          <DriveSignIn google={google} />
        </>
      )}
    </div>
  );
}

// Google sign-in setup: collapsed once it's done
function GoogleSection({ google, onSaved }) {
  const [open, setOpen] = useState(() => window.location.hash === "#google-setup" || !google.configured);
  return (
    <section id="google-setup" className="scroll-mt-6">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-2 font-medium">
          <Cloud size={18} className="text-dim" aria-hidden="true" />
          Google sign-in setup
        </h2>
        {google.configured ? (
          <span className="inline-flex items-center gap-1 text-sm text-good">
            <Check size={14} aria-hidden="true" /> Set up{google.picker ? ", with folder picking" : ""}
          </span>
        ) : (
          <span className="text-sm text-dim">Not set up yet</span>
        )}
        {google.configured && (
          <button type="button" className="text-sm text-dim underline hover:text-fg" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Change"}
          </button>
        )}
      </div>
      <p className="mb-4 max-w-2xl text-sm text-dim">
        Needed once for Google Drive copies. After that, adding a Drive is just signing in to the Google account and choosing the folder.
      </p>
      {open && <GoogleSetup google={google} onSaved={onSaved} />}
    </section>
  );
}

export default function Offsite() {
  const { data, error, loading, reload } = usePolling("/cloud", 4000);
  const [connected, setConnected] = useState(null); // recovery key from connecting a bucket, shown once
  const { note, choose } = useDriveReturn();

  return (
    <div className="w-full">
      <PageHeader title="Off-site">
        Copies of the backups away from this gateway: a failsafe with everything, and each device&rsquo;s own if it has any.
      </PageHeader>
      <Note note={note} />
      <DriveReturn choose={choose} onChanged={reload} />
      {!data ? (
        <LoadState loading={loading} error={error} onRetry={reload} />
      ) : (
        <div className="space-y-10">
          <section>
            <h2 className="mb-1 flex items-center gap-2 font-medium">
              <ShieldCheck size={18} className="text-good" aria-hidden="true" />
              Failsafe copy
            </h2>
            <p className="mb-4 max-w-2xl text-sm text-dim">
              Everything from every device, in one place, all the time. If anything else is lost, this is what you rebuild from.
            </p>
            {data.failsafe ? (
              <CopyCard s={data.failsafe} google={data.google} onChanged={reload} />
            ) : (
              <SetUpFailsafe
                google={data.google}
                onConnected={(result) => {
                  if (result.recoveryKey) setConnected(result);
                  reload();
                }}
              />
            )}
          </section>

          <section>
            <h2 className="mb-1 font-medium">Devices&rsquo; own copies</h2>
            <p className="mb-4 max-w-2xl text-sm text-dim">
              Add these on a device&rsquo;s page: its own Backblaze bucket (with its own key) or its own Google Drive. Each backup
              folder there picks which of them it goes to.
            </p>
            {data.copies.length === 0 ? (
              <p className="rounded-lg border border-dashed border-edge px-5 py-6 text-sm text-dim">
                No device has its own copy yet. Open a device from <Link to="/devices" className="text-signal hover:underline">Devices</Link>{" "}
                to add one.
              </p>
            ) : (
              <ul className="divide-y divide-edge rounded-lg border border-edge bg-surface">
                {data.copies.map((c) => {
                  const line = copyLine(c);
                  return (
                    <li key={c.id} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:gap-4">
                      <Link to={`/devices/${c.deviceId}`} className="min-w-0 font-medium text-fg hover:text-signal sm:w-56">
                        <span className="block truncate">{c.deviceName}</span>
                        <span className="block truncate text-xs font-normal text-dim">{c.client}</span>
                      </Link>
                      <span className="min-w-0 flex-1 text-sm">
                        {c.kind === "s3" ? c.providerLabel : "Google Drive"}{" "}
                        <span className="break-all font-mono text-dim">{c.kind === "s3" ? c.bucket : c.email}</span>
                        {c.kind === "drive" && c.folderName && <span className="text-dim"> / {c.folderName}</span>}
                      </span>
                      <span className={`text-sm ${line.tone}`}>{line.text}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <GoogleSection google={data.google} onSaved={reload} />

          {data.recoveryFingerprint && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 font-medium">
                <Lock size={16} className="text-secure" aria-hidden="true" />
                If this gateway is ever lost
              </h2>
              <div className="glass max-w-3xl space-y-3 rounded-lg border border-edge p-5 text-sm text-dim">
                <p>
                  Every copy opens with the same recovery key (fingerprint{" "}
                  <span className="font-mono text-fg">{data.recoveryFingerprint}</span>). On a new gateway, from the{" "}
                  <span className="font-mono text-fg">gateway</span> folder:
                </p>
                <pre className="overflow-x-auto rounded-md border border-edge bg-night px-3 py-2 font-mono text-xs text-fg">
                  {`# from a bucket (the failsafe, or a device's own)\nnpm run recover -- --endpoint ENDPOINT --bucket BUCKET --key-id KEY-ID --to ./data\n\n# from a Google Drive copy: download its "Backup Gateway - …" folder, unzip it, then\nnpm run recover -- --from-folder PATH-TO-THAT-FOLDER --to ./data`}
                </pre>
                <p>
                  It asks for the bucket&rsquo;s application key (buckets only) and the recovery key, then gets and checks every
                  backup. A device&rsquo;s own copy rebuilds just that device.
                </p>
              </div>
            </section>
          )}
        </div>
      )}
      {connected && <RecoveryKeyDialog result={connected} onDone={() => setConnected(null)} />}
    </div>
  );
}
