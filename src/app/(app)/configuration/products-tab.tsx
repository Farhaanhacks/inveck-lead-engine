import type { Product } from '@/lib/db/schema';
import { saveProductAction } from '@/app/configuration-actions';

/** Products: Inveck today; more can be added later and everything else is scoped to one. */
export function ProductsTab({ products }: { products: Product[] }) {
  return (
    <div className="space-y-6">
      <section className="card p-5">
        <h2 className="text-sm font-semibold">Products</h2>
        <p className="mb-3 text-xs text-muted">ICPs, team assignments, allocation, templates and follow-up rules each belong to a product. Deactivating one stops new searches and allocation for it; nothing already made is removed.</p>
        <ul className="divide-y divide-line">
          {products.map((p) => (
            <li key={p.id} className="py-3">
              <form action={saveProductAction} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto_auto] sm:items-end">
                <input type="hidden" name="id" value={p.id} />
                <div><label htmlFor={`pn-${p.id}`} className="label">Name</label><input id={`pn-${p.id}`} name="name" defaultValue={p.name} required className="field" /></div>
                <div><label htmlFor={`pd-${p.id}`} className="label">Description (what the AI is told it sells; blank uses Settings)</label><input id={`pd-${p.id}`} name="description" defaultValue={p.description} className="field" /></div>
                <label className="flex items-center gap-1.5 pb-2 text-sm"><input type="checkbox" name="active" defaultChecked={p.active} /> Active</label>
                <button className="btn-secondary">Save</button>
              </form>
              <p className="mt-1 text-xs text-muted">Search: {p.searchMode === 'people_first' ? 'People first (LinkedIn titles)' : 'AI planner (configured prompt)'} · configuration version {p.configVersion}</p>
            </li>
          ))}
        </ul>
      </section>
      <section className="card p-5">
        <h2 className="text-sm font-semibold">Add a product</h2>
        <p className="mb-3 text-xs text-muted">A new product starts on the AI planner: add its ICPs and their search prompts under ICPs &amp; Search.</p>
        <form action={saveProductAction} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
          <div><label htmlFor="np-name" className="label">Name</label><input id="np-name" name="name" required className="field" /></div>
          <div><label htmlFor="np-desc" className="label">Description</label><input id="np-desc" name="description" className="field" /></div>
          <input type="hidden" name="active" value="on" />
          <button className="btn-primary">Add product</button>
        </form>
      </section>
    </div>
  );
}
