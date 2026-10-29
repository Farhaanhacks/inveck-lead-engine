import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { BLOGS_USERNAME, ensureBlogsUser, hashPassword } from '@/lib/passwords';
import { verifyLogin } from '@/lib/users';
import { createSession, SESSION_COOKIE } from '@/lib/auth';
import { BLOG_SCHEMA_STATEMENTS } from '@/lib/blogs/db/ddl';
import { domainProfiles, imageStore } from '@/lib/blogs/db/schema';
import type { AnyDb } from '@/lib/blogs/db/types';
import { DbImageStorage } from '@/lib/blogs/pipeline/live';
import { domainConfigSchema } from '@/lib/blogs/domains/config';
import { systemPrompt } from '@/lib/blogs/discovery/engine';
import { writerSystem, type DomainInput } from '@/lib/blogs/pipeline/stages';
import { ensureBlogProfile, INVECK_SLUG, profileIsReady } from '@/lib/blogs/seed';
import { proxy } from '@/proxy';

vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(f: T) => f }));

const STARTING = 'a-test-only-starting-password';

let db: Db;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  process.env.APP_PASSWORD = 'test-admin-password-for-sessions';
  delete process.env.BLOGS_INITIAL_PASSWORD;
  resetDbForTests();
  db = await getDb();
});

describe('the Blogs login', () => {
  it('is not created until BLOGS_INITIAL_PASSWORD is set; then it is created once, hashed, and asks for a new password', async () => {
    // Without the variable there is no Blogs user (and no password anywhere in the code).
    expect((await db.select().from(users).where(eq(users.username, BLOGS_USERNAME))).length).toBe(0);
    expect(await ensureBlogsUser(db, '')).toBe('no-password');
    expect(await ensureBlogsUser(db, 'short')).toBe('no-password');
    expect(await ensureBlogsUser(db, STARTING)).toBe('created');
    const [row] = await db.select().from(users).where(eq(users.username, BLOGS_USERNAME));
    expect(row).toMatchObject({ name: 'Blogs', role: 'blogs', active: true, mustChangePassword: true });
    expect(row.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(JSON.stringify(row)).not.toContain(STARTING);
    // It signs in with that password, and not with another.
    expect((await verifyLogin(db, 'blogs@inveck', STARTING))?.role).toBe('blogs');
    expect(await verifyLogin(db, 'Blogs@Inveck', STARTING)).not.toBeNull();
    expect(await verifyLogin(db, 'blogs@inveck', 'wrong-password')).toBeNull();
    // Never touched again: a changed password stays changed, whatever the variable says.
    await db.update(users).set({ passwordHash: await hashPassword('changed-later-123'), mustChangePassword: false }).where(eq(users.id, row.id));
    expect(await ensureBlogsUser(db, 'another-starting-password')).toBe('exists');
    expect(await verifyLogin(db, 'blogs@inveck', 'changed-later-123')).not.toBeNull();
    expect(await verifyLogin(db, 'blogs@inveck', 'another-starting-password')).toBeNull();
  });

  it('is created at start-up from the environment variable, and not otherwise', async () => {
    process.env.BLOGS_INITIAL_PASSWORD = STARTING;
    resetDbForTests();
    const fresh = await getDb();
    expect((await verifyLogin(fresh, 'blogs@inveck', STARTING))?.role).toBe('blogs');
    delete process.env.BLOGS_INITIAL_PASSWORD;
  });
});

describe('Blogs access is separate from the CRM', () => {
  const req = (path: string, who: string) => new NextRequest(`http://localhost${path}`, { headers: { cookie: `${SESSION_COOKIE}=${who}` } });
  const as = async (path: string, subject: string) => proxy(req(path, await createSession(subject)));
  const where = (r: Response) => r.headers.get('location')?.replace('http://localhost', '') ?? null;

  it('the Blogs profile (b<id>) reaches /blogs and the blog image route only', async () => {
    expect(where(await as('/blogs/studio', 'b9'))).toBeNull();
    expect((await as('/api/blogs/image?key=x', 'b9')).status).toBe(200);
    for (const path of ['/today', '/leads', '/tracker', '/configuration', '/marketing/calendar', '/account']) expect(where(await as(path, 'b9'))).toBe('/blogs');
    expect((await as('/api/tracker/csv', 'b9')).status).toBe(403);
    expect((await as('/api/mail/anything', 'b9')).status).toBe(403);
  });

  it('a BDA (u<id>) and the Marketing profile (m<id>) never reach /blogs', async () => {
    expect(where(await as('/blogs', 'u3'))).toBe('/today');
    expect(where(await as('/blogs/profile', 'u3'))).toBe('/today');
    expect((await as('/api/blogs/image?key=x', 'u3')).status).toBe(403);
    expect(where(await as('/blogs', 'm4'))).toBe('/marketing/calendar');
    // Their own areas are unchanged.
    expect(where(await as('/today', 'u3'))).toBeNull();
    expect(where(await as('/marketing/calendar', 'm4'))).toBeNull();
  });

  it('the administrator reaches everything; the worker endpoints check their own secret; logged-out visitors go to the login page', async () => {
    expect(where(await as('/blogs/settings', 'admin'))).toBeNull();
    expect(where(await as('/today', 'admin'))).toBeNull();
    expect((await proxy(new NextRequest('http://localhost/api/cron/blogs'))).status).toBe(200);
    expect((await proxy(new NextRequest('http://localhost/api/cron/blogs/analytics'))).status).toBe(200);
    expect(where(await proxy(new NextRequest('http://localhost/blogs')))).toMatch(/^\/login\?next=%2Fblogs/);
    expect((await proxy(new NextRequest('http://localhost/api/blogs/image?key=x'))).status).toBe(401);
  });

  it('the roles list and the CRM user type leave Blogs out', async () => {
    const { getCurrentUser } = await import('@/lib/users');
    expect(typeof getCurrentUser).toBe('function');
    const src = (await import('node:fs')).readFileSync('src/lib/users.ts', 'utf8');
    expect(src).toContain("user.role === 'admin' || user.role === 'bda'");
  });
});

describe('the Blogs tables', () => {
  it('are all blog_*, idempotent to create, and none references the CRM tables', async () => {
    for (const statement of BLOG_SCHEMA_STATEMENTS) await db.execute(sql.raw(statement));
    const tables = (await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' and table_name like 'blog\\_%'`)) as unknown as { rows: { table_name: string }[] };
    const names = tables.rows.map((r) => r.table_name).sort();
    expect(names).toEqual(['blog_analytics_snapshots', 'blog_app_settings', 'blog_article_assets', 'blog_article_revisions', 'blog_article_sources', 'blog_articles', 'blog_audit_logs', 'blog_content_jobs', 'blog_image_store', 'blog_profile', 'blog_published_posts', 'blog_topic_approvals', 'blog_topic_candidates', 'blog_topic_runs', 'blog_usage_events']);
    const fks = (await db.execute(sql`
      select tc.table_name as from_table, ccu.table_name as to_table
      from information_schema.table_constraints tc
      join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.constraint_schema
      where tc.constraint_type = 'FOREIGN KEY' and tc.table_name like 'blog\\_%'`)) as unknown as { rows: { from_table: string; to_table: string }[] };
    expect(fks.rows.length).toBeGreaterThan(5);
    for (const r of fks.rows) expect(r.to_table.startsWith('blog_')).toBe(true);
  });

  it('start with one empty Inveck profile that keeps generation off until the audience and tone are set', async () => {
    const blog = db as unknown as AnyDb;
    const rows = await blog.select().from(domainProfiles);
    expect(rows.map((r) => r.slug)).toEqual([INVECK_SLUG]);
    expect(rows[0]).toMatchObject({ name: 'Inveck', audience: '', tone: '' });
    expect(profileIsReady(rows[0])).toBe(false);
    expect(profileIsReady({ audience: 'Finance and operations leaders', tone: 'Plain and practical' })).toBe(true);
    // Made once, never overwritten.
    await blog.update(domainProfiles).set({ audience: 'Edited by a person' }).where(eq(domainProfiles.slug, INVECK_SLUG));
    await ensureBlogProfile(db);
    expect((await blog.select().from(domainProfiles))[0].audience).toBe('Edited by a person');
  });

  it('keep featured images as bytes in their own table (no outside storage)', async () => {
    const blog = db as unknown as AnyDb;
    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 255, 128, 7]);
    const { url } = await new DbImageStorage(blog).put('articles/11111111-1111-4111-8111-111111111111/featured.webp', bytes, 'image/webp');
    expect(url).toBe('/api/blogs/image?key=articles%2F11111111-1111-4111-8111-111111111111%2Ffeatured.webp');
    const [row] = await blog.select().from(imageStore);
    expect(Buffer.from(row.bytes).equals(bytes)).toBe(true);
    expect(row.mimeType).toBe('image/webp');
    // Replacing the image under the same key keeps one row.
    await new DbImageStorage(blog).put('articles/11111111-1111-4111-8111-111111111111/featured.webp', Buffer.from([1, 2, 3]), 'image/webp');
    const all = await blog.select().from(imageStore);
    expect(all).toHaveLength(1);
    expect(Buffer.from(all[0].bytes).equals(Buffer.from([1, 2, 3]))).toBe(true);
  });
});

describe("Inveck's own prompts have a place and no content", () => {
  const domain = (writing: string): DomainInput => ({ slug: 'inveck', name: 'Inveck', audience: 'a', tone: 't', geography: 'Global', defaultArticleLength: 1200, config: domainConfigSchema.parse({ prompts: { writing } }) });

  it('start empty, so the built-in instructions are all there is; text saved for a stage is added to the end of that stage only', () => {
    expect(domainConfigSchema.parse({}).prompts).toEqual({ discovery: '', planning: '', writing: '', seo: '', image: '' });
    const plain = writerSystem(domain(''));
    expect(plain).not.toContain('Additional instructions for Inveck');
    expect(plain).toContain('the Inveck blog');
    expect(plain).not.toMatch(/ArticleBasket|Article Basket/i);
    const withNote = writerSystem(domain('Always explain the stock-count workflow.'));
    expect(withNote.endsWith('Always explain the stock-count workflow.')).toBe(true);
    expect(withNote).toContain('Additional instructions for Inveck:');
    expect(systemPrompt('Inveck')).not.toContain('Additional instructions');
    expect(systemPrompt('Inveck', 'Prefer product-led topics.')).toContain('Additional instructions for Inveck:\nPrefer product-led topics.');
    expect(systemPrompt('Inveck')).not.toMatch(/ArticleBasket|general-interest/i);
  });
});
