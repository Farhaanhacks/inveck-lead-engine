import { eq } from 'drizzle-orm';
import type { Db } from '../db';
import { domainProfiles } from './db/schema';
import type { AnyDb } from './db/types';
import { domainConfigSchema } from './domains/config';

export const INVECK_SLUG = 'inveck';

/**
 * The one blog profile (Inveck) the Blogs area writes for. Made once, empty on purpose: the audience, tone, rules and prompts are
 * filled in under Blogs → Settings, and article generation stays off until then. An existing profile is never touched.
 */
export async function ensureBlogProfile(crmDb: Db): Promise<void> {
  const db = crmDb as unknown as AnyDb;
  const [found] = await db.select({ id: domainProfiles.id }).from(domainProfiles).where(eq(domainProfiles.slug, INVECK_SLUG));
  if (found) return;
  await db
    .insert(domainProfiles)
    .values({ slug: INVECK_SLUG, name: 'Inveck', audience: '', geography: 'Global', locale: 'en', tone: '', defaultArticleLength: 1200, config: domainConfigSchema.parse({}) })
    .onConflictDoNothing();
}

/** Generation needs the profile to say who the articles are for and in what voice; until it does, nothing is written. */
export const profileIsReady = (p: { audience: string; tone: string }) => p.audience.trim().length >= 2 && p.tone.trim().length >= 2;
