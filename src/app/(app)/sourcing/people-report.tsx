import { peopleFunnelOf, type PeopleCompany, type PeopleReport } from '@/lib/sourcing/test-run';

const th = 'px-3 py-2 text-left font-medium whitespace-nowrap';
const td = 'px-3 py-2.5 align-top';

const SCREEN_LABEL: Record<PeopleCompany['screen'], string> = {
  pass: 'Ready',
  abroad: 'Abroad',
  small: 'Too small',
  industry: 'Industry',
  known: 'Already known',
  nopage: 'No LinkedIn page',
  unchecked: 'Not checked',
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

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '–');

function CompanyCell({ c }: { c: PeopleCompany }) {
  return (
    <td className={`${td} font-medium`}>
      {c.page ? (
        <a href={c.page.url} target="_blank" rel="noreferrer" className="hover:underline">{c.page.name}</a>
      ) : (
        c.employer
      )}
      {c.page && c.page.name !== c.employer && <span className="block text-xs font-normal text-muted">as its people write it: {c.employer}</span>}
      {c.page?.website && <span className="block text-xs font-normal text-muted">{c.page.website}</span>}
      {c.page && (
        <details className="mt-1 text-xs font-normal text-muted">
          <summary className="cursor-pointer">Google&apos;s text</summary>
          <p className="mt-1 max-w-md whitespace-pre-wrap break-words">{c.page.text}</p>
          {c.facts !== undefined && <p className="mt-1">Second search for size and headquarters: {c.facts ? `added ${c.facts}` : 'found nothing more'}</p>}
        </details>
      )}
    </td>
  );
}

/** A people-first test: people with the ICP's titles, then their companies. */
export function PeopleReportView({ report, done }: { report: PeopleReport; done: boolean }) {
  const f = peopleFunnelOf(report);
  const searches = report.searches.people + report.searches.companies + report.searches.facts;
  const ready = report.companies.filter((c) => c.screen === 'pass');
  const others = report.companies.filter((c) => c.screen !== 'pass');
  return (
    <>
      <section className="mb-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Tile label="People found" value={f.profiles} note={`from ${report.searches.people} searches`} />
          <Tile label="On your lists" value={f.contacts} note={`P1/P2/P3, in India, at ${f.companies} companies`} />
          <Tile label="Companies checked" value={f.checked} note={`${f.known} already known${f.unchecked ? `, ${f.unchecked} not checked` : ''}; ${report.searches.companies + report.searches.facts} searches`} />
          <Tile label="Ready with a contact" value={report.target ? `${f.ready} of ${report.target}` : f.ready} note={`${pct(f.ready, f.checked)} of those checked; ${f.readyWithP1} with a P1`} />
          <Tile label="Ruled out" value={f.abroad + f.small + f.industry} note={`${f.small} too small, ${f.industry} industry, ${f.abroad} abroad`} />
          <Tile label="No LinkedIn page" value={f.nopage} note="company page not found by name" />
        </div>
        {done && f.checked > 0 && (
          <p className="mt-3 text-sm text-ink-2">
            {searches} Google searches gave {f.ready} new, right-sized {f.ready === 1 ? 'company' : 'companies'} with a named contact
            {f.ready > 0 && <> (one per {Math.round(searches / f.ready)} searches)</>}
            {f.unchecked > 0 && <>; {f.unchecked} more companies with contacts weren&apos;t needed</>}.
          </p>
        )}
      </section>

      {ready.length > 0 && (
        <section className="card mb-6 overflow-x-auto">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">Ready: companies that fit, with their contacts</h2>
            <p className="text-xs text-muted">Each contact&apos;s profile shows the company as their current job, they are in India, and their title is on the ICP&apos;s P1, P2 or P3 list.</p>
          </div>
          <table className="w-full min-w-[960px] text-sm">
            <thead className="text-xs text-ink-2">
              <tr>
                <th className={th}>Company</th>
                <th className={th}>Size</th>
                <th className={th}>Industry and headquarters</th>
                <th className={th}>Contacts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {ready.map((c) => (
                <tr key={c.employer}>
                  <CompanyCell c={c} />
                  <td className={`${td} whitespace-nowrap`}>
                    {c.page?.size || <span className="text-muted">not shown</span>}
                    {c.note.includes('borderline') && <span className="block text-xs text-warning-ink">borderline</span>}
                  </td>
                  <td className={td}>
                    {c.page?.industry || <span className="text-muted">industry not shown</span>}
                    <span className="block text-xs text-muted">{c.page?.hq || 'headquarters not shown'}</span>
                    {c.note.startsWith('headquartered abroad') && <span className="block text-xs text-muted">{c.note.split(';')[0]}</span>}
                  </td>
                  <td className={td}>
                    <ul className="space-y-0.5">
                      {c.contacts.slice(0, 4).map((p) => (
                        <li key={p.linkedin}>
                          <a href={p.linkedin} target="_blank" rel="noreferrer" className="hover:underline">{p.name}</a>
                          <span className="text-xs text-muted">: {p.title} ({p.tier}){p.location ? `, ${p.location}` : ''}</span>
                        </li>
                      ))}
                    </ul>
                    {c.contacts.length > 4 && <span className="text-xs text-muted">and {c.contacts.length - 4} more</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {others.length > 0 && (
        <section className="card mb-6 overflow-x-auto">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">Ruled out or not checked</h2>
            <p className="text-xs text-muted">Companies where someone on the lists works, that didn&apos;t pass, or weren&apos;t checked within the number of companies to check.</p>
          </div>
          <table className="w-full min-w-[860px] text-sm">
            <thead className="text-xs text-ink-2">
              <tr>
                <th className={th}>Company</th>
                <th className={th}>Size</th>
                <th className={th}>Result</th>
                <th className={th}>Contacts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {others.map((c) => (
                <tr key={c.employer}>
                  <CompanyCell c={c} />
                  <td className={`${td} whitespace-nowrap`}>{c.page?.size || <span className="text-muted">–</span>}</td>
                  <td className={td}>
                    <span className="text-ink-2">{SCREEN_LABEL[c.screen]}</span>
                    {c.note && <span className="block text-xs text-muted">{c.note}</span>}
                  </td>
                  <td className={td}>
                    <span className="text-xs text-muted">{c.contacts.map((p) => `${p.name} (${p.tier})`).join(', ')}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {report.people.length > 0 && (
        <section className="card mb-6 p-5">
          <details>
            <summary className="cursor-pointer text-sm font-semibold">Everyone found ({report.people.length}), and why some can&apos;t be contacts</summary>
            <ul className="mt-3 space-y-1 text-sm">
              {report.people.map((p) => (
                <li key={p.linkedin}>
                  <a href={p.linkedin} target="_blank" rel="noreferrer" className="hover:underline">{p.name || 'Unnamed profile'}</a>
                  <span className="text-xs text-muted">
                    {p.title ? `: ${p.title}` : ''}
                    {p.employer ? ` at ${p.employer}` : ''}
                  </span>
                  <span className={`block text-xs ${p.why ? 'text-muted' : 'text-good-ink'}`}>{p.why || `contact (${p.tier})`}</span>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}

      {report.queries.length > 0 && (
        <section className="card mb-6 overflow-x-auto">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">Searches for people</h2>
            <p className="text-xs text-muted">&quot;Industry&quot; searches add a word for what the company makes or does; &quot;open&quot; ones are the title and the place only. Compare them to see which finds more.</p>
          </div>
          <table className="w-full min-w-[860px] text-sm">
            <thead className="text-xs text-ink-2">
              <tr>
                <th className={th}>Search</th>
                <th className={th}>Form</th>
                <th className={`${th} text-right`}>Results</th>
                <th className={`${th} text-right`}>Profiles</th>
                <th className={`${th} text-right`}>On the lists</th>
                <th className={`${th} text-right`}>New companies</th>
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
                  <td className={`${td} text-right tabular-nums`}>{q.profiles}</td>
                  <td className={`${td} text-right tabular-nums`}>{q.onLists}</td>
                  <td className={`${td} text-right tabular-nums`}>{q.newCompanies}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
