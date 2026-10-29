import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { normalizedKey } from './discovery/dedup';
import { articles, auditLogs, contentJobs, topicApprovals, topicCandidates } from './db/schema';
import type { AnyDb } from './db/types';

/** Who did it: the Blogs user's Inveck id and username (kept as `email` in the audit trail, as Article Basket named it). */
export type Actor = { id: number; email: string };

export type ApproveResult =
  | { ok: true; jobId: string; alreadyApproved: false }
  | { ok: true; jobId: string | null; alreadyApproved: true }
  | { ok: false; reason: 'not_found' | 'not_pending'; status?: string };

/** The key that makes "one job per approved topic" hold even if two approvals race. */
export const generationKey = (topicId: string, generation = 1) => `topic:${topicId}:generate:${generation}`;

/**
 * Approves a pending topic and creates its single generation job in one transaction.
 * Approving twice (double click, retry, two tabs) returns the existing job instead of creating another.
 */
export async function approveTopic(db: AnyDb, topicId: string, actor: Actor, comment?: string): Promise<ApproveResult> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(topicCandidates)
      .set({ status: 'approved', updatedAt: new Date() })
      .where(and(eq(topicCandidates.id, topicId), eq(topicCandidates.status, 'pending')))
      .returning({ id: topicCandidates.id });

    if (!claimed) {
      const [t] = await tx.select({ status: topicCandidates.status }).from(topicCandidates).where(eq(topicCandidates.id, topicId));
      if (!t) return { ok: false, reason: 'not_found' } as const;
      if (['approved', 'generating', 'published'].includes(t.status)) {
        const [job] = await tx.select({ id: contentJobs.id }).from(contentJobs).where(eq(contentJobs.idempotencyKey, generationKey(topicId)));
        return { ok: true, jobId: job?.id ?? null, alreadyApproved: true } as const;
      }
      return { ok: false, reason: 'not_pending', status: t.status } as const;
    }

    await tx.insert(topicApprovals).values({ topicId, adminId: actor.id, decision: 'approved', comment });
    const [job] = await tx
      .insert(contentJobs)
      .values({ topicId, idempotencyKey: generationKey(topicId), stage: 'research', status: 'queued', progress: { createdBy: actor.email } })
      .onConflictDoNothing({ target: contentJobs.idempotencyKey })
      .returning({ id: contentJobs.id });
    if (!job) throw new Error('A generation job already exists for this topic'); // rolls the approval back rather than leaving a topic with no job
    await tx.insert(auditLogs).values({ actor: actor.email, action: 'topic.approved', entityType: 'topic', entityId: topicId, details: { jobId: job.id } });
    return { ok: true, jobId: job.id, alreadyApproved: false } as const;
  });
}

export async function rejectTopic(db: AnyDb, topicId: string, actor: Actor, comment?: string): Promise<{ ok: boolean; reason?: string }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(topicCandidates)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(and(eq(topicCandidates.id, topicId), eq(topicCandidates.status, 'pending')))
      .returning({ id: topicCandidates.id });
    if (!row) return { ok: false, reason: 'Only a topic that is still pending can be rejected.' };
    await tx.insert(topicApprovals).values({ topicId, adminId: actor.id, decision: 'rejected', comment });
    await tx.insert(auditLogs).values({ actor: actor.email, action: 'topic.rejected', entityType: 'topic', entityId: topicId, details: { comment: comment ?? null } });
    return { ok: true };
  });
}

export const topicEditSchema = z.object({
  headline: z.string().trim().min(15).max(160),
  summary: z.string().trim().min(40).max(700),
  category: z.string().trim().min(2).max(60),
  primaryKeyword: z.string().trim().min(3).max(100),
  secondaryKeywords: z.array(z.string().trim().min(2).max(100)).max(8),
  searchIntent: z.enum(['informational', 'commercial', 'transactional', 'navigational']),
  articleFormat: z.string().trim().min(3).max(80),
  targetAudience: z.string().trim().min(3).max(200),
});
export type TopicEdit = z.infer<typeof topicEditSchema>;

/**
 * Edits a topic that has not been approved yet. Once approved, the subject is locked so a running job
 * can never have its subject silently changed; cancel the job and regenerate to change it deliberately.
 */
export async function editTopic(db: AnyDb, topicId: string, edit: TopicEdit, actor: Actor): Promise<{ ok: boolean; reason?: string }> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(topicCandidates).where(eq(topicCandidates.id, topicId)).for('update');
    if (!current) return { ok: false, reason: 'Topic not found.' };
    if (current.status !== 'pending') return { ok: false, reason: `This topic is ${current.status}, so its subject is locked. Cancel its job to change it.` };

    const key = normalizedKey(edit.primaryKeyword);
    const clash = await tx
      .select({ headline: topicCandidates.headline })
      .from(topicCandidates)
      .where(and(eq(topicCandidates.domainId, current.domainId), eq(topicCandidates.normalizedKey, key), ne(topicCandidates.id, topicId), ne(topicCandidates.status, 'rejected')))
      .limit(1);
    if (clash.length) return { ok: false, reason: `Another topic already targets that keyword: "${clash[0].headline}".` };
    const published = await tx.select({ title: articles.title }).from(articles).where(and(eq(articles.domainId, current.domainId), eq(articles.primaryKeyword, edit.primaryKeyword))).limit(1);
    if (published.length) return { ok: false, reason: `An article already targets that keyword: "${published[0].title}".` };

    await tx.update(topicCandidates).set({ ...edit, normalizedKey: key, editedAt: new Date(), updatedAt: new Date() }).where(eq(topicCandidates.id, topicId));
    await tx.insert(topicApprovals).values({ topicId, adminId: actor.id, decision: 'edited', comment: null });
    await tx.insert(auditLogs).values({ actor: actor.email, action: 'topic.edited', entityType: 'topic', entityId: topicId, details: { before: { headline: current.headline, primaryKeyword: current.primaryKeyword }, after: { headline: edit.headline, primaryKeyword: edit.primaryKeyword } } });
    return { ok: true };
  });
}
