import { getDb } from '@/lib/db';
import { icps } from '@/lib/db/schema';
import { PageHeader } from '@/components/page-header';
import { AddLeadForms } from './forms';

export default async function NewLeadsPage() {
  const db = await getDb();
  const segments = (await db.select({ segment: icps.segment }).from(icps)).map((s) => s.segment);
  return (
    <>
      <PageHeader
        title="Add companies"
        description="Companies added here are researched on the next run. You can also let the prospect search find companies for you."
      />
      <AddLeadForms segments={segments} />
    </>
  );
}
