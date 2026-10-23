'use client';

import { useState } from 'react';
import { saveAllocationAction } from '@/app/configuration-actions';
import { validateAllocationClient } from './allocation-check';

/** One BDA's daily total and count per ICP. Shows the running sum against the total, and saving is refused until they match. */
export function AllocationRow({ productId, userId, name, total: initialTotal, icps, counts: initial }: { productId: number; userId: number; name: string; total: number; icps: { id: number; name: string }[]; counts: Record<number, number> }) {
  const [total, setTotal] = useState(String(initialTotal));
  const [counts, setCounts] = useState<Record<number, string>>(Object.fromEntries(icps.map((i) => [i.id, String(initial[i.id] ?? 0)])));
  const check = validateAllocationClient(Number(total), icps.map((i) => Number(counts[i.id])));
  return (
    <form action={saveAllocationAction} className="rounded-lg border border-line p-3">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="userId" value={userId} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-32 text-sm font-medium">{name}</div>
        <div>
          <label htmlFor={`t-${userId}`} className="label">Daily total</label>
          <input id={`t-${userId}`} name="total" type="number" min={0} max={1000} value={total} onChange={(e) => setTotal(e.target.value)} className="field w-24" />
        </div>
        {icps.map((i) => (
          <div key={i.id}>
            <label htmlFor={`c-${userId}-${i.id}`} className="label">{i.name}</label>
            <input id={`c-${userId}-${i.id}`} name={`count_${i.id}`} type="number" min={0} max={500} value={counts[i.id]} onChange={(e) => setCounts((c) => ({ ...c, [i.id]: e.target.value }))} className="field w-24" />
          </div>
        ))}
        <button className="btn-primary" disabled={!check.ok}>Save</button>
      </div>
      <p role="status" className={`mt-2 text-xs ${check.ok ? 'text-good-ink' : 'text-critical-ink'}`}>
        {check.ok ? `The ICP counts add up to ${check.sum}, matching the daily total.` : check.message}
      </p>
    </form>
  );
}
