const W = { fill: 'none', stroke: '#fff', strokeOpacity: 0.92, strokeLinecap: 'round' as const };

export function BrandLogo({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="brand-logo">
      <defs>
        <linearGradient id="bl-pink" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ff7ab6" /><stop offset="1" stopColor="#e5307a" /></linearGradient>
        <linearGradient id="bl-cyan" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#46e6ff" /><stop offset="1" stopColor="#3b6dff" /></linearGradient>
        <linearGradient id="bl-amber" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffd85a" /><stop offset="1" stopColor="#ff7a2b" /></linearGradient>
        <linearGradient id="bl-lime" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b4f56a" /><stop offset="1" stopColor="#22c98d" /></linearGradient>
        <linearGradient id="bl-shelf" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#b46bff" /><stop offset="1" stopColor="#46e6ff" /></linearGradient>
      </defs>
      <g className="bl-case bl-c1" transform="rotate(-12 15 49)">
        <rect x="9" y="25" width="11" height="24" rx="3" fill="url(#bl-pink)" />
        <path d="M14.5 30.5l3.2 5.4h-6.4z" fill="#fff" fillOpacity=".92" />
      </g>
      <g className="bl-case bl-c2">
        <rect x="21" y="13" width="12" height="36" rx="3" fill="url(#bl-cyan)" />
        <circle cx="27" cy="20" r="2.7" strokeWidth="1.7" {...W} />
      </g>
      <g className="bl-case bl-c3">
        <rect x="35" y="20" width="11" height="29" rx="3" fill="url(#bl-amber)" />
        <path d="M38.3 24.3l4.4 4.4M42.7 24.3l-4.4 4.4" strokeWidth="1.7" {...W} />
      </g>
      <g className="bl-case bl-c4" transform="rotate(14 49 49)">
        <rect x="47" y="29" width="10" height="20" rx="3" fill="url(#bl-lime)" />
        <rect x="50" y="33" width="4" height="4" rx=".8" strokeWidth="1.5" {...W} />
      </g>
      <path d="M5 50Q32 58.5 59 50" fill="none" stroke="url(#bl-shelf)" strokeWidth="4.5" strokeLinecap="round" />
      <path className="bl-spark" d="M55 4.5l1.7 4.6 4.6 1.7-4.6 1.7L55 17.1l-1.7-4.6-4.6-1.7 4.6-1.7z" fill="#ffe066" />
    </svg>
  );
}
