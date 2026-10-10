// Device status: online (teal), offline / frozen (coral), never seen / revoked (grey).

const STYLES = {
  online: { label: "Online", dot: "bg-good", text: "text-good" },
  offline: { label: "Offline", dot: "bg-alert", text: "text-alert" },
  frozen: { label: "Frozen", dot: "bg-alert", text: "text-alert" },
  "never-seen": { label: "Never connected", dot: "bg-dim", text: "text-dim" },
  revoked: { label: "Revoked", dot: "bg-dim", text: "text-dim" },
};

export default function StatusBadge({ status }) {
  const s = STYLES[status] ?? STYLES["never-seen"];
  return (
    <span className={`inline-flex items-center gap-2 text-sm ${s.text}`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} aria-hidden="true" />
      {s.label}
    </span>
  );
}