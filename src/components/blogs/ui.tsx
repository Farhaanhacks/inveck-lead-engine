import type { ReactNode } from 'react';

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-border pb-5">
      <div className="min-w-0">
        <h1 className="text-[1.625rem] font-semibold leading-tight tracking-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function SectionTitle({ id, children, action }: { id?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <h2 id={id} className="section-title !mb-0">{children}</h2>
      {action}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1 rounded-[var(--radius)] border border-dashed border-border-strong bg-surface px-5 py-6">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children ? <div className="max-w-xl text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

const NOTICE = {
  info: { box: 'border-border bg-surface', icon: 'text-muted', path: 'M12 8h.01M11 12h1v5h1M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z' },
  ok: { box: 'border-ok/30 bg-ok-soft', icon: 'text-ok', path: 'm8.5 12.5 2.5 2.5 4.5-5M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z' },
  warn: { box: 'border-warn/35 bg-warn-soft', icon: 'text-warn', path: 'M12 9v4m0 3.5h.01M10.3 4.3 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z' },
  danger: { box: 'border-danger/35 bg-danger-soft', icon: 'text-danger', path: 'M12 8v4.5m0 3.5h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z' },
} as const;

export function Notice({ tone = 'info', title, children }: { tone?: keyof typeof NOTICE; title: string; children?: ReactNode }) {
  const t = NOTICE[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={`flex gap-3 rounded-[var(--radius)] border px-4 py-3 text-sm ${t.box}`}>
      <svg aria-hidden viewBox="0 0 24 24" className={`mt-0.5 size-[18px] shrink-0 ${t.icon}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={t.path} /></svg>
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        {children ? <div className="mt-0.5 text-muted">{children}</div> : null}
      </div>
    </div>
  );
}

const BADGE = {
  ok: 'bg-ok-soft text-ok ring-ok/25',
  warn: 'bg-warn-soft text-warn ring-warn/30',
  danger: 'bg-danger-soft text-danger ring-danger/25',
  neutral: 'bg-subtle text-muted ring-border',
} as const;

export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof BADGE; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${BADGE[tone]}`}>{children}</span>;
}

const STATUS_TONE: Record<string, keyof typeof BADGE> = {
  published: 'ok', completed: 'ok', ready: 'ok', approved: 'ok', uploaded: 'ok', generated: 'ok',
  failed: 'danger', blocked: 'danger', rejected: 'danger',
  delayed: 'warn', retrying: 'warn', pending: 'warn', scheduled: 'warn', running: 'warn', generating: 'warn', publishing: 'warn', queued: 'neutral',
};

/** Status as a coloured dot plus its word, so meaning never depends on colour alone. */
export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? 'neutral'}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {status.replace(/_/g, ' ')}
    </Badge>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card px-4 py-3.5">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold leading-none tracking-tight tabular-nums">{value}</p>
      {hint ? <p className="mt-1.5 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="card table-wrap overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr>{head.map((h, i) => <th key={`${h}-${i}`} className="border-b border-border px-4 py-2.5">{h}</th>)}</tr>
        </thead>
        <tbody className="[&_td]:border-b [&_td]:border-border [&_tr:last-child_td]:border-b-0">{children}</tbody>
      </table>
    </div>
  );
}

const DOT = { ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger', neutral: 'bg-muted/60' } as const;

/**
 * One status line from src/lib/status.ts: a dot (pulsing only while a worker is actually on it), the label, and an optional
 * detail. Rendered inside a polite live region so screen readers hear changes after a refresh.
 */
export function StateLine({ state, at }: { state: { label: string; tone: keyof typeof DOT; detail?: string; live?: boolean }; at?: string }) {
  return (
    <div aria-live="polite" className="min-w-0">
      <p className="flex items-center gap-2 text-sm font-medium">
        <span aria-hidden className="relative flex size-2 shrink-0">
          {state.live ? <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none ${DOT[state.tone]}`} /> : null}
          <span className={`relative inline-flex size-2 rounded-full ${DOT[state.tone]}`} />
        </span>
        <span>{state.label}{at ? <span className="font-normal text-muted"> · {at}</span> : null}</span>
      </p>
      {state.detail ? <p className="mt-0.5 text-xs text-muted">{state.detail}</p> : null}
    </div>
  );
}

const STEPS = ['research', 'planning', 'writing', 'seo', 'validation', 'image'] as const;
const STEP_LABEL: Record<string, string> = { research: 'Research', planning: 'Outline', writing: 'Writing', seo: 'SEO', validation: 'Checks', image: 'Image' };

/**
 * The six pipeline steps with the current one marked. The current step takes the colour of the job's state (amber for waiting or
 * running, red only for a real failure or block), so "waiting for review" never looks like an error.
 */
export function StageSteps({ stage, tone = 'warn', compact = false }: { stage: string; status?: string; tone?: keyof typeof DOT; compact?: boolean }) {
  const idx = stage === 'done' ? STEPS.length : STEPS.indexOf(stage as (typeof STEPS)[number]);
  const current = { ok: 'bg-ok/15 text-ok ring-ok/25', warn: 'bg-warn-soft text-warn ring-warn/30', danger: 'bg-danger-soft text-danger ring-danger/30', neutral: 'bg-subtle text-muted ring-border' }[tone];
  const label = `Step ${Math.min(idx + 1, STEPS.length)} of ${STEPS.length}: ${STEP_LABEL[stage] ?? 'Complete'}`;
  if (compact) {
    const bar = { ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger', neutral: 'bg-muted/50' }[tone];
    return (
      <div aria-label={label} role="img" className="min-w-[7rem]">
        <div className="flex gap-0.5">{STEPS.map((s, i) => <span key={s} className={`h-1.5 flex-1 rounded-full ${i < idx ? 'bg-ok' : i === idx ? bar : 'bg-border'}`} />)}</div>
        <p className="mt-1 text-xs text-muted">{STEP_LABEL[stage] ?? 'Complete'}</p>
      </div>
    );
  }
  return (
    <ol aria-label={label} className="flex flex-wrap items-center gap-1">
      {STEPS.map((s, i) => (
        <li key={s} aria-current={i === idx ? 'step' : undefined} className={`rounded-md px-1.5 py-0.5 text-[0.6875rem] font-medium ring-1 ring-inset ${i < idx ? 'bg-ok/15 text-ok ring-ok/25' : i === idx ? current : 'bg-subtle text-muted/70 ring-border'}`}>
          {STEP_LABEL[s]}
        </li>
      ))}
    </ol>
  );
}
