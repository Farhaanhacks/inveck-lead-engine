'use client';
import { useActionState } from 'react';
import type { Settings } from '@/lib/settings';
import { saveSettingsAction } from '../../actions';
import { SubmitButton } from '@/components/submit-button';


function Num({ name, label, value, hint, min, max }: { name: keyof Settings; label: string; value: number; hint: string; min: number; max: number }) {
  return (
    <div>
      <label htmlFor={name} className="label">{label}</label>
      <input id={name} name={name} type="number" min={min} max={max} defaultValue={value} className="field" />
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </div>
  );
}

export function SettingsForm({ settings: s }: { settings: Settings }) {
  const [state, action] = useActionState(saveSettingsAction, undefined);
  return (
    <form action={action} className="space-y-6">
      <section className="card space-y-4 p-5">
        <h2 className="text-sm font-semibold">Pipeline</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Num name="manufacturingPerAssociate" label="Default Manufacturing leads per associate, per day" value={s.manufacturingPerAssociate} min={0} max={100} hint="Only for an associate without their own daily list: each person's own numbers are set on the Team page (Anchal and Puja 40 Manufacturing; Parimal and Anuradha 24 Manufacturing + 16 3PL). Handed out every working morning at 8:00 am, at random from the researched list." />
          <Num name="logisticsPerAssociate" label="Default 3PL & Logistics leads per associate, per day" value={s.logisticsPerAssociate} min={0} max={100} hint="The same for 3PL & Logistics. A segment that runs short is never filled from the other segment or from CA firms." />
          <Num name="prospectsPerRun" label="New prospects per search" value={s.prospectsPerRun} min={1} max={50} hint="The fewest new companies Find new prospects adds, split across Manufacturing and 3PL. The 6 am run finds what the morning draw is short of instead." />
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="radarEnabled" defaultChecked={s.radarEnabled} className="mt-1" />
            <span>
              New facility radar
              <span className="block text-xs text-muted">
                Scans the news for new plants, warehouses and facilities in your segments (twice a day at most) and shows them on the dashboard to add as leads.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="morningSearch" defaultChecked={s.morningSearch} className="mt-1" />
            <span>
              Find new prospects on the 6 am run
              <span className="block text-xs text-muted">
                Every working day (not holidays), as many as the 8 am draw is short of in each segment: people with the ICP&apos;s P1 and P2 titles on LinkedIn first, then their companies, then the ICP check. CA firms come from their sheet and are never searched for.
              </span>
            </span>
          </label>
        </div>
      </section>

      <section className="card space-y-4 p-5">
        <h2 className="text-sm font-semibold">AI model</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="aiProvider" className="label">Provider</label>
            <select id="aiProvider" name="aiProvider" defaultValue={s.aiProvider} className="field">
              <option value="deepseek">DeepSeek</option>
              <option value="anthropic">Claude (Anthropic)</option>
            </select>
          </div>
          <div>
            <label htmlFor="aiModel" className="label">Model</label>
            <input id="aiModel" name="aiModel" defaultValue={s.aiModel} className="field" />
          </div>
          <div>
            <label htmlFor="aiEffort" className="label">Effort (Claude only)</label>
            <select id="aiEffort" name="aiEffort" defaultValue={s.aiEffort} className="field">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
        </div>
        <p className="text-xs text-muted">
          Switching provider also switches the model to that provider&apos;s default (deepseek-chat or claude-opus-5). Claude guarantees the answer format; DeepSeek is cheaper.
        </p>
      </section>

      <section className="card space-y-4 p-5">
        <h2 className="text-sm font-semibold">Outreach drafts</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="senderName" className="label">Sender name</label>
            <input id="senderName" name="senderName" defaultValue={s.senderName} className="field" />
          </div>
          <div>
            <label htmlFor="senderTitle" className="label">Sender title</label>
            <input id="senderTitle" name="senderTitle" defaultValue={s.senderTitle} className="field" />
          </div>
          <div>
            <label htmlFor="senderCompany" className="label">Company</label>
            <input id="senderCompany" name="senderCompany" defaultValue={s.senderCompany} className="field" />
          </div>
        </div>
        <div>
          <label htmlFor="demoLink" className="label">Demo booking link</label>
          <input id="demoLink" name="demoLink" defaultValue={s.demoLink} placeholder="https://calendly.com/…" className="field" />
          <p className="mt-1 text-xs text-muted">Leave empty to ask for a convenient time instead.</p>
        </div>
        <div>
          <label htmlFor="productDescription" className="label">What INVECK sells</label>
          <textarea id="productDescription" name="productDescription" defaultValue={s.productDescription} rows={6} className="field" />
          <p className="mt-1 text-xs text-muted">The AI only claims what&apos;s written here, so keep it accurate.</p>
        </div>
      </section>

      <section className="card space-y-4 p-5">
        <h2 className="text-sm font-semibold">WhatsApp template</h2>
        <p className="text-xs text-muted">
          The first message from INVECK&apos;s WhatsApp number to someone who agreed has to be a template Meta approved. Create it in Meta&apos;s WhatsApp Manager, then copy it here exactly as approved.
          In its text, {'{{1}}'} is the contact&apos;s first name, {'{{2}}'} the sender&apos;s name and {'{{3}}'} the company.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <label htmlFor="waTemplateName" className="label">Template name</label>
            <input id="waTemplateName" name="waTemplateName" defaultValue={s.waTemplateName} placeholder="inveck_details" className="field" />
          </div>
          <div>
            <label htmlFor="waTemplateLanguage" className="label">Language code</label>
            <input id="waTemplateLanguage" name="waTemplateLanguage" defaultValue={s.waTemplateLanguage} placeholder="en" className="field" />
          </div>
        </div>
        <div>
          <label htmlFor="waTemplateText" className="label">Template text (the body, as approved)</label>
          <textarea
            id="waTemplateText"
            name="waTemplateText"
            defaultValue={s.waTemplateText}
            rows={5}
            placeholder="Hi {{1}}, this is {{2}} from INVECK, following up on our call. …"
            className="field"
          />
          <p className="mt-1 text-xs text-muted">Shown to the team before sending, and used to fill in the template. Leave the name empty to send nothing from INVECK&apos;s number.</p>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <SubmitButton pendingText="Saving…">Save settings</SubmitButton>
        {state && <p className={`text-sm ${state.ok ? 'text-good-ink' : 'text-critical-ink'}`} role="status">{state.message}</p>}
      </div>
    </form>
  );
}
