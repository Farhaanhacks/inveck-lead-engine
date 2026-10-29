import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveTopic, editTopic, rejectTopic, type Actor, type TopicEdit } from '@/lib/blogs/approvals';
import { auditLogs, contentJobs, topicApprovals, topicCandidates } from '@/lib/blogs/db/schema';
import { normalizedKey } from '@/lib/blogs/discovery/dedup';
import { makeTestDb } from './helpers/testdb';

const admin: Actor = { id: 1, email: 'blogs@inveck' };
let t: Awaited<ReturnType<typeof makeTestDb>>;
beforeAll(async () => { t = await makeTestDb(); });
afterAll(async () => { await t.close(); });

let n = 0;
async function topic(over: Partial<typeof topicCandidates.$inferInsert> = {}) {
  n += 1;
  const kw = over.primaryKeyword ?? `keyword number ${n} alpha`;
  const [row] = await t.db
    .insert(topicCandidates)
    .values({ domainId: t.domains[0].id, headline: `Headline for topic number ${n} goes here`, summary: 'A summary that is long enough to be valid for the edit schema checks.', primaryKeyword: kw, normalizedKey: normalizedKey(kw), ...over })
    .returning();
  return row;
}
const edit = (over: Partial<TopicEdit> = {}): TopicEdit => ({
  headline: 'An edited headline that is long enough',
  summary: 'An edited summary that is comfortably long enough to pass validation.',
  category: 'Edited',
  primaryKeyword: 'edited unique keyword',
  secondaryKeywords: ['one'],
  searchIntent: 'informational',
  articleFormat: 'Explainer',
  targetAudience: 'Readers',
  ...over,
});

describe('approving a topic', () => {
  it('records the decision, creates one queued job and an audit entry', async () => {
    const tp = await topic();
    const r = await approveTopic(t.db, tp.id, admin, 'looks good');
    expect(r).toMatchObject({ ok: true, alreadyApproved: false });
    const jobs = await t.db.select().from(contentJobs).where(eq(contentJobs.topicId, tp.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'queued', stage: 'research' });
    const [after] = await t.db.select().from(topicCandidates).where(eq(topicCandidates.id, tp.id));
    expect(after.status).toBe('approved');
    const decisions = await t.db.select().from(topicApprovals).where(eq(topicApprovals.topicId, tp.id));
    expect(decisions).toMatchObject([{ decision: 'approved', adminId: admin.id, comment: 'looks good' }]);
    const log = await t.db.select().from(auditLogs).where(eq(auditLogs.entityId, tp.id));
    expect(log.map((l) => l.action)).toContain('topic.approved');
  });

  it('does not create a second job when approval is repeated', async () => {
    const tp = await topic();
    const first = await approveTopic(t.db, tp.id, admin);
    const second = await approveTopic(t.db, tp.id, admin);
    expect(second).toMatchObject({ ok: true, alreadyApproved: true });
    if (first.ok && second.ok) expect(second.jobId).toBe(first.jobId);
    expect(await t.db.select().from(contentJobs).where(eq(contentJobs.topicId, tp.id))).toHaveLength(1);
    expect(await t.db.select().from(topicApprovals).where(eq(topicApprovals.topicId, tp.id))).toHaveLength(1);
  });

  it('creates exactly one job when approvals race', async () => {
    const tp = await topic();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => approveTopic(t.db, tp.id, admin)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && !r.alreadyApproved)).toHaveLength(1);
    expect(await t.db.select().from(contentJobs).where(eq(contentJobs.topicId, tp.id))).toHaveLength(1);
  });

  it('the database itself refuses a second active job for a topic', async () => {
    const tp = await topic();
    await approveTopic(t.db, tp.id, admin);
    await expect(t.db.insert(contentJobs).values({ topicId: tp.id, idempotencyKey: 'manual-second-job' })).rejects.toThrow();
  });

  it('reports a missing topic', async () => {
    expect(await approveTopic(t.db, '22222222-2222-4222-8222-222222222222', admin)).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('rejecting a topic', () => {
  it('rejects without creating a job, and a rejected topic cannot then be approved', async () => {
    const tp = await topic();
    expect(await rejectTopic(t.db, tp.id, admin, 'off brand')).toEqual({ ok: true });
    expect(await t.db.select().from(contentJobs).where(eq(contentJobs.topicId, tp.id))).toHaveLength(0);
    expect(await approveTopic(t.db, tp.id, admin)).toMatchObject({ ok: false, reason: 'not_pending', status: 'rejected' });
    expect(await t.db.select().from(contentJobs).where(eq(contentJobs.topicId, tp.id))).toHaveLength(0);
  });

  it('cannot reject an approved topic', async () => {
    const tp = await topic();
    await approveTopic(t.db, tp.id, admin);
    expect((await rejectTopic(t.db, tp.id, admin)).ok).toBe(false);
  });
});

describe('editing a topic', () => {
  it('updates fields, recomputes the keyword key and logs the change', async () => {
    const tp = await topic();
    expect(await editTopic(t.db, tp.id, edit({ primaryKeyword: 'Brand New Keyword Phrase' }), admin)).toEqual({ ok: true });
    const [row] = await t.db.select().from(topicCandidates).where(eq(topicCandidates.id, tp.id));
    expect(row.headline).toBe('An edited headline that is long enough');
    expect(row.normalizedKey).toBe(normalizedKey('Brand New Keyword Phrase'));
    expect(row.editedAt).not.toBeNull();
    expect(row.status).toBe('pending');
  });

  it('locks the subject once the topic is approved', async () => {
    const tp = await topic();
    await approveTopic(t.db, tp.id, admin);
    const r = await editTopic(t.db, tp.id, edit({ primaryKeyword: 'sneaky change' }), admin);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/locked/);
    const [row] = await t.db.select().from(topicCandidates).where(eq(topicCandidates.id, tp.id));
    expect(row.primaryKeyword).not.toBe('sneaky change');
  });

  it('refuses a keyword another live topic already targets', async () => {
    const other = await topic({ primaryKeyword: 'shared target keyword' });
    const tp = await topic();
    const r = await editTopic(t.db, tp.id, edit({ primaryKeyword: 'Shared Target Keyword' }), admin);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(other.headline);
  });
});
