import Link from 'next/link';
import { and, desc, eq, ilike, ne, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { leads, people } from '@/lib/db/schema';
import { PageHeader } from '@/components/page-header';
import { AutoFilterForm } from '@/components/auto-filter-form';
import { getCurrentUser } from '@/lib/users';
import { ownerScope } from '@/lib/access';

const PAGE_SIZE = 100;

export default async function ContactsPage({ searchParams }: PageProps<'/contacts'>) {
  const sp = await searchParams;
  const q = typeof sp.q === 'string' ? sp.q.trim() : '';
  const withEmail = sp.email === '1';
  const page = Math.max(1, Number(sp.page) || 1);
  const db = await getDb();

  const filters: SQL[] = [];
  const owner = ownerScope((await getCurrentUser())!);
  if (owner !== null) filters.push(eq(leads.ownerId, owner));
  if (q) filters.push(or(ilike(people.name, `%${q}%`), ilike(people.title, `%${q}%`), ilike(leads.company, `%${q}%`))!);
  if (withEmail) filters.push(ne(people.email, ''));
  const where = filters.length ? and(...filters) : undefined;

  const [rows, [{ total, emails, phones }]] = await Promise.all([
    db
      .select({ p: people, company: leads.company, leadId: leads.id, status: leads.status })
      .from(people)
      .innerJoin(leads, eq(people.leadId, leads.id))
      .where(where)
      .orderBy(desc(people.isPrimary), desc(leads.finalScore), people.id)
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db
      .select({
        total: sql<number>`count(*)::int`,
        emails: sql<number>`(count(*) filter (where ${people.email} <> ''))::int`,
        phones: sql<number>`(count(*) filter (where ${people.phone} <> ''))::int`,
      })
      .from(people)
      .innerJoin(leads, eq(people.leadId, leads.id))
      .where(where),
  ]);
  const link = (next: Record<string, string>) => {
    const p = new URLSearchParams({ ...(q && { q }), ...(withEmail && { email: '1' }), ...next });
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
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" name="email" value="1" defaultChecked={withEmail} /> With email only
        </label>
        <span className="ml-auto text-xs text-muted tabular-nums">
          {total} people · {emails} with email · {phones} with phone
        </span>
      </AutoFilterForm>

      <div className="card overflow-hidden">
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="px-5 py-2 font-medium">Name</th>
                <th className="px-2 py-2 font-medium">Company</th>
                <th className="px-2 py-2 font-medium">Email</th>
                <th className="px-2 py-2 font-medium">Phone</th>
                <th className="px-2 py-2 font-medium">LinkedIn</th>
                <th className="px-5 py-2 font-medium">Found via</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, company, leadId }) => (
                <tr key={p.id} className="border-t border-line align-top hover:bg-surface-2">
                  <td className="px-5 py-2.5">
                    <div className="font-medium">
                      {p.name}
                      {p.isPrimary && <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">Main</span>}
                    </div>
                    <div className="max-w-[16rem] truncate text-xs text-muted" title={p.title}>{p.title || '—'}</div>
                  </td>
                  <td className="px-2 py-2.5">
                    <Link href={`/leads/${leadId}`} className="hover:underline">{company}</Link>
                  </td>
                  <td className="px-2 py-2.5">
                    {p.email ? <a href={`mailto:${p.email}`} className="hover:underline">{p.email}</a> : <span className="text-muted">—</span>}
                    {p.emailStatus && <div className="max-w-[15rem] truncate text-xs text-muted" title={p.emailStatus}>{p.emailStatus}</div>}
                  </td>
                  <td className="px-2 py-2.5 whitespace-nowrap">{p.phone || <span className="text-muted">—</span>}</td>
                  <td className="px-2 py-2.5">
                    {p.linkedin ? <a href={p.linkedin} target="_blank" rel="noreferrer" className="whitespace-nowrap text-accent hover:underline">LinkedIn</a> : <span className="text-muted">—</span>}
                  </td>
                  <td className="px-5 py-2.5 text-xs text-ink-2">{p.source}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-sm text-muted">
                    {q || withEmail ? 'No contacts match.' : 'No contacts yet. Everyone found while researching leads appears here.'}
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
