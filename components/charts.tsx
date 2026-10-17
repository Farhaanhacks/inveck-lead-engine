import type { FunnelStep, Week } from '@/lib/analytics';

/** Funnel as horizontal bars, one hue; each row shows its count and the conversion from the step before. */
export function Funnel({ steps }: { steps: FunnelStep[] }) {
  const max = Math.max(1, ...steps.map((s) => s.value));
  return (
    <ol className="space-y-2.5">
      {steps.map((s) => (
        <li key={s.label} className="grid grid-cols-[6.5rem_1fr_3rem] items-center gap-3 sm:grid-cols-[7rem_1fr_2.5rem_9rem]" title={`${s.label}: ${s.value}${s.rate != null ? ` (${s.rate}% ${s.of})` : ''}`}>
          <span className="text-sm text-ink-2">{s.label}</span>
          <span className="h-3.5 rounded-r-[4px] bg-bar" style={{ width: s.value ? `max(4px, ${(s.value / max) * 100}%)` : 0 }} />
          <span className="text-right text-sm font-medium tabular-nums">{s.value}</span>
          <span className="hidden text-xs text-muted tabular-nums sm:block">{s.rate != null ? `${s.rate}% ${s.of}` : ''}</span>
        </li>
      ))}
    </ol>
  );
}

/** One weekly series as columns. Small multiples share `max` so they compare honestly. */
export function WeeklyColumns({ title, weeks, pick, max }: { title: string; weeks: Week[]; pick: (w: Week) => number; max: number }) {
  const W = 240;
  const H = 100;
  const top = 16;
  const bottom = 20;
  const slot = W / weeks.length;
  const bar = Math.min(22, slot * 0.6);
  const scale = (v: number) => (v / Math.max(1, max)) * (H - top - bottom);
  const values = weeks.map(pick);
  const total = values.reduce((a, b) => a + b, 0);
  const peak = values.indexOf(Math.max(...values));
  return (
    <figure>
      <figcaption className="mb-1 flex items-baseline justify-between text-xs">
        <span className="font-medium text-ink-2">{title}</span>
        <span className="text-muted tabular-nums">{total} in 8 weeks</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title}: ${weeks.map((w, i) => `${w.label} ${values[i]}`).join(', ')}`}>
        <line x1="0" x2={W} y1={H - bottom} y2={H - bottom} className="stroke-line" strokeWidth="1" />
        {weeks.map((w, i) => {
          const v = values[i];
          const h = v ? Math.max(3, scale(v)) : 0;
          const x = i * slot + (slot - bar) / 2;
          const y = H - bottom - h;
          const label = i === weeks.length - 1 || (i === peak && v > 0);
          return (
            <g key={w.label}>
              <title>{`Week of ${w.label}: ${v}`}</title>
              {/* Hit target taller than the bar. */}
              <rect x={i * slot} y={0} width={slot} height={H - bottom} fill="transparent" />
              {h > 0 && <path d={`M${x},${H - bottom} V${y + 3} Q${x},${y} ${x + 3},${y} H${x + bar - 3} Q${x + bar},${y} ${x + bar},${y + 3} V${H - bottom} Z`} className="fill-bar" />}
              {label && (
                <text x={x + bar / 2} y={y - 4} textAnchor="middle" className="fill-ink text-[10px] tabular-nums">
                  {v}
                </text>
              )}
              {i % 2 === (weeks.length - 1) % 2 && (
                <text x={i * slot + slot / 2} y={H - 5} textAnchor="middle" className="fill-muted text-[8px]">
                  {w.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
