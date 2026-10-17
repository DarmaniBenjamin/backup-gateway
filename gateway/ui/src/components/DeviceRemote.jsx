// Remote desktop, terminal and files for a device (gateway/src/remote.js): each opens in a new tab,
// straight into this device. Signing in there uses your own remote-access account (Account page).

import { Link } from "react-router";
import { FolderOpen, Monitor, SquareTerminal } from "lucide-react";
import { secondaryButton } from "./buttons.js";

export default function DeviceRemote({ remote, platform }) {
  if (!remote || platform === "synology") return null;
  const { links, status } = remote;
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
      ) : (
        <p className="text-sm text-dim">
          This device doesn&rsquo;t have remote access yet. Devices installed from now on get it with the install command.
        </p>
      )}
    </section>
  );
}
