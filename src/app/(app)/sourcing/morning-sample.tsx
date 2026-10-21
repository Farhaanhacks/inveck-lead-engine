import Link from 'next/link';
import type { Icp, Lead, SourcingTest } from '@/lib/db/schema';
import { LOGISTICS, MANUFACTURING } from '@/lib/db/seed';
import { DRAW_SEGMENTS, quotaTotal } from '@/lib/draw';
import { callOpener, discoveryQuestions, linkedinNote } from '@/lib/talk';
import { buildWhatsApp } from '@/lib/whatsapp-outreach';
import { planEmail } from '@/lib/mail/plan';
import { icpFor, tierOf, type Tier } from '@/lib/tiers';
import { formatDateTime } from '@/lib/dates';
import { TierBadge } from '@/components/tier-badge';
import { SubmitButton } from '@/components/submit-button';
import { AutoRefresh } from '@/components/auto-refresh';
import { CopyButton } from '@/components/copy-button';
import { carryOnSampleAction, startMorningSampleAction } from '@/app/sourcing-actions';
import { canCarryOn } from '@/lib/sourcing/test-run';
import { CA_PER_ASSOCIATE, cardLead, isMorningSample, quotaFor, SAMPLE_RULES, type MorningSampleReport, type SampleCard, type SampleHand, type SamplePerson } from '@/lib/sourcing/sample-run';

const SMALL = 'btn-secondary px-2.5 py-1 text-xs';
const th = 'px-3 py-2 text-left font-medium whitespace-nowrap';
const td = 'px-3 py-2.5 align-top';

const dayName = (day: string) => new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${day}T00:00:00Z`));

const OUTCOME: Record<string, { label: string; tone: string }> = {
  approved: { label: 'Approved', tone: 'bg-good-soft text-good-ink' },
  ruled_out: { label: 'Ruled out by the ICP check', tone: 'bg-neutral-soft text-ink-2' },
  no_contact: { label: 'No contact found', tone: 'bg-warning-soft text-warning-ink' },
  error: { label: 'Research failed', tone: 'bg-critical-soft text-critical-ink' },
  waiting: { label: 'Next day (search budget)', tone: 'bg-warning-soft text-warning-ink' },
};

function Counter({ label, value, goal, note }: { label: string; value: number; goal?: number; note?: string }) {
  const pct = goal ? Math.min(100, Math.round((value / goal) * 100)) : 0;
  return (
    <div className="card p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">
        {value}
        {goal ? <span className="text-sm font-normal text-muted"> / {goal}</span> : null}
      </div>
      {note ? <div className="text-xs text-muted">{note}</div> : null}
      {goal ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`${pct}% of the daily quota`}>
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** A step's buttons as Today shows them, for looking at only. */
function Buttons({ labels }: { labels: string[] }) {
  return (
    <div className="flex flex-wrap gap-2" aria-hidden>
      {labels.map((l) => (
        <span key={l} className={`${SMALL} pointer-events-none opacity-70`}>{l}</span>
      ))}
    </div>
  );
}

/** One line of the company's Day 1 checklist, as Today shows it: the step, its buttons, and what to say. */
function Step({ label, buttons, hint, summary, children }: { label: string; buttons: string[]; hint?: string; summary: string; children: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3">
      <div className="flex w-40 shrink-0 items-start gap-2">
        <span className="mt-0.5 h-4 w-4 shrink-0 rounded border border-line bg-surface" aria-hidden />
        <div className="text-sm font-medium">{label}</div>
      </div>
      <div className="min-w-0 flex-1">
        <Buttons labels={buttons} />
        {hint && <p className="mt-2 text-xs text-muted">{hint}</p>}
        <details className="mt-1.5">
          <summary className="cursor-pointer text-xs text-muted hover:text-ink">{summary}</summary>
          <div className="mt-2 space-y-2 rounded-md bg-surface-2 p-3 text-sm">{children}</div>
        </details>
      </div>
    </li>
  );
}

/** A company as it would be on the person's Today: the contact, the people, and the four Day 1 steps. */
function Card({ r, card, person, senderName, icps }: { r: MorningSampleReport; card: SampleCard; person: string; senderName: string; icps: Icp[] }) {
  const found = cardLead(r, card);
  if (!found) return null;
  const { lead, people, company } = found;
  const icp = icpFor(lead.segment, icps);
  const tier = (['P1', 'P2', 'P3'].includes(lead.contactTier) ? lead.contactTier : tierOf(lead.contactTitle, icp)) as Tier;
  const others = people.filter((p) => !p.isPrimary && !p.setAside && p.name !== lead.contactName).slice(0, 6);
  const whatsapp = buildWhatsApp(lead, person);
  const email = planEmail(lead as Lead, undefined, { from: senderName, as: person, owner: person });
  const note = linkedinNote(lead, person);
  return (
    <li className="px-5 py-4">
      <div className="min-w-0">
        {card.from === 'pool' ? (
          <Link href={`/leads/${lead.id}`} className="font-medium hover:underline">{lead.company}</Link>
        ) : (
          <a href={lead.companyLinkedin || company?.page.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">{lead.company}</a>
        )}
        {lead.city && <span className="ml-1.5 text-sm text-muted">{lead.city}</span>}
        <span className="ml-2 text-xs text-muted">First contact · <span className="tabular-nums">0 of 4 done</span></span>
        <span className={`ml-2 rounded px-1.5 py-0.5 text-[11px] font-medium ${card.from === 'pool' ? 'bg-neutral-soft text-ink-2' : 'bg-accent-soft text-accent'}`}>
          {card.from === 'pool' ? 'Waiting in the pool now' : 'Found by this sample'}
        </span>
        <div className="text-sm text-ink-2">
          {lead.contactName}
          {lead.contactTitle ? <span className="text-muted">, {lead.contactTitle}</span> : null}
          {lead.contactName ? <TierBadge tier={tier} /> : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {lead.contactEmail && <a href={`mailto:${lead.contactEmail}`} className="text-accent hover:underline">{lead.contactEmail}</a>}
          {lead.contactLinkedin && <a href={lead.contactLinkedin} target="_blank" rel="noreferrer" className="text-accent hover:underline">LinkedIn profile</a>}
        </div>
        {others.length > 0 && (
          <div className="mt-2 rounded-md border border-line bg-surface-2 px-3 py-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted">More points of contact at {lead.company}</div>
            <ul className="mt-1 space-y-1">
              {others.map((p: SamplePerson) => (
                <li key={p.linkedin || p.name} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="font-medium text-ink">{p.name}</span>
                  {['P1', 'P2', 'P3'].includes(p.tier) && <TierBadge tier={p.tier as Tier} />}
                  {p.title && <span className="text-muted">{p.title}</span>}
                  {p.linkedin ? <a href={p.linkedin} target="_blank" rel="noreferrer" className="text-accent hover:underline">LinkedIn</a> : <span className="text-muted">no details yet</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <ul className="mt-2 divide-y divide-line border-t border-line">
        <Step label="Call" buttons={['No answer', 'Busy or voicemail', 'Wrong number', 'No contact found', 'Connected']} hint={lead.contactPhone ? undefined : 'No number yet: Today asks them to save it once they find it.'} summary="Talk track">
          <p>{callOpener(lead, person)}</p>
          <ul className="list-disc space-y-0.5 pl-5 text-ink-2">
            {discoveryQuestions(lead).map((q) => <li key={q}>{q}</li>)}
          </ul>
        </Step>
        <Step label="WhatsApp" buttons={['Open WhatsApp', 'Mark sent', 'Skip']} hint={whatsapp.ok ? undefined : whatsapp.error} summary="Message">
          {whatsapp.ok ? <p className="whitespace-pre-line">{whatsapp.text}</p> : <p className="text-ink-2">{whatsapp.error}</p>}
        </Step>
        <Step label="Email" buttons={['Mark sent', 'Skip']} hint={lead.contactEmail ? undefined : 'No email address yet: Today asks them to save it once they find it.'} summary="Message">
          <p className="whitespace-pre-line">{email.subject ? `Subject: ${email.subject}\n\n` : ''}{email.body || 'No draft yet.'}</p>
          {email.problem && <p className="text-xs text-warning-ink">{email.problem}</p>}
        </Step>
        <Step label="LinkedIn" buttons={lead.contactLinkedin ? ['Open LinkedIn profile', 'Request sent', 'Skip'] : ['Request sent', 'Skip']} summary="Connection note">
          <p>{note}</p>
          <CopyButton text={note} label="Copy note" />
        </Step>
      </ul>
      <details className="mt-2 text-xs text-muted">
        <summary className="cursor-pointer hover:text-ink">Why it&apos;s on the list (only you see this)</summary>
        <div className="mt-1 space-y-1">
          <p>{lead.segment}{company ? `; LinkedIn page: ${[company.page.size, company.page.industry, company.page.hq].filter(Boolean).join(', ') || 'no facts shown'}` : ''}</p>
          {lead.fitReason && <p>ICP check: {lead.fitReason}{lead.fitScore != null ? ` (fit ${lead.fitScore}/10)` : ''}</p>}
          {company && <p>Screen: {company.note}</p>}
          <p>Source: {lead.source || 'not recorded'}</p>
        </div>
      </details>
    </li>
  );
}

/** One associate's day: their counters, then every company they'd be given, as Today would show it. */
function PersonDay({ r, hand, senderName, icps }: { r: MorningSampleReport; hand: SampleHand; senderName: string; icps: Icp[] }) {
  const q = quotaFor(r, hand.userId);
  const quota = quotaTotal(q);
  const seg = (s: string) => hand.cards.filter((c) => cardLead(r, c)?.lead.segment === s).length;
  const short = DRAW_SEGMENTS.filter((s) => hand.short[s] > 0);
  const carried = [...new Map(hand.carried.map((c) => [c.leadId, c])).values()];
  return (
    <div>
      <h3 className="mb-3 text-base font-semibold">{hand.name}&apos;s Today on {dayName(r.day)}</h3>
      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Counter label="Leads assigned today" value={hand.cards.length} goal={quota} note={`${seg(MANUFACTURING)}/${q[MANUFACTURING]} Manufacturing + ${seg(LOGISTICS)}/${q[LOGISTICS]} 3PL & Logistics`} />
        <Counter label="From earlier days" value={carried.length} note="companies with a step already due" />
        {hand.ca && <Counter label="CA firms" value={CA_PER_ASSOCIATE} note="from the Google Sheet at 8 am: not part of this sample" />}
      </div>
      {short.length > 0 && (
        <p className="mb-4 rounded-lg bg-warning-soft px-4 py-3 text-sm text-warning-ink">
          Short: {short.map((s) => `${hand.short[s]} ${s}`).join(' and ')}. Not enough researched leads with a confirmed contact for everyone&apos;s quota.
        </p>
      )}
      {hand.cards.length > 0 ? (
        <ul className="card divide-y divide-line">
          {hand.cards.map((c) => (
            <Card key={`${c.from}-${c.key}`} r={r} card={c} person={hand.name} senderName={senderName} icps={icps} />
          ))}
        </ul>
      ) : (
        <p className="card p-5 text-sm text-muted">No new leads for {hand.name} in this sample.</p>
      )}
      {carried.length > 0 && (
        <details className="card mt-4 p-5">
          <summary className="cursor-pointer text-sm font-semibold">Also on {hand.name}&apos;s list from earlier days ({carried.length})</summary>
          <ul className="mt-2 space-y-1 text-sm">
            {carried.map((c) => (
              <li key={c.leadId}>
                <Link href={`/leads/${c.leadId}`} className="hover:underline">{c.company}</Link>
                <span className="text-xs text-muted"> · {c.priority ? 'Promised callback' : c.step} · {c.segment}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Every associate's leads in one place: what each gets per segment, then every lead, person by person. */
function WhoGetsWhat({ r, icps }: { r: MorningSampleReport; icps: Icp[] }) {
  const rows = r.hands.map((h) => {
    const q = quotaFor(r, h.userId);
    const leads = h.cards.map((c) => ({ c, found: cardLead(r, c) })).filter((x) => x.found);
    const got = (s: string) => leads.filter((x) => x.found!.lead.segment === s).length;
    return { h, q, leads, m: got(MANUFACTURING), l: got(LOGISTICS) };
  });
  const total = (pick: (x: (typeof rows)[number]) => number) => rows.reduce((a, x) => a + pick(x), 0);
  return (
    <div className="mb-6 space-y-4">
      <div className="card overflow-x-auto">
        <div className="border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold">Who gets what on {dayName(r.day)}</h3>
          <p className="text-xs text-muted">Each associate&apos;s daily list (Team page) and what this sample could give them.</p>
        </div>
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-xs text-ink-2">
            <tr>
              <th className={th}>Associate</th>
              <th className={`${th} text-right`}>{MANUFACTURING}</th>
              <th className={`${th} text-right`}>{LOGISTICS}</th>
              <th className={`${th} text-right`}>Total</th>
              <th className={th}>Short</th>
              <th className={th}>CA firms</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map(({ h, q, m, l }) => (
              <tr key={h.userId}>
                <td className={`${td} font-medium`}>{h.name}</td>
                <td className={`${td} text-right tabular-nums`}>{m} <span className="text-xs text-muted">of {q[MANUFACTURING]}</span></td>
                <td className={`${td} text-right tabular-nums`}>{l} <span className="text-xs text-muted">of {q[LOGISTICS]}</span></td>
                <td className={`${td} text-right tabular-nums`}>{m + l} <span className="text-xs text-muted">of {quotaTotal(q)}</span></td>
                <td className={td}>
                  {DRAW_SEGMENTS.some((s) => h.short[s] > 0) ? (
                    <span className="text-warning-ink">{DRAW_SEGMENTS.filter((s) => h.short[s] > 0).map((s) => `${h.short[s]} ${s}`).join(', ')}</span>
                  ) : (
                    <span className="text-good-ink">Full</span>
                  )}
                </td>
                <td className={`${td} text-xs text-muted`}>{h.ca ? `+${CA_PER_ASSOCIATE} from the sheet (not in this sample)` : '–'}</td>
              </tr>
            ))}
            <tr className="font-medium">
              <td className={td}>Team</td>
              <td className={`${td} text-right tabular-nums`}>{total((x) => x.m)} <span className="text-xs font-normal text-muted">of {total((x) => x.q[MANUFACTURING])}</span></td>
              <td className={`${td} text-right tabular-nums`}>{total((x) => x.l)} <span className="text-xs font-normal text-muted">of {total((x) => x.q[LOGISTICS])}</span></td>
              <td className={`${td} text-right tabular-nums`}>{total((x) => x.m + x.l)} <span className="text-xs font-normal text-muted">of {total((x) => quotaTotal(x.q))}</span></td>
              <td className={td} colSpan={2} />
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card overflow-x-auto">
        <div className="border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold">Every lead, person by person</h3>
          <p className="text-xs text-muted">Click a name below the table to see that person&apos;s Today as it would look, with the messages.</p>
        </div>
        <table className="w-full min-w-[960px] text-sm">
          <thead className="text-xs text-ink-2">
            <tr>
              <th className={th}>#</th>
              <th className={th}>Company</th>
              <th className={th}>Segment</th>
              <th className={th}>City</th>
              <th className={th}>Size</th>
              <th className={th}>Contact</th>
              <th className={th}>From</th>
            </tr>
          </thead>
          {rows.map(({ h, q, leads, m, l }) => (
            <tbody key={h.userId} className="divide-y divide-line">
              <tr className="bg-surface-2">
                <td colSpan={7} className="px-3 py-2 text-sm font-semibold">
                  {h.name} <span className="font-normal text-muted">· {m} {MANUFACTURING} + {l} {LOGISTICS} of {q[MANUFACTURING]} + {q[LOGISTICS]}</span>
                </td>
              </tr>
              {leads.length ? (
                leads.map(({ c, found }, i) => {
                  const { lead, company } = found!;
                  const tier = (['P1', 'P2', 'P3'].includes(lead.contactTier) ? lead.contactTier : tierOf(lead.contactTitle, icpFor(lead.segment, icps))) as Tier;
                  return (
                    <tr key={`${c.from}-${c.key}`}>
                      <td className={`${td} tabular-nums text-muted`}>{i + 1}</td>
                      <td className={`${td} font-medium`}>
                        {c.from === 'pool' ? (
                          <Link href={`/leads/${lead.id}`} className="hover:underline">{lead.company}</Link>
                        ) : (
                          <a href={lead.companyLinkedin || company?.page.url} target="_blank" rel="noreferrer" className="hover:underline">{lead.company}</a>
                        )}
                      </td>
                      <td className={td}>{lead.segment === LOGISTICS ? '3PL' : lead.segment}</td>
                      <td className={td}>{lead.city || <span className="text-muted">–</span>}</td>
                      <td className={`${td} whitespace-nowrap`}>{company?.page.size || <span className="text-muted">–</span>}</td>
                      <td className={td}>
                        {lead.contactLinkedin ? (
                          <a href={lead.contactLinkedin} target="_blank" rel="noreferrer" className="hover:underline">{lead.contactName}</a>
                        ) : (
                          lead.contactName
                        )}
                        <TierBadge tier={tier} />
                        <span className="block text-xs text-muted">{lead.contactTitle}</span>
                      </td>
                      <td className={`${td} text-xs text-muted`}>{c.from === 'pool' ? 'Already waiting' : 'This sample'}</td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={7} className="px-3 py-2.5 text-sm text-muted">Nothing for {h.name} in this sample.</td>
                </tr>
              )}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}

/**
 * The Morning Sample Run section of the Sourcing page: start one, watch it, then switch between the
 * associates to see each one's day as tomorrow's Today would show it.
 */
export function MorningSample({
  test,
  running,
  earlier,
  person,
  senderName,
  icps,
}: {
  test: SourcingTest | null;
  running: boolean;
  earlier: { id: number; status: string; startedAt: Date }[];
  person: number;
  senderName: string;
  icps: Icp[];
}) {
  const r = test && isMorningSample(test.report) ? test.report : null;
  const hand = r?.hands.find((h) => h.userId === person) ?? r?.hands[0];
  const counts = r ? DRAW_SEGMENTS.map((s) => ({ s, found: r.companies.filter((c) => c.segment === s).length, approved: r.companies.filter((c) => c.segment === s && c.outcome === 'approved').length })) : [];
  return (
    <section id="morning" className="mb-8">
      <div className="card mb-4 p-5">
        <h2 className="text-sm font-semibold">Morning Sample Run</h2>
        <p className="mt-1 text-sm text-ink-2">
          The next 6 am run and 8 am draw, done now (the date is shown on the result): it finds what the draw is short of (people first), researches every company exactly as the run does (the ICP check, the contact, the drafts), then deals each associate their own daily list (Team page) as the draw would. Switch between the team to see each person&apos;s Today. Nothing is saved as a lead, nobody is given anything and no search is remembered: the real run starts fresh, so it can find these same companies again (none is used up), though the companies it picks will differ. CA firms aren&apos;t part of it.
        </p>
        <p className="mt-2 text-sm text-ink-2">
          <span className="font-medium">Cheaper rules being tried here first</span> (the 6 am run doesn&apos;t use them yet): people searches of 100 results, companies already ruled out not checked again, 2 contacts a company, no repeat lookups of a company&apos;s LinkedIn page or of its officers in the news, 10% extra companies, and at most {SAMPLE_RULES.credits.toLocaleString('en-IN')} Google search credits for a new sample. A sample carried on from where it stopped uses them too.
        </p>
        <form action={startMorningSampleAction} className="mt-4 flex flex-wrap items-center gap-4">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="fresh" className="mt-1" />
            <span>
              Fill every list from the search alone
              <span className="block text-xs text-muted">Leaves out the leads already waiting in the pool, to test the search at full size.</span>
            </span>
          </label>
          <SubmitButton pendingText="Starting…" disabled={running}>Run</SubmitButton>
        </form>
        <p className="mt-3 text-xs text-muted">
          It takes about as long as the morning run: searching, then around half a minute to research each company. Leave the page open or come back later.
          {running && ' A sample is running: wait for it to finish before starting another.'}
        </p>
      </div>

      {test && (
        <div className="mb-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">
              Sample {test.id}{r ? `: ${dayName(r.day)}` : ''}
              <span className="ml-2 font-normal text-muted">started {formatDateTime(test.startedAt)}{r?.seconds ? `, ${Math.round(r.seconds / 60)} min` : ''}{r?.fresh ? ', from the search alone' : ''}</span>
            </h2>
            <span className={`inline-flex h-5 items-center rounded px-1.5 text-[11px] font-medium ${test.status === 'done' ? 'bg-good-soft text-good-ink' : test.status === 'failed' ? 'bg-critical-soft text-critical-ink' : 'bg-accent-soft text-accent'}`}>
              {test.status === 'done' ? 'Done' : test.status === 'failed' ? 'Failed' : 'Running'}
            </span>
          </div>
          {test.status === 'running' && <AutoRefresh />}
          {test.progress && <p className="mb-3 text-sm text-ink-2" role="status">{test.progress}</p>}
          {test.error && <p className="mb-3 rounded-lg border border-line bg-critical-soft px-4 py-3 text-sm text-critical-ink">{test.error}</p>}
          {canCarryOn(test) && !running && (
            <form action={carryOnSampleAction} className="mb-3 flex flex-wrap items-center gap-3">
              <input type="hidden" name="id" value={test.id} />
              <SubmitButton pendingText="Carrying on…">Carry on from here</SubmitButton>
              <span className="text-xs text-muted">Picks up where it stopped: what it already searched and researched isn&apos;t done (or paid for) again.</span>
            </form>
          )}

          {r && (
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              {counts.map(({ s, found, approved }) => (
                <div key={s} className="card p-4 text-sm">
                  <div className="font-medium">{s}</div>
                  <p className="mt-1 text-xs text-muted">
                    The draw needs {r.start[s].need} ({r.team.map((t) => `${t.name} ${quotaFor(r, t.id)[s]}`).join(', ')}). {r.fresh ? 'Pool left out' : `${r.start[s].pool} waiting in the pool`}; the search was asked for {r.start[s].wanted}.
                    {r.start[s].waiting ? ` ${r.start[s].waiting} companies already waiting for research would be researched first at 6 am (not shown here).` : ''}
                  </p>
                  <p className="mt-2">
                    <span className="font-semibold tabular-nums">{found}</span> found, <span className="font-semibold tabular-nums">{approved}</span> approved
                  </p>
                </div>
              ))}
            </div>
          )}

          {r && r.phase === 'done' && r.hands.length > 0 && hand && (
            <>
              <WhoGetsWhat r={r} icps={icps} />
              <h3 className="mb-2 text-sm font-semibold">Each person&apos;s Today</h3>
              <nav className="mb-4 flex flex-wrap gap-2" aria-label="Associates">
                {r.hands.map((h) => (
                  <Link
                    key={h.userId}
                    href={`/sourcing?sample=${test.id}&person=${h.userId}#morning`}
                    className={h.userId === hand.userId ? 'btn-primary' : 'btn-secondary'}
                    aria-current={h.userId === hand.userId ? 'page' : undefined}
                  >
                    {h.name} <span className="tabular-nums opacity-80">({h.cards.length})</span>
                  </Link>
                ))}
              </nav>
              <PersonDay r={r} hand={hand} senderName={senderName} icps={icps} />
            </>
          )}
          {r && r.phase === 'done' && !r.hands.length && <p className="card p-5 text-sm text-muted">No active associates to deal leads to.</p>}

          {r && r.companies.length > 0 && (
            <details className="card mt-4 overflow-x-auto">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Everything the search found ({r.companies.length}), and what research made of it</summary>
              <table className="w-full min-w-[860px] text-sm">
                <thead className="text-xs text-ink-2">
                  <tr>
                    <th className={th}>Company</th>
                    <th className={th}>Segment</th>
                    <th className={th}>LinkedIn page</th>
                    <th className={th}>Contact</th>
                    <th className={th}>Research</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {r.companies.map((c) => {
                    const o = c.outcome ? OUTCOME[c.outcome] : null;
                    return (
                      <tr key={c.key}>
                        <td className={`${td} font-medium`}>
                          <a href={c.page.url} target="_blank" rel="noreferrer" className="hover:underline">{c.page.name}</a>
                          {c.page.website && <span className="block text-xs font-normal text-muted">{c.page.website}</span>}
                        </td>
                        <td className={td}>{c.segment}</td>
                        <td className={td}>
                          {[c.page.size, c.page.industry].filter(Boolean).join(', ') || <span className="text-muted">no facts shown</span>}
                          <span className="block text-xs text-muted">{c.page.hq || 'headquarters not shown'}</span>
                        </td>
                        <td className={td}>
                          {c.lead?.contactName ? `${c.lead.contactName}, ${c.lead.contactTitle}` : `${c.contacts[0]?.name}, ${c.contacts[0]?.title}`}
                          <span className="block text-xs text-muted">{c.contacts.length} found by the search</span>
                        </td>
                        <td className={td}>
                          {o ? <span className={`inline-flex h-5 items-center whitespace-nowrap rounded px-1.5 text-[11px] font-medium ${o.tone}`}>{o.label}</span> : <span className="text-muted">not yet</span>}
                          {c.why && <span className="block max-w-sm text-xs text-muted">{c.why}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </details>
          )}
        </div>
      )}

      {earlier.length > 1 && (
        <div className="card p-5">
          <h2 className="mb-2 text-sm font-semibold">Earlier samples</h2>
          <ul className="space-y-1 text-sm">
            {earlier.map((e) => (
              <li key={e.id}>
                <Link href={`/sourcing?sample=${e.id}#morning`} className={e.id === test?.id ? 'font-medium' : 'text-accent hover:underline'}>Sample {e.id}</Link>
                <span className="ml-2 text-xs text-muted">{formatDateTime(e.startedAt)}, {e.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
