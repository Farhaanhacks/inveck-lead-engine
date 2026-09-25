import { desc, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { leads, PIPELINE_STAGES } from '@/lib/db/schema';
import { PageHeader } from '@/components/page-header';
import { isPast, relativeDays } from '@/lib/dates';
import { Board, type Card } from './board';

export default async function PipelinePage() {
  const db = await getDb();
  const rows = await db
    .select()
    .from(leads)
    .where(inArray(leads.status, [...PIPELINE_STAGES]))
    .orderBy(desc(leads.finalScore), desc(leads.updatedAt));

  const cards: Card[] = rows.map((l) => ({
    id: l.id,
    company: l.company,
    stage: l.status as Card['stage'],
    contact: [l.contactName, l.contactTitle].filter(Boolean).join(' · '),
    score: l.finalScore,
    signal: l.signals[0]?.headline ?? '',
    email: !!l.contactEmail,
    followUp:
      l.status === 'Contacted' && l.nextFollowUpAt
        ? { due: isPast(l.nextFollowUpAt), label: `Follow-up ${l.followUpStep + 1} ${isPast(l.nextFollowUpAt) ? 'due' : relativeDays(l.nextFollowUpAt)}` }
        : null,
  }));

  return (
    <>
      <PageHeader title="Pipeline" description="Every lead from approval to won or lost. Drag a card to move it, or use its menu." />
      <Board cards={cards} />
    </>
  );
}
