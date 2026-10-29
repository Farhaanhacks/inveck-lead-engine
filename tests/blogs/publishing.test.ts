import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockCmsAdapter, UnconfiguredCmsAdapter } from '@/lib/blogs/cms/mock';
import { CmsError, type CmsAdapter, type PostInput } from '@/lib/blogs/cms/types';
import { WordPressAdapter } from '@/lib/blogs/cms/wordpress';
import { articleAssets, articles, publishedPosts, topicCandidates } from '@/lib/blogs/db/schema';
import { normalizedKey } from '@/lib/blogs/discovery/dedup';
import { DEFAULT_AUTHORS, saveAuthors, type Author } from '@/lib/blogs/authors';

// Test people only: the Inveck blog ships with no authors at all.
const TEST_AUTHORS: Author[] = [
  { id: 'asha-test', name: 'Asha Test', designation: 'Editor', linkedin: 'https://www.linkedin.com/in/asha-test/', wpUserId: null },
  { id: 'ravi-test', name: 'Ravi Test', designation: 'Writer', linkedin: 'https://www.linkedin.com/in/ravi-test/', wpUserId: null },
];
import { cancelPost, reschedulePost, schedulePublication, type QueueSettings } from '@/lib/blogs/publishing/schedule';
import { dayIsFull, findSlot, localDayKey } from '@/lib/blogs/publishing/slots';
import { processDuePosts, publishBackoffMs, retryPost } from '@/lib/blogs/publishing/worker';
import { zonedTimeToUtc } from '@/lib/blogs/time';
import { NOW } from './helpers/fakes';
import { makeTestDb } from './helpers/testdb';

const admin = { id: 1, email: 'blogs@inveck' };
const Q: QueueSettings = { timezone: 'Asia/Kolkata', targetPerDay: 5, maxPerDay: 3, windows: [{ start: '09:00', end: '21:00' }], minIntervalMinutes: 60, maxConcurrentJobs: 2, autoSlotApproved: false };
const ist = (d: string, h: number, m = 0) => { const [y, mo, da] = d.split('-').map(Number); return zonedTimeToUtc('Asia/Kolkata', y, mo, da, h, m); };

describe('findSlot', () => {
  it('starts at the window opening and spaces posts by the minimum interval', () => {
    const from = ist('2026-10-19', 6);
    const first = findSlot(from, [], Q)!;
    expect(first.toISOString()).toBe(ist('2026-10-19', 9).toISOString());
    const second = findSlot(from, [first], Q)!;
    expect(second.getTime() - first.getTime()).toBe(60 * 60_000);
  });

  it('moves to the next day when the daily limit is reached', () => {
    const taken = [9, 10, 11].map((h) => ist('2026-10-19', h));
    const slot = findSlot(ist('2026-10-19', 8), taken, Q)!;
    expect(localDayKey('Asia/Kolkata', slot)).toBe('2026-10-20');
    expect(slot.toISOString()).toBe(ist('2026-10-20', 9).toISOString());
  });

  it('skips the rest of the day once the window has closed', () => {
    const slot = findSlot(ist('2026-10-19', 22), [], Q)!;
    expect(slot.toISOString()).toBe(ist('2026-10-20', 9).toISOString());
  });

  it('never returns a time outside the window or within the interval of another post', () => {
    const taken: Date[] = [];
    let from = ist('2026-10-19', 5);
    for (let i = 0; i < 20; i++) {
      const s = findSlot(from, taken, { ...Q, maxPerDay: 6 })!;
      taken.push(s);
      const mins = (s.getTime() - ist(localDayKey('Asia/Kolkata', s), 0).getTime()) / 60_000;
      expect(mins).toBeGreaterThanOrEqual(9 * 60);
      expect(mins).toBeLessThan(21 * 60);
    }
    const sorted = taken.map((t) => t.getTime()).sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(60 * 60_000);
    const perDay = new Map<string, number>();
    for (const t of taken) perDay.set(localDayKey('Asia/Kolkata', t), (perDay.get(localDayKey('Asia/Kolkata', t)) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(6);
    from = from;
  });

  it('keeps the same wall-clock window across a daylight-saving change', () => {
    const ny = { ...Q, timezone: 'America/New_York' };
    const before = findSlot(zonedTimeToUtc('America/New_York', 2026, 10, 31, 6), [], ny)!; // still daylight time
    const after = findSlot(zonedTimeToUtc('America/New_York', 2026, 11, 1, 6), [], ny)!; // clocks went back overnight
    expect(before.toISOString()).toBe(zonedTimeToUtc('America/New_York', 2026, 10, 31, 9).toISOString());
    expect(after.toISOString()).toBe(zonedTimeToUtc('America/New_York', 2026, 11, 1, 9).toISOString());
    expect(after.getTime() - before.getTime()).toBe(25 * 3600_000); // 9:00 to 9:00 across the 25-hour day
    expect(localDayKey('America/New_York', after)).toBe('2026-11-01');
  });

  it('reports whether a day is full', () => {
    const taken = [9, 10, 11].map((h) => ist('2026-10-19', h));
    expect(dayIsFull(ist('2026-10-19', 15), taken, Q)).toBe(true);
    expect(dayIsFull(ist('2026-10-20', 15), taken, Q)).toBe(false);
  });
});

describe('scheduling and publishing (database)', () => {
  let t: Awaited<ReturnType<typeof makeTestDb>>;
  let n = 0;
  beforeAll(async () => { t = await makeTestDb(); });
  afterAll(async () => { await t.close(); });
  // Each test starts with an empty schedule so leftovers from one cannot be published by another.
  beforeEach(async () => { await t.db.delete(publishedPosts); await t.db.update(articles).set({ status: 'draft' }); });

  async function readyArticle(over: { status?: string; passed?: boolean; image?: boolean } = {}) {
    n++;
    const [topic] = await t.db.insert(topicCandidates).values({ domainId: t.domains[0].id, headline: `Headline number ${n} for publishing tests`, summary: 'x'.repeat(60), primaryKeyword: `kw ${n}`, normalizedKey: normalizedKey(`kw ${n}`), status: 'generating' }).returning();
    const [a] = await t.db.insert(articles).values({ topicId: topic.id, domainId: t.domains[0].id, title: `Article ${n}`, slug: `article-${n}`, bodyMarkdown: 'body', bodyHtml: '<p>body</p>', excerpt: 'ex', seoTitle: 's', metaDescription: 'm', primaryKeyword: `kw ${n}`, category: 'Business', tags: ['a'], status: over.status ?? 'ready', validation: { passed: over.passed ?? true } }).returning();
    if (over.image !== false) await t.db.insert(articleAssets).values({ articleId: a.id, status: 'generated', url: 'https://storage.example.com/x.webp', altText: 'alt', mimeType: 'image/webp' });
    return a;
  }
  const post = async (id: string) => (await t.db.select().from(publishedPosts).where(eq(publishedPosts.id, id)))[0];
  const article = async (id: string) => (await t.db.select().from(articles).where(eq(articles.id, id)))[0];
  const mockWith = () => new MockCmsAdapter();
  const fetchImage = async () => ({ bytes: Buffer.from('img'), mimeType: 'image/webp' });
  const run = (adapter: CmsAdapter, q: QueueSettings, at: Date, extra: { limit?: number } = {}) => processDuePosts(t.db, adapter, q, at, { fetchImage, ...extra });

  it('refuses to schedule anything that is not ready, validated and illustrated', async () => {
    const mock = mockWith();
    for (const [over, text] of [[{ status: 'blocked' }, /ready/], [{ passed: false }, /quality checks/], [{ image: false }, /image/]] as const) {
      const a = await readyArticle(over);
      const r = await schedulePublication(t.db, mock, a.id, { mode: 'immediate' }, Q, admin, NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(text);
    }
  });

  it('schedules once per article, in the requested mode', async () => {
    const mock = mockWith();
    const a = await readyArticle();
    const at = new Date(NOW.getTime() + 3 * 3600_000);
    const r = await schedulePublication(t.db, mock, a.id, { mode: 'scheduled', at }, Q, admin, NOW);
    expect(r).toMatchObject({ ok: true });
    expect((await article(a.id)).status).toBe('scheduled');
    expect((await schedulePublication(t.db, mock, a.id, { mode: 'immediate' }, Q, admin, NOW)).ok).toBe(false);
    expect((await schedulePublication(t.db, mock, (await readyArticle()).id, { mode: 'scheduled', at: new Date(NOW.getTime() - 3600_000) }, Q, admin, NOW)).ok).toBe(false);
  });

  it('keeps a scheduled article unpublished until its time, then publishes it and records id and URL', async () => {
    const mock = mockWith();
    const a = await readyArticle();
    const at = new Date(NOW.getTime() + 2 * 3600_000);
    const r = await schedulePublication(t.db, mock, a.id, { mode: 'scheduled', at }, Q, admin, NOW);
    if (!r.ok) throw new Error(r.reason);
    expect(await run(mock, Q, new Date(at.getTime() - 60_000))).toEqual([]);
    expect((await post(r.postId)).status).toBe('scheduled');
    const out = await run(mock, Q, new Date(at.getTime() + 1000));
    expect(out).toEqual([{ postId: r.postId, result: 'published' }]);
    const p = await post(r.postId);
    expect(p).toMatchObject({ status: 'published', isMock: true, adapter: 'mock' });
    expect(p.cmsPostId).toMatch(/^mock-/);
    expect(p.publicUrl).toMatch(/^mock:\/\//);
    expect((await article(a.id)).status).toBe('published');
  });

  it('publishes with the article\'s author: a LinkedIn author box in the content and the WordPress byline', async () => {
    const created: PostInput[] = [];
    const spy: CmsAdapter = { ...mockWith(), name: 'spy', isMock: false, testConnection: async () => ({ state: 'connected', detail: '', checkedAt: '' }), uploadMedia: async () => ({ mediaId: '7', url: '' }), findExisting: async () => null, getPost: async () => null, unpublish: async () => {}, createPost: async (input) => { created.push(input); return { cmsPostId: '99', url: 'https://site.example/p/', status: 'publish', notes: {} }; } };
    const a = await readyArticle();
    // The current author list is the source of truth (a corrected link or WordPress ID applies to every article).
    await saveAuthors(t.db, TEST_AUTHORS.map((x) => (x.id === 'ravi-test' ? { ...x, wpUserId: 12 } : x)));
    await t.db.update(articles).set({ metadata: { author: TEST_AUTHORS[1] } }).where(eq(articles.id, a.id));
    const r = await schedulePublication(t.db, spy, a.id, { mode: 'immediate' }, { ...Q, maxPerDay: 50 }, admin, NOW);
    if (!r.ok) throw new Error(r.reason);
    await run(spy, { ...Q, maxPerDay: 50 }, new Date(NOW.getTime() + 1000));
    expect(created).toHaveLength(1);
    expect(created[0].contentHtml).toContain('Ravi Test');
    expect(created[0].contentHtml).toContain('Writer');
    expect(created[0].contentHtml).toContain('https://www.linkedin.com/in/ravi-test/');
    expect(created[0].authorWpId).toBe(12);
    await saveAuthors(t.db, TEST_AUTHORS);
  });

  it('gives an older article without an author a random one at publish time, and saves it', async () => {
    const mock = mockWith();
    const a = await readyArticle();
    const r = await schedulePublication(t.db, mock, a.id, { mode: 'immediate' }, { ...Q, maxPerDay: 50 }, admin, NOW);
    if (!r.ok) throw new Error(r.reason);
    await run(mock, { ...Q, maxPerDay: 50 }, new Date(NOW.getTime() + 1000));
    const after = await article(a.id);
    expect(['Asha Test', 'Ravi Test']).toContain((after.metadata as { author?: { name: string } }).author?.name);
  });

  it('never lets a retry create a second post, even after a crash between create and save', async () => {
    const mock = mockWith();
    const a = await readyArticle();
    const r = await schedulePublication(t.db, mock, a.id, { mode: 'immediate' }, Q, admin, NOW);
    if (!r.ok) throw new Error(r.reason);
    // Simulate the crash: the CMS has the post, our database does not know.
    await mock.createPost({ articleId: a.id, title: 't', slug: a.slug, contentHtml: 'h', excerpt: '', categoryNames: [], tags: [], status: 'publish' });
    mock.created.get(a.id)!.status = 'publish';
    await run(mock, Q, new Date(NOW.getTime() + 1000));
    expect(mock.created.size).toBe(1);
    expect((await post(r.postId)).syncDetails).toMatchObject({ adopted: true });
  });

  it('retries transient CMS errors with backoff and gives up after the maximum attempts', async () => {
    const flaky: CmsAdapter = { ...mockWith(), name: 'flaky', isMock: false, testConnection: async () => ({ state: 'connected', detail: 'ok', checkedAt: '' }), uploadMedia: async () => ({ mediaId: '1', url: '' }), findExisting: async () => null, createPost: async () => { throw new CmsError('WordPress is unavailable (503)', 'unavailable', true, 503); }, getPost: async () => null, unpublish: async () => {} };
    const a = await readyArticle();
    const r = await schedulePublication(t.db, flaky, a.id, { mode: 'immediate' }, { ...Q, maxPerDay: 50 }, admin, NOW);
    if (!r.ok) throw new Error(r.reason);
    let clock = new Date(NOW.getTime() + 1000);
    const results: string[] = [];
    for (let i = 0; i < 6; i++) {
      const out = await run(flaky, { ...Q, maxPerDay: 50 }, clock);
      if (out[0]) results.push(out[0].result);
      clock = new Date(clock.getTime() + 2 * 3600_000);
    }
    expect(results).toEqual(['retry', 'retry', 'retry', 'retry', 'failed']);
    expect(await post(r.postId)).toMatchObject({ status: 'failed', attempts: 5 });
    expect(publishBackoffMs(1)).toBe(60_000);
    expect((await article(a.id)).status).toBe('ready'); // available to reschedule
    expect((await retryPost(t.db, r.postId, clock)).ok).toBe(true);
    expect((await post(r.postId)).status).toBe('scheduled');
  });

  it('does not use up attempts when the CMS is down or unauthorised; it waits in a visible delayed state', async () => {
    const down = new UnconfiguredCmsAdapter('WordPress is not configured');
    const a = await readyArticle();
    const r = await schedulePublication(t.db, down, a.id, { mode: 'immediate' }, { ...Q, maxPerDay: 50 }, admin, NOW);
    if (!r.ok) throw new Error(r.reason);
    const out = await run(down, { ...Q, maxPerDay: 50 }, new Date(NOW.getTime() + 1000));
    expect(out[0].result).toBe('delayed');
    expect(await post(r.postId)).toMatchObject({ status: 'delayed', attempts: 0 });
    expect(((await post(r.postId)).lastError as { code: string }).code).toBe('cms_not_configured');
    expect((await article(a.id)).status).toBe('scheduled');
  });

  it('delays instead of publishing when the article is no longer ready', async () => {
    const mock = mockWith();
    const a = await readyArticle();
    const r = await schedulePublication(t.db, mock, a.id, { mode: 'immediate' }, { ...Q, maxPerDay: 50 }, admin, NOW);
    if (!r.ok) throw new Error(r.reason);
    await t.db.update(articles).set({ validation: { passed: false } }).where(eq(articles.id, a.id));
    const out = await run(mock, { ...Q, maxPerDay: 50 }, new Date(NOW.getTime() + 1000));
    expect(out[0]).toMatchObject({ result: 'delayed' });
    expect(mock.created.size).toBe(0);
    expect((await post(r.postId)).status).toBe('delayed');
  });

  it('enforces the daily limit at scheduling and at publishing time', async () => {
    const mock = mockWith();
    const q = { ...Q, maxPerDay: 2 };
    const day = new Date('2027-03-10T05:00:00Z');
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await schedulePublication(t.db, mock, (await readyArticle()).id, { mode: 'scheduled', at: new Date(day.getTime() + i * 3600_000) }, q, admin, NOW);
      expect(r.ok).toBe(true);
      if (r.ok) ids.push(r.postId);
    }
    const third = await schedulePublication(t.db, mock, (await readyArticle()).id, { mode: 'scheduled', at: new Date(day.getTime() + 2 * 3600_000) }, q, admin, NOW);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toMatch(/daily limit/);
    const queued = await schedulePublication(t.db, mock, (await readyArticle()).id, { mode: 'queue' }, q, admin, day);
    expect(queued.ok && localDayKey(q.timezone, queued.scheduledFor)).not.toBe(localDayKey(q.timezone, day));
  });

  it('reschedules and cancels, and a cancelled article can be scheduled again', async () => {
    const mock = mockWith();
    const q = { ...Q, maxPerDay: 50 };
    const a = await readyArticle();
    const r = await schedulePublication(t.db, mock, a.id, { mode: 'scheduled', at: new Date(NOW.getTime() + 3600_000) }, q, admin, NOW);
    if (!r.ok) throw new Error(r.reason);
    const later = new Date(NOW.getTime() + 5 * 3600_000);
    expect(await reschedulePost(t.db, r.postId, { at: later }, q, admin, NOW)).toMatchObject({ ok: true });
    expect((await post(r.postId)).scheduledFor!.toISOString()).toBe(later.toISOString());
    expect((await cancelPost(t.db, r.postId, admin, NOW)).ok).toBe(true);
    expect((await article(a.id)).status).toBe('ready');
    expect((await reschedulePost(t.db, r.postId, { at: later }, q, admin, NOW)).ok).toBe(false);
    expect((await schedulePublication(t.db, mock, a.id, { mode: 'immediate' }, q, admin, NOW)).ok).toBe(true);
  });

  it('respects the concurrency limit and runs higher priority first', async () => {
    const mock = mockWith();
    const q = { ...Q, maxPerDay: 50, maxConcurrentJobs: 1 };
    const low = await schedulePublication(t.db, mock, (await readyArticle()).id, { mode: 'scheduled', at: new Date(NOW.getTime() + 1000), priority: 0 }, q, admin, NOW);
    const high = await schedulePublication(t.db, mock, (await readyArticle()).id, { mode: 'scheduled', at: new Date(NOW.getTime() + 2000), priority: 5 }, q, admin, NOW);
    if (!low.ok || !high.ok) throw new Error('setup');
    const out = await run(mock, q, new Date(NOW.getTime() + 10_000), { limit: 5 });
    expect(out).toHaveLength(1);
    expect(out[0].postId).toBe(high.postId);
  });

  it('only one worker publishes a due post', async () => {
    const mock = mockWith();
    const q = { ...Q, maxPerDay: 50 };
    const a = await readyArticle();
    const r = await schedulePublication(t.db, mock, a.id, { mode: 'immediate' }, q, admin, NOW);
    if (!r.ok) throw new Error('setup');
    const at = new Date(NOW.getTime() + 1000);
    const [x, y] = await Promise.all([run(mock, q, at), run(mock, q, at)]);
    expect([...x, ...y].filter((o) => o.result === 'published')).toHaveLength(1);
    expect(mock.created.size).toBe(1);
  });

  it('the database refuses two live posts for one article', async () => {
    const a = await readyArticle();
    await t.db.insert(publishedPosts).values({ articleId: a.id, adapter: 'mock', status: 'scheduled', idempotencyKey: `k-${a.id}-1` });
    await expect(t.db.insert(publishedPosts).values({ articleId: a.id, adapter: 'mock', status: 'scheduled', idempotencyKey: `k-${a.id}-2` })).rejects.toThrow();
  });
});

describe('adapters', () => {
  it('mock adapter says it is a mock and the unconfigured adapter refuses to act', async () => {
    expect((await new MockCmsAdapter().testConnection()).state).toBe('mock');
    const u = new UnconfiguredCmsAdapter('not set up');
    expect((await u.testConnection()).state).toBe('not_configured');
    await expect((u as CmsAdapter).createPost({} as PostInput)).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('WordPressAdapter (HTTP mocked; not a real site)', () => {
  type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };
  function wp(handler: (c: Call) => { status?: number; json?: unknown }) {
    const calls: Call[] = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      const c: Call = { url: String(url), method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body };
      calls.push(c);
      const r = handler(c);
      return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { adapter: new WordPressAdapter('https://site.example/', 'editor', 'abcd efgh ijkl', f), calls };
  }

  it('sends Basic auth built from the application password with spaces removed', async () => {
    const { adapter, calls } = wp((c) => (c.url.includes('users/me') ? { json: { name: 'Ed', capabilities: { publish_posts: true, upload_files: true, edit_posts: true } } } : { json: { name: 'Site' } }));
    const s = await adapter.testConnection();
    expect(s.state).toBe('connected');
    expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from('editor:abcdefghijkl').toString('base64')}`);
    expect(calls[0].url).toBe('https://site.example/wp-json/wp/v2/users/me?context=edit');
  });

  it('reports auth failures, missing capabilities and outages distinctly', async () => {
    expect((await wp(() => ({ status: 401, json: { code: 'incorrect_password' } })).adapter.testConnection()).state).toBe('auth_failed');
    expect((await wp(() => ({ json: { name: 'Sub', capabilities: { read: true } } })).adapter.testConnection()).state).toBe('auth_failed');
    expect((await wp(() => ({ status: 503 })).adapter.testConnection()).state).toBe('unavailable');
  });

  it('creates a published post with the category, tags, featured image and a recognisable marker, and confirms it from the response', async () => {
    const { adapter, calls } = wp((c) => {
      if (c.url.includes('/categories')) return { json: [{ id: 12, name: 'Business' }] };
      if (c.url.includes('/tags?search=')) return { json: [] };
      if (c.url.endsWith('/tags') && c.method === 'POST') return { status: 201, json: { id: 77 } };
      if (c.url.endsWith('/posts') && c.method === 'POST') return { status: 201, json: { id: 901, status: 'publish', link: 'https://site.example/business/x/' } };
      return { status: 200, json: {} };
    });
    const r = await adapter.createPost({ articleId: 'abc', title: 'T', slug: 'x', contentHtml: '<p>hi</p>', excerpt: 'e', categoryNames: ['Business'], tags: ['retail'], featuredMediaId: '55', authorWpId: 12, status: 'publish', seo: { title: 'S', description: 'D', focusKeyword: 'k' } });
    expect(r).toMatchObject({ cmsPostId: '901', url: 'https://site.example/business/x/', status: 'publish' });
    const create = calls.find((c) => c.url.endsWith('/posts') && c.method === 'POST')!;
    expect(create.body).toMatchObject({ status: 'publish', categories: [12], tags: [77], featured_media: 55, slug: 'x', author: 12 });
    expect((create.body as { content: string }).content).toContain('<!-- inveck-blog:abc -->');
  });

  it('refuses to guess a category and treats an unpublished response as unverified', async () => {
    const noCat = wp((c) => (c.url.includes('/categories') ? { json: [] } : { json: [] }));
    await expect(noCat.adapter.createPost({ articleId: 'a', title: 't', slug: 's', contentHtml: '', excerpt: '', categoryNames: ['Nope'], tags: [], status: 'publish' })).rejects.toMatchObject({ code: 'category_missing' });
    const draft = wp((c) => (c.url.includes('/categories') ? { json: [{ id: 1, name: 'Business' }] } : { status: 201, json: { id: 5, status: 'draft', link: '' } }));
    await expect(draft.adapter.createPost({ articleId: 'a', title: 't', slug: 's', contentHtml: '', excerpt: '', categoryNames: ['Business'], tags: [], status: 'publish' })).rejects.toMatchObject({ code: 'unverified' });
  });

  it('does not fail a publication when the Rank Math route is missing, and says so', async () => {
    const { adapter } = wp((c) => {
      if (c.url.includes('/categories')) return { json: [{ id: 1, name: 'Business' }] };
      if (c.url.includes('rankmath')) return { status: 404, json: {} };
      return { status: 201, json: { id: 5, status: 'publish', link: 'https://site.example/x/' } };
    });
    const r = await adapter.createPost({ articleId: 'a', title: 't', slug: 's', contentHtml: '', excerpt: '', categoryNames: ['Business'], tags: [], status: 'publish', seo: { title: 'S' } });
    expect(r.notes.rankMathMeta).toMatch(/not applied/);
  });

  it('finds a post it created earlier by slug and marker, and ignores someone else\'s post with the same slug', async () => {
    const { adapter } = wp(() => ({ json: [{ id: 3, slug: 's', status: 'publish', link: 'https://site.example/other/', content: { raw: '<p>other</p>' } }, { id: 4, slug: 's', status: 'publish', link: 'https://site.example/mine/', content: { raw: '<p>x</p>\n<!-- inveck-blog:abc -->' } }] }));
    expect(await adapter.findExisting('abc', 's')).toMatchObject({ cmsPostId: '4' });
    expect(await adapter.findExisting('zzz', 's')).toBeNull();
  });

  it('uploads media, then sets alt text and title', async () => {
    const { adapter, calls } = wp((c) => (c.url.endsWith('/media') ? { status: 201, json: { id: 55, source_url: 'https://site.example/i.webp' } } : { json: {} }));
    const m = await adapter.uploadMedia({ bytes: Buffer.from('img'), filename: 'x.webp', mimeType: 'image/webp', altText: 'alt', title: 'T' });
    expect(m.mediaId).toBe('55');
    expect(calls[0].headers['content-disposition']).toContain('x.webp');
    expect(calls[1].body).toMatchObject({ alt_text: 'alt', title: 'T' });
  });
});

describe('no authors configured', () => {
  it('ships with none (no real person is credited by default); a post then goes out without an author box', () => {
    expect(DEFAULT_AUTHORS).toEqual([]);
  });
});
