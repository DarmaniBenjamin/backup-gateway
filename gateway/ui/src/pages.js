// Pages other than the dashboard load when first opened, so the first screen comes up faster.
// They're fetched in the background right after login (see Layout), so switching tabs stays instant.
export const pages = {
  Devices: () => import("./pages/Devices.jsx"),
  DeviceFolders: () => import("./pages/DeviceFolders.jsx"),
  Restore: () => import("./pages/Restore.jsx"),
  Quarantine: () => import("./pages/Quarantine.jsx"),
  Jobs: () => import("./pages/Jobs.jsx"),
  Integrity: () => import("./pages/Integrity.jsx"),
  Audit: () => import("./pages/Audit.jsx"),
  Offsite: () => import("./pages/Offsite.jsx"),
  Security: () => import("./pages/Security.jsx"),
  Alerts: () => import("./pages/Alerts.jsx"),
  Certificate: () => import("./pages/Certificate.jsx"),
};

// Fetch them all quietly once the browser is idle
export function preloadPages() {
  const run = () => Object.values(pages).forEach((load) => load().catch(() => {}));
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1500);
}
