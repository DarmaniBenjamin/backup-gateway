// Donut of device states: protected (green), paused (amber), frozen or offline (red),
// never connected (grey). The number of protected devices sits in the middle.

const SIZE = 156;
const R = 62;
const STROKE = 14;
const C = 2 * Math.PI * R;

export default function StatusDonut({ parts }) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  const shown = parts.filter((p) => p.value > 0);
  const gap = shown.length > 1 ? 6 : 0;
  let offset = 0;
  const protectedCount = parts.find((p) => p.key === "protected")?.value ?? 0;

  return (
    <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={`${protectedCount} of ${total} devices protected`}>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="var(--color-raised)" strokeWidth={STROKE} />
        {shown.map((p) => {
          const len = (p.value / total) * C;
          const dash = Math.max(len - gap, 1);
          const el = (
            <circle
              key={p.key}
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={R}
              fill="none"
              stroke={p.color}
              strokeWidth={STROKE}
              strokeLinecap={shown.length > 1 ? "round" : "butt"}
              strokeDasharray={`${dash} ${C}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            />
          );
          offset += len;
          return el;
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center" aria-hidden="true">
        <span className="font-display text-3xl font-semibold tabular-nums">
          {protectedCount}
          <span className="text-dim">/{total}</span>
        </span>
        <span className="text-xs text-dim">protected</span>
      </div>
    </div>
  );
}
