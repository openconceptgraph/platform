/** The OpenConceptGraph mark: dots hopping along a number line to an open ring. */
export function Mark({ width = 36 }: { width?: number }) {
  return (
    <svg width={width} height={(width * 2) / 3} viewBox="0 0 48 32" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeLinecap="round">
        <path d="M6 19.6 Q12.5 7 19 18.2" strokeWidth="2.6" />
        <path d="M19 18.2 Q28 1 37 15" strokeWidth="2.6" />
        <circle cx="37" cy="23" r="6.5" strokeWidth="3" />
      </g>
      <circle cx="6" cy="23" r="3.2" fill="currentColor" />
      <circle cx="19" cy="23" r="4.7" fill="currentColor" />
    </svg>
  );
}
