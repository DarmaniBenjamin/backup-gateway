// A device's own off-site copies, on its page: its own Backblaze bucket (with its own key) and/or
// its own Google Drive. Which backup folders go to which copy is set on each folder above.

import { useState } from "react";
import { Cloud, HardDrive, ShieldCheck } from "lucide-react";
import Modal from "./Modal.jsx";
import { secondaryButton } from "./buttons.js";
import { CopyCard, DriveSignIn, Note, RecoveryKeyDialog, S3Form, useDriveReturn } from "./OffsiteParts.jsx";

export default function DeviceCopies({ device, offsite, onChanged }) {
  const [adding, setAdding] = useState(null); // "s3" | "drive"
  const [keyShown, setKeyShown] = useState(null);
  const note = useDriveReturn();

  return (
    <section className="mb-10">
      <h2 className="font-medium">Off-site copies</h2>
      <p className="mb-3 mt-1 max-w-2xl text-sm text-dim">
        This device&rsquo;s own copies away from the gateway.{" "}
        {offsite.failsafe ? (
          <span className="inline-flex items-center gap-1 text-good">
            <ShieldCheck size={14} aria-hidden="true" /> Everything is also in the failsafe copy.
          </span>
        ) : (
          "There's no failsafe copy yet (Off-site page)."
        )}
      </p>
      <Note note={note} />
      <div className="space-y-4">
        {offsite.copies.map((c) => (
          <CopyCard key={c.id} s={c} google={offsite.google} onChanged={onChanged} />
        ))}
      </div>
      <div className={`flex flex-wrap gap-2 ${offsite.copies.length ? "mt-4" : ""}`}>
        <button type="button" className={secondaryButton} onClick={() => setAdding("s3")}>
          <HardDrive size={16} aria-hidden="true" />
          Add a Backblaze bucket
        </button>
        <button type="button" className={secondaryButton} onClick={() => setAdding("drive")}>
          <Cloud size={16} aria-hidden="true" />
          Add a Google Drive
        </button>
      </div>

      {adding === "s3" && (
        <Modal title={`A Backblaze bucket for ${device.name}`} onClose={() => setAdding(null)} wide>
          <p className="mb-4 text-sm text-dim">
            Make a bucket and a key just for this device, so its key can only reach its own backups.
          </p>
          <S3Form
            deviceId={device.id}
            onConnected={(result) => {
              setAdding(null);
              if (result.recoveryKey) setKeyShown(result);
              onChanged();
            }}
          />
        </Modal>
      )}
      {adding === "drive" && (
        <Modal title={`A Google Drive for ${device.name}`} onClose={() => setAdding(null)} wide>
          <p className="mb-4 text-sm text-dim">
            Sign in with the Google account whose Drive should hold this device&rsquo;s copy. The gateway makes its own folder there
            and can only see the files it makes.
          </p>
          <DriveSignIn deviceId={device.id} google={offsite.google} />
        </Modal>
      )}
      {keyShown && <RecoveryKeyDialog result={keyShown} onDone={() => setKeyShown(null)} />}
    </section>
  );
}
