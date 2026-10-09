// Product mark: three stacked drive bays with an amber activity light.

export default function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--color-raised)" />
      <rect x="7" y="8" width="18" height="4" rx="1.5" fill="var(--color-dim)" />
      <rect x="7" y="14" width="18" height="4" rx="1.5" fill="var(--color-dim)" />
      <rect x="7" y="20" width="18" height="4" rx="1.5" fill="var(--color-dim)" />
      <circle cx="21.5" cy="22" r="1.4" fill="var(--color-signal)" />
    </svg>
  );
}