// A small Google Drive client: just what the off-site copy needs, with plain fetch (no Google SDK).
//
// Signing in uses Google's "desktop app" OAuth flow: the browser on the gateway goes to Google,
// the person allows access, and Google sends them back to this gateway's own address
// (http://127.0.0.1:<port>/...), so nothing on the internet has to reach the gateway.
// The only permission asked for is drive.file: the gateway can see and change ONLY the files it
// created itself, never anything else in that Google account.

import crypto from "node:crypto";

// Real Google addresses. GATEWAY_GOOGLE_TEST_BASE points them all at a stand-in, for tests only.
const TEST = process.env.GATEWAY_GOOGLE_TEST_BASE?.replace(/\/+$/, "");
export const GOOGLE = {
  auth: TEST ? `${TEST}/o/oauth2/v2/auth` : "https://accounts.google.com/o/oauth2/v2/auth",
  token: TEST ? `${TEST}/token` : "https://oauth2.googleapis.com/token",
  api: TEST ? `${TEST}/drive/v3` : "https://www.googleapis.com/drive/v3",
  upload: TEST ? `${TEST}/upload/drive/v3` : "https://www.googleapis.com/upload/drive/v3",
  scope: "https://www.googleapis.com/auth/drive.file",
};

const FOLDER = "application/vnd.google-apps.folder";

export class DriveError extends Error {
  constructor(status, message, reason) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

async function call(url, options = {}, timeoutMs = 120_000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let reason;
    try {
      const body = await res.json();
      message = body.error_description || body.error?.message || (typeof body.error === "string" ? body.error : message);
      reason = body.error?.errors?.[0]?.reason || (typeof body.error === "string" ? body.error : undefined);
    } catch {
      // not JSON
    }
    throw new DriveError(res.status, message, reason);
  }
  return res;
}

// ---- Signing in ------------------------------------------------------------------------------

// The address to send the person to, plus what's needed to finish afterwards
export function startSignIn({ clientId, redirectUri }) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const state = crypto.randomBytes(24).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(GOOGLE.auth);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE.scope,
    access_type: "offline", // a refresh token, so the gateway keeps access
    prompt: "consent", // always hand out a refresh token, even if allowed before
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), state, verifier };
}

// Swap the code Google sent back for a refresh token
export async function finishSignIn({ clientId, clientSecret, redirectUri, code, verifier }) {
  const res = await call(GOOGLE.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const body = await res.json();
  if (!body.refresh_token) throw new DriveError(400, "Google didn't hand out a long-term token. Remove the gateway's access in your Google account (Security > Third-party access) and sign in again.");
  if (!String(body.scope ?? GOOGLE.scope).includes("drive.file")) throw new DriveError(400, "Access to Google Drive wasn't allowed. Sign in again and tick the Drive box.");
  return body.refresh_token;
}

// ---- Drive -----------------------------------------------------------------------------------

export function createDrive({ clientId, clientSecret, refreshToken }) {
  let token = null;
  let tokenUntil = 0;

  async function accessToken() {
    if (token && Date.now() < tokenUntil) return token;
    const res = await call(GOOGLE.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    }, 30_000);
    const body = await res.json();
    token = body.access_token;
    tokenUntil = Date.now() + Math.max(60, (body.expires_in ?? 3600) - 120) * 1000;
    return token;
  }

  const auth = async (headers = {}) => ({ ...headers, Authorization: `Bearer ${await accessToken()}` });

  const api = {
    // Who's signed in, and how much space is left
    async about() {
      const res = await call(`${GOOGLE.api}/about?fields=user(emailAddress,displayName),storageQuota`, { headers: await auth() }, 30_000);
      const b = await res.json();
      return {
        email: b.user?.emailAddress ?? null,
        name: b.user?.displayName ?? null,
        limit: b.storageQuota?.limit != null ? Number(b.storageQuota.limit) : null,
        usage: b.storageQuota?.usage != null ? Number(b.storageQuota.usage) : null,
      };
    },

    async createFolder(name, parentId = null, appProperties = {}) {
      const res = await call(`${GOOGLE.api}/files?fields=id`, {
        method: "POST",
        headers: await auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ name, mimeType: FOLDER, ...(parentId ? { parents: [parentId] } : {}), appProperties }),
      }, 30_000);
      return (await res.json()).id;
    },

    // Is this file or folder (one the gateway made) still there, and not in the bin?
    async exists(id) {
      try {
        const res = await call(`${GOOGLE.api}/files/${encodeURIComponent(id)}?fields=id,trashed`, { headers: await auth() }, 30_000);
        return !(await res.json()).trashed;
      } catch (err) {
        if (err instanceof DriveError && err.status === 404) return false;
        throw err;
      }
    },

    // A folder the person picked (or the gateway made): its name, and whether it really is a folder
    async folder(id) {
      const res = await call(`${GOOGLE.api}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,trashed`, { headers: await auth() }, 30_000);
      const f = await res.json();
      if (f.mimeType !== FOLDER) throw new DriveError(400, "That's a file, not a folder. Choose a folder.");
      if (f.trashed) throw new DriveError(400, "That folder is in the bin. Choose another one.");
      return { id: f.id, name: f.name };
    },

    // A folder the gateway made earlier inside `parentId` (marked with appProperties), if any
    async findChild(parentId, kind) {
      const q = `'${String(parentId).replace(/'/g, "\\'")}' in parents and trashed = false and mimeType = '${FOLDER}' and appProperties has { key='backupGateway' and value='${kind}' }`;
      const res = await call(`${GOOGLE.api}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`, { headers: await auth() }, 30_000);
      return (await res.json()).files?.[0]?.id ?? null;
    },

    // A short-lived token for the Google folder picker in the browser (drive.file only)
    async token() {
      return accessToken();
    },

    // Upload a file in one go (resumable upload: works for any size, two requests)
    async upload(name, parentId, data, appProperties = {}) {
      const start = await call(`${GOOGLE.upload}/files?uploadType=resumable&fields=id`, {
        method: "POST",
        headers: await auth({
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": "application/octet-stream",
          "X-Upload-Content-Length": String(data.length),
        }),
        body: JSON.stringify({ name, parents: [parentId], appProperties }),
      }, 30_000);
      const session = start.headers.get("location");
      if (!session) throw new DriveError(502, "Google Drive didn't start the upload.");
      const res = await call(session, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(data.length) },
        body: data,
      }, 15 * 60_000);
      const body = await res.json();
      if (Number(body.size ?? data.length) !== data.length && body.size != null) throw new DriveError(502, "Google Drive stored a different size than was sent.");
      return body.id;
    },

    async download(id) {
      const res = await call(`${GOOGLE.api}/files/${encodeURIComponent(id)}?alt=media`, { headers: await auth() });
      return Buffer.from(await res.arrayBuffer());
    },

    // Only ever used on the connection test's own little file
    async remove(id) {
      await call(`${GOOGLE.api}/files/${encodeURIComponent(id)}`, { method: "DELETE", headers: await auth() }, 30_000);
    },
  };
  return api;
}

// Plain-language versions of what Google says
export function explainDrive(err) {
  if (!(err instanceof DriveError)) {
    const m = err.cause?.code || err.code || err.name || err.message;
    if (/ENOTFOUND|EAI_AGAIN/.test(m)) return "Can't reach Google. Check this computer's internet connection.";
    if (/Timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED/.test(m)) return "Google Drive didn't answer in time. It'll try again.";
    return err.message;
  }
  if (err.reason === "invalid_grant" || /invalid_grant|expired or revoked/i.test(err.message)) {
    return "Google no longer accepts the gateway's sign-in (it was removed, the password changed, or the Google project is still in \"Testing\", where sign-ins expire after 7 days). Sign in to Google Drive again on the Off-site page.";
  }
  if (err.reason === "invalid_client" || /invalid_client|unauthorized_client/i.test(err.message)) return "Google doesn't recognise the client ID or secret. Check them, or make a new OAuth client.";
  if (err.reason === "storageQuotaExceeded" || /quota.*exceeded|storage quota/i.test(err.message)) return "The Google Drive is full. Free up space or buy more storage.";
  if (err.reason === "userRateLimitExceeded" || err.reason === "rateLimitExceeded" || err.status === 429) return "Google Drive asked the gateway to slow down. It'll carry on shortly.";
  if (err.reason === "dailyLimitExceeded" || /daily.*limit|750/i.test(err.message)) return "Google Drive's daily upload limit (about 750 GB) was reached. It carries on tomorrow.";
  if (err.status === 403 && /has not been used|disabled/i.test(err.message)) return "The Google Drive API isn't turned on for this Google project. Turn it on (APIs & Services > Library > Google Drive API) and try again.";
  return `Google Drive: ${err.message}`;
}
