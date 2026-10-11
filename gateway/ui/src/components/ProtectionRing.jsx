// The overview's status dial: one ring segment per device, coloured by its state
// (green protected, amber paused, red frozen or offline, grey never connected), with the
// number of protected devices in the middle and a slow scanner sweep behind it.

const SIZE = 176;
const R = 70;
const STROKE = 9;
const C = 2 * Math.PI * R;

function tone(d) {
  if (d.status === "frozen" || d.status === "offline") return "var(--color-alert)";
  if (d.status === "never-seen" || d.status === "revoked") return "var(--color-edge)";
  if (d.pausedReason) return "var(--color-warn)";
  return "var(--color-good)";
}

export default function ProtectionRing({ devices }) {
  const n = devices.length;
  const protectedCount = devices.filter((d) => tone(d) === "var(--color-good)").length;
  const gap = n > 1 ? Math.min(10, C / n / 4) : 0;
  const seg = n ? C / n - gap : C;
  const center = SIZE / 2;

  const label = n === 0 ? "No devices yet" : `${protectedCount} of ${n} devices protected`;

  return (
    <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }} role="img" aria-label={label}>
      {/* Scanner sweep, clipped to the inside of the ring */}
      <div
        className="absolute rounded-full motion-safe:animate-[spin_9s_linear_infinite]"
        style={{
          inset: SIZE / 2 - R + STROKE,
          background: "conic-gradient(from 0deg, transparent 0deg 300deg, color-mix(in srgb, var(--color-secure) 22%, transparent) 360deg)",
        }}
        aria-hidden="true"
      />
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="relative" aria-hidden="true">
        {/* Dial ticks */}
        {Array.from({ length: 60 }, (_, i) => {
          const a = (i / 60) * 2 * Math.PI;
          const long = i % 5 === 0;
          const r1 = R + STROKE / 2 + 5;
          const r2 = r1 + (long ? 6 : 3);
          return (
            <line
              key={i}
              x1={center + r1 * Math.sin(a)}
              y1={center - r1 * Math.cos(a)}
              x2={center + r2 * Math.sin(a)}
              y2={center - r2 * Math.cos(a)}
              stroke="var(--color-edge)"
              strokeWidth={long ? 1.5 : 1}
            />
          );
        })}
        <circle cx={center} cy={center} r={R} fill="none" stroke="var(--color-raised)" strokeWidth={STROKE} />
        {n === 0 ? null : (
          devices.map((d, i) => (
            <circle
              key={d.id}
              cx={center}
              cy={center}
              r={R}
              fill="none"
              stroke={tone(d)}
              strokeWidth={STROKE}
              strokeDasharray={`${seg} ${C}`}
              transform={`rotate(${-90 + (360 / n) * i + (gap / C) * 180} ${center} ${center})`}
            >
              <title>{`${d.name}: ${d.status}${d.pausedReason ? ` (paused: ${d.pausedReason})` : ""}`}</title>
            </circle>
          ))
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center" aria-hidden="true">
        <span className="font-display text-4xl font-semibold leading-none tabular-nums">
          {protectedCount}
          <span className="text-dim">/{n}</span>
        </span>
        <span className="mt-1.5 text-xs text-dim">protected</span>
      </div>
    </div>
  );
}
