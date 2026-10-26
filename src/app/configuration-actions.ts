'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/access';
import { saveAllocation, saveFollowupRule, saveIcp, saveProduct, saveSearchPrompt, saveTemplate, setIcpActive, setUserProducts } from '@/lib/config';
import { createBda, setBdaActive } from '@/lib/config-team';
import { parseOutcomes } from '@/lib/config-rules';
import { driveSourcingTest } from '@/lib/sourcing/drive';
import { startProspectSearch } from '@/lib/sourcing/sample-run';

/** Every action here is administrators only (checked on the server, whatever page sent it). */
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const num = (f: FormData, k: string) => Number(str(f, k));
const raw = (f: FormData, k: string) => String(f.get(k) ?? '');

type Result = { ok: true; notice?: string } | { ok: false; error: string };

/** Back to the page it came from, with what happened shown at the top. */
function back(tab: string, product: number | string | undefined, r: Result): never {
  const p = new URLSearchParams({ tab });
  if (product) p.set('product', String(product));
  if (r.ok) p.set('notice', r.notice ?? 'Saved.');
  else p.set('error', r.error);
  revalidatePath('/configuration');
  redirect(`/configuration?${p}`);
}

export async function saveProductAction(form: FormData) {
  await requireAdmin();
  const id = num(form, 'id') || undefined;
  const r = await saveProduct(await getDb(), { id, name: str(form, 'name'), description: raw(form, 'description'), active: form.get('active') === 'on' });
  back('products', r.ok ? r.product.id : id, r.ok ? { ok: true, notice: id ? 'Product saved.' : `${r.product.name} added.` } : r);
}

export async function saveSearchAction(form: FormData) {
  await requireAdmin();
  const productId = num(form, 'productId');
  const reset = form.get('reset') === '1';
  const r = await saveSearchPrompt(await getDb(), productId, reset ? '' : raw(form, 'searchPrompt'), raw(form, 'description'), str(form, 'searchMode') || undefined);
  back('icps', productId, r.ok ? { ok: true, notice: reset ? 'The shared prompt is back to the built-in one.' : 'Search settings saved.' } : r);
}

export async function saveIcpAction(form: FormData) {
  await requireAdmin();
  const productId = num(form, 'productId');
  const id = num(form, 'id') || undefined;
  const fields = ['description', 'industries', 'geography', 'companySize', 'mustHaves', 'dealBreakers', 'searchInstructions', 'targetTitles', 'p2Titles', 'p3Titles', 'avoidTitles', 'pitchAngle'] as const;
  const input: Record<string, string> = {};
  for (const f of fields) if (form.has(f)) input[f] = raw(form, f);
  const r = await saveIcp(await getDb(), productId, { id, segment: str(form, 'segment'), ...input });
  back('icps', productId, r.ok ? { ok: true, notice: id ? 'ICP saved.' : `${r.icp.segment} added. It can be used in Allocation, Templates and Follow-up rules now.` } : r);
}

export async function toggleIcpAction(form: FormData) {
  await requireAdmin();
  const productId = num(form, 'productId');
  const active = form.get('active') === '1';
  const ok = await setIcpActive(await getDb(), productId, num(form, 'id'), active);
  back('icps', productId, ok ? { ok: true, notice: active ? 'ICP activated.' : 'ICP deactivated.' } : { ok: false, error: 'That ICP no longer exists.' });
}

export async function createBdaAction(form: FormData) {
  await requireAdmin();
  const productIds = form.getAll('products').map(Number).filter(Number.isInteger);
  const r = await createBda(await getDb(), { name: raw(form, 'name'), email: raw(form, 'email'), productIds });
  if (r.ok) {
    // Shown once on the next page: a short-lived cookie the page reads, never stored or sent anywhere else.
    (await cookies()).set('cfg_new_bda', JSON.stringify({ id: r.id, password: r.password }), { httpOnly: true, sameSite: 'lax', path: '/configuration', maxAge: 60, secure: process.env.NODE_ENV === 'production' });
  }
  back('team', undefined, r.ok ? { ok: true, notice: 'BDA created. Their starting password is shown below, once.' } : r);
}

export async function setUserProductsAction(form: FormData) {
  await requireAdmin();
  const ok = await setUserProducts(await getDb(), num(form, 'userId'), form.getAll('products').map(Number).filter(Number.isInteger));
  back('team', undefined, ok ? { ok: true, notice: 'Products saved.' } : { ok: false, error: 'That BDA no longer exists.' });
}

export async function setBdaActiveAction(form: FormData) {
  await requireAdmin();
  const active = form.get('active') === '1';
  const ok = await setBdaActive(await getDb(), num(form, 'userId'), active);
  back('team', undefined, ok ? { ok: true, notice: active ? 'BDA activated.' : 'BDA deactivated. Their leads and history are kept.' } : { ok: false, error: 'That BDA no longer exists.' });
}

export async function saveAllocationAction(form: FormData) {
  await requireAdmin();
  const productId = num(form, 'productId');
  const counts: Record<number, number> = {};
  for (const [k, v] of form.entries()) if (k.startsWith('count_')) counts[Number(k.slice(6))] = Number(v);
  const r = await saveAllocation(await getDb(), productId, num(form, 'userId'), num(form, 'total'), counts);
  back('allocation', productId, r.ok ? { ok: true, notice: 'Allocation saved. It applies from the next draw.' } : r);
}

export async function saveTemplateAction(form: FormData) {
  await requireAdmin();
  const productId = num(form, 'productId');
  const channel = str(form, 'channel') === 'whatsapp' ? 'whatsapp' : 'email';
  const r = await saveTemplate(await getDb(), productId, num(form, 'icpId'), channel, { subject: raw(form, 'subject'), body: raw(form, 'body'), active: form.get('active') === 'on' });
  back('templates', productId, r.ok ? { ok: true, notice: 'Template saved. It applies to messages from now on; messages already sent are unchanged.' } : r);
}

export async function saveFollowupAction(form: FormData) {
  await requireAdmin();
  const productId = num(form, 'productId');
  const r = await saveFollowupRule(await getDb(), productId, num(form, 'icpId'), { rounds: num(form, 'rounds'), spacingDays: num(form, 'spacing'), outcomes: form.getAll('outcomes').map(String).flatMap(parseOutcomes) });
  back('followups', productId, r.ok ? { ok: true, notice: 'Follow-up rule saved. It applies to sequences that start from now on.' } : r);
}

/**
 * Starts a prospect search for what the morning draw is short of, on the one capped engine the daily run uses (INVECK,
 * 26 Oct 2026: its rules and its credit limit), like Find new prospects on the dashboard.
 */
export async function startProspectingAction(form: FormData) {
  const user = await requireAdmin();
  const productId = num(form, 'productId');
  const search = await startProspectSearch(await getDb(), { wanted: null, to: '' }, user.id);
  if (search.created) {
    const h = await headers();
    const origin = `${h.get('x-forwarded-proto') || 'http'}://${h.get('host')}`;
    after(() => driveSourcingTest(search.id, origin));
  }
  back('icps', productId, { ok: true, notice: search.created ? `Prospect search ${search.id} started. Watch it on the Sourcing page.` : `A search is already running (${search.id}). Watch it on the Sourcing page.` });
}
