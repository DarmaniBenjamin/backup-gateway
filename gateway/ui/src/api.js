// Talks to the gateway's admin API.
// - The login cookie is sent automatically by the browser (it's HttpOnly, so this code can't read it).
// - Every request carries X-Backup-UI: 1, which the gateway requires as CSRF protection.
// - If the session has expired, the app is told so it can show the login screen.

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`/admin/api${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        "X-Backup-UI": "1",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can't reach the gateway. Is it running?");
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && path !== "/login") onUnauthorized();
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body = {}) => request("POST", path, body),
};