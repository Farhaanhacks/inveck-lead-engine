import { eq } from 'drizzle-orm';
import { SubmitButton } from '@/components/blogs/submit-button';
import { Notice, PageHeader } from '@/components/blogs/ui';
import { blogsPage } from '@/lib/access';
import { getDb } from '@/lib/blogs/db/client';
import { domainProfiles } from '@/lib/blogs/db/schema';
import { domainConfigSchema, PROMPT_STAGE_LABEL, PROMPT_STAGES } from '@/lib/blogs/domains/config';
import { INVECK_SLUG, profileIsReady } from '@/lib/blogs/seed';
import { saveProfile } from './actions';

export const dynamic = 'force-dynamic';

const join = (a: string[]) => a.join('\n');

function Area({ name, label, value, hint, rows = 4 }: { name: string; label: string; value: string; hint?: string; rows?: number }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <textarea name={name} rows={rows} defaultValue={value} className="field font-mono text-xs" />
      <span className="text-xs text-muted">{hint ?? 'One per line.'}</span>
    </label>
  );
}

/** Inveck's blog profile and prompts: the one place the Inveck-specific blog settings live. Everything starts empty. */
export default async function ProfilePage({ searchParams }: PageProps<'/blogs/profile'>) {
  await blogsPage();
  const { saved, error } = await searchParams;
  const [d] = await (await getDb()).select().from(domainProfiles).where(eq(domainProfiles.slug, INVECK_SLUG));
  if (!d) return <Notice tone="danger" title="The Inveck profile is missing">Reload the page; it is created when the app starts.</Notice>;
  const c = domainConfigSchema.parse(d.config);
  return (
    <>
      <PageHeader title="Inveck profile & prompts" description="Who the Inveck blog is for, how it should sound, the rules its checks use, and Inveck's own prompts for each stage." />
      <div className="space-y-4">
        {saved ? <Notice tone="ok" title={String(saved)} /> : null}
        {error ? <Notice tone="danger" title={String(error)} /> : null}
        {!profileIsReady(d) ? <Notice tone="warn" title="Article generation is off until the audience and tone below are filled in">Topic discovery and article writing need to know who the articles are for and in what voice.</Notice> : null}
        <form action={saveProfile} className="card grid gap-5 p-5 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">Audience<input name="audience" className="field" defaultValue={d.audience} maxLength={300} /></label>
          <label className="flex flex-col gap-1 text-sm">Target geography<input name="geography" className="field" defaultValue={d.geography} required /></label>
          <label className="flex flex-col gap-1 text-sm">Locale<input name="locale" className="field" defaultValue={d.locale} required /></label>
          <label className="flex flex-col gap-1 text-sm">Default article length (words)<input name="defaultArticleLength" type="number" min={300} max={5000} className="field" defaultValue={d.defaultArticleLength} required /></label>
          <label className="flex flex-col gap-1 text-sm md:col-span-2">Writing tone<input name="tone" className="field" defaultValue={d.tone} maxLength={300} /></label>
          <label className="flex items-center gap-2 text-sm md:col-span-2"><input name="requireHumanReview" type="checkbox" defaultChecked={c.validation.requireHumanReview} /> Always require human review before publishing</label>

          <section className="md:col-span-2" aria-labelledby="prompts">
            <h2 id="prompts" className="section-title">Inveck prompts</h2>
            <p className="mb-3 text-xs text-muted">Each box is added to the end of that stage&apos;s built-in instructions (which already handle sourcing, honesty and the output format). Leave a box empty to use the built-in instructions alone.</p>
            <div className="grid gap-4">
              {PROMPT_STAGES.map((s) => (
                <Area key={s} name={`prompt_${s}`} label={PROMPT_STAGE_LABEL[s]} value={c.prompts[s]} rows={6} hint="Plain text." />
              ))}
            </div>
          </section>

          <Area name="preferredSources" label="Preferred research sources" value={join(c.researchSources.preferred)} />
          <Area name="avoidSources" label="Sources to avoid" value={join(c.researchSources.avoid)} />
          <label className="flex flex-col gap-1 text-sm md:col-span-2">Source notes<input name="sourceNotes" className="field" defaultValue={c.researchSources.notes} /></label>
          <Area name="articleFormats" label="Article formats" value={join(c.articleFormats)} />
          <Area name="seoRules" label="SEO rules" value={join(c.seoRules)} />
          <Area name="evidenceStandards" label="Required evidence standards" value={join(c.evidenceStandards)} />
          <Area name="restrictedClaims" label="Restricted claims" value={join(c.restrictedClaims)} />
          <Area name="restrictedTopics" label="Restricted topics" value={join(c.restrictedTopics)} />
          <Area name="blockPatterns" label="Block-for-review patterns" value={join(c.validation.blockPatterns)} hint="Regular expressions, one per line. A match stops publication and sends the article to a person." />
          <Area name="validationNotes" label="Special validation notes" value={join(c.validation.notes)} />
          <Area name="linkRules" label="Internal linking rules" value={join(c.internalLinking.rules)} />
          <label className="flex flex-col gap-1 text-sm">Minimum internal links<input name="minLinks" type="number" min={0} className="field" defaultValue={c.internalLinking.minLinks} /></label>
          <label className="flex flex-col gap-1 text-sm">Maximum internal links<input name="maxLinks" type="number" min={0} className="field" defaultValue={c.internalLinking.maxLinks} /></label>
          <Area name="categories" label="Publishing categories" value={join(c.publishing.categories)} />
          <Area name="defaultTags" label="Default tags" value={join(c.publishing.defaultTags)} />
          <div className="md:col-span-2"><SubmitButton primary pendingLabel="Saving…">Save profile</SubmitButton></div>
        </form>
      </div>
    </>
  );
}
