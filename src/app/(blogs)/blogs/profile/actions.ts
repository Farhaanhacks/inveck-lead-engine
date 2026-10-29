'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { audit } from '@/lib/blogs/audit';
import { blogActor } from '@/lib/blogs/auth';
import { getDb } from '@/lib/blogs/db/client';
import { domainProfiles } from '@/lib/blogs/db/schema';
import { z } from 'zod';
import { domainConfigSchema, splitLines } from '@/lib/blogs/domains/config';
import { INVECK_SLUG } from '@/lib/blogs/seed';

/** The audience and tone may be saved empty (generation just stays off until they are filled in). */
const profileFormSchema = z.object({
  audience: z.string().trim().max(300),
  geography: z.string().trim().min(2).max(120),
  locale: z.string().trim().min(2).max(10),
  tone: z.string().trim().max(300),
  defaultArticleLength: z.coerce.number().int().min(300).max(5000),
});

const back = (kind: 'saved' | 'error', message: string): never => redirect(`/blogs/profile?${kind}=${encodeURIComponent(message)}`);

/** Saves the Inveck blog profile: who the articles are for, the rules the checks use, and Inveck's own prompt additions per stage. */
export async function saveProfile(formData: FormData) {
  const user = await blogActor();
  const form = profileFormSchema.safeParse({
    audience: formData.get('audience'),
    geography: formData.get('geography'),
    locale: formData.get('locale'),
    tone: formData.get('tone'),
    defaultArticleLength: formData.get('defaultArticleLength'),
  });
  const lines = (k: string) => splitLines(formData.get(k));
  const text = (k: string) => String(formData.get(k) ?? '').trim().slice(0, 8000);
  const config = domainConfigSchema.safeParse({
    researchSources: { preferred: lines('preferredSources'), avoid: lines('avoidSources'), notes: String(formData.get('sourceNotes') ?? '') },
    articleFormats: lines('articleFormats'),
    seoRules: lines('seoRules'),
    restrictedClaims: lines('restrictedClaims'),
    restrictedTopics: lines('restrictedTopics'),
    evidenceStandards: lines('evidenceStandards'),
    internalLinking: { minLinks: Number(formData.get('minLinks')), maxLinks: Number(formData.get('maxLinks')), rules: lines('linkRules') },
    publishing: { categories: lines('categories'), defaultTags: lines('defaultTags') },
    validation: { requireHumanReview: formData.get('requireHumanReview') === 'on', blockPatterns: lines('blockPatterns'), notes: lines('validationNotes') },
    prompts: { discovery: text('prompt_discovery'), planning: text('prompt_planning'), writing: text('prompt_writing'), seo: text('prompt_seo'), image: text('prompt_image') },
  });
  if (!form.success || !config.success) return back('error', 'Some values are invalid. Check the fields and try again.');
  for (const p of config.data.validation.blockPatterns) {
    try {
      new RegExp(p, 'i');
    } catch {
      return back('error', `"${p}" is not a valid pattern.`);
    }
  }
  if (config.data.internalLinking.minLinks > config.data.internalLinking.maxLinks) return back('error', 'Minimum links cannot exceed maximum links.');
  const updated = await (await getDb())
    .update(domainProfiles)
    .set({ audience: form.data.audience, geography: form.data.geography, locale: form.data.locale, tone: form.data.tone, defaultArticleLength: form.data.defaultArticleLength, config: config.data, updatedAt: new Date() })
    .where(eq(domainProfiles.slug, INVECK_SLUG))
    .returning({ id: domainProfiles.id });
  if (!updated.length) return back('error', 'The Inveck profile is missing. Reload the page.');
  await audit(user.email, 'profile.updated', 'blog_profile', updated[0].id, { prompts: Object.fromEntries(Object.entries(config.data.prompts).map(([k, v]) => [k, v.length])) });
  revalidatePath('/blogs', 'layout');
  return back('saved', 'Inveck profile saved.');
}
