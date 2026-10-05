/** Inline SVG icon set (no icon-font dependency). 24px grid, currentColor. */

export function IconShuffle({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
      <path d="M3 6.5h3.2c1.5 0 2.6.7 3.4 1.9l4.8 7.2c.8 1.2 1.9 1.9 3.4 1.9H21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M3 17.5h3.2c1.5 0 2.6-.7 3.4-1.9l.9-1.4M14.6 9.8l.9-1.4c.8-1.2 1.9-1.9 3.4-1.9H21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M18.5 4l2.8 2.5-2.8 2.5M18.5 15l2.8 2.5-2.8 2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconShare({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
      <path d="M12 3.5v11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M8 7l4-3.5L16 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 12.5v6a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconSave({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
      <path d="M6 3.5h9.5L20 8v11.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M8 3.5v5h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="8" y="13" width="8" height="7" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

export function IconVibe({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
      <circle cx="7" cy="9" r="3.2" stroke="currentColor" strokeWidth="2" />
      <circle cx="17" cy="9" r="3.2" stroke="currentColor" strokeWidth="2" />
      <path d="M2.8 19c.8-3 2.4-4.5 4.2-4.5S10.4 16 11.2 19M12.8 19c.8-3 2.4-4.5 4.2-4.5s3.4 1.5 4.2 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconChevron({ size = 18, dir = "down" }: { size?: number; dir?: "up" | "down" | "left" | "right" }) {
  const rot = { up: 180, down: 0, left: 90, right: -90 }[dir];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden focusable="false" style={{ transform: `rotate(${rot}deg)` }}>
      <path d="M6 9.5l6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
