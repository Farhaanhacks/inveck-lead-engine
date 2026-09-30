import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { leads, people } from '@/lib/db/schema';
import { toCsv } from '@/lib/csv';
import { getCurrentUser } from '@/lib/users';
import { ownerScope } from '@/lib/access';

/** All contacts as a CSV for Excel. Behind the login, like every API route. */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not logged in' }, { status: 401 });
  const owner = ownerScope(me);
  const db = await getDb();
  const rows = await db
    .select({ p: people, company: leads.company, website: leads.website, status: leads.status })
    .from(people)
    .innerJoin(leads, eq(people.leadId, leads.id))
    .where(owner === null ? undefined : eq(leads.ownerId, owner))
    .orderBy(asc(leads.company), asc(people.id));
  const csv = toCsv([
    ['Name', 'Title', 'Company', 'Website', 'Email', 'Email status', 'Phone', 'LinkedIn', 'Found via', 'Main contact', 'Lead status'],
    ...rows.map(({ p, company, website, status }) => [p.name, p.title, company, website, p.email, p.emailStatus, p.phone, p.linkedin, p.source, p.isPrimary ? 'Yes' : '', status]),
  ]);
  return new Response('﻿' + csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="inveck-contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
