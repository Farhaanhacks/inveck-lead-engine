import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { adminPage } from '@/lib/access';
import { defaultProduct, listProducts } from '@/lib/config';
import { getDb } from '@/lib/db';
import { AllocationTab } from './allocation-tab';
import { FollowupsTab } from './followups-tab';
import { IcpsTab } from './icps-tab';
import { ProductsTab } from './products-tab';
import { TeamTab } from './team-tab';
import { TemplatesTab } from './templates-tab';
import { one, type ConfigParams } from './params';

export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'products', label: 'Products' },
  { key: 'icps', label: 'ICPs & Search' },
  { key: 'team', label: 'Team Members' },
  { key: 'allocation', label: 'Allocation' },
  { key: 'templates', label: 'Templates' },
  { key: 'followups', label: 'Follow-up Rules' },
] as const;

/** Configuration (administrators): products, their ICPs and search, the team, allocation, templates and follow-up rules. */
export default async function ConfigurationPage({ searchParams }: PageProps<'/configuration'>) {
  await adminPage();
  const sp = (await searchParams) as ConfigParams;
  const db = await getDb();
  const products = await listProducts(db);
  const tab = TABS.some((t) => t.key === one(sp.tab)) ? one(sp.tab) : 'products';
  const asked = Number(one(sp.product));
  const product = products.find((p) => p.id === asked) ?? (await defaultProduct(db)) ?? products[0];
  const notice = one(sp.notice);
  const error = one(sp.error);
  const scoped = tab !== 'products' && tab !== 'team';

  return (
    <>
      <PageHeader title="Configuration" description="Products, ICPs and search, the team, allocation, templates and follow-up rules. Changes apply from now on: nothing already done is rewritten." />
      <nav className="mb-4 flex flex-wrap gap-1.5" aria-label="Configuration sections">
        {TABS.map((t) => (
          <Link key={t.key} href={`/configuration?tab=${t.key}${product && t.key !== 'products' && t.key !== 'team' ? `&product=${product.id}` : ''}`} aria-current={tab === t.key ? 'page' : undefined} className={`rounded-full border px-3 py-1 text-sm ${tab === t.key ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line text-ink-2 hover:bg-surface-2'}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      {scoped && product && (
        <form className="mb-4 flex items-center gap-2 text-sm" method="get">
          <input type="hidden" name="tab" value={tab} />
          <label htmlFor="cfg-product" className="text-muted">Product</label>
          <select id="cfg-product" name="product" defaultValue={product.id} className="field w-auto py-1.5">
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.active ? '' : ' (inactive)'}</option>)}
          </select>
          <button className="btn-secondary px-3 py-1.5 text-sm">Show</button>
          <span className="text-xs text-muted">Configuration version {product.configVersion}</span>
        </form>
      )}
      {notice && <p role="status" className="mb-4 rounded-md border border-line bg-good-soft px-3 py-2 text-sm text-good-ink">{notice}</p>}
      {error && <p role="alert" className="mb-4 rounded-md border border-line bg-critical-soft px-3 py-2 text-sm text-critical-ink">{error}</p>}
      {tab === 'products' && <ProductsTab products={products} />}
      {tab === 'team' && <TeamTab products={products} showNew={!!notice} />}
      {tab === 'icps' && product && <IcpsTab product={product} />}
      {tab === 'allocation' && product && <AllocationTab product={product} />}
      {tab === 'templates' && product && <TemplatesTab product={product} sp={sp} />}
      {tab === 'followups' && product && <FollowupsTab product={product} sp={sp} />}
    </>
  );
}
