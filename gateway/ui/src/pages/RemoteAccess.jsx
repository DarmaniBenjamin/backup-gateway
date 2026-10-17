// Remote access (gateway/src/remote.js): its own page in the main menu. Set your remote-access
// password, open remote access, and see which version of the gateway is running.

import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../api.js";
import { useAuth } from "../auth-context.js";
import PageHeader from "../components/PageHeader.jsx";
import { RemoteAccess } from "./Account.jsx";

export default function RemoteAccessPage() {
  const { user } = useAuth();
  const [version, setVersion] = useState(null);
  useEffect(() => {
    api.get("/version").then(setVersion).catch(() => setVersion(null));
  }, []);
  return (
    <div className="w-full max-w-3xl">
      <PageHeader title="Remote access">
        Desktop, terminal and files for your devices, in the browser. Open a device from its own page on{" "}
        <Link to="/devices" className="-my-2 inline-block py-2 text-signal hover:underline">
          Devices
        </Link>{" "}
        (Open desktop, Open terminal, Files).
      </PageHeader>
      <RemoteAccess twoFactor={!!user?.twoFactor} />
      <section className="mt-6 text-sm text-dim">
        <h2 className="mb-1 font-medium text-fg">How signing in works</h2>
        <p>
          Remote access only opens once you&rsquo;re signed in here (with your two-factor code). Then it asks for your own remote-access
          account: your username here ({user?.username}) and the remote-access password you set above. It&rsquo;s not the password of the
          computer you&rsquo;re connecting to; if that computer is locked, its own login screen shows inside the remote desktop.
        </p>
      </section>
      {version && (
        <p className="mt-6 text-xs text-dim">
          Gateway version {version.commit ?? "unknown"}
          {version.agent ? `, agent ${version.agent}` : ""}
        </p>
      )}
    </div>
  );
}
