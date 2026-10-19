'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PlatformLogo } from '@/components/platform-logo';
import { CONTENT_PLATFORMS, CONTENT_STATUSES, FORMAT_LABEL, PLATFORM_LABEL, STATUS_LABEL, type ContentPlatform, type ContentStatus, type PersonView, type PostView } from '@/lib/content-meta';

const fmt = (day: string) => (day ? new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${day}T12:00:00Z`)) : 'Not scheduled');

export function ContentBank({ posts, people }: { posts: PostView[]; people: PersonView[] }) {
  const [platform, setPlatform] = useState<'' | ContentPlatform>('');
  const [status, setStatus] = useState<'' | ContentStatus>('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<PostView | null>(null);
  const who = (id: number | null) => people.find((p) => p.id === id)?.name ?? '';
  const needle = q.trim().toLowerCase();
  const shown = posts.filter((p) => (!platform || p.platform === platform) && (!status || p.status === status) && (!needle || p.title.toLowerCase().includes(needle) || p.caption.toLowerCase().includes(needle)));

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label htmlFor="cb-q" className="sr-only">Search</label>
        <input id="cb-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title or draft" className="field h-9 w-56 py-1.5" />
        <label htmlFor="cb-platform" className="sr-only">Platform</label>
        <select id="cb-platform" value={platform} onChange={(e) => setPlatform(e.target.value as '' | ContentPlatform)} className="field h-9 w-auto py-1.5">
          <option value="">All platforms</option>
          {CONTENT_PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
        </select>
        <label htmlFor="cb-status" className="sr-only">Status</label>
        <select id="cb-status" value={status} onChange={(e) => setStatus(e.target.value as '' | ContentStatus)} className="field h-9 w-auto py-1.5">
          <option value="">All statuses</option>
          {CONTENT_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <span className="text-xs text-muted tabular-nums">{shown.length} of {posts.length}</span>
      </div>
      <div className="glass overflow-x-auto rounded-2xl">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="text-[11px] uppercase tracking-wide text-muted">
            <tr>
              {['Title', 'Platform', 'Type', 'Status', 'Scheduled', 'Assigned to', 'Drive'].map((h) => <th key={h} className="px-3 py-2.5 font-semibold">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-line/60">
            {shown.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-muted">{posts.length ? 'Nothing matches these filters.' : 'No content yet. Create it on the Content Calendar.'}</td></tr>}
            {shown.map((p) => (
              <tr key={p.id} className="align-top">
                <td className="px-3 py-2.5"><button type="button" onClick={() => setOpen(p)} className="text-left font-medium hover:underline">{p.title}</button></td>
                <td className="px-3 py-2.5"><span className="inline-flex items-center gap-1.5"><PlatformLogo platform={p.platform} size={16} />{PLATFORM_LABEL[p.platform]}</span></td>
                <td className="px-3 py-2.5 text-ink-2">{FORMAT_LABEL(p.format)}</td>
                <td className="px-3 py-2.5 text-ink-2">{STATUS_LABEL[p.status]}</td>
                <td className="px-3 py-2.5 whitespace-nowrap text-ink-2">{fmt(p.scheduledOn)}</td>
                <td className="px-3 py-2.5 text-ink-2">{who(p.assigneeId) || <span className="text-muted">Unassigned</span>}</td>
                <td className="px-3 py-2.5">{p.driveLink ? <a href={p.driveLink} target="_blank" rel="noreferrer" className="text-accent hover:underline">Open</a> : <span className="text-muted">None</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && <Review post={open} assignee={who(open.assigneeId)} onClose={() => setOpen(null)} />}
    </>
  );
}

/** A content piece to read through: its draft or caption in full, its details and its Drive link. */
function Review({ post, assignee, onClose }: { post: PostView; assignee: string; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={post.title} className="card mt-8 w-full max-w-xl space-y-4 p-5">
        <div className="flex items-start gap-2">
          <PlatformLogo platform={post.platform} size={24} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{post.title}</h2>
            <p className="text-xs text-muted">{PLATFORM_LABEL[post.platform]} · {FORMAT_LABEL(post.format)} · {STATUS_LABEL[post.status]}</p>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div><dt className="text-xs text-muted">Scheduled</dt><dd>{fmt(post.scheduledOn)}</dd></div>
          <div><dt className="text-xs text-muted">Assigned to</dt><dd>{assignee || 'Unassigned'}</dd></div>
        </dl>
        {post.status === 'waiting_dependency' && post.dependencyNote && <p className="text-sm text-critical-ink">Waiting: {post.dependencyNote}</p>}
        <div>
          <div className="text-xs text-muted">Draft / caption</div>
          <p className="mt-1 whitespace-pre-line rounded-md border border-line bg-surface-2 p-3 text-sm leading-relaxed">{post.caption || 'No draft written yet.'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {post.driveLink ? <a href={post.driveLink} target="_blank" rel="noreferrer" className="btn-primary">Open in Google Drive</a> : <span className="text-sm text-muted">No Drive link added.</span>}
          <Link href="/marketing/calendar" className="btn-secondary">Edit on the calendar</Link>
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
