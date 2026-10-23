import { cookies } from 'next/headers';
import type { Product } from '@/lib/db/schema';
import { createBdaAction, setBdaActiveAction, setUserProductsAction } from '@/app/configuration-actions';
import { listTeam } from '@/lib/config';
import { getDb } from '@/lib/db';

/** A dropdown with checkboxes: pick several products. Submits each ticked one as `products`. */
function ProductPicker({ products, selected, label }: { products: Product[]; selected: number[]; label: string }) {
  const chosen = products.filter((p) => selected.includes(p.id)).map((p) => p.name);
  return (
    <details className="relative">
      <summary className="field flex cursor-pointer list-none items-center justify-between gap-2 py-1.5 text-sm" aria-label={label}>
        <span className="truncate">{chosen.length ? chosen.join(', ') : 'Choose products'}</span>
        <span aria-hidden className="text-muted">▾</span>
      </summary>
      <div className="absolute z-10 mt-1 w-56 rounded-md border border-line bg-surface p-2 shadow-lg">
        {products.filter((p) => p.active || selected.includes(p.id)).map((p) => (
          <label key={p.id} className="flex items-center gap-2 px-1 py-1 text-sm">
            <input type="checkbox" name="products" value={p.id} defaultChecked={selected.includes(p.id)} /> {p.name}{p.active ? '' : ' (inactive)'}
          </label>
        ))}
      </div>
    </details>
  );
}

/** Team Members: BDAs only. Each can be on several products. */
export async function TeamTab({ products, showNew }: { products: Product[]; showNew: boolean }) {
  const team = await listTeam(await getDb());
  let fresh: { id: number; password: string } | null = null;
  if (showNew) {
    try {
      fresh = JSON.parse((await cookies()).get('cfg_new_bda')?.value ?? 'null');
    } catch {
      fresh = null;
    }
  }
  const created = fresh ? team.find((t) => t.id === fresh!.id) : null;
  return (
    <div className="space-y-6">
      {created && fresh && (
        <section className="card border-warning-ink/40 p-5" role="status">
          <h2 className="text-sm font-semibold">Starting password for {created.name}</h2>
          <p className="mt-1 text-sm">Login <code>{created.username}</code> · password <code className="rounded bg-surface-2 px-1.5 py-0.5 text-base">{fresh.password}</code></p>
          <p className="mt-1 text-xs text-muted">Shown once, here only. It is stored hashed; they must change it at first login. Give it to them privately.</p>
        </section>
      )}
      <section className="card p-5">
        <h2 className="text-sm font-semibold">Team members (BDAs)</h2>
        <p className="mb-3 text-xs text-muted">Only the BDA role can be made here. A BDA works on every product ticked for them, and appears in Allocation for it.</p>
        <ul className="divide-y divide-line">
          {team.map((t) => (
            <li key={t.id} className="py-3">
              <div className="grid gap-2 sm:grid-cols-[1.2fr_1.5fr_auto_auto] sm:items-center">
                <div>
                  <div className="text-sm font-medium">{t.name}{t.active ? '' : ' (inactive)'}</div>
                  <div className="text-xs text-muted">{t.username}</div>
                </div>
                <form action={setUserProductsAction} className="flex items-center gap-2">
                  <input type="hidden" name="userId" value={t.id} />
                  <div className="min-w-0 flex-1"><ProductPicker products={products} selected={t.productIds} label={`Products for ${t.name}`} /></div>
                  <button className="btn-secondary px-3 py-1 text-sm">Save</button>
                </form>
                <form action={setBdaActiveAction}>
                  <input type="hidden" name="userId" value={t.id} />
                  <input type="hidden" name="active" value={t.active ? '0' : '1'} />
                  <button className="btn-secondary px-3 py-1 text-sm">{t.active ? 'Deactivate' : 'Activate'}</button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className="card p-5">
        <h2 className="text-sm font-semibold">Add a BDA</h2>
        <form action={createBdaAction} className="mt-3 grid gap-3 sm:grid-cols-[1fr_1.2fr_1fr_auto] sm:items-end">
          <div><label htmlFor="bda-name" className="label">Name</label><input id="bda-name" name="name" required className="field" /></div>
          <div><label htmlFor="bda-email" className="label">Email (their login)</label><input id="bda-email" name="email" type="email" required className="field" /></div>
          <div><span className="label">Products</span><ProductPicker products={products} selected={products.filter((p) => p.active).slice(0, 1).map((p) => p.id)} label="Products" /></div>
          <button className="btn-primary">Create BDA</button>
        </form>
        <p className="mt-2 text-xs text-muted">An email that already has a login is refused, so nobody is made twice.</p>
      </section>
    </div>
  );
}
