import type { Product } from '@/lib/db/schema';
import { saveIcpAction, saveSearchAction, startProspectingAction, toggleIcpAction } from '@/app/configuration-actions';
import { listIcps } from '@/lib/config';
import { BUILT_IN_SEARCH_PROMPT, plannerPreview } from '@/lib/config-search';
import { getDb } from '@/lib/db';

const AREA = 'field font-[inherit] leading-snug';

/** ICPs & Search: the product's search settings and shared prompt, a preview of what a run would ask, and its ICPs. */
export async function IcpsTab({ product }: { product: Product }) {
  const db = await getDb();
  const icps = await listIcps(db, product.id);
  const preview = await plannerPreview(db, product.id);
  return (
    <div className="space-y-6">
      <section className="card p-5">
        <h2 className="text-sm font-semibold">Search for {product.name}</h2>
        <form action={saveSearchAction} className="mt-3 space-y-3">
          <input type="hidden" name="productId" value={product.id} />
          <div>
            <label htmlFor="sm" className="label">How runs find prospects</label>
            <select id="sm" name="searchMode" defaultValue={product.searchMode} className="field w-auto">
              <option value="people_first">People first (LinkedIn job titles from the ICP, as Inveck runs today)</option>
              <option value="ai_planner">AI planner (the prompt below, then DeepSeek plans the searches and Serper runs them)</option>
            </select>
          </div>
          <div>
            <label htmlFor="pdesc" className="label">Product description for the AI (blank: the one in Settings)</label>
            <textarea id="pdesc" name="description" defaultValue={product.description} rows={3} className={AREA} />
          </div>
          <div>
            <label htmlFor="pprompt" className="label">Shared search-planning prompt (blank: the built-in one)</label>
            <textarea id="pprompt" name="searchPrompt" defaultValue={product.searchPrompt} rows={8} placeholder="Blank uses the built-in prompt shown below. Use {{PRODUCT_DESCRIPTION}} where the description should go." className={AREA} />
            <details className="mt-1 text-xs text-muted">
              <summary className="cursor-pointer">Built-in shared prompt</summary>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-3">{BUILT_IN_SEARCH_PROMPT}</pre>
            </details>
          </div>
          <div className="flex gap-2">
            <button className="btn-primary">Save search settings</button>
            <button name="reset" value="1" className="btn-secondary" title="Use the built-in shared prompt again">Reset prompt to built-in</button>
          </div>
        </form>
        <p className="mt-2 text-xs text-muted">Each ICP&apos;s own search instructions (below) are added to this prompt while the ICP is active. The built-in Manufacturing and 3PL &amp; Logistics instructions are kept on those two Inveck ICPs.</p>
      </section>

      {preview && (
        <section className="card p-5">
          <h2 className="text-sm font-semibold">Preview: what a run would ask</h2>
          <p className="mb-3 text-xs text-muted">
            Mode: {preview.mode === 'ai_planner' ? 'AI planner' : 'People first (this prompt is not used by this product\'s runs; switch the mode above to use it)'} · active ICPs: {preview.icps.map((i) => i.segment).join(', ') || 'none'} · configuration version {preview.version}. CA firms come from the Google Sheet and are never searched.
          </p>
          <details open>
            <summary className="cursor-pointer text-sm font-medium">Planner prompt (sent to DeepSeek)</summary>
            <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-3 text-xs">{preview.systemPrompt.replaceAll('{{PRODUCT_DESCRIPTION}}', preview.productDescription)}</pre>
          </details>
          <details className="mt-2">
            <summary className="cursor-pointer text-sm font-medium">What it is asked about (ICPs and current clients)</summary>
            <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-3 text-xs">{preview.inputs}</pre>
          </details>
          <p className="mt-2 text-xs text-muted">The planner returns search queries; each is then sent to Serper (Google), and the companies in the results are picked and added as leads.</p>
          <form action={startProspectingAction} className="mt-3">
            <input type="hidden" name="productId" value={product.id} />
            <button className="btn-secondary">Start a prospecting run for {product.name}</button>
          </form>
        </section>
      )}

      <section className="card p-5">
        <h2 className="text-sm font-semibold">ICPs</h2>
        <p className="mb-3 text-xs text-muted">Add or edit ICPs for {product.name}. An ICP is available in Allocation, Templates and Follow-up rules as soon as it exists. A lead&apos;s segment is its ICP&apos;s name.</p>
        <ul className="divide-y divide-line">
          {icps.map((i) => (
            <li key={i.id} className="py-3">
              <details>
                <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm font-medium">
                  {i.segment}
                  <span className={`rounded-full px-2 py-0.5 text-xs ${i.active ? 'bg-good-soft text-good-ink' : 'bg-neutral-soft text-ink-2'}`}>{i.active ? 'Active' : 'Inactive'}</span>
                </summary>
                <IcpForm productId={product.id} icp={i} />
                <form action={toggleIcpAction} className="mt-2">
                  <input type="hidden" name="productId" value={product.id} />
                  <input type="hidden" name="id" value={i.id} />
                  <input type="hidden" name="active" value={i.active ? '0' : '1'} />
                  <button className="btn-secondary px-3 py-1 text-sm">{i.active ? 'Deactivate this ICP' : 'Activate this ICP'}</button>
                </form>
              </details>
            </li>
          ))}
          {icps.length === 0 && <li className="py-3 text-sm text-muted">No ICPs yet for this product. Add the first one below.</li>}
        </ul>
      </section>

      <section className="card p-5">
        <h2 className="text-sm font-semibold">Add an ICP to {product.name}</h2>
        <IcpForm productId={product.id} />
      </section>
    </div>
  );
}

type IcpFormValue = { id: number; segment: string; description: string; industries: string; geography: string; companySize: string; mustHaves: string; dealBreakers: string; searchInstructions: string; targetTitles: string; p2Titles: string; p3Titles: string; avoidTitles: string; pitchAngle: string };

function IcpForm({ productId, icp }: { productId: number; icp?: IcpFormValue }) {
  const k = icp?.id ?? 'new';
  const t = (name: keyof IcpFormValue, label: string, rows = 2) => (
    <div>
      <label htmlFor={`${name}-${k}`} className="label">{label}</label>
      <textarea id={`${name}-${k}`} name={name} defaultValue={icp ? String(icp[name]) : ''} rows={rows} className={AREA} />
    </div>
  );
  return (
    <form action={saveIcpAction} className="mt-3 space-y-3">
      <input type="hidden" name="productId" value={productId} />
      {icp && <input type="hidden" name="id" value={icp.id} />}
      <div className="max-w-sm">
        <label htmlFor={`segment-${k}`} className="label">ICP name</label>
        <input id={`segment-${k}`} name="segment" defaultValue={icp?.segment ?? ''} required className="field" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {t('industries', 'Industries')}
        {t('geography', 'Locations')}
        {t('companySize', 'Company size', 1)}
        {t('dealBreakers', 'Exclusions (what rules a company out)')}
      </div>
      {t('description', 'Description')}
      {t('mustHaves', 'Must-haves')}
      <div className="grid gap-3 sm:grid-cols-2">
        {t('targetTitles', 'P1 titles (approached first)')}
        {t('p2Titles', 'P2 titles')}
        {t('p3Titles', 'P3 titles')}
        {t('avoidTitles', 'Titles to avoid')}
      </div>
      {t('pitchAngle', 'Pitch angle', 2)}
      {t('searchInstructions', 'Search instructions for query generation (added to the shared prompt while this ICP is active)', 8)}
      <button className="btn-primary">{icp ? 'Save ICP' : 'Add ICP'}</button>
    </form>
  );
}
