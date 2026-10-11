// Folder lock: once the backup folders are chosen, they can be locked ON THIS DEVICE with a key.
//
// While locked, the device keeps backing up exactly the locked folders (paths and exclusions) and
// refuses any other folder list from the gateway. Only someone with the unlock key can change
// them: they unlock for 30 minutes, make the changes, and lock again (it locks again by itself
// after 30 minutes, keeping the folders as they are then). So even a hacked gateway
// can't quietly stop a folder from being backed up or point the device somewhere else.
//
// The device only keeps a scrypt hash of the key, never the key itself. The gateway makes the key,
// shows it once and forgets it. Unlocking is never remembered across a restart: the device starts
// locked again.

import crypto from "node:crypto";
import { log } from "./logger.js";

const UNLOCK_MS = 30 * 60 * 1000;
const MAX_TRIES = 5; // wrong keys in a row...
const COOLDOWN_MS = 15 * 60 * 1000; // ...then no more tries for 15 minutes
// Keys look like BGFL-7Q2M-K4XD-PL3Z-W9AB-C5TN; spaces, dashes and lower case don't matter
const KEY_FORMAT = /^[A-Z2-7]{20}$/;
const normalize = (key) => String(key ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^BGFL/, "");
const hashOf = (key, salt) => crypto.scryptSync(normalize(key), Buffer.from(salt, "base64"), 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

// The part of a folder that the lock protects
const shape = (folders) =>
  JSON.stringify(
    folders
      .map((f) => ({ name: f.name, path: f.path, excludes: [...(f.excludes ?? [])].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name))
  );

export class LockError extends Error {}

// current(): the folders the device is backing up right now
export function createLock({ db, current, now = () => Date.now() }) {
  let unlockedUntil = 0;
  let relockTimer = null;
  let wrongTries = 0;
  let blockedUntil = 0;
  let refusedAt = null; // last time the gateway sent folders that the lock refused

  const state = () => db.getSetting("folderLock"); // { hash, salt, folders, lockedAt } or null

  function checkKey(key) {
    const s = state();
    if (!s) throw new LockError("The folders aren't locked.");
    if (now() < blockedUntil) {
      throw new LockError(`Too many wrong keys. Try again in ${Math.ceil((blockedUntil - now()) / 60000)} minute(s).`);
    }
    const ok = crypto.timingSafeEqual(hashOf(key, s.salt), Buffer.from(s.hash, "base64"));
    if (!ok) {
      wrongTries++;
      log.warn(`Wrong folder unlock key (${wrongTries} in a row)`);
      if (wrongTries >= MAX_TRIES) {
        wrongTries = 0;
        blockedUntil = now() + COOLDOWN_MS;
        log.warn("Too many wrong folder unlock keys: no more tries for 15 minutes");
      }
      throw new LockError("That key is wrong.");
    }
    wrongTries = 0;
    return s;
  }

  const api = {
    enabled: () => !!state(),
    isLocked: () => !!state() && now() >= unlockedUntil,

    status() {
      const s = state();
      return {
        enabled: !!s,
        locked: api.isLocked(),
        lockedAt: s?.lockedAt ?? null,
        unlockedUntil: s && now() < unlockedUntil ? new Date(unlockedUntil).toISOString() : null,
        refusedAt,
        // What the device is really backing up while locked (the gateway's list could differ)
        folders: s ? s.folders.map((f) => ({ name: f.name, path: f.path })) : [],
      };
    },

    // Lock the folders the device is backing up now. The first time, with the new key from the
    // gateway; after an unlock, the same key stays.
    lock(newKey, relocking = false) {
      const s = state();
      if (s && api.isLocked() && !relocking) throw new LockError("The folders are already locked.");
      let hash = s?.hash;
      let salt = s?.salt;
      if (!s) {
        if (!KEY_FORMAT.test(normalize(newKey))) throw new LockError("Bad key.");
        salt = crypto.randomBytes(16).toString("base64");
        hash = hashOf(newKey, salt).toString("base64");
      }
      const folders = current().map((f) => ({ id: f.id, name: f.name, path: f.path, excludes: f.excludes ?? [] }));
      db.setSetting("folderLock", { hash, salt, folders, lockedAt: new Date(now()).toISOString() });
      unlockedUntil = 0;
      clearTimeout(relockTimer);
      refusedAt = null;
      log.info(`Backup folders locked (${folders.map((f) => f.name).join(", ") || "none"}). Changing them now needs the unlock key.`);
      return api.status();
    },

    unlock(key) {
      checkKey(key);
      unlockedUntil = now() + UNLOCK_MS;
      clearTimeout(relockTimer);
      relockTimer = setTimeout(() => {
        if (state() && now() >= unlockedUntil) {
          log.info("30 minutes are up: locking the backup folders again");
          api.lock(undefined, true);
        }
      }, UNLOCK_MS + 1000);
      relockTimer.unref?.();
      log.info("Backup folders unlocked for 30 minutes with the unlock key");
      return api.status();
    },

    // Turn the lock off for good (needs the key)
    remove(key) {
      checkKey(key);
      db.deleteSetting("folderLock");
      unlockedUntil = 0;
      clearTimeout(relockTimer);
      refusedAt = null;
      log.info("Folder lock turned off with the unlock key");
      return api.status();
    },

    // The folder list to use: the gateway's, unless the lock says otherwise
    enforce(wanted) {
      const s = state();
      if (!s || !api.isLocked() || shape(wanted) === shape(s.folders)) return wanted;
      if (!refusedAt) log.warn("The gateway asked to change the backup folders, but they're locked on this device. Keeping the locked folders.");
      refusedAt = new Date(now()).toISOString();
      return s.folders;
    },
  };
  return api;
}
