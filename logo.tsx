/** The INVECK wordmark: a brown cube dotting the "i". The letters follow the text colour, so it works in dark mode. */
export function Logo({ className = 'h-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 122 50" className={className} role="img" aria-label="Inveck">
      <Cube />
      <rect x="7.6" y="25.5" width="6.8" height="23" rx="0.6" fill="currentColor" />
      <text
        x="16.8"
        y="48.5"
        fill="currentColor"
        fontFamily="'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
        fontWeight="700"
        fontSize="37"
        letterSpacing="0.4"
      >
        nveck
      </text>
    </svg>
  );
}

function Cube() {
  return (
    <g strokeLinejoin="round">
      <polygon points="11,1 20.5,6.4 11,11.8 1.5,6.4" fill="#a77248" />
      <polygon points="1.5,6.4 11,11.8 11,22.6 1.5,17.2" fill="#6f4327" />
      <polygon points="11,11.8 20.5,6.4 20.5,17.2 11,22.6" fill="#8a5634" />
      <path d="M1.5 6.4 11 11.8 20.5 6.4 M11 11.8 V22.6" stroke="#f1d9bf" strokeWidth="1.1" fill="none" />
    </g>
  );
}
