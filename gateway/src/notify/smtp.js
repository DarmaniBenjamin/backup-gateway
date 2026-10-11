// A small SMTP client for alert emails (no extra packages). Works with Gmail and Google Workspace
// (an app password), Microsoft 365 (smtp.office365.com, port 587), and most mail providers or a
// local relay.
//
//   security: "tls"       encrypted from the start (usually port 465)
//             "starttls"  plain connection upgraded to TLS before logging in (usually port 587)
//             "none"      no encryption (only for a relay on your own network, usually port 25)
//
// The message is plain text, sent as base64 so any line length and character is safe.

import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import crypto from "node:crypto";

const TIMEOUT_MS = 20_000;

export class SmtpError extends Error {}

// Header values come partly from devices (file names), so line breaks are never let through
const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();
const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
export const isEmail = (s) => ADDRESS.test(String(s ?? ""));

function buildMessage({ from, fromName, to, subject, text }) {
  const body = Buffer.from(text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  const domain = from.split("@")[1] || "localhost";
  const headers = [
    `From: ${fromName ? `${encodeWord(oneLine(fromName))} <${from}>` : from}`,
    `To: ${to.join(", ")}`,
    `Subject: ${encodeWord(oneLine(subject))}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

// Reads SMTP replies ("250-..." continues, "250 ..." ends) from a socket that can be swapped for
// its TLS version halfway through
function replyReader() {
  let buffer = "";
  let waiting = null;
  let failure = null;
  function check() {
    if (!waiting) return;
    if (failure) {
      const w = waiting;
      waiting = null;
      return w.reject(failure);
    }
    const lines = buffer.split("\r\n");
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        const reply = lines.slice(0, i + 1);
        buffer = lines.slice(i + 1).join("\r\n");
        const w = waiting;
        waiting = null;
        return w.resolve({ code: Number(reply[i].slice(0, 3)), lines: reply.map((l) => l.slice(4)) });
      }
    }
  }
  return {
    feed(data) {
      buffer += data.toString("utf8");
      check();
    },
    fail(err) {
      failure ??= err;
      check();
    },
    next: () => new Promise((resolve, reject) => ((waiting = { resolve, reject }), check())),
  };
}

export async function sendMail(settings, { to, subject, text }) {
  const { host, port, security = "starttls", username, password, from, fromName } = settings;
  if (!host || !port || !from) throw new SmtpError("The mail server, port and From address are needed.");
  const reader = replyReader();
  let socket;

  const attach = (s) => {
    s.setTimeout(TIMEOUT_MS, () => s.destroy(new SmtpError(`The mail server ${host} stopped answering.`)));
    s.on("data", (d) => reader.feed(d));
    s.on("error", (err) => reader.fail(err));
    s.on("close", () => reader.fail(new SmtpError(`The mail server ${host} closed the connection.`)));
  };
  const connect = () =>
    new Promise((resolve, reject) => {
      const s = security === "tls" ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
      s.once(security === "tls" ? "secureConnect" : "connect", () => resolve(s));
      s.once("error", reject);
      s.setTimeout(TIMEOUT_MS, () => s.destroy(new SmtpError(`Couldn't connect to ${host}:${port}.`)));
    });

  async function cmd(line, expect, what) {
    if (line != null) socket.write(`${line}\r\n`);
    const r = await reader.next();
    if (!expect.includes(r.code)) {
      throw new SmtpError(`${what}: the mail server said "${r.code} ${r.lines.join(" ").slice(0, 200)}"`);
    }
    return r;
  }

  try {
    socket = await connect().catch((err) => {
      throw new SmtpError(`Couldn't connect to ${host}:${port} (${err.code || err.message}).`);
    });
    attach(socket);
    const me = os.hostname().replace(/[^\w.-]/g, "") || "backup-gateway";
    await cmd(null, [220], "Greeting");
    let ehlo = await cmd(`EHLO ${me}`, [250], "EHLO");
    if (security === "starttls") {
      if (!ehlo.lines.some((l) => /^STARTTLS/i.test(l))) throw new SmtpError("This mail server doesn't offer STARTTLS. Pick SSL/TLS or another port.");
      await cmd("STARTTLS", [220], "STARTTLS");
      socket.removeAllListeners("data");
      socket.removeAllListeners("close");
      socket.setTimeout(0);
      socket = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket, servername: host }, () => resolve(s));
        s.once("error", reject);
      }).catch((err) => {
        throw new SmtpError(`The secure connection to ${host} failed (${err.code || err.message}).`);
      });
      attach(socket);
      ehlo = await cmd(`EHLO ${me}`, [250], "EHLO");
    }
    if (username) {
      const auth = ehlo.lines.find((l) => /^AUTH[ =]/i.test(l)) ?? "";
      if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth)) {
        const token = Buffer.from(`\0${username}\0${password ?? ""}`, "utf8").toString("base64");
        await cmd(`AUTH PLAIN ${token}`, [235], "Login");
      } else {
        await cmd("AUTH LOGIN", [334], "Login");
        await cmd(Buffer.from(username, "utf8").toString("base64"), [334], "Login");
        await cmd(Buffer.from(password ?? "", "utf8").toString("base64"), [235], "Login");
      }
    }
    await cmd(`MAIL FROM:<${from}>`, [250], "Sender");
    for (const rcpt of to) await cmd(`RCPT TO:<${rcpt}>`, [250, 251], `Recipient ${rcpt}`);
    await cmd("DATA", [354], "Message");
    socket.write(buildMessage({ from, fromName, to, subject, text }));
    await cmd(".", [250], "Message");
    socket.write("QUIT\r\n");
  } finally {
    setTimeout(() => socket?.destroy(), 500).unref();
  }
}
