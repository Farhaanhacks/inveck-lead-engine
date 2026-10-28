import Link from 'next/link';
import type { Product } from '@/lib/db/schema';
import { deleteEmailTemplateAction, saveEmailStepsAction, saveEmailTemplateAction, saveTemplateAction } from '@/app/configuration-actions';
import { emailStepsFor, listEmailAssignments, listEmailTemplates, listIcps, listTemplates } from '@/lib/config';
import { MISSING_TEXT, renderTemplate, SAMPLE_VARS, TEMPLATE_VARIABLES, VARIABLE_HELP } from '@/lib/config-templates';
import { getDb } from '@/lib/db';
import { RichEditor } from '@/components/rich-editor';
import { escHtml } from '@/lib/rich-text';
import { sanitizeEmailHtml } from '@/lib/mail/sanitize';
import { one, type ConfigParams } from './params';

const SAMPLE_HTML_VARS = Object.fromEntries(Object.entries(SAMPLE_VARS).map(([k, v]) => [k, escHtml(v ?? '')]));

/** The email as the recipient gets it, with sample values: subject, formatted body, and a note that the sender's signature follows. */
function EmailPreview({ subject, body }: { subject: string; body: string }) {
  const s = renderTemplate(subject, SAMPLE_VARS);
  const b = renderTemplate(body, SAMPLE_HTML_VARS);
  return (
    <div className="mt-3 rounded-md border border-line bg-surface-2 p-3">
      <div className="text-xs font-medium text-muted">Preview with sample values</div>
      {s.ok && b.ok ? (
        <>
          <p className="mt-1 text-sm"><span className="text-muted">Subject: </span><span className="font-medium">{s.text}</span></p>
          {/* Sanitized when saved (and again here): only paragraphs, breaks, bold, italic, underline, lists and links. */}
          <div className="mt-2 rounded border border-line bg-surface p-3 text-sm leading-relaxed [&_a]:text-accent [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5" dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(b.text) }} />
          <p className="mt-1 text-xs text-muted">The sender&apos;s signature (name, number, office, logo) is added under it when the email is sent.</p>
        </>
      ) : (
        <p className="mt-1 text-sm text-warning-ink">The sample has no value for {[...(s.ok ? [] : s.missing), ...(b.ok ? [] : b.missing)].map((m) => MISSING_TEXT[m]).join(', ')}.</p>
      )}
    </div>
  );
}

/**
 * Templates: for the chosen ICP, a first-contact email template and one for every follow-up of its follow-up rule (the steps
 * follow the rule, so they change with it), plus the ICP's first WhatsApp message. Several templates can be written per ICP and
 * any of them assigned to any step; a step with none is flagged and sends the AI draft as before.
 */
export async function TemplatesTab({ product, sp }: { product: Product; sp: ConfigParams }) {
  const db = await getDb();
  const icps = await listIcps(db, product.id);
  const icp = icps.find((i) => i.id === Number(one(sp.icp))) ?? icps[0];
  if (!icp) return <p className="text-sm text-muted">Add an ICP under ICPs &amp; Search first.</p>;
  const steps = await emailStepsFor(db, product.id, icp.id);
  const templates = (await listEmailTemplates(db, product.id)).filter((t) => t.icpId === icp.id);
  const assigned = new Map((await listEmailAssignments(db, product.id)).filter((a) => a.icpId === icp.id).map((a) => [a.step, a.templateId]));
  const missing = steps.filter((s) => !templates.some((t) => t.id === assigned.get(s.step)));
  const wa = (await listTemplates(db, product.id)).find((t) => t.icpId === icp.id && t.channel === 'whatsapp');
  const waRendered = wa ? renderTemplate(wa.body, SAMPLE_VARS) : null;
  const usedBy = (id: number) => steps.filter((s) => assigned.get(s.step) === id).map((s) => s.label);

  return (
    <div className="space-y-6">
      <section className="card p-5">
        <h2 className="text-sm font-semibold">Templates for {product.name}</h2>
        <p className="mt-1 text-xs text-muted">
          Choose an ICP, write its email templates, and say which one each step of its sequence sends: the first contact, then one per follow-up (the steps come from Follow-up Rules, so they change when the rule does). Editing an email while sending it changes only that email, never the template. A change applies to emails from now on.
        </p>
        <form method="get" className="mt-3 flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="templates" />
          <input type="hidden" name="product" value={product.id} />
          <div>
            <label htmlFor="tpl-icp" className="label">ICP</label>
            <select id="tpl-icp" name="icp" defaultValue={icp.id} className="field w-auto">
              {icps.map((i) => <option key={i.id} value={i.id}>{i.segment}{i.active ? '' : ' (inactive)'}</option>)}
            </select>
          </div>
          <button className="btn-secondary px-3 py-1.5 text-sm">Show</button>
        </form>
        <ul className="mt-3 grid gap-1 text-xs text-muted sm:grid-cols-2">
          {TEMPLATE_VARIABLES.map((v) => <li key={v}><code>{`{{${v}}}`}</code> · {VARIABLE_HELP[v]}</li>)}
        </ul>
      </section>

      <section className="card p-5" aria-labelledby="steps-h">
        <h3 id="steps-h" className="text-sm font-semibold">{icp.segment}: email sequence</h3>
        {missing.length > 0 ? (
          <p role="status" className="mt-2 rounded-md border border-line bg-warning-soft px-3 py-2 text-sm text-warning-ink">
            {missing.length} of {steps.length} steps have no template ({missing.map((s) => s.label).join(', ')}). Until one is assigned, that step sends the AI-written draft.
          </p>
        ) : (
          <p role="status" className="mt-2 rounded-md border border-line bg-good-soft px-3 py-2 text-sm text-good-ink">Every step has a template.</p>
        )}
        <form action={saveEmailStepsAction} className="mt-3">
          <input type="hidden" name="productId" value={product.id} />
          <input type="hidden" name="icpId" value={icp.id} />
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted"><th className="py-1 pr-3 font-medium">Step</th><th className="py-1 pr-3 font-medium">Template</th><th className="py-1 font-medium">Status</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {steps.map((s) => {
                const current = templates.find((t) => t.id === assigned.get(s.step));
                return (
                  <tr key={s.step}>
                    <td className="py-2 pr-3 align-top font-medium"><label htmlFor={`step-${s.step}`}>{s.label}</label></td>
                    <td className="py-2 pr-3 align-top">
                      <select id={`step-${s.step}`} name={`step_${s.step}`} defaultValue={current?.id ?? ''} className="field w-auto min-w-48">
                        <option value="">None: use the AI draft</option>
                        {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </td>
                    <td className="py-2 align-top">
                      {current ? <span className="rounded bg-good-soft px-1.5 py-0.5 text-xs font-medium text-good-ink">Assigned: {current.name}</span> : <span className="rounded bg-warning-soft px-1.5 py-0.5 text-xs font-medium text-warning-ink">Missing</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button className="btn-primary mt-3 px-3 py-1 text-sm">Save assignments</button>
        </form>
      </section>

      <section className="card p-5" aria-labelledby="tpls-h">
        <h3 id="tpls-h" className="text-sm font-semibold">{icp.segment}: email templates</h3>
        <div className="mt-3 space-y-3">
          {templates.map((t) => (
            <details key={t.id} className="rounded-md border border-line p-3" open={Number(one(sp.edit)) === t.id}>
              <summary className="cursor-pointer text-sm font-medium">
                {t.name} <span className="font-normal text-muted">· {t.subject}</span>
                <span className="ml-2 text-xs font-normal text-muted">{usedBy(t.id).length ? `Used by: ${usedBy(t.id).join(', ')}` : 'Not assigned to a step'}</span>
              </summary>
              <form action={saveEmailTemplateAction} className="mt-3 space-y-2">
                <input type="hidden" name="productId" value={product.id} />
                <input type="hidden" name="icpId" value={icp.id} />
                <input type="hidden" name="id" value={t.id} />
                <div>
                  <label htmlFor={`n-${t.id}`} className="label">Template name</label>
                  <input id={`n-${t.id}`} name="name" defaultValue={t.name} required className="field" />
                </div>
                <div>
                  <label htmlFor={`s-${t.id}`} className="label">Subject</label>
                  <input id={`s-${t.id}`} name="subject" defaultValue={t.subject} required className="field" />
                </div>
                <div>
                  <label htmlFor={`b-${t.id}`} className="label">Message</label>
                  <RichEditor id={`b-${t.id}`} name="body" defaultHtml={t.body} label="Message" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="btn-primary px-3 py-1 text-sm">Save template</button>
                </div>
              </form>
              <form action={deleteEmailTemplateAction} className="mt-2">
                <input type="hidden" name="productId" value={product.id} />
                <input type="hidden" name="icpId" value={icp.id} />
                <input type="hidden" name="id" value={t.id} />
                <button className="btn-secondary px-3 py-1 text-sm text-critical-ink">Delete template</button>
              </form>
              <EmailPreview subject={t.subject} body={t.body} />
            </details>
          ))}
          {templates.length === 0 && <p className="text-sm text-muted">No email templates for {icp.segment} yet: every step sends the AI draft. Add one below.</p>}
        </div>
        <details className="mt-4 rounded-md border border-dashed border-line p-3" open={templates.length === 0}>
          <summary className="cursor-pointer text-sm font-medium">New template</summary>
          <form action={saveEmailTemplateAction} className="mt-3 space-y-2">
            <input type="hidden" name="productId" value={product.id} />
            <input type="hidden" name="icpId" value={icp.id} />
            <div>
              <label htmlFor="n-new" className="label">Template name</label>
              <input id="n-new" name="name" required placeholder="e.g. Follow-up 1" className="field" />
            </div>
            <div>
              <label htmlFor="s-new" className="label">Subject</label>
              <input id="s-new" name="subject" required className="field" />
            </div>
            <div>
              <label htmlFor="b-new" className="label">Message</label>
              <RichEditor id="b-new" name="body" defaultHtml="" label="Message" />
            </div>
            <button className="btn-primary px-3 py-1 text-sm">Add template</button>
          </form>
        </details>
      </section>

      <section className="card p-5">
        <h3 className="text-sm font-semibold">{icp.segment}: first WhatsApp message</h3>
        <form action={saveTemplateAction} className="mt-2 space-y-2">
          <input type="hidden" name="productId" value={product.id} />
          <input type="hidden" name="icpId" value={icp.id} />
          <div>
            <label htmlFor={`wa-${icp.id}`} className="label">Message</label>
            <textarea id={`wa-${icp.id}`} name="body" defaultValue={wa?.body ?? ''} rows={10} className="field font-[inherit] leading-relaxed" placeholder="No WhatsApp template: the WhatsApp step has no message for this ICP." />
          </div>
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="active" defaultChecked={wa ? wa.active : true} /> In use</label>
          <button className="btn-primary px-3 py-1 text-sm">Save template</button>
        </form>
        {waRendered && (
          <div className="mt-3 rounded-md border border-line bg-surface-2 p-3">
            <div className="text-xs font-medium text-muted">Preview with sample values</div>
            {waRendered.ok ? <p className="mt-1 whitespace-pre-line text-sm">{waRendered.text}</p> : <p className="mt-1 text-sm text-warning-ink">The sample has no value for {waRendered.missing.map((m) => MISSING_TEXT[m]).join(', ')}.</p>}
          </div>
        )}
        <p className="mt-3 text-xs text-muted"><Link href={`/configuration?tab=followups&product=${product.id}&icp=${icp.id}`} className="text-accent hover:underline">Change the number of follow-ups</Link> in Follow-up Rules: the steps above follow it.</p>
      </section>
    </div>
  );
}
