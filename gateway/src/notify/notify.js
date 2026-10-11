// Alerts that reach you away from the gateway: every security event (security.js) is matched
// against the notification channels set up on the Alerts page, and sent out.
//
// Channels:
//   push     a phone notification through ntfy (free app for iPhone and Android, ntfy.sh or your
//            own ntfy server). The topic name works like a password: anyone who knows it can read
//            the alerts, so the gateway makes a long random one.
//   email    through any SMTP server (smtp.js)
//   webhook  an HTTPS POST: plain JSON (signed with HMAC-SHA256 if a secret is set: for your own
//            systems, like a helpdesk), or a Slack or Discord message
//
// Each channel has a minimum severity and the kinds of events it wants. Events that arrive close
// together are sent as one message (a burst of 50 detections is one notification, not 50), each
// channel sends at most 20 messages an hour, and a failed send is retried 3 times. "Back to
// normal" messages (a device back online) go wherever their problem went.
//
// Passwords, tokens, secrets and webhook addresses are kept in the gateway's database and never
// sent to the web UI or written to the audit log.

import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { sendMail, isEmail, SmtpError } from "./smtp.js";
import { SEVERITIES } from "../security.js";
import { log } from "../logger.js";

export const KINDS = ["push", "email", "webhook"];
export const WEBHOOK_FORMATS = ["json", "slack", "discord"];
export const EMAIL_SECURITY = ["starttls", "tls", "none"];
export const CATEGORIES = [
  { id: "malware", label: "Malware found", match: ["malware."] },
  { id: "ransomware", label: "Ransomware signs, frozen devices", match: ["ransomware.", "device.frozen", "device.unfrozen"] },
  { id: "offline", label: "Devices offline and back online", match: ["device.offline", "device.online"] },
  { id: "offsite", label: "Off-site copy problems", match: ["offsite."] },
  { id: "gateway", label: "Gateway health: disk space, antivirus engine", match: ["gateway.", "engine.", "scan."] },
  { id: "quarantine", label: "Quarantine decisions", match: ["quarantine."] },
  { id: "agents", label: "Agent updates and uninstalls", match: ["agent."] },
  { id: "logins", label: "Web UI logins", match: ["admin."] },
];
export const DEFAULT_SETTINGS = { gatewayName: os.hostname() || "Backup gateway", offlineHours: 24, diskPercent: 10 };

const GATHER_MS = 20_000; // wait this long for more events before sending (critical ones go at once)
const PER_HOUR = 20;
const RETRY_MS = [30_000, 120_000, 600_000];
const MAX_IN_MESSAGE = 25;
const SEV_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" };
const rank = (s) => SEVERITIES.indexOf(s);

export class NotifyError extends Error {}

export function categoryOf(kind) {
  return CATEGORIES.find((c) => c.match.some((m) => (m.endsWith(".") ? kind.startsWith(m) : kind === m)))?.id ?? null;
}

// ---- Checking what the web UI sends ----------------------------------------------------------

const text = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
function httpUrl(v, label) {
  const s = text(v, 2000);
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new NotifyError(`${label} isn't a valid web address.`);
  }
  if (!["http:", "https:"].includes(u.protocol)) throw new NotifyError(`${label} must start with https://`);
  return u.toString();
}
export const newTopic = () => `backup-${crypto.randomBytes(12).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x")}`;

// `old` = the saved channel, so secret fields left empty keep their saved value
export function cleanChannel(input, old = null) {
  const kind = old?.kind ?? input?.kind;
  if (!KINDS.includes(kind)) throw new NotifyError("Pick a kind of channel.");
  const prev = old?.settings ?? {};
  const s = input?.settings ?? {};
  let settings;
  if (kind === "push") {
    const topic = text(s.topic, 64);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(topic)) throw new NotifyError("The topic needs 8 to 64 letters, numbers, dashes or underscores.");
    settings = { server: httpUrl(s.server || "https://ntfy.sh", "The ntfy server").replace(/\/+$/, ""), topic, token: text(s.token, 200) || (s.clearToken ? "" : prev.token ?? "") };
  } else if (kind === "email") {
    const host = text(s.host, 255);
    if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new NotifyError("Enter the mail server, like smtp.gmail.com.");
    const port = Number(s.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new NotifyError("The port is a number, usually 587 or 465.");
    const security = EMAIL_SECURITY.includes(s.security) ? s.security : "starttls";
    const from = text(s.from, 254);
    if (!isEmail(from)) throw new NotifyError("The From address isn't a valid email address.");
    const to = [...new Set(String(s.to ?? "").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean))];
    if (!to.length || to.length > 10 || !to.every(isEmail)) throw new NotifyError("Enter 1 to 10 email addresses to send to, separated by commas.");
    const username = text(s.username, 254);
    const password = typeof s.password === "string" && s.password ? s.password.slice(0, 500) : username && username === prev.username ? prev.password ?? "" : "";
    if (username && !password) throw new NotifyError("Enter the password for that username.");
    settings = { host, port, security, username, password, from, fromName: text(s.fromName, 80), to };
  } else {
    const url = s.url ? httpUrl(s.url, "The webhook address") : prev.url;
    if (!url) throw new NotifyError("Enter the webhook address.");
    const format = WEBHOOK_FORMATS.includes(s.format) ? s.format : "json";
    settings = { url, format, secret: format === "json" ? text(s.secret, 200) || (s.clearSecret ? "" : prev.secret ?? "") : "" };
  }
  const minSeverity = SEVERITIES.includes(input?.minSeverity) ? input.minSeverity : "high";
  const categories = (Array.isArray(input?.categories) ? input.categories : CATEGORIES.map((c) => c.id)).filter((c) => CATEGORIES.some((x) => x.id === c));
  if (!categories.length) throw new NotifyError("Pick at least one kind of event to send.");
  const defaultName = { push: "Phone (ntfy)", email: "Email", webhook: "Webhook" }[kind];
  return { kind, name: text(input?.name, 60) || old?.name || defaultName, settings, minSeverity, categories: [...new Set(categories)] };
}

// What the web UI may see of a channel: no passwords, tokens, secrets or webhook addresses
function publicChannel(c) {
  const s = c.settings;
  let summary;
  let settings;
  if (c.kind === "push") {
    summary = `${s.server.replace(/^https?:\/\//, "")} / ${s.topic}`;
    settings = { server: s.server, topic: s.topic, hasToken: !!s.token };
  } else if (c.kind === "email") {
    summary = s.to.join(", ");
    settings = { host: s.host, port: s.port, security: s.security, username: s.username, hasPassword: !!s.password, from: s.from, fromName: s.fromName, to: s.to.join(", ") };
  } else {
    const u = new URL(s.url);
    const hint = `${u.host}/…${s.url.slice(-4)}`;
    summary = `${s.format === "json" ? "JSON" : s.format === "slack" ? "Slack" : "Discord"} · ${hint}`;
    settings = { format: s.format, urlHint: hint, hasSecret: !!s.secret };
  }
  return {
    id: c.id, kind: c.kind, name: c.name, enabled: !!c.enabled, minSeverity: c.min_severity, categories: c.categories, summary, settings,
    lastSentAt: c.last_sent_at, lastError: c.last_error, lastErrorAt: c.last_error_at, createdAt: c.created_at,
  };
}

// ---- Writing the message ---------------------------------------------------------------------

const when = (iso) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

function describe(e) {
  const d = e.detail ?? {};
  const lines = [e.title];
  if (e.device) lines.push(`Device: ${e.device}${e.client ? ` (${e.client})` : ""}`);
  if (d.signature) lines.push(`Malware: ${d.signature}`);
  if (d.path) lines.push(`File: ${d.path}`);
  if (d.note) lines.push(d.note);
  lines.push(`When: ${when(e.at)}`);
  return lines.join("\n");
}

export function compose(events, gatewayName) {
  const worst = events.reduce((a, e) => (rank(e.severity) > rank(a) ? e.severity : a), "info");
  const recovery = events.every((e) => e.detail?.recovers);
  if (events.length === 1) {
    const e = events[0];
    return {
      worst, recovery,
      title: (e.kind === "notify.test" ? e.title : `${recovery ? "Resolved" : SEV_LABEL[e.severity]}: ${e.title}`).slice(0, 250),
      body: `${describe(e)}\n\nGateway: ${gatewayName}. Details on its Security page.`,
    };
  }
  // The same thing many times (a burst of wrong passwords) is one line with a count
  const groups = new Map();
  for (const e of events) {
    const key = `${e.severity}|${e.title}`;
    const g = groups.get(key) ?? { ...e, count: 0 };
    g.count++;
    if (e.at > g.at) g.at = e.at;
    groups.set(key, g);
  }
  const all = [...groups.values()].sort((a, b) => rank(b.severity) - rank(a.severity) || (a.at < b.at ? -1 : 1));
  const shown = all.slice(0, MAX_IN_MESSAGE);
  const lines = shown.map((e) => `• [${SEV_LABEL[e.severity]}] ${e.title}${e.count > 1 ? ` (${e.count} times, last ${when(e.at)})` : ` (${when(e.at)})`}`);
  if (all.length > shown.length) lines.push(`…and ${all.slice(shown.length).reduce((n, g) => n + g.count, 0)} more`);
  return {
    worst, recovery,
    title: `${events.length} security events on ${gatewayName} (worst: ${SEV_LABEL[worst]})`,
    body: `${lines.join("\n")}\n\nDetails on the gateway's Security page.`,
  };
}

// ---- Sending ---------------------------------------------------------------------------------

const PRIORITY = { critical: 5, high: 4, medium: 3, low: 2, info: 2 };
const TAG = { critical: "rotating_light", high: "warning", medium: "large_orange_diamond", low: "small_blue_diamond", info: "information_source" };

async function post(url, body, headers = {}) {
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new NotifyError(`Couldn't reach ${new URL(url).host} (${err.name === "TimeoutError" ? "timed out" : err.cause?.code || err.message}).`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    throw new NotifyError(`${new URL(url).host} answered ${res.status}${detail ? `: ${detail}` : ""}`);
  }
}

export async function deliver(channel, events, gatewayName) {
  const s = channel.settings;
  const m = compose(events, gatewayName);
  if (channel.kind === "push") {
    const headers = s.token ? { authorization: `Bearer ${s.token}` } : {};
    await post(`${s.server}/`, JSON.stringify({
      topic: s.topic, title: m.title, message: m.body.slice(0, 3800),
      priority: m.recovery ? 3 : PRIORITY[m.worst], tags: [m.recovery ? "white_check_mark" : TAG[m.worst]],
    }), headers);
  } else if (channel.kind === "email") {
    try {
      await sendMail(s, { to: s.to, subject: `[${gatewayName}] ${m.title}`, text: m.body });
    } catch (err) {
      throw err instanceof SmtpError ? new NotifyError(err.message) : new NotifyError(`Sending the email failed: ${err.message}`);
    }
  } else if (s.format === "slack") {
    await post(s.url, JSON.stringify({ text: `*${m.title}*\n${m.body}`.slice(0, 3900) }));
  } else if (s.format === "discord") {
    await post(s.url, JSON.stringify({ content: `**${m.title}**\n${m.body}`.slice(0, 1990), allowed_mentions: { parse: [] } }));
  } else {
    // For your own systems (a helpdesk): the events as data
    const body = JSON.stringify({
      source: "backup-gateway",
      gateway: gatewayName,
      sentAt: new Date().toISOString(),
      title: m.title,
      events: events.map((e) => ({
        id: e.id, at: e.at, severity: e.severity, kind: e.kind, category: categoryOf(e.kind), title: e.title,
        deviceId: e.deviceId, device: e.device, client: e.client, recovers: !!e.detail?.recovers, detail: e.detail ?? null,
      })),
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = { "user-agent": "backup-gateway", "x-gateway-timestamp": ts };
    if (s.secret) headers["x-gateway-signature"] = `sha256=${crypto.createHmac("sha256", s.secret).update(`${ts}.${body}`).digest("hex")}`;
    await post(s.url, body, headers);
  }
}

// ---- The service -----------------------------------------------------------------------------

export function createNotify({ db, dataDir, security, deliverFn = deliver }) {
  const conn = new DatabaseSync(path.join(dataDir, "gateway.db"));
  conn.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS notify_channels (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      kind          TEXT NOT NULL,
      name          TEXT NOT NULL,
      settings      TEXT NOT NULL,   -- includes passwords/tokens: never sent to the web UI
      min_severity  TEXT NOT NULL,
      categories    TEXT NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL,
      last_sent_at  TEXT,
      last_error    TEXT,
      last_error_at TEXT
    );
    CREATE TABLE IF NOT EXISTS notify_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      at         TEXT NOT NULL,
      channel_id INTEGER,
      channel    TEXT,
      ok         INTEGER NOT NULL,
      events     INTEGER NOT NULL,
      title      TEXT,
      error      TEXT
    );
    CREATE TABLE IF NOT EXISTS notify_meta (
      name  TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  const q = {
    all: conn.prepare("SELECT * FROM notify_channels ORDER BY id"),
    get: conn.prepare("SELECT * FROM notify_channels WHERE id = ?"),
    add: conn.prepare("INSERT INTO notify_channels (kind, name, settings, min_severity, categories, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
    update: conn.prepare("UPDATE notify_channels SET name = ?, settings = ?, min_severity = ?, categories = ? WHERE id = ?"),
    enable: conn.prepare("UPDATE notify_channels SET enabled = ? WHERE id = ?"),
    remove: conn.prepare("DELETE FROM notify_channels WHERE id = ?"),
    sent: conn.prepare("UPDATE notify_channels SET last_sent_at = ?, last_error = NULL, last_error_at = NULL WHERE id = ?"),
    failed: conn.prepare("UPDATE notify_channels SET last_error = ?, last_error_at = ? WHERE id = ?"),
    addLog: conn.prepare("INSERT INTO notify_log (at, channel_id, channel, ok, events, title, error) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    log: conn.prepare("SELECT * FROM notify_log ORDER BY id DESC LIMIT ?"),
    trimLog: conn.prepare("DELETE FROM notify_log WHERE id < (SELECT COALESCE(MAX(id), 0) - 2000 FROM notify_log)"),
    getMeta: conn.prepare("SELECT value FROM notify_meta WHERE name = ?"),
    setMeta: conn.prepare("INSERT OR REPLACE INTO notify_meta (name, value) VALUES (?, ?)"),
    openAlert: conn.prepare("SELECT id FROM alerts WHERE kind = 'notify' AND acknowledged_at IS NULL AND message LIKE ? LIMIT 1"),
  };
  const now = () => new Date().toISOString();
  const row = (r) => r && { ...r, settings: JSON.parse(r.settings), categories: JSON.parse(r.categories) };
  const channels = () => q.all.all().map(row);

  function settings() {
    let saved = {};
    try {
      saved = JSON.parse(q.getMeta.get("settings")?.value ?? "{}");
    } catch {
      saved = {};
    }
    return { ...DEFAULT_SETTINGS, ...saved };
  }

  // Per channel: events waiting to go out, sends in the last hour, retries
  const state = new Map();
  const stateOf = (id) => {
    if (!state.has(id)) state.set(id, { queue: [], sending: false, sends: [], attempt: 0, retryAt: 0 });
    return state.get(id);
  };

  function wants(c, e) {
    if (!c.enabled || e.kind.startsWith("notify.")) return false;
    const cat = categoryOf(e.kind);
    if (!cat || !c.categories.includes(cat)) return false;
    // "Back to normal" goes wherever its problem went
    const level = e.detail?.recovers ? e.detail.problemSeverity ?? "high" : e.severity;
    return rank(level) >= rank(c.min_severity);
  }

  function onEvent(e) {
    const d = e.deviceId ? db.getDevice(e.deviceId) : null;
    const full = { ...e, device: d?.device_name ?? null, client: d?.client_name ?? null };
    for (const c of channels()) {
      if (!wants(c, full)) continue;
      const st = stateOf(c.id);
      st.queue.push({ ...full, queuedAt: Date.now() });
      if (st.queue.length > 1000) st.queue.splice(0, st.queue.length - 1000);
      if (e.severity === "critical") setImmediate(() => flush(c.id));
    }
  }

  async function flush(id) {
    const st = stateOf(id);
    if (st.sending || !st.queue.length || Date.now() < st.retryAt) return;
    // Critical goes at once, unless something was just sent: then a burst becomes one message
    const urgent = st.queue.some((e) => e.severity === "critical") && Date.now() - (st.sends.at(-1) ?? 0) > 60_000;
    if (!urgent && Date.now() - st.queue[0].queuedAt < GATHER_MS) return;
    st.sends = st.sends.filter((t) => Date.now() - t < 3600_000);
    if (st.sends.length >= PER_HOUR) return; // the next message carries everything held back
    const c = row(q.get.get(id));
    if (!c || !c.enabled) {
      state.delete(id);
      return;
    }
    const batch = st.queue.splice(0);
    st.sending = true;
    const gatewayName = settings().gatewayName;
    try {
      await deliverFn(c, batch, gatewayName);
      st.sends.push(Date.now());
      st.attempt = 0;
      q.sent.run(now(), id);
      q.addLog.run(now(), id, c.name, 1, batch.length, compose(batch, gatewayName).title, null);
    } catch (err) {
      st.attempt++;
      const message = err.message.slice(0, 300);
      q.failed.run(message, now(), id);
      if (st.attempt <= RETRY_MS.length) {
        st.queue.unshift(...batch);
        st.retryAt = Date.now() + RETRY_MS[st.attempt - 1];
        log.warn(`Alert channel "${c.name}" failed (${message}); trying again in ${RETRY_MS[st.attempt - 1] / 1000}s`);
      } else {
        st.attempt = 0;
        q.addLog.run(now(), id, c.name, 0, batch.length, compose(batch, gatewayName).title, message);
        log.error(`Alert channel "${c.name}" failed 4 times; ${batch.length} alert(s) dropped: ${message}`);
        const prefix = `Alerts to "${c.name}" aren't getting through`;
        if (!q.openAlert.get(`${prefix}%`)) db.addAlert(null, "notify", `${prefix}: ${message}`);
      }
    } finally {
      st.sending = false;
    }
    q.trimLog.run();
  }

  let timer = null;
  let unsubscribe = null;

  return {
    conn,
    settings,
    setSettings(input) {
      const cur = settings();
      const name = text(input?.gatewayName, 60) || cur.gatewayName;
      const offlineHours = Number(input?.offlineHours ?? cur.offlineHours);
      const diskPercent = Number(input?.diskPercent ?? cur.diskPercent);
      if (!Number.isInteger(offlineHours) || offlineHours < 1 || offlineHours > 720) throw new NotifyError("Offline time must be 1 to 720 hours.");
      if (!Number.isInteger(diskPercent) || diskPercent < 1 || diskPercent > 50) throw new NotifyError("Disk space warning must be 1 to 50 %.");
      const next = { gatewayName: name, offlineHours, diskPercent };
      q.setMeta.run("settings", JSON.stringify(next));
      return next;
    },

    list: () => channels().map(publicChannel),
    get: (id) => row(q.get.get(id)),
    add(input) {
      const c = cleanChannel(input);
      const id = Number(q.add.run(c.kind, c.name, JSON.stringify(c.settings), c.minSeverity, JSON.stringify(c.categories), now()).lastInsertRowid);
      return publicChannel(row(q.get.get(id)));
    },
    update(id, input) {
      const old = row(q.get.get(id));
      if (!old) throw new NotifyError("That channel doesn't exist any more.");
      const c = cleanChannel(input, old);
      q.update.run(c.name, JSON.stringify(c.settings), c.minSeverity, JSON.stringify(c.categories), id);
      return publicChannel(row(q.get.get(id)));
    },
    setEnabled(id, on) {
      q.enable.run(on ? 1 : 0, id);
      if (!on) state.delete(id);
    },
    remove(id) {
      q.remove.run(id);
      state.delete(id);
    },

    // Sends a test message straight away (to a saved channel, or to settings not saved yet)
    async test({ id = null, input = null }) {
      const old = id ? row(q.get.get(id)) : null;
      const c = input ? { ...cleanChannel(input, old), id } : old;
      if (!c) throw new NotifyError("That channel doesn't exist any more.");
      const gatewayName = settings().gatewayName;
      const event = {
        id: 0, at: now(), severity: "info", kind: "notify.test", deviceId: null, device: null, client: null,
        title: `Test alert from ${gatewayName}`,
        detail: { note: "If you can read this, alerts reach you here." },
      };
      try {
        await deliverFn(c, [event], gatewayName);
        if (id) q.sent.run(now(), id);
        q.addLog.run(now(), id, c.name, 1, 1, "Test alert", null);
      } catch (err) {
        if (id) q.failed.run(err.message.slice(0, 300), now(), id);
        q.addLog.run(now(), id, c.name, 0, 1, "Test alert", err.message.slice(0, 300));
        throw err instanceof NotifyError ? err : new NotifyError(err.message);
      }
    },

    log: (limit = 50) =>
      q.log.all(limit).map((r) => ({ id: r.id, at: r.at, channelId: r.channel_id, channel: r.channel, ok: !!r.ok, events: r.events, title: r.title, error: r.error })),
    pending: () => [...state.entries()].reduce((n, [, s]) => n + s.queue.length, 0),

    start() {
      unsubscribe = security.onEvent(onEvent);
      timer = setInterval(() => {
        for (const c of channels()) flush(c.id).catch((err) => log.error("Alert sending failed", err));
      }, 5000);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      unsubscribe?.();
    },
  };
}
