import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { icps } from '@/lib/db/schema';
import { PageHeader } from '@/components/page-header';
import { AddLeadForms } from './forms';

// Research started from this page keeps working after the response.
export const maxDuration = 300;

export default async function NewLeadsPage() {
  const db = await getDb();
  // Only active ICPs: a company is checked against the one its segment names.
  const segments = (await db.select({ segment: icps.segment }).from(icps).where(eq(icps.active, true)).orderBy(asc(icps.id))).map((s) => s.segment);
  return (
    <>
      <PageHeader
        title="Add companies"
        description="Companies added here are researched straight away. You can also let the prospect search find companies for you."
      />
      <AddLeadForms segments={segments} />
    </>
  );
}
