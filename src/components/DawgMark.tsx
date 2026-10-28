/** The dawg head mark, drawn with the current text colour. */
export function DawgMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 22c-.2-6 .2-12 2.5-15 1.7-2.3 4.5-3.4 6.7-1.8l1.4 1.2 5.2.7c1.4.2 1.8 2.2.5 2.8l-4.7 1c-.8.2-1 1.4-1.6 2.3-.8 1.2-1.4 2.8-1.4 4.8v4" />
      <path d="M8.4 5.7C6.7 7.5 6.4 11 7.4 13.4c.5 1.2 2 .8 2.2-.4l.5-5.9" />
      <circle cx="13.2" cy="7.8" r=".45" fill="currentColor" stroke="none" />
    </svg>
  );
}
