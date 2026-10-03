import { liveServices } from '@/lib/run-driver';
import { hunterCredits } from '@/lib/pipeline/services';

/** Warns when the mail-server check (Hunter's email verifier) is out of credits: addresses can't be confirmed then. */
export async function HunterNotice({ always = false }: { always?: boolean }) {
  const svc = await liveServices();
  if (!svc.keys.hunter) return null;
  const c = await hunterCredits(svc);
  const out = !c.error && !c.verificationsLeft;
  if (!out && !always) return null;
  return (
    <div className={`rounded-lg border p-4 text-sm ${out ? 'border-warning-ink/40 bg-warning-soft text-warning-ink' : 'border-line text-ink-2'}`} role={out ? 'alert' : undefined}>
      {c.error ? (
        <>Couldn&apos;t read Hunter credits: {c.error}</>
      ) : (
        <>
          <strong className="font-semibold">Email verification (Hunter):</strong> {c.verificationsLeft} email checks left
          {c.resetDate ? ` (resets ${c.resetDate})` : ''}.
          {out && ' Until it has credits, addresses from Apollo or the company’s format can’t be confirmed: they are saved labelled unverified or inferred, never as verified.'}
        </>
      )}
    </div>
  );
}
