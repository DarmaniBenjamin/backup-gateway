// Backup activity over time: one bar per time slot, showing how many files were added/changed,
// deleted, and held back by the quarantine engine. A ransomware attack shows up as a sudden
// tall bar, mostly in the quarantine colour.
// Hover a bar to see its numbers; click it to restore to just before that moment.

import { useMemo, useState } from "react";

const HEIGHT = 150;
const GAP = 2; // surface gap between bars and between stacked segments

// Stacked bottom to top. Only the top segment of each bar gets rounded corners.
const SERIES = [
  { key: "change", label: "Added or changed", fill: "var(--color-series-change)", swatch: "bg-series-change", value: (b) => b.added + b.changed },
  { key: "delete", label: "Deleted", fill: "var(--color-series-delete)", swatch: "bg-series-delete", value: (b) => b.deleted },
  { key: "quarantine", label: "Quarantined", fill: "var(--color-series-quarantine)", swatch: "bg-series-quarantine", value: (b) => b.quarantined ?? 0 },
];

// A bar whose top corners are rounded and whose bottom sits flat
function topRoundedRect(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

function niceMax(n) {
  if (n <= 5) return 5;
  const pow = 10 ** Math.floor(Math.log10(n));
  return Math.ceil(n / pow) * pow;
}

function formatSlot(startIso, minutes) {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + minutes * 60000);
  const day = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const t = (d) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day}, ${t(start)} to ${t(end)}`;
}

export default function ActivityChart({ buckets, bucketMinutes, selectedAt, onSelect }) {
  const [hover, setHover] = useState(null);

  const { max, slot } = useMemo(() => {
    const totals = buckets.map((b) => SERIES.reduce((n, s) => n + s.value(b), 0));
    return { max: niceMax(Math.max(0, ...totals)), slot: 10 };
  }, [buckets]);

  const width = buckets.length * slot;
  const scale = (n) => (n / max) * (HEIGHT - 4);
  const selectedIndex =
    selectedAt == null
      ? -1
      : buckets.findIndex((b) => new Date(b.start).getTime() - 1 === new Date(selectedAt).getTime());

  const ticks = [0, Math.floor(buckets.length / 2), buckets.length - 1].filter((i, n, a) => a.indexOf(i) === n);
  const tickLabel = (iso) => {
    const d = new Date(iso);
    return bucketMinutes >= 120
      ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  };

  const hovered = hover != null ? buckets[hover] : null;

  return (
    <div>
      <div className="flex gap-3">
        {/* y-axis: just the top value and zero, the grid stays recessive */}
        <div className="flex w-8 shrink-0 flex-col justify-between text-right text-xs text-dim" style={{ height: HEIGHT }}>
          <span>{max}</span>
          <span>0</span>
        </div>
        <div className="relative min-w-0 flex-1">
          <svg
            viewBox={`0 0 ${width} ${HEIGHT}`}
            preserveAspectRatio="none"
            className="block w-full"
            style={{ height: HEIGHT }}
            role="img"
            aria-label="Files changed per time slot"
            onMouseLeave={() => setHover(null)}
          >
            <line x1="0" x2={width} y1="0.5" y2="0.5" stroke="var(--color-edge)" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
            <line x1="0" x2={width} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} stroke="var(--color-edge)" vectorEffect="non-scaling-stroke" />
            {buckets.map((b, i) => {
              const x = i * slot + GAP / 2;
              const w = slot - GAP;
              const parts = SERIES.map((s) => ({ ...s, h: scale(s.value(b)) })).filter((p) => p.h > 0);
              let top = HEIGHT;
              return (
                <g key={b.start}>
                  {parts.map((p, n) => {
                    if (n > 0) top -= GAP; // surface gap between stacked segments
                    top -= p.h;
                    const isTop = n === parts.length - 1;
                    return (
                      <path
                        key={p.key}
                        d={topRoundedRect(x, top, w, p.h, isTop ? 3 : 0)}
                        fill={p.fill}
                        opacity={hover == null || hover === i ? 1 : 0.55}
                      />
                    );
                  })}
                  {i === selectedIndex && (
                    <line x1={i * slot} x2={i * slot} y1="0" y2={HEIGHT} stroke="var(--color-signal)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                  )}
                  {/* full-height hit area, bigger than the bar */}
                  <rect
                    x={i * slot}
                    y="0"
                    width={slot}
                    height={HEIGHT}
                    fill="transparent"
                    className="cursor-pointer"
                    onMouseEnter={() => setHover(i)}
                    onClick={() => onSelect(new Date(new Date(b.start).getTime() - 1).toISOString())}
                  />
                </g>
              );
            })}
          </svg>
          {hovered && (
            <div
              className="pointer-events-none absolute top-0 z-10 w-56 rounded-md border border-edge bg-raised px-3 py-2 text-xs shadow-xl"
              style={{
                left: `${((hover + 0.5) / buckets.length) * 100}%`,
                transform: hover > buckets.length * 0.6 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
              }}
            >
              <p className="font-medium text-fg">{formatSlot(hovered.start, bucketMinutes)}</p>
              {SERIES.map((s, n) => (
                <p key={s.key} className={`${n === 0 ? "mt-1.5" : "mt-1"} flex items-center justify-between text-dim`}>
                  <span className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-sm ${s.swatch}`} />
                    {s.label}
                  </span>
                  <span className="text-fg">{s.value(hovered)}</span>
                </p>
              ))}
              <p className="mt-2 text-dim">Click to restore to just before this.</p>
            </div>
          )}
          <div className="relative mt-2 h-4 text-xs text-dim">
            {ticks.map((i) => (
              <span
                key={i}
                className="absolute whitespace-nowrap"
                style={{
                  left: `${(i / buckets.length) * 100}%`,
                  transform: i === 0 ? "none" : i === buckets.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
                }}
              >
                {tickLabel(buckets[i].start)}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-dim">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-sm ${s.swatch}`} aria-hidden="true" />
            {s.label}
          </span>
        ))}
        <span className="flex items-center gap-2">
          <span className="h-3 w-0.5 bg-signal" aria-hidden="true" />
          Restore point
        </span>
      </div>
    </div>
  );
}