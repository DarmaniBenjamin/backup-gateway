// Remote desktop, terminal and files for a device (gateway/src/remote.js): each opens in a new tab,
// straight into this device. Signing in there uses your own remote-access account (Account page).

import { useState } from "react";
import { Link } from "react-router";
import { Check, Copy, FolderOpen, Monitor, SquareTerminal } from "lucide-react";
import { secondaryButton } from "./buttons.js";

// The one line that adds remote access to a device installed before it existed
function AddCommand({ add }) {
  const [copied, setCopied] = useState(false);
  const windows = add.platform === "windows";
  return (
    <div className="space-y-2">
      <p className="text-sm text-dim">
        This device was installed before remote access. To add it, run this once on the device,{" "}
        {windows ? "in PowerShell opened as Administrator" : "in a terminal (it asks for the password, for sudo)"}. Only remote access is
        added; backups aren&rsquo;t touched. The buttons appear here a minute or two after.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md border border-edge bg-night px-3 py-2.5 font-mono text-xs leading-relaxed text-fg">
          {add.command}
        </pre>
        <button
          type="button"
          className={`${secondaryButton} w-full shrink-0 justify-center sm:w-auto`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(add.command);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              // clipboard not allowed: the command is on screen to copy by hand
            }
          }}
        >
          {copied ? <Check size={16} className="text-good" /> : <Copy size={16} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export default function DeviceRemote({ remote }) {
  if (!remote || remote.synology) return null;
  const { links, status, add } = remote;
  const open = (href, Icon, label) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${secondaryButton} justify-center`}>
      <Icon size={16} aria-hidden="true" />
      {label}
    </a>
  );
  return (
    <section className="mb-8">
      <h2 className="mb-1 flex items-center gap-2 font-medium">
        <Monitor size={17} aria-hidden="true" /> Remote access
      </h2>
      {links ? (
        <>
          <p className="mb-3 text-sm text-dim">Opens in a new tab. The first time, sign in with your remote-access account.</p>
          <div className="grid grid-cols-1 gap-2 sm:flex">
            {open(links.desktop, Monitor, "Open desktop")}
            {open(links.terminal, SquareTerminal, "Open terminal")}
            {open(links.files, FolderOpen, "Files")}
          </div>
        </>
      ) : !status?.domain ? (
        <p className="text-sm text-dim">
          Remote access turns on once{" "}
          <Link to="/domain" className="text-signal hover:underline">
            Domain &amp; SSL
          </Link>{" "}
          is set up: it only ever runs over https.
        </p>
      ) : !status?.running ? (
        <p className="text-sm text-warn">Remote access is starting, or stopped{status?.error ? `: ${status.error}` : ""}.</p>
      ) : add ? (
        <AddCommand add={add} />
      ) : (
        <p className="text-sm text-dim">
          This device doesn&rsquo;t have remote access yet. Devices installed from now on get it with the install command.
        </p>
      )}
    </section>
  );
}
