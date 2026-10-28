import Link from 'next/link';
import type { EmailTemplate, Product } from '@/lib/db/schema';
import { deleteStepTemplateAction, saveStepAssignmentsAction, saveStepTemplateAction } from '@/app/configuration-actions';
import { listIcps, listStepAssignments, listStepTemplates, stepsFor, type Channel } from '@/lib/config';
import { MISSING_TEXT, renderTemplate, SAMPLE_VARS, TEMPLATE_VARIABLES, VARIABLE_HELP } from '@/lib/config-templates';
import { getDb } from '@/lib/db';
import { RichEditor } from '@/components/rich-editor';
import { escHtml } from '@/lib/rich-text';
import { sanitizeEmailHtml } from '@/lib/mail/sanitize';
import { one, type ConfigParams } from './params';

const SAMPLE_HTML_VARS = Object.fromEntries(Object.entries(SAMPLE_VARS).map(([k, v]) => [k, escHtml(v ?? '')]));

/** The message as the recipient gets it, with sample values. An email shows subject and formatted body; a WhatsApp shows its text. */
function Preview({ channel, subject, body }: { channel: Channel; subject: string; body: string }) {
  const s = renderTemplate(subject, SAMPLE_VARS);
  const b = renderTemplate(body, channel === 'email' ? SAMPLE_HTML_VARS : SAMPLE_VARS);
  const missing = [...(s.ok ? [] : s.missing), ...(b.ok ? [] : b.missing)];
  return (
    <div className="mt-3 rounded-md border border-line bg-surface-2 p-3">
      <div className="text-xs font-medium text-muted">Preview with sample values</div>
      {missing.length > 0 ? (
        <p className="mt-1 text-sm text-warning-ink">The sample has no value for {missing.map((m) => MISSING_TEXT[m]).join(', ')}.</p>
      ) : channel === 'email' ? (
        <>
          <p className="mt-1 text-sm"><span className="text-muted">Subject: </span><span className="font-medium">{s.ok ? s.text : ''}</span></p>
          {/* Sanitized when saved (and again here): only paragraphs, breaks, bold, italic, underline, lists and links. */}
          <div className="mt-2 rounded border border-line bg-surface p-3 text-sm leading-relaxed [&_a]:text-accent [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5" dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(b.ok ? b.text : '') }} />
          <p className="mt-1 text-xs text-muted">The sender&apos;s signature (name, number, office, logo) is added under it when the email is sent.</p>
        </>
      ) : (
        <p className="mt-1 whitespace-pre-line rounded border border-line bg-surface p-3 text-sm">{b.ok ? b.text : ''}</p>
      )}
    </div>
  );
}

/** One channel's part of an ICP: the step table (which template each step sends, with missing ones flagged) and the templates. */
function ChannelSection({
  channel,
  product,
  icp,
  steps,
  templates,
  assigned,
  editId,
}: {
  channel: Channel;
  product: Product;
  icp: { id: number; segment: string };
  steps: { step: number; label: string }[];
  templates: EmailTemplate[];
  assigned: Map<number, number>;
  editId: number;
}) {
  const email = channel === 'email';
  const noun = email ? 'email' : 'WhatsApp';
  const missing = steps.filter((s) => !templates.some((t) => t.id === assigned.get(s.step)));
  const usedBy = (id: number) => steps.filter((s) => assigned.get(s.step) === id).map((s) => s.label);
  const hidden = (
    <>
      <input type="hidden" name="productId" value={product.id} />
      <input type="hidden" name="icpId" value={icp.id} />
      <input type="hidden" name="channel" value={channel} />
    </>
  );
  return (
    <>
      <section className="card p-5" aria-labelledby={`${channel}-steps-h`}>
        <h3 id={`${channel}-steps-h`} className="text-sm font-semibold">{icp.segment}: {noun} sequence</h3>
        {missing.length > 0 ? (
          <p role="status" className="mt-2 rounded-md border border-line bg-warning-soft px-3 py-2 text-sm text-warning-ink">
            {missing.length} of {steps.length} steps have no template ({missing.map((s) => s.label).join(', ')}). Nothing is written or sent for a step with no template: it shows as missing to the associate until one is assigned.
          </p>
        ) : (
          <p role="status" className="mt-2 rounded-md border border-line bg-good-soft px-3 py-2 text-sm text-good-ink">Every step has a template.</p>
        )}
        <form action={saveStepAssignmentsAction} className="mt-3">
          {hidden}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted"><th className="py-1 pr-3 font-medium">Step</th><th className="py-1 pr-3 font-medium">Template</th><th className="py-1 font-medium">Status</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {steps.map((s) => {
                const current = templates.find((t) => t.id === assigned.get(s.step));
                return (
                  <tr key={s.step}>
                    <td className="py-2 pr-3 align-top font-medium"><label htmlFor={`${channel}-step-${s.step}`}>{s.label}</label></td>
                    <td className="py-2 pr-3 align-top">
                      <select id={`${channel}-step-${s.step}`} name={`step_${s.step}`} defaultValue={current?.id ?? ''} className="field w-auto min-w-48">
                        <option value="">None</option>
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

      <section className="card p-5" aria-labelledby={`${channel}-tpls-h`}>
        <h3 id={`${channel}-tpls-h`} className="text-sm font-semibold">{icp.segment}: {noun} templates</h3>
        <div className="mt-3 space-y-3">
          {templates.map((t) => (
            <details key={t.id} className="rounded-md border border-line p-3" open={editId === t.id}>
              <summary className="cursor-pointer text-sm font-medium">
                {t.name}{email && <span className="font-normal text-muted"> · {t.subject}</span>}
                <span className="ml-2 text-xs font-normal text-muted">{usedBy(t.id).length ? `Used by: ${usedBy(t.id).join(', ')}` : 'Not assigned to a step'}</span>
              </summary>
              <form action={saveStepTemplateAction} className="mt-3 space-y-2">
                {hidden}
                <input type="hidden" name="id" value={t.id} />
                <div>
                  <label htmlFor={`${channel}-n-${t.id}`} className="label">Template name</label>
                  <input id={`${channel}-n-${t.id}`} name="name" defaultValue={t.name} required className="field" />
                </div>
                {email && (
                  <div>
                    <label htmlFor={`${channel}-s-${t.id}`} className="label">Subject</label>
                    <input id={`${channel}-s-${t.id}`} name="subject" defaultValue={t.subject} required className="field" />
                  </div>
                )}
                <div>
                  <label htmlFor={`${channel}-b-${t.id}`} className="label">Message</label>
                  {email ? <RichEditor id={`${channel}-b-${t.id}`} name="body" defaultHtml={t.body} label="Message" /> : <textarea id={`${channel}-b-${t.id}`} name="body" defaultValue={t.body} rows={10} required className="field font-[inherit] leading-relaxed" />}
                </div>
                <button className="btn-primary px-3 py-1 text-sm">Save template</button>
              </form>
              <form action={deleteStepTemplateAction} className="mt-2">
                {hidden}
                <input type="hidden" name="id" value={t.id} />
                <button className="btn-secondary px-3 py-1 text-sm text-critical-ink">Delete template</button>
              </form>
              <Preview channel={channel} subject={t.subject} body={t.body} />
            </details>
          ))}
          {templates.length === 0 && <p className="text-sm text-muted">No {noun} templates for {icp.segment} yet: every step is missing. Add one below.</p>}
        </div>
        <details className="mt-4 rounded-md border border-dashed border-line p-3" open={templates.length === 0}>
          <summary className="cursor-pointer text-sm font-medium">New {noun} template</summary>
          <form action={saveStepTemplateAction} className="mt-3 space-y-2">
            {hidden}
            <div>
              <label htmlFor={`${channel}-n-new`} className="label">Template name</label>
              <input id={`${channel}-n-new`} name="name" required placeholder="e.g. Follow-up 1" className="field" />
            </div>
            {email && (
              <div>
                <label htmlFor={`${channel}-s-new`} className="label">Subject</label>
                <input id={`${channel}-s-new`} name="subject" required className="field" />
              </div>
            )}
            <div>
              <label htmlFor={`${channel}-b-new`} className="label">Message</label>
              {email ? <RichEditor id={`${channel}-b-new`} name="body" defaultHtml="" label="Message" /> : <textarea id={`${channel}-b-new`} name="body" required rows={8} className="field font-[inherit] leading-relaxed" />}
            </div>
            <button className="btn-primary px-3 py-1 text-sm">Add template</button>
          </form>
        </details>
      </section>
    </>
  );
}

/**
 * Templates: for the chosen ICP, the first-contact message and one for every follow-up of its follow-up rule (the steps follow the
 * rule, so they change with it), for email and for WhatsApp. Several templates can be written per ICP and any of them assigned to any
 * step; a step with none is flagged as missing and nothing is written or sent for it.
 */
export async function TemplatesTab({ product, sp }: { product: Product; sp: ConfigParams }) {
  const db = await getDb();
  const icps = await listIcps(db, product.id);
  const icp = icps.find((i) => i.id === Number(one(sp.icp))) ?? icps[0];
  if (!icp) return <p className="text-sm text-muted">Add an ICP under ICPs &amp; Search first.</p>;
  const steps = await stepsFor(db, product.id, icp.id);
  const editId = Number(one(sp.edit));
  const load = async (channel: Channel) => ({
    templates: (await listStepTemplates(db, product.id, channel)).filter((t) => t.icpId === icp.id),
    assigned: new Map((await listStepAssignments(db, product.id, channel)).filter((a) => a.icpId === icp.id).map((a) => [a.step, a.templateId] as const)),
  });
  const [email, whatsapp] = await Promise.all([load('email'), load('whatsapp')]);

  return (
    <div className="space-y-6">
      <section className="card p-5">
        <h2 className="text-sm font-semibold">Templates for {product.name}</h2>
        <p className="mt-1 text-xs text-muted">
          Choose an ICP, write its email and WhatsApp templates, and say which one each step of its sequence sends: the first contact, then one per follow-up (the steps come from Follow-up Rules, so they change when the rule does). Nothing is drafted by AI: a step with no template is missing and nothing is sent for it. Editing a message while sending it changes only that message, never the template. A change applies from now on.
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
        <p className="mt-3 text-xs text-muted"><Link href={`/configuration?tab=followups&product=${product.id}&icp=${icp.id}`} className="text-accent hover:underline">Change the number of follow-ups</Link> in Follow-up Rules: the steps follow it.</p>
      </section>
      <ChannelSection channel="email" product={product} icp={icp} steps={steps} templates={email.templates} assigned={email.assigned} editId={editId} />
      <ChannelSection channel="whatsapp" product={product} icp={icp} steps={steps} templates={whatsapp.templates} assigned={whatsapp.assigned} editId={editId} />
    </div>
  );
}
