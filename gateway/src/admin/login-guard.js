// Wrong-password protection for the web UI, built so it can't be turned against you:
//   - an address that keeps getting it wrong is slowed down (each try waits longer, up to 8 s),
//     then blocked for 15 minutes after 10 wrong tries
//   - a username is blocked for 15 minutes only for the address getting it wrong (5 tries): your
//     own logins from anywhere else still work, so nobody can lock you out by guessing
//   - many wrong tries for one username from several places, or a flood of wrong tries overall,
//     is an attack: it raises a critical alert and turns on lockdown (lockdown.js)
// With two-factor login on, a guessed password alone gets nobody in anyway.

const WINDOW_MS = 15 * 60_000;
const IP_LIMIT = 10;
const IP_USER_LIMIT = 5;
const ATTACK_PER_USER = 20; // wrong tries for one username, from 3+ addresses
const ATTACK_TOTAL = 50; // wrong tries overall

export function createLoginGuard({ onAttack = () => {}, now = () => Date.now() } = {}) {
  const fails = new Map(); // key -> [{ at, ip }]
  let lastAttack = 0;

  function recent(key) {
    const t = now();
    const list = (fails.get(key) ?? []).filter((f) => t - f.at < WINDOW_MS);
    if (list.length) fails.set(key, list);
    else fails.delete(key);
    return list;
  }
  const add = (key, ip) => fails.set(key, [...recent(key), { at: now(), ip }]);
  const userKey = (u) => String(u ?? "").trim().toLowerCase();

  return {
    // A reason if this try isn't allowed right now, or null
    blocked(ip, username) {
      if (recent(`ip:${ip}`).length >= IP_LIMIT) return "Too many wrong tries from this address. Wait 15 minutes and try again.";
      if (recent(`ipuser:${ip}|${userKey(username)}`).length >= IP_USER_LIMIT) return "Too many wrong tries for this account from this address. Wait 15 minutes and try again.";
      return null;
    },
    // How long to make a wrong try wait (more each time from the same address)
    delayMs(ip) {
      const n = recent(`ip:${ip}`).length;
      return n ? Math.min(8000, 250 * 2 ** (n - 1)) : 0;
    },
    failed(ip, username) {
      const u = userKey(username);
      add(`ip:${ip}`, ip);
      add(`ipuser:${ip}|${u}`, ip);
      add(`user:${u}`, ip);
      add("all", ip);
      const forUser = recent(`user:${u}`);
      const places = new Set(forUser.map((f) => f.ip)).size;
      const total = recent("all").length;
      let reason = null;
      if (forUser.length >= ATTACK_PER_USER && places >= 3) reason = `${forUser.length} wrong passwords for "${u || "?"}" from ${places} addresses in 15 minutes`;
      else if (total >= ATTACK_TOTAL) reason = `${total} wrong passwords in 15 minutes`;
      if (reason && now() - lastAttack > WINDOW_MS) {
        lastAttack = now();
        onAttack(reason);
      }
    },
    succeeded(ip, username) {
      fails.delete(`ipuser:${ip}|${userKey(username)}`);
    },
  };
}
