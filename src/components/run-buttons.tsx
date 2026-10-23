import Link from 'next/link';
import { startRunAction } from '@/app/actions';
import { SubmitButton } from './submit-button';

/** Starts a prospect search. While research is running, links to its progress instead. */
export function RunButtons({ running, runId, team = [] }: { running: boolean; runId?: number; team?: { id: number; name: string }[] }) {
  if (running) {
    return (
      <Link href={`/?run=${runId}#activity`} className="btn-secondary">
        <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden /> Researching…
      </Link>
    );
  }
  // Companies added to the lead list are researched automatically; this finds new ones.
  return (
    <form action={startRunAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="findProspects" value="yes" />
      <span className="text-xs text-muted" title="Leave both empty to find what the morning draw is short of">Leads to find</span>
      <label htmlFor="manufacturing" className="text-xs text-muted">Manufacturing</label>
      <input id="manufacturing" name="manufacturing" type="number" min={0} max={200} placeholder="0" className="field h-9 w-20 py-1.5 text-sm" />
      <label htmlFor="logistics" className="text-xs text-muted">3PL &amp; Logistics</label>
      <input id="logistics" name="logistics" type="number" min={0} max={200} placeholder="0" className="field h-9 w-20 py-1.5 text-sm" />
      <label htmlFor="prospectsTo" className="text-xs text-muted">Found companies go to</label>
      <select id="prospectsTo" name="prospectsTo" defaultValue="" className="field h-9 w-auto py-1.5 text-sm">
        <option value="">The morning draw</option>
        {team.length > 0 && <option value="team">The team now (split evenly)</option>}
        {team.map((u) => (
          <option key={u.id} value={u.id}>{u.name}</option>
        ))}
      </select>
      <SubmitButton pendingText="Starting…">Find new prospects</SubmitButton>
    </form>
  );
}
