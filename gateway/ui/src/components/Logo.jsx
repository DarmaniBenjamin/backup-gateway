// Product mark: a shield around a locked vault door. Cyan = encryption, green = protected.

export default function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M16 2.5 27 6.5v8.2c0 6.6-4.6 12.2-11 14.8C9.6 26.9 5 21.3 5 14.7V6.5L16 2.5Z"
        fill="var(--color-raised)"
        stroke="var(--color-secure)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="14.5" r="5.2" fill="none" stroke="var(--color-dim)" strokeWidth="1.4" />
      <circle cx="16" cy="13.4" r="1.6" fill="var(--color-good)" />
      <path d="M15.2 14.4h1.6l.5 3.2h-2.6l.5-3.2Z" fill="var(--color-good)" />
    </svg>
  );
}
