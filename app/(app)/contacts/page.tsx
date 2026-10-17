import Link from 'next/link';
import { and, desc, eq, ilike, ne, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { tidyContacts } from '@/lib/verify-contacts';
import { redraftForContact } from '@/lib/pipeline/redraft';
import { liveServices } from '@/lib/run-driver';
import { after } from 'next/server';
import { icps, leads, people } from '@/lib/db/schema';
import { PageHeader } from '@/components/page-header';
import { AutoFilterForm } from '@/components/auto-filter-form';
import { getCurrentUser } from '@/lib/users';
import { ownerScope } from '@/lib/access';
import { bestEffort } from '@/lib/best-effort';
import { icpFor, tierOf } from '@/lib/tiers';
import { TierBadge } from '@/components/tier-badge';

const PAGE_SIZE = 100;

export default async function ContactsPage({ searchParams }: PageProps<'/contacts'>) {
  const sp = await searchParams;
  const q = typeof sp.q === 'string' ? sp.q.trim() : '';
  const page = Math.max(1, Number(sp.page) || 1);
  const db = await getDb();
  // Nobody who has left their company is listed.
  // (and nobody INVECK doesn't contact: off the ICP lists, or based outside India).
  const promoted = await bestEffort('tidying contacts', () => tidyContacts(db), [] as number[]);
  if (promoted.length) after(async () => { const d = await getDb(); const svc = await liveServices(); for (const id of promoted) await redraftForContact(d, svc, id); });

  // Decision-makers only: not people found at a company who aren't a contact for its site.
  const filters: SQL[] = [ne(people.passedReason, 'excluded')];
  const owner = ownerScope((await getCurrentUser())!);
  if (owner !== null) filters.push(eq(leads.ownerId, owner));
  if (q) filters.push(or(ilike(people.name, `%${q}%`), ilike(people.title, `%${q}%`), ilike(leads.company, `%${q}%`))!);
  const where = filters.length ? and(...filters) : undefined;

  const icpRows = await db.select().from(icps);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ p: people, company: leads.company, leadId: leads.id, status: leads.status, segment: leads.segment })
      .from(people)
      .innerJoin(leads, eq(people.leadId, leads.id))
      .where(where)
      .orderBy(desc(people.isPrimary), desc(leads.finalScore), people.id)
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db
      .select({
        total: sql<number>`count(*)::int`,
      })
      .from(people)
      .innerJoin(leads, eq(people.leadId, leads.id))
      .where(where),
  ]);
  const link = (next: Record<string, string>) => {
    const p = new URLSearchParams({ ...(q && { q }), ...next });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    return `/contacts${p.size ? `?${p}` : ''}`;
  };

  return (
    <>
      <PageHeader title="Contacts" description="Every decision-maker found at your leads' companies, not just the main contact.">
        <a href="/api/contacts/csv" download className="btn-secondary">Download CSV</a>
      </PageHeader>

      <AutoFilterForm className="mb-4 flex flex-wrap items-center gap-2">
        <input type="search" aria-label="Search name, title or company" name="q" defaultValue={q} placeholder="Search name, title or company" className="field max-w-xs" />
        <span className="ml-auto text-xs text-muted tabular-nums">
          {total} people
        </span>
      </AutoFilterForm>

      <div className="card overflow-hidden">
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="px-5 py-2 font-medium">Name</th>
                <th className="px-2 py-2 font-medium">Company</th>
                <th className="px-2 py-2 font-medium">LinkedIn</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, company, leadId, segment }) => (
                <tr key={p.id} className="border-t border-line align-top hover:bg-surface-2">
                  <td className="px-5 py-2.5">
                    <div className="font-medium">
                      {p.name}
                      <TierBadge tier={tierOf(p.title, icpFor(segment, icpRows))} />
                      {p.isPrimary && <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">Main</span>}
                    </div>
                    <div className="max-w-[16rem] truncate text-xs text-muted" title={p.title}>{p.title || '—'}</div>
                  </td>
                  <td className="px-2 py-2.5">
                    <Link href={`/leads/${leadId}`} className="hover:underline">{company}</Link>
                  </td>
                  <td className="px-2 py-2.5">
                    {p.linkedin ? <a href={p.linkedin} target="_blank" rel="noreferrer" className="whitespace-nowrap text-accent hover:underline">LinkedIn</a> : <span className="text-muted">—</span>}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={5} className="px-5 py-10 text-center text-sm text-muted">
                    {q ? 'No contacts match.' : 'No contacts yet. Everyone found while researching leads appears here.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-2">
          <span>
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-2">
            {page > 1 && <Link href={link({ page: String(page - 1) })} className="btn-secondary">Previous</Link>}
            {page * PAGE_SIZE < total && <Link href={link({ page: String(page + 1) })} className="btn-secondary">Next</Link>}
          </div>
        </div>
      )}
    </>
  );
}
