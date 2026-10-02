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
      <label htmlFor="prospectsTo" className="text-xs text-muted">Found companies go to</label>
      <select id="prospectsTo" name="prospectsTo" defaultValue={team.length ? 'team' : ''} className="field h-9 w-auto py-1.5 text-sm">
        {team.length > 0 && <option value="team">The whole team (split evenly)</option>}
        {team.map((u) => (
          <option key={u.id} value={u.id}>{u.name}</option>
        ))}
        <option value="">Nobody yet (I&apos;ll assign them)</option>
      </select>
      <SubmitButton pendingText="Starting…">Find new prospects</SubmitButton>
    </form>
  );
}
