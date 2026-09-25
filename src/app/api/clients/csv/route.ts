import { asc } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { clients } from '@/lib/db/schema';
import { CLIENT_FIELDS, CLIENT_HEADERS } from '@/lib/clients';
import { toCsv } from '@/lib/csv';

/** The client list as a CSV file that opens straight in Excel. Behind the login, like every API route. */
export async function GET() {
  const db = await getDb();
  const rows = await db.select().from(clients).orderBy(asc(clients.id));
  const csv = toCsv([CLIENT_FIELDS.map((f) => CLIENT_HEADERS[f]), ...rows.map((r) => CLIENT_FIELDS.map((f) => r[f]))]);
  const date = new Date().toISOString().slice(0, 10);
  // The byte-order mark makes Excel read the file as UTF-8.
  return new Response('﻿' + csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="inveck-clients-${date}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
