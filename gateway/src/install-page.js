// The page a short install link opens in a browser on the new device (http://…:8080/i/K7Q2MX):
// the setup program to download (Windows) and the one command to paste. No scripts, and its only
// style is allowed by its hash, so the page can't run anything else.

import crypto from "node:crypto";

const STYLE = `
:root{color-scheme:dark;--bg:#0b0a1a;--card:#14132a;--edge:#2a2850;--fg:#eeeef8;--dim:#a3a2c2;--brand:#4fd1ff;--good:#3ddc97;--warn:#f5b84b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:40px 16px 56px}
h1{font-size:1.6rem;line-height:1.25;margin:0 0 6px}
h2{font-size:1.05rem;margin:28px 0 8px}
p{margin:6px 0;color:var(--dim)}
strong{color:var(--fg)}
.card{background:var(--card);border:1px solid var(--edge);border-radius:12px;padding:18px 18px 20px;margin-top:22px}
.card h2{margin-top:0}
.button{display:inline-block;margin-top:12px;padding:12px 20px;border-radius:8px;background:var(--brand);color:#06121a;font-weight:600;text-decoration:none}
.button:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
pre{margin:10px 0 0;padding:12px 14px;border-radius:8px;border:1px solid var(--edge);background:#0f0e22;color:var(--fg);white-space:pre-wrap;word-break:break-all;font:14px/1.5 ui-monospace,Consolas,monospace;user-select:all}
.file{font-family:ui-monospace,Consolas,monospace;font-size:.9em;color:var(--fg);word-break:break-all}
.note{font-size:.9rem}
.warn{color:var(--warn)}
.dead h1{color:var(--warn)}
`;
const STYLE_HASH = crypto.createHash("sha256").update(STYLE).digest("base64");
export const PAGE_CSP = `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; img-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

const PLATFORM_NAMES = { windows: "Windows PC or server", linux: "Linux PC or server", synology: "Synology NAS" };

export function installPage(link) {
  const forWho = `<p>For <strong>${esc(link.clientName)}</strong> (${esc(PLATFORM_NAMES[link.platform] ?? link.platform)}). This link works once, until ${esc(link.expires)}.</p>`;
  let body;
  if (link.platform === "windows") {
    const ps = `irm ${link.url}/win | iex`;
    body = `
<h1>${link.upgrade ? "Turn on automatic updates" : "Install the backup agent"}</h1>
${forWho}
${
  link.setupName
    ? `<div class="card">
<h2>The setup program</h2>
<p>Download it, open it, and choose <strong>Yes</strong> when Windows asks to allow changes.</p>
<a class="button" href="/i/${esc(link.short)}/setup.exe" download="${esc(link.setupName)}">Download the setup program</a>
<p class="note">Keep its name as it is: <span class="file">${esc(link.setupName)}</span>. It tells the program which install this is.</p>
<p class="note">If Windows says it protected your PC, choose <strong>More info</strong>, then <strong>Run anyway</strong>.</p>
</div>`
    : ""
}
<div class="card">
<h2>${link.setupName ? "Or paste one command" : "Paste one command"}</h2>
<p>In <strong>PowerShell opened as Administrator</strong> (right-click the Start button &gt; Terminal (Admin)):</p>
<pre>${esc(ps)}</pre>
</div>`;
  } else {
    const cmd = `curl -fsSL ${link.url}/sh | sudo bash`;
    body = `
<h1>${link.upgrade ? "Turn on automatic updates" : "Install the backup agent"}</h1>
${forWho}
<div class="card">
<h2>${link.platform === "synology" ? "Paste this in an SSH session on the NAS" : "Paste this in a terminal"}</h2>
<pre>${esc(cmd)}</pre>
<p class="note">No curl? Use <span class="file">wget -qO- ${esc(link.url)}/sh | sudo bash</span></p>
</div>`;
  }
  return page("Install the backup agent", body);
}

export function deadLinkPage() {
  return page(
    "Install link not found",
    `<div class="dead"><h1>This install link doesn't work any more</h1>
<p>It has expired, was already used, or was typed wrong. Make a new one on the gateway: <strong>Devices &gt; Add device</strong>.</p></div>`
  );
}

export function tooManyPage() {
  return page(
    "Too many tries",
    `<div class="dead"><h1>Too many wrong links</h1><p>Too many install links that don't exist were tried from this device. Wait 10 minutes, then try again.</p></div>`
  );
}
