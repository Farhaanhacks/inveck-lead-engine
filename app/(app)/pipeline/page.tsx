import { and, desc, eq, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/users';
import { ownerScope } from '@/lib/access';
import { getDb } from '@/lib/db';
import { leads, PIPELINE_STAGES } from '@/lib/db/schema';
import { PageHeader } from '@/components/page-header';
import { nextRounds, roundBadge } from '@/lib/follow-up-sequence';
import { Board, type Card } from './board';

export default async function PipelinePage() {
  const db = await getDb();
  const me = (await getCurrentUser())!;
  const owner = ownerScope(me);
  const rows = await db
    .select()
    .from(leads)
    .where(and(inArray(leads.status, [...PIPELINE_STAGES]), owner === null ? undefined : eq(leads.ownerId, owner)))
    .orderBy(desc(leads.finalScore), desc(leads.updatedAt));

  const rounds = await nextRounds(db, rows.map((l) => l.id));
  const cards: Card[] = rows.map((l) => ({
    id: l.id,
    company: l.company,
    stage: l.status as Card['stage'],
    contact: [l.contactName, l.contactTitle].filter(Boolean).join(' · '),
    score: l.finalScore,
    followUp: rounds.has(l.id) ? roundBadge(rounds.get(l.id)!) : null,
  }));

  return (
    <>
      <PageHeader title="Pipeline" description="Every lead from approval to won or lost. Drag a card to move it, or use its menu." />
      <Board cards={cards} />
    </>
  );
}
