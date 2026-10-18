'use client';
import { useEffect, useRef, useState, useTransition } from 'react';
import { createPostAction, deletePostAction, movePostAction, updatePostAction } from '@/app/marketing-actions';
import { addDays, CONTENT_PLATFORMS, CONTENT_STATUSES, FORMAT_LABEL, FORMATS, monthWeeks, PLATFORM_LABEL, STATUS_LABEL, weekOf, type ContentPlatform, type ContentStatus, type PostView } from '@/lib/content-meta';

const STATUS_TONE: Record<ContentStatus, string> = {
  draft: 'bg-neutral-soft text-ink-2',
  pending_approval: 'bg-warning-soft text-warning-ink',
  approved: 'bg-teal-soft text-teal',
  scheduled: 'bg-violet-soft text-violet',
  waiting_dependency: 'bg-critical-soft text-critical-ink',
  posted: 'bg-good-soft text-good-ink',
};
const STATUS_DOT: Record<ContentStatus, string> = { draft: 'bg-muted', pending_approval: 'bg-warning-ink', approved: 'bg-teal', scheduled: 'bg-violet', waiting_dependency: 'bg-critical-ink', posted: 'bg-good-ink' };
const PLATFORM_TONE: Record<ContentPlatform, string> = { instagram: 'bg-rose text-accent-ink', linkedin: 'bg-accent text-accent-ink' };
/** Each card is tinted by its platform, with a coloured edge. */
const CARD_TONE: Record<ContentPlatform, string> = { instagram: 'border-l-rose bg-rose-soft/75', linkedin: 'border-l-accent bg-accent-soft/75' };
const PLATFORM_SHORT: Record<ContentPlatform, string> = { instagram: 'IG', linkedin: 'in' };

const fmt = (day: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', ...opts }).format(new Date(`${day}T12:00:00Z`));
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type Draft = { id: number | null; title: string; platform: ContentPlatform; format: string; caption: string; scheduledOn: string; status: ContentStatus; dependencyNote: string; postedAt: string | null };
const blank = (scheduledOn = ''): Draft => ({ id: null, title: '', platform: 'instagram', format: 'post', caption: '', scheduledOn, status: 'draft', dependencyNote: '', postedAt: null });

export function CalendarBoard({ initialPosts, today }: { initialPosts: PostView[]; today: string }) {
  const [posts, setPosts] = useState(initialPosts);
  const [cursor, setCursor] = useState(today);
  const [view, setView] = useState<'month' | 'week'>('month');
  const [editor, setEditor] = useState<Draft | null>(null);
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState<number | null>(null);
  const [overDay, setOverDay] = useState('');
  const [, start] = useTransition();

  const put = (p: PostView) => setPosts((all) => (all.some((x) => x.id === p.id) ? all.map((x) => (x.id === p.id ? p : x)) : [...all, p]));
  const byId = (id: number) => posts.find((p) => p.id === id);

  /** Moves a post to a date ('' = back to the drafts list). The server has the last word; a refusal is shown, never swallowed. */
  const move = (id: number, date: string) => {
    const post = byId(id);
    if (!post || post.scheduledOn === date) return;
    setNotice('');
    setPosts((all) => all.map((p) => (p.id === id ? { ...p, scheduledOn: date } : p)));
    start(async () => {
      const r = await movePostAction(id, date);
      if (r.ok) put(r.post);
      else {
        setPosts((all) => all.map((p) => (p.id === id ? post : p)));
        setNotice(r.error);
      }
    });
  };

  const setStatus = (id: number, status: ContentStatus) => {
    setNotice('');
    start(async () => {
      const r = await updatePostAction(id, { status });
      if (r.ok) put(r.post);
      else setNotice(r.error);
    });
  };

  const onDrop = (date: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData('text/plain') || dragging);
    setDragging(null);
    setOverDay('');
    if (id) move(id, date);
  };
  const over = (e: React.DragEvent) => e.preventDefault();

  const weeks = view === 'month' ? monthWeeks(Number(cursor.slice(0, 4)), Number(cursor.slice(5, 7)) - 1) : [weekOf(cursor)];
  const step = (dir: 1 | -1) => {
    if (view === 'week') return setCursor(addDays(cursor, 7 * dir));
    const d = new Date(`${cursor.slice(0, 7)}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + dir);
    setCursor(d.toISOString().slice(0, 10));
  };
  const unscheduled = posts.filter((p) => !p.scheduledOn);
  const count = (st: ContentStatus) => posts.filter((p) => p.status === st).length;
  const stats: { label: string; value: number; tone: string }[] = [
    { label: 'Posted', value: count('posted'), tone: 'bg-good-soft/70 text-good-ink' },
    { label: 'Scheduled', value: count('scheduled'), tone: 'bg-violet-soft/70 text-violet' },
    { label: 'In review', value: count('pending_approval') + count('approved'), tone: 'bg-teal-soft/70 text-teal' },
    { label: 'Drafts', value: count('draft') + count('waiting_dependency'), tone: 'bg-warning-soft/70 text-warning-ink' },
  ];
  const title = view === 'month' ? fmt(cursor, { month: 'long', year: 'numeric' }) : `${fmt(weeks[0][0], { day: 'numeric', month: 'short' })} – ${fmt(weeks[0][6], { day: 'numeric', month: 'short', year: 'numeric' })}`;

  return (
    <>
      <header className="glass mb-5 overflow-hidden rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Content Calendar</h1>
            <p className="mt-1 text-sm text-ink-2">Plan, approve and post across Instagram and LinkedIn.</p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs font-medium">
              <span className="glass-tint inline-flex items-center gap-1.5 rounded-full bg-surface/60 px-2.5 py-1"><span className="h-2 w-2 rounded-full bg-rose" />Instagram</span>
              <span className="glass-tint inline-flex items-center gap-1.5 rounded-full bg-surface/60 px-2.5 py-1"><span className="h-2 w-2 rounded-full bg-accent" />LinkedIn</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {stats.map((x) => (
              <div key={x.label} className={`glass-tint min-w-24 rounded-xl px-3 py-2 ${x.tone}`}>
                <div className="text-2xl font-bold tabular-nums leading-none">{x.value}</div>
                <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide opacity-80">{x.label}</div>
              </div>
            ))}
          </div>
        </div>
      </header>
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* Content with no date yet: drag a card onto a day, or drop a scheduled one here to take its date off. */}
      <aside className="lg:w-72 lg:shrink-0" onDragOver={over} onDrop={onDrop('')} aria-label="Content with no date">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Drafts <span className="ml-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent tabular-nums">{unscheduled.length}</span></h2>
          <button type="button" className="btn-primary rounded-full px-3.5 py-1 text-sm" onClick={() => setEditor(blank())}>+ New content</button>
        </div>
        <div className="glass space-y-2 rounded-2xl p-2 lg:max-h-[75vh] lg:overflow-y-auto">
          {unscheduled.length === 0 && <p className="px-2 py-4 text-center text-xs text-muted">No unscheduled content. Create one, or drop a post here to take its date off.</p>}
          {unscheduled.map((p) => (
            <Card key={p.id} post={p} onOpen={() => setEditor({ ...p })} onStatus={setStatus} onDragStart={setDragging} />
          ))}
        </div>
      </aside>

      <section className="min-w-0 flex-1">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary px-2.5 py-1" onClick={() => step(-1)} aria-label={view === 'month' ? 'Previous month' : 'Previous week'}>‹</button>
            <h2 className="min-w-44 text-center text-lg font-semibold tracking-tight">{title}</h2>
            <button type="button" className="btn-secondary px-2.5 py-1" onClick={() => step(1)} aria-label={view === 'month' ? 'Next month' : 'Next week'}>›</button>
            <button type="button" className="btn-secondary px-3 py-1 text-sm" onClick={() => setCursor(today)}>Today</button>
          </div>
          <div className="inline-flex gap-1 rounded-full bg-surface-2 p-1" role="group" aria-label="View">
            {(['month', 'week'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className={`rounded-full px-3.5 py-1 text-sm transition ${view === v ? 'bg-surface font-semibold text-accent shadow-sm' : 'text-ink-2 hover:text-ink'}`}>
                {v === 'month' ? 'Month' : 'Week'}
              </button>
            ))}
          </div>
        </div>
        {notice && (
          <p role="alert" className="mb-3 rounded-md border border-line bg-critical-soft px-3 py-2 text-sm text-critical-ink">
            {notice}
          </p>
        )}
        <div className="overflow-x-auto">
          <div className="glass min-w-[760px] overflow-hidden rounded-2xl">
            <div className="grid grid-cols-7 bg-accent-soft/60 text-[11px] font-semibold uppercase tracking-wider text-accent">
              {DOW.map((d) => (
                <div key={d} className="px-2.5 py-2.5">{d}</div>
              ))}
            </div>
            {weeks.map((week) => (
              <div key={week[0]} className="grid grid-cols-7 border-t border-line">
                {week.map((day) => {
                  const inMonth = view === 'week' || day.slice(0, 7) === cursor.slice(0, 7);
                  const list = posts.filter((p) => p.scheduledOn === day);
                  const weekend = [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
                  return (
                    <div
                      key={day}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (overDay !== day) setOverDay(day);
                      }}
                      onDragLeave={() => overDay === day && setOverDay('')}
                      onDrop={onDrop(day)}
                      className={`${view === 'week' ? 'min-h-80' : 'min-h-32'} space-y-1.5 border-l border-line/50 p-1.5 transition first:border-l-0 ${
                        overDay === day ? 'bg-accent-soft/80 ring-2 ring-inset ring-accent' : day === today ? 'bg-accent-soft/50' : !inMonth ? 'bg-surface-2/30 opacity-60' : weekend ? 'bg-neutral-soft/40' : 'bg-surface/30'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs tabular-nums ${day === today ? 'bg-accent font-bold text-accent-ink shadow' : inMonth ? 'font-medium text-ink-2' : 'text-muted'}`}>
                          {Number(day.slice(8))}
                        </span>
                        <button type="button" className="rounded-full px-1.5 text-sm text-muted opacity-40 transition hover:bg-accent-soft hover:text-accent hover:opacity-100 focus:opacity-100" aria-label={`Add content on ${fmt(day, { day: 'numeric', month: 'long' })}`} onClick={() => setEditor(blank(day))}>
                          +
                        </button>
                      </div>
                      {list.map((p) => (
                        <Card key={p.id} post={p} compact onOpen={() => setEditor({ ...p })} onStatus={setStatus} onDragStart={setDragging} />
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <p className="mt-2 text-xs text-muted">Drag a card to another day to move it, or open it and choose a date. Moving a post never changes its status, and changing its status never takes its date off.</p>
      </section>

      {editor && (
        <Editor
          key={editor.id ?? `new-${editor.scheduledOn}`}
          draft={editor}
          onClose={() => setEditor(null)}
          onSaved={(p) => {
            put(p);
            setEditor(null);
            setNotice('');
          }}
          onDeleted={(id) => {
            setPosts((all) => all.filter((p) => p.id !== id));
            setEditor(null);
          }}
        />
      )}
    </div>
    </>
  );
}

/** A post on the calendar or in the drafts list: platform, format, title, its status (changeable here) and, in the drafts list, that it has no date. */
function Card({ post, compact, onOpen, onStatus, onDragStart }: { post: PostView; compact?: boolean; onOpen: () => void; onStatus: (id: number, s: ContentStatus) => void; onDragStart: (id: number | null) => void }) {
  const posted = post.status === 'posted';
  return (
    <div
      draggable={!posted}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(post.id));
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(post.id);
      }}
      onDragEnd={() => onDragStart(null)}
      className={`glass-tint rounded-lg border-l-4 p-2 text-xs transition hover:-translate-y-0.5 ${CARD_TONE[post.platform]} ${posted ? 'opacity-90' : 'cursor-grab active:cursor-grabbing'}`}
    >
      <div className="flex flex-wrap items-center gap-1">
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${PLATFORM_TONE[post.platform]}`} title={PLATFORM_LABEL[post.platform]}>
          {PLATFORM_SHORT[post.platform]}
        </span>
        <span className="text-[11px] text-muted">{PLATFORM_LABEL[post.platform]} · {FORMAT_LABEL(post.format)}</span>
      </div>
      <button type="button" onClick={onOpen} className="mt-1 block w-full text-left text-sm font-medium hover:underline">
        {post.title}
      </button>
      {!compact && <p className="mt-0.5 text-[11px] text-muted">{post.scheduledOn ? fmt(post.scheduledOn, { day: 'numeric', month: 'short' }) : 'No date yet'}</p>}
      {post.status === 'waiting_dependency' && post.dependencyNote && <p className="mt-0.5 text-[11px] text-critical-ink">Waiting: {post.dependencyNote}</p>}
      <label className="mt-1.5 flex items-center gap-1.5">
        <span className="sr-only">Status of {post.title}</span>
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[post.status]}`} />
        <select value={post.status} onChange={(e) => onStatus(post.id, e.target.value as ContentStatus)} className={`min-w-0 flex-1 rounded-full border-0 px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[post.status]}`}>
          {CONTENT_STATUSES.map((s) => (
            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

function Editor({ draft, onClose, onSaved, onDeleted }: { draft: Draft; onClose: () => void; onSaved: (p: PostView) => void; onDeleted: (id: number) => void }) {
  const [f, setF] = useState(draft);
  const [error, setError] = useState('');
  const [busy, start] = useTransition();
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setF((x) => ({ ...x, [k]: v }));
  const posted = draft.status === 'posted';

  const save = () => {
    setError('');
    const body = { title: f.title, platform: f.platform, format: f.format, caption: f.caption, scheduledOn: f.scheduledOn, status: f.status, dependencyNote: f.dependencyNote };
    start(async () => {
      const r = f.id === null ? await createPostAction(body) : await updatePostAction(f.id, body);
      if (r.ok) onSaved(r.post);
      else setError(r.error);
    });
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={f.id === null ? 'New content' : 'Edit content'}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="card mt-8 w-full max-w-xl space-y-4 p-5"
      >
        <h2 className="text-base font-semibold">{f.id === null ? 'New content' : 'Edit content'}</h2>
        <div>
          <label htmlFor="c-title" className="label">Title or working name</label>
          <input id="c-title" ref={first} value={f.title} onChange={(e) => set('title', e.target.value)} required maxLength={160} className="field" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="c-platform" className="label">Platform</label>
            <select
              id="c-platform"
              value={f.platform}
              onChange={(e) => {
                const platform = e.target.value as ContentPlatform;
                setF((x) => ({ ...x, platform, format: FORMATS[platform].includes(x.format) ? x.format : 'post' }));
              }}
              className="field"
            >
              {CONTENT_PLATFORMS.map((p) => (
                <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="c-format" className="label">Format</label>
            <select id="c-format" value={f.format} onChange={(e) => set('format', e.target.value)} className="field">
              {FORMATS[f.platform].map((x) => (
                <option key={x} value={x}>{FORMAT_LABEL(x)}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label htmlFor="c-caption" className="label">Caption or draft copy</label>
          <textarea id="c-caption" value={f.caption} onChange={(e) => set('caption', e.target.value)} rows={6} maxLength={5000} className="field leading-relaxed" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="c-status" className="label">Status</label>
            <select id="c-status" value={f.status} onChange={(e) => set('status', e.target.value as ContentStatus)} className="field">
              {CONTENT_STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="c-date" className="label">Scheduled date</label>
            <input id="c-date" type="date" value={f.scheduledOn} onChange={(e) => set('scheduledOn', e.target.value)} disabled={posted} className="field" />
            <p className="mt-1 text-xs text-muted">{posted ? 'Posted: mark it as not posted to change the date.' : 'Empty keeps it in Drafts. The status stays as it is.'}</p>
          </div>
        </div>
        {(f.status === 'waiting_dependency' || f.dependencyNote) && (
          <div>
            <label htmlFor="c-dep" className="label">{f.status === 'waiting_dependency' ? 'What is it waiting for?' : 'Dependency note (kept)'}</label>
            <input id="c-dep" value={f.dependencyNote} onChange={(e) => set('dependencyNote', e.target.value)} maxLength={300} placeholder="e.g. waiting for the product photos" className="field" />
          </div>
        )}
        {f.postedAt && <p className="text-xs text-good-ink">Posted on {new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(f.postedAt))}.</p>}
        {error && <p role="alert" className="text-sm text-critical-ink">{error}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          </div>
          {f.id !== null && (
            <button
              type="button"
              className="btn-danger"
              disabled={busy}
              onClick={() => {
                if (!window.confirm('Delete this content for good?')) return;
                start(async () => {
                  await deletePostAction(f.id!);
                  onDeleted(f.id!);
                });
              }}
            >
              Delete
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
