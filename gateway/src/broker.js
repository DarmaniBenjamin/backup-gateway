// The live link to agents, without opening any ports on the client.
//
// Each agent keeps one "anything for me?" request open to the gateway (a long poll). When there
// is work for it (a restore, a folder change, a folder-browse request) the gateway answers that
// request at once, and the agent fetches the details over its normal signed heartbeat.
// So restores and folder changes start within a second instead of waiting for the next heartbeat.

import crypto from "node:crypto";

export function createBroker() {
  const waiters = new Map(); // deviceId -> Set of functions that end a waiting request
  const woken = new Set();   // devices woken while they had no request open
  const browse = new Map();  // deviceId -> Map(requestId -> { path, sent, resolve, timer })

  function wake(deviceId) {
    const set = waiters.get(deviceId);
    if (set?.size) {
      for (const done of [...set]) done(true);
    } else {
      woken.add(deviceId);
    }
  }

  return {
    wake,

    // Agent side: resolves true as soon as there's work, or false after timeoutMs
    wait(deviceId, timeoutMs, onAbort) {
      if (woken.delete(deviceId)) return Promise.resolve(true);
      return new Promise((resolve) => {
        let set = waiters.get(deviceId);
        if (!set) waiters.set(deviceId, (set = new Set()));
        let finished = false;
        const done = (value) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          set.delete(done);
          resolve(value);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        set.add(done);
        onAbort?.(() => done(false));
      });
    },

    // Is this device's agent connected right now (has a waiting request open)?
    isLive: (deviceId) => (waiters.get(deviceId)?.size ?? 0) > 0,

    // Admin side: ask a device to list the folders inside `path`. Resolves with its answer.
    requestBrowse(deviceId, path, timeoutMs = 15_000) {
      const id = crypto.randomBytes(9).toString("base64url");
      let requests = browse.get(deviceId);
      if (!requests) browse.set(deviceId, (requests = new Map()));
      const promise = new Promise((resolve) => {
        const timer = setTimeout(() => {
          requests.delete(id);
          resolve({ error: "The device didn't answer in time. Is its agent running?" });
        }, timeoutMs);
        requests.set(id, { path, sent: false, resolve, timer });
      });
      wake(deviceId);
      return promise;
    },

    // Browse requests not yet handed to the agent (each is handed over once)
    takeBrowseRequests(deviceId) {
      const out = [];
      for (const [id, r] of browse.get(deviceId) ?? []) {
        if (r.sent) continue;
        r.sent = true;
        out.push({ id, path: r.path });
      }
      return out;
    },

    // The agent's answer to a browse request
    answerBrowse(deviceId, id, result) {
      const r = browse.get(deviceId)?.get(id);
      if (!r) return false;
      clearTimeout(r.timer);
      browse.get(deviceId).delete(id);
      r.resolve(result);
      return true;
    },
  };
}
