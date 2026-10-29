import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { appSettings } from './db/schema';
import type { AnyDb } from './db/types';

export const authorSchema = z.object({
  id: z.string().trim().min(1).max(60),
  name: z.string().trim().min(2).max(80),
  designation: z.string().trim().min(2).max(80),
  linkedin: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#]+\/?$/i.test(u), 'Use a LinkedIn profile address like https://www.linkedin.com/in/your-name/'),
  /** Optional: the matching WordPress user, so the post's own byline shows this person too. */
  wpUserId: z.coerce.number().int().positive().nullable().optional(),
});
export type Author = z.infer<typeof authorSchema>;

/** No authors are assumed: add the people (and their LinkedIn profiles) under Blogs → Settings. With none, posts go out without an author box. */
export const DEFAULT_AUTHORS: Author[] = [];

export const AUTHORS_KEY = 'authors';

/** The configured authors (none until they are added). Invalid saved entries are skipped rather than breaking publishing. */
export async function loadAuthors(db: AnyDb): Promise<Author[]> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, AUTHORS_KEY)).limit(1);
  const list = Array.isArray(row?.value) ? (row!.value as unknown[]).flatMap((v) => { const p = authorSchema.safeParse(v); return p.success ? [p.data] : []; }) : [];
  return list.length ? list : DEFAULT_AUTHORS;
}

export async function saveAuthors(db: AnyDb, authors: Author[]) {
  await db.insert(appSettings).values({ key: AUTHORS_KEY, value: authors }).onConflictDoUpdate({ target: appSettings.key, set: { value: authors, updatedAt: new Date() } });
}

export function pickAuthor(authors: Author[], random: () => number = Math.random): Author | null {
  if (!authors.length) return null;
  return authors[Math.min(authors.length - 1, Math.floor(random() * authors.length))];
}

/** The author saved on an article, refreshed from the current list (so a corrected LinkedIn link applies everywhere). */
export function resolveAuthor(saved: unknown, authors: Author[]): Author | null {
  const s = authorSchema.safeParse(saved);
  if (!s.success) return null;
  return authors.find((a) => a.id === s.data.id) ?? s.data;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The author box appended to a published post. Inline styles so it looks right on any WordPress theme; if the site strips styles,
 * it degrades to a plain name, title and link. Every value is escaped and the link must be a LinkedIn profile.
 */
export function authorBoxHtml(a: Author): string {
  const linkedin = authorSchema.shape.linkedin.safeParse(a.linkedin).success ? a.linkedin : null;
  return `
<div class="blog-author-box" style="margin-top:2.5em;padding:1.25em 1.5em;border:1px solid #e4e4e8;border-radius:10px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:1em;">
<div><p style="margin:0;font-size:0.8em;letter-spacing:0.06em;text-transform:uppercase;color:#5b5e66;">Written by</p><p style="margin:0.15em 0 0;font-weight:600;font-size:1.1em;">${esc(a.name)}</p><p style="margin:0;color:#5b5e66;">${esc(a.designation)}</p></div>
${linkedin ? `<a href="${esc(linkedin)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:0.55em 1.1em;border-radius:6px;background:#0a66c2;color:#ffffff;font-weight:600;text-decoration:none;">Connect on LinkedIn</a>` : ''}
</div>`;
}
