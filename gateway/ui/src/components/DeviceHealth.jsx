// A device's health (gateway/src/device-health.js): what's wrong right now, its disks, CPU and memory.
// The agent checks every few minutes; problems also go out as alerts (category "Device health").

import { Activity, CircleCheck, HardDrive, TriangleAlert } from "lucide-react";
import { formatSize, timeAgo } from "../format.js";

const TONE = {
  critical: "border-alert/50 bg-alert/10 text-alert",
  high: "border-warn/50 bg-warn/10 text-warn",
  medium: "border-warn/30 bg-warn/5 text-warn",
  low: "border-edge bg-raised/50 text-dim",
  info: "border-edge bg-raised/50 text-dim",
};
const ORDER = ["critical", "high", "medium", "low", "info"];

function Meter({ label, value }) {
  if (value == null) return null;
  const tone = value >= 90 ? "bg-alert" : value >= 75 ? "bg-warn" : "bg-good";
  return (
    <div>
      <div className="flex justify-between text-xs text-dim">
        <span>{label}</span>
        <span className="text-fg">{value}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
    </div>
  );
}

export default function DeviceHealth({ health }) {
  if (!health) {
    return (
      <section className="mb-8">
        <h2 className="mb-3 flex items-center gap-2 font-medium">
          <Activity size={17} aria-hidden="true" /> Health
        </h2>
        <p className="text-sm text-dim">No health report yet. Devices send one with agent 0.18 or newer, a few minutes after starting.</p>
      </section>
    );
  }
  const problems = [...health.problems].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
  const f = health.facts ?? {};
  return (
    <section className="mb-8">
      <h2 className="mb-1 flex items-center gap-2 font-medium">
        <Activity size={17} aria-hidden="true" /> Health
      </h2>
      <p className="mb-3 text-sm text-dim">
        Checked {timeAgo(health.updatedAt)}
        {f.bootedAt ? `, running since ${timeAgo(f.bootedAt).replace(/ ago$/, "")} ago` : ""}
        {f.os ? `, ${f.os}` : ""}.
      </p>
      {problems.length ? (
        <ul className="mb-4 space-y-2">
          {problems.map((p) => (
            <li key={p.id} className={`flex items-start gap-2.5 rounded-md border px-4 py-3 text-sm ${TONE[p.severity]}`}>
              <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                <span className="font-medium capitalize">{p.severity}:</span> {p.title}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 flex items-center gap-2 text-sm text-good">
          <CircleCheck size={16} aria-hidden="true" /> Nothing wrong right now.
        </p>
      )}
      <div className="glass grid gap-4 rounded-lg border border-edge p-4 sm:grid-cols-2">
        <div className="space-y-3">
          <Meter label="CPU" value={f.cpu} />
          <Meter label="Memory" value={f.mem} />
        </div>
        <ul className="space-y-3">
          {(f.disks ?? []).map((d) => {
            const used = d.total ? Math.round(((d.total - (d.free ?? 0)) / d.total) * 100) : null;
            return (
              <li key={d.name}>
                <div className="flex items-center justify-between gap-2 text-xs text-dim">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <HardDrive size={13} className="shrink-0" aria-hidden="true" />
                    <span className="truncate font-mono text-fg">{d.name}</span>
                  </span>
                  <span className="shrink-0">{formatSize(d.free ?? 0)} free of {formatSize(d.total)}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised">
                  <div className={`h-full rounded-full ${used >= 95 ? "bg-alert" : used >= 90 ? "bg-warn" : "bg-good"}`} style={{ width: `${used ?? 0}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
