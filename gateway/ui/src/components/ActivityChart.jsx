// Backup activity over time: one bar per time slot, showing how many files were added/changed
// and deleted. A ransomware attack shows up as a sudden tall bar.
// Hover a bar to see its numbers; click it to restore to just before that moment.

import { useMemo, useState } from "react";

const HEIGHT = 150;
const GAP = 2; // surface gap between bars and between stacked segments

// A bar whose top corners are rounded and whose bottom sits flat on the baseline
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
    const totals = buckets.map((b) => b.added + b.changed + b.deleted);
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
              const changes = b.added + b.changed;
              const hChange = scale(changes);
              const hDelete = scale(b.deleted);
              const deleteTop = HEIGHT - hChange - (hChange > 0 && hDelete > 0 ? GAP : 0) - hDelete;
              return (
                <g key={b.start}>
                  {hChange > 0 && (
                    <path
                      d={topRoundedRect(x, HEIGHT - hChange, w, hChange, hDelete > 0 ? 0 : 3)}
                      fill="var(--color-series-change)"
                      opacity={hover == null || hover === i ? 1 : 0.55}
                    />
                  )}
                  {hDelete > 0 && (
                    <path
                      d={topRoundedRect(x, deleteTop, w, hDelete, 3)}
                      fill="var(--color-series-delete)"
                      opacity={hover == null || hover === i ? 1 : 0.55}
                    />
                  )}
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
              <p className="mt-1.5 flex items-center justify-between text-dim">
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-sm bg-series-change" />
                  Added or changed
                </span>
                <span className="text-fg">{hovered.added + hovered.changed}</span>
              </p>
              <p className="mt-1 flex items-center justify-between text-dim">
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-sm bg-series-delete" />
                  Deleted
                </span>
                <span className="text-fg">{hovered.deleted}</span>
              </p>
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
        <span className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-sm bg-series-change" aria-hidden="true" />
          Added or changed
        </span>
        <span className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-sm bg-series-delete" aria-hidden="true" />
          Deleted
        </span>
        <span className="flex items-center gap-2">
          <span className="h-3 w-0.5 bg-signal" aria-hidden="true" />
          Restore point
        </span>
      </div>
    </div>
  );
}