import Link from 'next/link';
import { startRunAction } from '@/app/actions';
import { SubmitButton } from './submit-button';

/** Starts a prospect search. While research is running, links to its progress instead. */
export function RunButtons({ running, runId }: { running: boolean; runId?: number }) {
  if (running) {
    return (
      <Link href={`/?run=${runId}#activity`} className="btn-secondary">
        <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden /> Researching…
      </Link>
    );
  }
  // Companies added to the lead list are researched automatically; this finds new ones.
  return (
    <form action={startRunAction}>
      <input type="hidden" name="findProspects" value="yes" />
      <SubmitButton pendingText="Starting…">Find new prospects</SubmitButton>
    </form>
  );
}
