import type { Product } from '@/lib/db/schema';
import { allocationFor } from '@/lib/config';
import { getDb } from '@/lib/db';
import { AllocationRow } from './allocation-row';

/** Allocation: how many leads each BDA is given every working day, per ICP, for a product. */
export async function AllocationTab({ product }: { product: Product }) {
  const { icps, rows } = await allocationFor(await getDb(), product.id);
  const active = icps.filter((i) => i.active);
  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold">Daily allocation for {product.name}</h2>
      <p className="mb-3 text-xs text-muted">
        The exact number of leads each BDA gets per working day, per ICP. The counts must add up to the BDA&apos;s daily total. Leads are given out in a fixed, fair order (oldest first, dealt in turn from where the last draw stopped), never at random.
        CA firms come from the Google Sheet and use their count here too. New ICPs appear as soon as they are added. Changes apply from the next draw.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">No BDA is assigned to {product.name} yet. Assign them under Team Members.</p>
      ) : active.length === 0 ? (
        <p className="text-sm text-muted">{product.name} has no active ICP. Add or activate one under ICPs &amp; Search.</p>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <AllocationRow key={r.userId} productId={product.id} userId={r.userId} name={r.name} total={r.total} icps={active.map((i) => ({ id: i.id, name: i.segment }))} counts={r.counts} />
          ))}
        </div>
      )}
    </section>
  );
}
