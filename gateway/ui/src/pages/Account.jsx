// Account: two-factor login (gateway/src/admin/totp.js). Turning it on: password, then scan the QR
// code with an authenticator app, then type its code. Then 10 recovery codes are shown once, for a
// lost phone. Turning it off, or making new recovery codes, needs the password and a code.

import { useEffect, useState } from "react";
import qrcode from "qrcode-generator";
import { Check, Copy, ExternalLink, KeyRound, LoaderCircle, Monitor, ShieldCheck, ShieldOff, TriangleAlert } from "lucide-react";
import { api } from "../api.js";
import { useAuth } from "../auth-context.js";
import PageHeader from "../components/PageHeader.jsx";
import { inputClass, primaryButton, secondaryButton } from "../components/buttons.js";

// The QR code as SVG squares (no images, no outside scripts)
function QrCode({ text }) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const cells = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) cells.push(`M${c + 2} ${r + 2}h1v1h-1z`);
  return (
    <svg viewBox={`0 0 ${n + 4} ${n + 4}`} className="h-52 w-52 rounded-md bg-white" role="img" aria-label="QR code to scan with your authenticator app">
      <path d={cells.join("")} fill="#000" />
    </svg>
  );
}

function CopyText({ text, label }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`${secondaryButton} w-full justify-center sm:w-auto`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // clipboard not allowed: the text is on screen to copy by hand
        }
      }}
    >
      {copied ? <Check size={16} className="text-good" /> : <Copy size={16} />}
      {copied ? "Copied" : label}
    </button>
  );
}

const codeInput = `${inputClass} max-w-[12rem] text-center font-mono text-lg tracking-[0.3em]`;

function RecoveryCodes({ codes, onDone }) {
  return (
    <div className="space-y-4">
      <div className="flex gap-2.5 rounded-md border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
        <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <p>Save these recovery codes now, somewhere other than your phone (a password manager, or printed). They&rsquo;re shown only once. Each one signs you in once if you lose your phone.</p>
      </div>
      <ul className="grid grid-cols-2 gap-2 rounded-md border border-edge bg-night p-4 font-mono text-sm text-fg sm:grid-cols-5">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-col gap-2 sm:flex-row">
        <CopyText text={codes.join("\n")} label="Copy the codes" />
        <button type="button" className={`${primaryButton} w-full justify-center sm:w-auto`} onClick={onDone}>
          I&rsquo;ve saved them
        </button>
      </div>
    </div>
  );
}

// onCodes: two-factor is on, with these recovery codes to show (the page shows them, already "on")
function TurnOn({ onCodes }) {
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!setup)
    return (
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), run(async () => setSetup(await api.post("/me/2fa/start", { password }))))}>
        <label className="block text-sm">
          <span className="mb-1.5 block text-fg">Your password</span>
          <input className={`${inputClass} max-w-sm`} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="text-sm text-alert">{error}</p>}
        <button type="submit" className={`${primaryButton} w-full justify-center sm:w-auto`} disabled={busy || !password}>
          {busy ? <LoaderCircle size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
          Set up two-factor login
        </button>
      </form>
    );

  return (
    <form className="space-y-5" onSubmit={(e) => (e.preventDefault(), run(async () => onCodes((await api.post("/me/2fa/confirm", { code })).recoveryCodes)))}>
      <ol className="space-y-5 text-sm">
        <li>
          <p className="text-fg">1. Scan this with an authenticator app</p>
          <p className="mt-1 text-dim">Google Authenticator, Microsoft Authenticator, 1Password, Authy… On this phone? Tap the button instead.</p>
          <div className="mt-3 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <QrCode text={setup.otpauth} />
            <div className="w-full min-w-0 space-y-2 sm:w-auto">
              <a href={setup.otpauth} className={`${secondaryButton} w-full justify-center sm:w-auto`}>
                <KeyRound size={16} />
                Open in authenticator app
              </a>
              <p className="text-xs text-dim">Or type this key into the app:</p>
              <p className="break-all font-mono text-xs text-fg">{setup.secret.match(/.{1,4}/g).join(" ")}</p>
            </div>
          </div>
        </li>
        <li>
          <label className="block">
            <span className="text-fg">2. Type the 6-digit code it shows</span>
            <input
              className={`${codeInput} mt-2`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              required
            />
          </label>
        </li>
      </ol>
      {error && <p className="text-sm text-alert">{error}</p>}
      <button type="submit" className={`${primaryButton} w-full justify-center sm:w-auto`} disabled={busy || code.length !== 6}>
        {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Check size={16} />}
        Turn on
      </button>
    </form>
  );
}

// Needs the password and a code: turning off, or new recovery codes
function WithCode({ path, label, icon: Icon, danger = false, onDone }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          onDone(await api.post(path, { password, code }));
        } catch (err) {
          setError(err.message);
          setBusy(false);
        }
      }}
    >
      <div className="flex flex-col gap-3 sm:flex-row">
        <input className={`${inputClass} sm:max-w-xs`} type="password" placeholder="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <input className={`${inputClass} sm:max-w-[10rem]`} placeholder="Code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
      </div>
      {error && <p className="text-sm text-alert">{error}</p>}
      <button type="submit" className={`${danger ? secondaryButton : primaryButton} w-full justify-center sm:w-auto`} disabled={busy || !password || !code}>
        {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Icon size={16} />}
        {label}
      </button>
    </form>
  );
}


// Your own remote-access account (gateway/src/remote.js): the same name as here, its own password.
// Remote access only opens after the gateway's own sign-in (with its two-factor), then asks for this.
function RemoteAccess({ twoFactor }) {
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState({ password: "", code: "", remotePassword: "", again: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);
  useEffect(() => {
    api.get("/remote").then(setStatus).catch(() => setStatus(null));
  }, []);
  if (!status?.installed) return null;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const mismatch = form.again && form.again !== form.remotePassword;
  return (
    <section className="glass mt-6 rounded-lg border border-edge p-5">
      <h2 className="flex items-center gap-2 font-medium">
        <Monitor size={18} aria-hidden="true" /> Remote access
      </h2>
      {!status.running ? (
        <p className="mt-1 text-sm text-dim">
          {status.domain ? `Starting${status.error ? `: ${status.error}` : "…"}` : "Turns on once Domain & SSL is set up: remote control only ever runs over https."}
        </p>
      ) : done ? (
        <div className="mt-2 space-y-3 text-sm">
          <p className="text-good">Your remote-access password is set. Sign in there as {done.user}.</p>
          <p className="text-dim">It only opens after you&rsquo;re signed in here (with your two-factor code), then asks for this password.</p>
          <a href={done.url} target="_blank" rel="noopener noreferrer" className={`${primaryButton} w-full justify-center sm:w-auto`}>
            <ExternalLink size={16} aria-hidden="true" /> Open remote access
          </a>
        </div>
      ) : (
        <form
          className="mt-3 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              setDone(await api.post("/me/remote-password", form));
            } catch (err) {
              setError(err.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="text-sm text-dim">
            Remote desktop, terminal and files sign in with their own password, so a stolen gateway password alone can&rsquo;t take over a
            client&rsquo;s computer. Set or change yours here.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <input className={inputClass} type="password" placeholder="New remote-access password (12+ characters)" autoComplete="new-password" value={form.remotePassword} onChange={set("remotePassword")} required />
            <input className={inputClass} type="password" placeholder="The same again" autoComplete="new-password" value={form.again} onChange={set("again")} required />
          </div>
          <p className="text-xs text-dim">To confirm it&rsquo;s you:</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <input className={inputClass} type="password" placeholder="Your gateway password" autoComplete="current-password" value={form.password} onChange={set("password")} required />
            {twoFactor && <input className={inputClass} placeholder="Two-factor code" inputMode="numeric" autoComplete="one-time-code" value={form.code} onChange={set("code")} required />}
          </div>
          {mismatch && <p className="text-sm text-warn">The two passwords aren&rsquo;t the same.</p>}
          {error && <p className="text-sm text-alert">{error}</p>}
          <button type="submit" className={`${primaryButton} w-full justify-center sm:w-auto`} disabled={busy || mismatch || form.remotePassword.length < 12 || !form.password}>
            {busy ? <LoaderCircle size={16} className="animate-spin" /> : <KeyRound size={16} />}
            Set remote-access password
          </button>
        </form>
      )}
    </section>
  );
}

export default function Account() {
  const { user, refresh } = useAuth();
  const [mode, setMode] = useState(null); // "codes" | "off"
  const [codes, setCodes] = useState(null);
  const on = !!user?.twoFactor;

  return (
    <div className="w-full max-w-3xl">
      <PageHeader title="Account">Signed in as {user?.username}.</PageHeader>
      <section className="glass rounded-lg border border-edge p-5">
        <h2 className="flex items-center gap-2 font-medium">
          {on ? <ShieldCheck size={18} className="text-good" aria-hidden="true" /> : <ShieldOff size={18} className="text-warn" aria-hidden="true" />}
          Two-factor login {on ? <span className="text-good">is on</span> : <span className="text-warn">is off</span>}
        </h2>
        <p className="mt-1 text-sm text-dim">
          {on
            ? `Signing in needs your password and a code from your phone. ${user.recoveryCodesLeft} recovery code${user.recoveryCodesLeft === 1 ? "" : "s"} left.`
            : "With it on, signing in needs your password and a code from an app on your phone, so a stolen or guessed password alone gets nobody in."}
        </p>
        <div className="mt-5">
          {codes ? (
            <RecoveryCodes codes={codes} onDone={() => (setCodes(null), setMode(null))} />
          ) : !on ? (
            <TurnOn onCodes={(c) => (setCodes(c), refresh())} />
          ) : mode === "codes" ? (
            <WithCode path="/me/2fa/recovery-codes" label="Make new recovery codes" icon={KeyRound} onDone={(r) => setCodes(r.recoveryCodes)} />
          ) : mode === "off" ? (
            <WithCode path="/me/2fa/disable" label="Turn off two-factor login" icon={ShieldOff} danger onDone={() => (setMode(null), refresh())} />
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:flex">
              <button type="button" className={`${secondaryButton} justify-center`} onClick={() => setMode("codes")}>
                <KeyRound size={16} />
                New recovery codes
              </button>
              <button type="button" className={`${secondaryButton} justify-center`} onClick={() => setMode("off")}>
                <ShieldOff size={16} />
                Turn off
              </button>
            </div>
          )}
        </div>
      </section>
      <RemoteAccess twoFactor={on} />
      <p className="mt-4 text-xs text-dim">
        Lost your phone and the recovery codes? On the server, run <code className="font-mono text-fg">sudo npm run reset-2fa -- {user?.username}</code> in the gateway folder.
      </p>
    </div>
  );
}
