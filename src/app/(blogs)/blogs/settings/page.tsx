import { Badge, Notice, PageHeader } from '@/components/blogs/ui';
import { env, integrationPresence } from '@/lib/blogs/env';
import { getSetting, SETTING_DEFAULTS } from '@/lib/blogs/settings';
import { saveAuthorsAction, saveScoringWeights } from './actions';
import { loadAuthors } from '@/lib/blogs/authors';
import { getDb } from '@/lib/blogs/db/client';
import { SubmitButton } from '@/components/blogs/submit-button';
import { getCmsAdapter } from '@/lib/blogs/cms';
import { formatInZone } from '@/lib/blogs/time';
import { chooseImageService } from '@/lib/blogs/providers/image-choice';
import { testCmsConnection } from '../publishing/actions';

export const dynamic = 'force-dynamic';

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

export default async function SettingsPage({ searchParams }: PageProps<'/blogs/settings'>) {
  const { saved, error } = await searchParams;
  const present = integrationPresence();
  const [weights, models, cmsStatus, queue] = await Promise.all([getSetting('scoringWeights'), getSetting('models'), getSetting('cmsStatus'), getSetting('queue')]);
  const adapter = getCmsAdapter();
  const authors = await loadAuthors((await getDb()));
  const images = chooseImageService(env());

  // "Key present" is all this page can honestly claim; live connection tests arrive with each provider.
  const rows: { name: string; purpose: string; status: string; tone: Tone }[] = [
    { name: 'Gemini', purpose: images ? 'Writing and fact-checking' : 'Writing, fact-checking and featured images', status: present.gemini ? 'Key set' : 'Not configured', tone: present.gemini ? 'ok' : 'warn' },
    { name: 'WaveSpeed', purpose: 'Featured images', status: present.wavespeed ? 'Key set (in use)' : 'Not configured', tone: present.wavespeed ? 'ok' : 'neutral' },
    { name: 'Pollinations', purpose: 'Featured images (backup)', status: present.pollinations ? (images?.name === 'pollinations' ? 'Key set (in use)' : 'Key set (not used while WaveSpeed is set)') : 'Not configured', tone: present.pollinations ? 'ok' : 'neutral' },
    { name: 'Exa', purpose: 'Research and news search', status: present.exa ? 'Key set' : 'Not configured', tone: present.exa ? 'ok' : 'warn' },
    { name: 'Google Search Console', purpose: 'Impressions, clicks, queries (synced daily)', status: present.searchConsole ? 'Credentials set' : 'Not configured', tone: present.searchConsole ? 'ok' : 'warn' },
  ];
  const fields = [
    ['trendMomentum', 'Trend momentum'],
    ['searchDemand', 'Search demand'],
    ['competitionGap', 'Competition & content gap'],
    ['relevance', 'Relevance to Inveck'],
    ['engagementPotential', 'Clicks & engagement potential'],
  ] as const;

  return (
    <>
      <PageHeader title="Settings & Integrations" description="Secrets stay in server environment variables." />
      <div className="space-y-8">
        {saved ? <Notice tone="ok" title={String(saved)} /> : null}
        {error ? <Notice tone="danger" title={String(error)} /> : null}

        <section aria-labelledby="integrations">
          <h2 id="integrations" className="section-title">Integrations</h2>
          <ul className="card divide-y divide-border">
            {rows.map((r) => (
              <li key={r.name} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <div><p className="font-medium">{r.name}</p><p className="text-xs text-muted">{r.purpose}</p></div>
                <Badge tone={r.tone}>{r.status}</Badge>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="cms">
          <h2 id="cms" className="section-title">Blog CMS (WordPress)</h2>
          <div className="card flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
            <div>
              <p className="flex items-center gap-2 font-medium">Adapter: {adapter.name}
                <Badge tone={cmsStatus?.state === 'connected' ? 'ok' : cmsStatus?.state === 'mock' ? 'warn' : cmsStatus ? 'danger' : 'neutral'}>{cmsStatus ? cmsStatus.state.replace('_', ' ') : 'not tested'}</Badge></p>
              <p className="mt-1 text-xs text-muted">{cmsStatus ? `${cmsStatus.detail} Checked ${formatInZone(cmsStatus.checkedAt, queue.timezone)}.` : 'Run a test to confirm the credentials can publish posts and upload media.'}</p>
            </div>
            <form action={testCmsConnection}><SubmitButton pendingLabel="Testing…">Test connection</SubmitButton></form>
          </div>
        </section>

        <section aria-labelledby="authors">
          <h2 id="authors" className="section-title !mb-1">Authors</h2>
          <p className="mb-2 text-xs text-muted">Each new article gets one at random; change it on the article page. The WordPress user ID is optional: with it, the post byline shows this person too.</p>
          <form action={saveAuthorsAction} className="card space-y-3 p-4">
            {[...authors, { id: '', name: '', designation: '', linkedin: '', wpUserId: null }].map((a, i) => (
              <fieldset key={`${a.id}-${i}`} className="grid gap-2 border-b border-border pb-3 last:border-0 last:pb-0 md:grid-cols-[1fr_1fr_1.6fr_7rem_auto]">
                <legend className="sr-only">{a.name || 'New author'}</legend>
                <input type="hidden" name="id" value={a.id} />
                <label className="flex flex-col gap-1 text-xs">Name<input name="name" className="field" defaultValue={a.name} placeholder={a.id ? '' : 'Add an author'} /></label>
                <label className="flex flex-col gap-1 text-xs">Designation<input name="designation" className="field" defaultValue={a.designation} /></label>
                <label className="flex flex-col gap-1 text-xs">LinkedIn profile<input name="linkedin" type="url" className="field" defaultValue={a.linkedin} placeholder="https://www.linkedin.com/in/…" /></label>
                <label className="flex flex-col gap-1 text-xs">WP user ID<input name="wpUserId" inputMode="numeric" className="field" defaultValue={a.wpUserId ?? ''} /></label>
                {a.id ? <label className="flex items-center gap-1.5 self-end pb-2 text-xs"><input type="checkbox" name="remove" value={i} /> Remove</label> : <span />}
              </fieldset>
            ))}
            <SubmitButton primary pendingLabel="Saving…">Save authors</SubmitButton>
          </form>
        </section>

        <section aria-labelledby="models">
          <h2 id="models" className="section-title">Models</h2>
          <dl className="card grid gap-3 p-4 text-sm md:grid-cols-3">
            <div><dt className="text-xs text-muted">Writing</dt><dd className="font-mono">{models.writing}</dd></div>
            <div><dt className="text-xs text-muted">Fast tasks</dt><dd className="font-mono">{models.fast}</dd></div>
            <div><dt className="text-xs text-muted">Image</dt><dd className="font-mono">{images ? `${images.name}: ${images.model}` : models.image}</dd></div>
          </dl>
          <p className="mt-1 text-xs text-muted">Defaults. Not yet editable here.</p>
        </section>

        <section aria-labelledby="weights">
          <h2 id="weights" className="section-title">Topic scoring weights</h2>
          <p className="mb-2 text-xs text-muted">A prioritisation heuristic, not a forecast. Must add up to 100 (default {Object.values(SETTING_DEFAULTS.scoringWeights).join(' / ')}).</p>
          <form action={saveScoringWeights} className="card grid gap-4 p-5 md:grid-cols-3">
            {fields.map(([key, label]) => (
              <label key={key} className="flex flex-col gap-1 text-sm">{label}
                <input name={key} type="number" min={0} max={100} step="any" className="field" defaultValue={weights[key]} required />
              </label>
            ))}
            <div className="md:col-span-3"><SubmitButton primary pendingLabel="Saving…">Save weights</SubmitButton></div>
          </form>
        </section>
      </div>
    </>
  );
}
