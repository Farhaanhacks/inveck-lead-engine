import type { Product } from '@/lib/db/schema';
import { saveFollowupAction } from '@/app/configuration-actions';
import { followupRuleFor, listIcps } from '@/lib/config';
import { MAX_ROUNDS, MAX_SPACING, OUTCOME_CHOICES, offsetsOf, parseOutcomes, scheduleFor, validateFollowup } from '@/lib/config-rules';
import { getDb } from '@/lib/db';
import { formatDate } from '@/lib/dates';
import { getHolidays } from '@/lib/holidays';
import { istDay } from '@/lib/tasks';
import { one, type ConfigParams } from './params';

/** Follow-up rules: how many rounds, how far apart in working days, which outcomes start them. Preview before saving. */
export async function FollowupsTab({ product, sp }: { product: Product; sp: ConfigParams }) {
  const db = await getDb();
  const icps = await listIcps(db, product.id);
  const scopeId = Number(one(sp.icp)) || 0;
  const saved = (await followupRuleFor(db, product.id, scopeId)).rule;
  // What is on the form: the values being previewed (if any), else the saved rule.
  const previewing = one(sp.rounds) !== '';
  const rule = previewing ? { rounds: Number(one(sp.rounds)), spacingDays: Number(one(sp.spacing)), outcomes: Array.isArray(sp.outcomes) ? sp.outcomes : parseOutcomes(one(sp.outcomes)) } : saved;
  const errors = validateFollowup(rule);
  const holidays = await getHolidays(db);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(one(sp.start)) ? one(sp.start) : istDay();
  const dates = errors.length ? [] : scheduleFor(rule, start, holidays);
  const rows = [{ id: 0, name: `${product.name} default (every ICP without its own rule)` }, ...icps.map((i) => ({ id: i.id, name: i.segment }))];
  const scopeName = rows.find((r) => r.id === scopeId)?.name ?? rows[0].name;

  return (
    <div className="space-y-6">
      <section className="card p-5">
        <h2 className="text-sm font-semibold">Follow-up rule for {product.name}</h2>
        <p className="mb-3 text-xs text-muted">
          A follow-up sequence starts when a call is saved with one of the chosen outcomes (a connected call always ends it). Day 1 is that call; round N falls N × the gap in working days later: weekends and the holidays in Settings never count. It applies to sequences that start from now on. CA firms use their own rounds after the LinkedIn request.
        </p>
        <form method="get" className="space-y-3">
          <input type="hidden" name="tab" value="followups" />
          <input type="hidden" name="product" value={product.id} />
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="fu-icp" className="label">Applies to</label>
              <select id="fu-icp" name="icp" defaultValue={scopeId} className="field w-auto">{rows.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
            </div>
            <div><label htmlFor="fu-rounds" className="label">Follow-ups</label><input id="fu-rounds" name="rounds" type="number" min={1} max={MAX_ROUNDS} defaultValue={rule.rounds} className="field w-24" /></div>
            <div><label htmlFor="fu-spacing" className="label">Working days apart</label><input id="fu-spacing" name="spacing" type="number" min={1} max={MAX_SPACING} defaultValue={rule.spacingDays} className="field w-28" /></div>
            <div><label htmlFor="fu-start" className="label">Preview from Day 1</label><input id="fu-start" name="start" type="date" defaultValue={start} className="field w-auto" /></div>
          </div>
          <fieldset>
            <legend className="label">Call outcomes that start the follow-ups</legend>
            <div className="flex flex-wrap gap-4">
              {OUTCOME_CHOICES.map((o) => (
                <label key={o.value} className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="outcomes" value={o.value} defaultChecked={rule.outcomes.includes(o.value)} /> {o.label}</label>
              ))}
            </div>
          </fieldset>
          <div className="flex gap-2">
            <button className="btn-secondary">Preview schedule</button>
            <button formAction={saveFollowupAction} formMethod="post" className="btn-primary">Save rule</button>
          </div>
        </form>
        <div className="mt-4 rounded-md border border-line bg-surface-2 p-3 text-sm" aria-live="polite">
          <div className="text-xs font-medium text-muted">Preview for {scopeName}</div>
          {errors.length ? (
            <ul className="mt-1 list-disc pl-5 text-critical-ink">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
          ) : (
            <ol className="mt-1 space-y-0.5">
              <li>Day 1: {formatDate(new Date(`${start}T12:00:00+05:30`))} (the call)</li>
              {dates.map((d, i) => <li key={d + i}>Follow-up {i + 1}: {formatDate(new Date(`${d}T12:00:00+05:30`))} <span className="text-muted">({offsetsOf(rule)[i]} working days after Day 1)</span></li>)}
            </ol>
          )}
        </div>
      </section>
      <section className="card p-5">
        <h2 className="text-sm font-semibold">Saved rules</h2>
        <ul className="mt-2 divide-y divide-line text-sm">
          {await Promise.all(rows.map(async (r) => {
            const { rule: x, own } = await followupRuleFor(db, product.id, r.id);
            return (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{r.name}</span>
                <span className="text-xs text-muted">{x.rounds} follow-ups, {x.spacingDays} working day{x.spacingDays === 1 ? '' : 's'} apart · {x.outcomes.map((o) => OUTCOME_CHOICES.find((c) => c.value === o)?.label ?? o).join(', ')}{r.id !== 0 && !own ? ' · uses the default' : ''}</span>
              </li>
            );
          }))}
        </ul>
      </section>
    </div>
  );
}
