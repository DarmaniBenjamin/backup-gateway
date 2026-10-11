// Which off-site copies each backed-up file goes to.
//
//   The failsafe copy gets everything, from every device, always.
//   A device's own copies (its own Backblaze bucket, its own Google Drive) get that device's
//   files, from the folders set to go there on the device's page. By default (destinations
//   NULL) a folder goes to all of its device's copies.
// A version belongs to the folder named by the first part of its path ("Documents/a/b.txt").

export function cleanDestinations(value, allowedIds) {
  if (!Array.isArray(value)) throw new Error("Pick where this folder's backups go.");
  const list = [...new Set(value.map(String))];
  if (list.some((d) => !allowedIds.includes(d))) throw new Error("That copy isn't one of this device's off-site copies.");
  return list.length === allowedIds.length && allowedIds.every((id) => list.includes(id)) ? null : list.sort();
}

// Returns (deviceId, relPath) -> should this version go to `dest`? Built once per pass.
export function routerFor(conn, dest) {
  if (!dest.device_id) return () => true; // failsafe: everything
  const rules = new Map(); // folder name -> destination ids, or null (all of the device's copies)
  for (const f of conn.prepare("SELECT name, destinations FROM device_folders WHERE device_id = ?").iterate(dest.device_id)) {
    rules.set(f.name, f.destinations ? JSON.parse(f.destinations) : null);
  }
  return (deviceId, relPath) => {
    if (deviceId !== dest.device_id) return false;
    const list = rules.get(String(relPath).split("/")[0]);
    return !list || list.includes(dest.id); // a folder it doesn't know (older devices): yes
  };
}
