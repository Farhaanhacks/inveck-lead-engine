'use client';
import { useActionState } from 'react';
import type { Settings } from '@/lib/settings';
import { saveSettingsAction } from '../../actions';
import { SubmitButton } from '@/components/submit-button';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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
          <Num name="leadsPerMorning" label="Leads handed out each morning" value={s.leadsPerMorning} min={0} max={500} hint="Drawn at random from the researched list by 8:00 am India time on working days and split evenly across the team. 0 stops the draw." />
          <Num name="prospectsPerRun" label="New prospects per search" value={s.prospectsPerRun} min={1} max={50} hint="How many companies the prospect search adds at most." />
          <Num name="maxEmailGuesses" label="Email formats to try" value={s.maxEmailGuesses} min={0} max={6} hint="When the company's format is unknown and Apollo has nothing. Each try uses one mail-server check (Hunter verification); only confirmed addresses are kept, labelled inferred." />
          <Num name="emailLookupsPerCompany" label="Email lookups per company (Prospeo, Apollo)" value={s.emailLookupsPerCompany} min={0} max={10} hint="Paid lookups: the main contact first, then the best-ranked others. Prospeo is asked first, Apollo when Prospeo has nothing. Emails only: phone numbers are never requested. Earlier results are reused at no cost. 0 switches both off." />
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="useCompanyFormat" defaultChecked={s.useCompanyFormat} className="mt-1" />
            <span>
              Use the company&apos;s known email format when its mail server can&apos;t confirm addresses
              <span className="block text-xs text-muted">
                Saves first.last@company.com, labelled inferred, when the company&apos;s format is proven (published email-format data or the company&apos;s own published addresses) and neither a published address nor Apollo gave one. Plain guesses are never saved.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="radarEnabled" defaultChecked={s.radarEnabled} className="mt-1" />
            <span>
              New facility radar
              <span className="block text-xs text-muted">
                Scans the news for new plants, warehouses and facilities in your segments (twice a day at most) and shows them on the dashboard to add as leads.
              </span>
            </span>
          </label>
          <div>
            <label htmlFor="prospectDay" className="label">Prospect search on scheduled runs</label>
            <select id="prospectDay" name="prospectDay" defaultValue={s.prospectDay} className="field">
              <option value={-1}>Never (manual only)</option>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>Every {d}</option>
              ))}
            </select>
          </div>
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

      <div className="flex items-center gap-3">
        <SubmitButton pendingText="Saving…">Save settings</SubmitButton>
        {state && <p className={`text-sm ${state.ok ? 'text-good-ink' : 'text-critical-ink'}`} role="status">{state.message}</p>}
      </div>
    </form>
  );
}
