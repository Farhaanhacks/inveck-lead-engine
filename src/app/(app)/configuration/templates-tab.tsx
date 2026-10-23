import type { Product } from '@/lib/db/schema';
import { saveTemplateAction } from '@/app/configuration-actions';
import { listIcps, listTemplates } from '@/lib/config';
import { MISSING_TEXT, renderTemplate, SAMPLE_VARS, TEMPLATE_VARIABLES, VARIABLE_HELP } from '@/lib/config-templates';
import { getDb } from '@/lib/db';

/** Templates: the first email and first WhatsApp for each ICP of a product, with the variables filled in as a preview. */
export async function TemplatesTab({ product }: { product: Product }) {
  const db = await getDb();
  const icps = await listIcps(db, product.id);
  const templates = await listTemplates(db, product.id);
  const pick = (icpId: number, channel: 'email' | 'whatsapp') => templates.find((t) => t.icpId === icpId && t.channel === channel);
  return (
    <div className="space-y-6">
      <section className="card p-5">
        <h2 className="text-sm font-semibold">Templates for {product.name}</h2>
        <p className="mt-1 text-xs text-muted">
          The first email and WhatsApp a BDA sends, per ICP. Attachments, the sender account and the WhatsApp flow work as before. Editing a message while sending it changes only that message, never the template. A template applies to messages from now on.
        </p>
        <ul className="mt-3 grid gap-1 text-xs text-muted sm:grid-cols-2">
          {TEMPLATE_VARIABLES.map((v) => <li key={v}><code>{`{{${v}}}`}</code> · {VARIABLE_HELP[v]}</li>)}
        </ul>
      </section>
      {icps.map((icp) => (
        <section key={icp.id} className="card p-5">
          <h3 className="text-sm font-semibold">{icp.segment}{icp.active ? '' : ' (inactive)'}</h3>
          <div className="mt-3 grid gap-5 lg:grid-cols-2">
            {(['email', 'whatsapp'] as const).map((channel) => {
              const t = pick(icp.id, channel);
              const rendered = t ? renderTemplate(`${t.subject ? `${t.subject}\n\n` : ''}${t.body}`, SAMPLE_VARS) : null;
              return (
                <div key={channel}>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">{channel === 'email' ? 'Email' : 'WhatsApp'}</h4>
                  <form action={saveTemplateAction} className="mt-2 space-y-2">
                    <input type="hidden" name="productId" value={product.id} />
                    <input type="hidden" name="icpId" value={icp.id} />
                    <input type="hidden" name="channel" value={channel} />
                    {channel === 'email' && (
                      <div>
                        <label htmlFor={`s-${icp.id}`} className="label">Subject</label>
                        <input id={`s-${icp.id}`} name="subject" defaultValue={t?.subject ?? ''} className="field" />
                      </div>
                    )}
                    <div>
                      <label htmlFor={`b-${icp.id}-${channel}`} className="label">Message</label>
                      <textarea id={`b-${icp.id}-${channel}`} name="body" defaultValue={t?.body ?? ''} rows={10} className="field font-[inherit] leading-relaxed" placeholder={channel === 'email' ? 'No email template: the first email is the AI draft on the lead.' : 'No WhatsApp template: the WhatsApp step has no message for this ICP.'} />
                    </div>
                    <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="active" defaultChecked={t ? t.active : true} /> In use</label>
                    <button className="btn-primary px-3 py-1 text-sm">Save template</button>
                  </form>
                  {rendered && (
                    <div className="mt-3 rounded-md border border-line bg-surface-2 p-3">
                      <div className="text-xs font-medium text-muted">Preview with sample values</div>
                      {rendered.ok ? <p className="mt-1 whitespace-pre-line text-sm">{rendered.text}</p> : <p className="mt-1 text-sm text-warning-ink">The sample has no value for {rendered.missing.map((m) => MISSING_TEXT[m]).join(', ')}.</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {icps.length === 0 && <p className="text-sm text-muted">Add an ICP under ICPs &amp; Search first.</p>}
    </div>
  );
}
