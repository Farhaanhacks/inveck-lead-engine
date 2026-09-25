import { liveServices } from '@/lib/run-driver';
import { hunterCredits } from '@/lib/pipeline/services';

/** Warns when Hunter is out of credits, since emails can't be found or confirmed without it. */
export async function HunterNotice({ always = false }: { always?: boolean }) {
  const svc = await liveServices();
  if (!svc.keys.hunter) return null;
  const c = await hunterCredits(svc);
  const out = !c.error && (!c.verificationsLeft || !c.searchesLeft);
  if (!out && !always) return null;
  return (
    <div className={`rounded-lg border p-4 text-sm ${out ? 'border-warning-ink/40 bg-warning-soft text-warning-ink' : 'border-line text-ink-2'}`} role={out ? 'alert' : undefined}>
      {c.error ? (
        <>Couldn&apos;t read Hunter credits: {c.error}</>
      ) : (
        <>
          <strong className="font-semibold">Hunter:</strong> {c.searchesLeft} searches and {c.verificationsLeft} email checks left
          {c.resetDate ? ` (resets ${c.resetDate})` : ''}.
          {out && ' Until it has credits, the app can only use emails published on the web; guessed emails can’t be confirmed, so most leads get no email.'}
        </>
      )}
    </div>
  );
}
