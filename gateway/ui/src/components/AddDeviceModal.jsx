// Creates a one-time enrollment code for a new device. The code is shown once — the gateway
// only keeps a fingerprint of it — and works a single time before it expires.

import { useState } from "react";
import { Check, Copy, LoaderCircle } from "lucide-react";
import { api } from "../api.js";
import { formatDateTime } from "../format.js";
import Modal from "./Modal.jsx";
import { inputClass, primaryButton, secondaryButton } from "./buttons.js";

export default function AddDeviceModal({ clients, onClose }) {
  const [clientName, setClientName] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleCreate(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setResult(await api.post("/enrollment-codes", { clientName: clientName.trim() }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(result.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard not allowed (e.g. not on a secure address) — select the text so it can be copied by hand
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("enroll-code"));
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }
  }

  if (result) {
    return (
      <Modal title="Enrollment code" onClose={onClose} footer={<button type="button" className={primaryButton} onClick={onClose}>Done</button>}>
        <p className="text-sm text-dim">
          For <span className="text-fg">{result.clientName}</span>. Works once, until {formatDateTime(result.expiresAt)}.
        </p>
        <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-edge bg-raised px-4 py-3">
          <code id="enroll-code" className="font-mono text-xl tracking-wider text-fg">
            {result.code}
          </code>
          <button type="button" onClick={copyCode} className={secondaryButton} aria-label="Copy code">
            {copied ? <Check size={16} className="text-good" /> : <Copy size={16} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="mt-4 text-sm text-dim">On the new device, put this line in the agent&rsquo;s .env file, then start the agent:</p>
        <pre className="mt-2 overflow-x-auto rounded-md border border-edge bg-night px-3 py-2 font-mono text-sm text-fg">
          AGENT_ENROLL_CODE={result.code}
        </pre>
        <p className="mt-4 text-sm text-dim">
          The code won&rsquo;t be shown again. If you lose it, just create a new one.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Add a device"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="add-device" className={primaryButton} disabled={busy || !clientName.trim()}>
            {busy && <LoaderCircle size={16} className="animate-spin" />}
            Create code
          </button>
        </>
      }
    >
      <form id="add-device" onSubmit={handleCreate}>
        <label htmlFor="client-name" className="mb-1.5 block text-sm text-dim">
          Client
        </label>
        <input
          id="client-name"
          list="known-clients"
          autoComplete="off"
          placeholder="e.g. Law Firm"
          value={clientName}
          onChange={(e) => setClientName(e.target.value)}
          className={inputClass}
        />
        <datalist id="known-clients">
          {clients.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <p className="mt-2 text-sm text-dim">
          The device joins this client. Pick an existing client to add another device to them.
        </p>
        {error && (
          <p role="alert" className="mt-4 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}