import Link from 'next/link';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { sourcingTests } from '@/lib/db/schema';
import { adminPage } from '@/lib/access';
import { apiKeys } from '@/lib/settings';
import { formatDateTime } from '@/lib/dates';
import { PageHeader } from '@/components/page-header';
import { SubmitButton } from '@/components/submit-button';
import { AutoRefresh } from '@/components/auto-refresh';
import { startSourcingTestAction } from '@/app/sourcing-actions';
import { SOURCING_SEGMENTS } from '@/lib/sourcing/linkedin-pages';
import { activeSourcingTest, funnelOf, SOURCING_LIMITS, type CompanyReport, type PeopleOutcome, type SourcingReport } from '@/lib/sourcing/test-run';

// The test runs after the response, inside this page's time limit.
export const maxDuration = 300;

const th = 'px-3 py-2 text-left font-medium whitespace-nowrap';
const td = 'px-3 py-2.5 align-top';

const SCREEN_LABEL: Record<CompanyReport['screen'], string> = {
  pass: 'Passed',
  abroad: 'Abroad',
  small: 'Too small',
  industry: 'Industry',
  known: 'Already known',
};

const OUTCOME: Record<PeopleOutcome, { label: string; tone: string }> = {
  reachable: { label: 'Reachable', tone: 'bg-good-soft text-good-ink' },
  top_only: { label: 'Owner or MD only', tone: 'bg-warning-soft text-warning-ink' },
  staff_only: { label: 'Staff, none on the lists', tone: 'bg-warning-soft text-warning-ink' },
  nobody: { label: 'Nobody found', tone: 'bg-critical-soft text-critical-ink' },
  failed: { label: 'Search failed', tone: 'bg-critical-soft text-critical-ink' },
};

function Tile({ label, value, note }: { label: string; value: number | string; note?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium text-ink-2">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {note && <div className="mt-1 text-xs text-muted">{note}</div>}
    </div>
  );
}

/** What Google showed for the page, and what the second search for its facts added. */
function GoogleText({ c }: { c: CompanyReport }) {
  return (
    <details className="mt-1 text-xs font-normal text-muted">
      <summary className="cursor-pointer">Google&apos;s text</summary>
      <p className="mt-1 max-w-md whitespace-pre-wrap break-words">{c.text}</p>
      {c.facts !== undefined && <p className="mt-1">Second search for size and headquarters: {c.facts ? `added ${c.facts}` : 'found nothing more'}</p>}
    </details>
  );
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '–');

export default async function SourcingPage({ searchParams }: PageProps<'/sourcing'>) {
  await adminPage();
  const db = await getDb();
  const running = await activeSourcingTest(db);
  const recent = await db
    .select({ id: sourcingTests.id, segment: sourcingTests.segment, status: sourcingTests.status, startedAt: sourcingTests.startedAt })
    .from(sourcingTests)
    .orderBy(desc(sourcingTests.id))
    .limit(10);
  const wanted = Number((await searchParams).test) || recent[0]?.id || 0;
  const [test] = wanted ? await db.select().from(sourcingTests).where(eq(sourcingTests.id, wanted)) : [];
  const report = (test?.report ?? null) as SourcingReport | null;
  const f = report ? funnelOf(report) : null;
  const searches = report ? report.searches.find + (report.searches.facts ?? 0) + report.searches.people : 0;
  const checkedList = report?.companies.filter((c) => c.people) ?? [];
  const otherList = report?.companies.filter((c) => !c.people) ?? [];
  const noSerper = !apiKeys().serper;

  return (
    <>
      <PageHeader
        title="Sourcing test"
        description="Finds companies through their LinkedIn pages, screens them on what the page shows (size, industry, headquarters, already known to INVECK), then checks whether anyone reachable works there. Nothing is saved as a lead and nothing is sent: only this report is kept."
      >
        <Link href="/" className="btn-secondary">Dashboard</Link>
      </PageHeader>

      <section className="card mb-6 p-5">
        <form action={startSourcingTestAction} className="flex flex-wrap items-end gap-4">
          <div>
            <label htmlFor="segment" className="label">Segment</label>
            <select id="segment" name="segment" defaultValue={SOURCING_SEGMENTS[0]} className="field">
              {SOURCING_SEGMENTS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="companies" className="label">Companies to check for people</label>
            <input id="companies" name="companies" type="number" min={SOURCING_LIMITS.minCompanies} max={SOURCING_LIMITS.maxCompanies} defaultValue={SOURCING_LIMITS.companies} className="field w-28" />
          </div>
          <SubmitButton pendingText="Starting…" disabled={!!running || noSerper}>Run the test</SubmitButton>
        </form>
        <p className="mt-3 text-xs text-muted">
          Uses up to {SOURCING_LIMITS.searches + SOURCING_LIMITS.secondPages} Google searches to find company pages, up to {SOURCING_LIMITS.facts} more for sizes and headquarters Google&apos;s first result left out, and up to 4 per company checked for people. It takes a minute or two. No AI is used.
          {running && ' A test is running: wait for it to finish before starting another.'}
          {noSerper && ' SERPER_API_KEY is not set, so the test cannot search.'}
        </p>
      </section>

      {test && (
        <section className="mb-6">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">
              Test {test.id}: {test.segment}
              <span className="ml-2 font-normal text-muted">started {formatDateTime(test.startedAt)}{report?.seconds ? `, ${report.seconds}s` : ''}</span>
            </h2>
            <span
              className={`inline-flex h-5 items-center rounded px-1.5 text-[11px] font-medium ${
                test.status === 'done' ? 'bg-good-soft text-good-ink' : test.status === 'failed' ? 'bg-critical-soft text-critical-ink' : 'bg-accent-soft text-accent'
              }`}
            >
              {test.status === 'done' ? 'Done' : test.status === 'failed' ? 'Failed' : 'Running'}
            </span>
          </div>
          {test.status === 'running' && <AutoRefresh />}
          {test.progress && <p className="mb-3 text-sm text-ink-2" role="status">{test.progress}</p>}
          {test.error && <p className="mb-3 rounded-lg border border-line bg-critical-soft px-4 py-3 text-sm text-critical-ink">{test.error}</p>}
          {report?.stoppedEarly && <p className="mb-3 text-sm text-warning-ink">{report.stoppedEarly}</p>}

          {f && report && (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
                <Tile label="Company pages found" value={f.found} note={`from ${report.searches.find} searches${report.searches.facts ? `, ${report.searches.facts} more for missing sizes` : ''}`} />
                <Tile label="Passed the screen" value={f.passed} note={`${f.abroad} abroad, ${f.small} too small, ${f.industry} industry, ${f.known} already known`} />
                <Tile label="Checked for people" value={f.checked} note={`${report.searches.people} searches`} />
                <Tile label="Reachable contact" value={f.reachable} note={`${pct(f.reachable, f.checked)} of those checked; ${f.withP1} with a P1`} />
                <Tile label="Owner or MD only" value={f.topOnly} note={`${f.staffOnly} with staff but none on the lists`} />
                <Tile label="Nobody found" value={f.nobody} note={f.failed ? `${f.failed} searches failed` : undefined} />
              </div>
              {test.status === 'done' && f.checked > 0 && (
                <p className="mt-3 text-sm text-ink-2">
                  {searches} Google searches gave {f.reachable} new, right-sized {f.reachable === 1 ? 'company' : 'companies'} with a reachable contact
                  {f.reachable > 0 && <> (one per {Math.round(searches / f.reachable)} searches)</>}
                  {f.passed > f.checked && <>; {f.passed - f.checked} more passed the screen but weren&apos;t checked for people</>}.
                </p>
              )}
            </>
          )}
        </section>
      )}

      {checkedList.length > 0 && (
        <section className="card mb-6 overflow-x-auto">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">Checked for people</h2>
            <p className="text-xs text-muted">The company&apos;s staff on LinkedIn, searched by its page&apos;s name. Reachable means someone on the ICP&apos;s P1, P2 or P3 lists who works there now, in India.</p>
          </div>
          <table className="w-full min-w-[960px] text-sm">
            <thead className="text-xs text-ink-2">
              <tr>
                <th className={th}>Company</th>
                <th className={th}>Size</th>
                <th className={th}>Industry and headquarters</th>
                <th className={th}>People</th>
                <th className={th}>Best contacts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {checkedList.map((c) => {
                const p = c.people!;
                const o = OUTCOME[p.outcome];
                const shown = p.best.length ? p.best : p.top;
                return (
                  <tr key={c.url}>
                    <td className={`${td} font-medium`}>
                      <a href={c.url} target="_blank" rel="noreferrer" className="hover:underline">{c.name}</a>
                      {c.website && <span className="block text-xs font-normal text-muted">{c.website}</span>}
                      <GoogleText c={c} />
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      {c.size || <span className="text-muted">not shown</span>}
                      {c.note.startsWith('borderline') && <span className="block text-xs text-warning-ink">borderline</span>}
                    </td>
                    <td className={td}>
                      {c.industry || <span className="text-muted">industry not shown</span>}
                      <span className="block text-xs text-muted">{c.hq || 'headquarters not shown'}</span>
                    </td>
                    <td className={td}>
                      <span className={`inline-flex h-5 items-center whitespace-nowrap rounded px-1.5 text-[11px] font-medium ${o.tone}`}>{o.label}</span>
                      <span className="block text-xs text-muted">
                        {p.staff} at the company, {p.acceptable} on the lists{p.p1 ? ` (${p.p1} P1)` : ''}; {p.searches} searches
                      </span>
                      {p.error && <span className="block text-xs text-critical-ink">{p.error}</span>}
                    </td>
                    <td className={td}>
                      {shown.length ? (
                        <ul className="space-y-0.5">
                          {shown.map((x) => (
                            <li key={x.linkedin || x.name}>
                              <a href={x.linkedin} target="_blank" rel="noreferrer" className="hover:underline">{x.name}</a>
                              <span className="text-xs text-muted">: {x.title}{x.tier ? ` (${x.tier})` : ''}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-muted">none</span>
                      )}
                      {p.log.length > 0 && (
                        <details className="mt-1 text-xs text-muted">
                          <summary className="cursor-pointer">Search log</summary>
                          <ul className="mt-1 max-w-xl space-y-0.5 whitespace-pre-wrap break-words">
                            {p.log.map((l, i) => (
                              <li key={i}>{l}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {otherList.length > 0 && (
        <section className="card mb-6 overflow-x-auto">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">Not checked for people</h2>
            <p className="text-xs text-muted">Ruled out by the screen, or passed but beyond the number of companies to check.</p>
          </div>
          <table className="w-full min-w-[860px] text-sm">
            <thead className="text-xs text-ink-2">
              <tr>
                <th className={th}>Company</th>
                <th className={th}>Size</th>
                <th className={th}>Industry and headquarters</th>
                <th className={th}>Screen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {otherList.map((c) => (
                <tr key={c.url}>
                  <td className={`${td} font-medium`}>
                    <a href={c.url} target="_blank" rel="noreferrer" className="hover:underline">{c.name}</a>
                    <GoogleText c={c} />
                  </td>
                  <td className={`${td} whitespace-nowrap`}>{c.size || <span className="text-muted">not shown</span>}</td>
                  <td className={td}>
                    {c.industry || <span className="text-muted">industry not shown</span>}
                    <span className="block text-xs text-muted">{c.hq || 'headquarters not shown'}</span>
                  </td>
                  <td className={td}>
                    <span className={c.screen === 'pass' ? 'text-good-ink' : 'text-ink-2'}>{SCREEN_LABEL[c.screen]}</span>
                    <span className="block text-xs text-muted">{c.note}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {report && report.queries.length > 0 && (
        <section className="card mb-6 overflow-x-auto">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">Searches for company pages</h2>
            <p className="text-xs text-muted">&quot;Band&quot; searches name LinkedIn&apos;s size bands; &quot;open&quot; ones take any size and read it from the result. Compare them to see which finds more.</p>
          </div>
          <table className="w-full min-w-[860px] text-sm">
            <thead className="text-xs text-ink-2">
              <tr>
                <th className={th}>Search</th>
                <th className={th}>Form</th>
                <th className={`${th} text-right`}>Results</th>
                <th className={`${th} text-right`}>Company pages</th>
                <th className={`${th} text-right`}>New</th>
                <th className={`${th} text-right`}>Passed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {report.queries.map((q, i) => (
                <tr key={i}>
                  <td className={`${td} font-mono text-xs break-all`}>
                    {q.q}
                    {q.page > 1 && <span className="ml-1 text-muted">(page {q.page})</span>}
                    {q.error && <span className="block font-sans text-critical-ink">{q.error}</span>}
                  </td>
                  <td className={td}>{q.form}</td>
                  <td className={`${td} text-right tabular-nums`}>{q.results}</td>
                  <td className={`${td} text-right tabular-nums`}>{q.pages}</td>
                  <td className={`${td} text-right tabular-nums`}>{q.newPages}</td>
                  <td className={`${td} text-right tabular-nums`}>{q.passed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {recent.length > 1 && (
        <section className="card p-5">
          <h2 className="mb-2 text-sm font-semibold">Earlier tests</h2>
          <ul className="space-y-1 text-sm">
            {recent.map((r) => (
              <li key={r.id}>
                <Link href={`/sourcing?test=${r.id}`} className={r.id === test?.id ? 'font-medium' : 'text-accent hover:underline'}>
                  Test {r.id}: {r.segment}
                </Link>
                <span className="ml-2 text-xs text-muted">{formatDateTime(r.startedAt)}, {r.status}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
