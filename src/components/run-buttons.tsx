import Link from 'next/link';
import { startRunAction } from '@/app/actions';
import { SubmitButton } from './submit-button';

/** The two ways to start a run. While one is running, link to it instead. */
export function RunButtons({ running, runId }: { running: boolean; runId?: number }) {
  if (running) {
    return (
      <Link href={`/runs?id=${runId}`} className="btn-secondary">
        <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden /> Run in progress
      </Link>
    );
  }
  return (
    <>
      <form action={startRunAction}>
        <input type="hidden" name="findProspects" value="no" />
        <SubmitButton className="btn-secondary" pendingText="Starting…">Research new leads</SubmitButton>
      </form>
      <form action={startRunAction}>
        <input type="hidden" name="findProspects" value="yes" />
        <SubmitButton pendingText="Starting…">Find prospects &amp; research</SubmitButton>
      </form>
    </>
  );
}
