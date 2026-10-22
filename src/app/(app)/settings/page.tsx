import { getDb, databaseUrl } from '@/lib/db';
import { apiKeys, getSettings } from '@/lib/settings';
import { PageHeader } from '@/components/page-header';
import { SettingsForm } from './settings-form';
import { adminPage } from '@/lib/access';
import { getHolidays } from '@/lib/holidays';
import { googleCredentials } from '@/lib/google-sheet';
import { addHolidayAction, removeHolidayAction } from '@/app/actions';
import { formatDate } from '@/lib/dates';
import { istDay } from '@/lib/tasks';
import { lastSyncReport, rotationView, INBOUND_SHEET_ID, INBOUND_SHEET_TAB } from '@/lib/inbound-demo';
import { syncInboundDemosAction } from '@/app/inbound-demo-actions';

export default async function SettingsPage() {
  await adminPage();
  const db = await getDb();
  const settings = await getSettings(db);
  const keys = apiKeys();
  const url = databaseUrl();
  const holidays = [...(await getHolidays(db))].sort();
  const demoSync = await lastSyncReport(db);
  const rotation = await rotationView(db);
  const status = [
    { name: 'DEEPSEEK_API_KEY', ok: !!keys.deepseek, use: 'AI (DeepSeek)', needed: settings.aiProvider === 'deepseek' },
    { name: 'ANTHROPIC_API_KEY', ok: !!keys.anthropic, use: 'AI (Claude)', needed: settings.aiProvider === 'anthropic' },
    { name: 'SERPER_API_KEY', ok: !!keys.serper, use: 'Google search: LinkedIn profiles & prospects', needed: true },
    { name: 'GOOGLE_SERVICE_ACCOUNT_JSON', ok: !!googleCredentials(), use: 'CA firms: the service-account key (whole JSON file) that reads the master Google Sheet; read-only', needed: false },
    { name: 'INBOUND_DEMO_SHEET_ID', ok: !!process.env.INBOUND_DEMO_SHEET_ID, use: `Optional: the inbound demo sheet's ID (defaults to the website form's sheet); tab name in INBOUND_DEMO_SHEET_TAB (default Leads)`, needed: false },
    { name: 'JINA_API_KEY', ok: !!keys.jina, use: 'Optional: higher limits for reading JavaScript-heavy websites', needed: false },
    { name: 'APP_PASSWORD', ok: !!process.env.APP_PASSWORD, use: 'Team login', needed: true },
    { name: 'CRON_SECRET', ok: !!process.env.CRON_SECRET, use: 'Scheduled runs on Vercel', needed: !!process.env.VERCEL },
    { name: 'MICROSOFT_CLIENT_ID', ok: !!process.env.MICROSOFT_CLIENT_ID, use: "Optional: Send mail from Outlook (the Entra app's client ID)", needed: false },
    { name: 'MICROSOFT_TENANT_ID', ok: !!process.env.MICROSOFT_TENANT_ID, use: "Optional: Outlook, INVECK's directory (tenant) ID", needed: false },
    { name: 'MICROSOFT_CLIENT_SECRET', ok: !!process.env.MICROSOFT_CLIENT_SECRET, use: "Optional: Outlook, the Entra app's client secret (it expires: renew it in Entra)", needed: false },
    { name: 'MICROSOFT_REDIRECT_URI', ok: !!process.env.MICROSOFT_REDIRECT_URI, use: 'Optional: Outlook, the sign-in return address, exactly as registered in Entra (https://inveck-lead-engine.vercel.app/api/auth/microsoft/callback)', needed: false },
    { name: 'MICROSOFT_TOKEN_ENCRYPTION_KEY', ok: (process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY ?? '').length >= 32, use: 'Optional: Outlook, a random string of 32+ characters; saved connections are encrypted with it', needed: false },
    { name: 'WHATSAPP_PHONE_NUMBER_ID', ok: !!process.env.WHATSAPP_PHONE_NUMBER_ID, use: "Optional: WhatsApp from INVECK's number (Meta's phone number ID)", needed: false },
    { name: 'WHATSAPP_TOKEN', ok: !!process.env.WHATSAPP_TOKEN, use: 'Optional: WhatsApp, a permanent System User token', needed: false },
    { name: 'WHATSAPP_APP_SECRET', ok: !!process.env.WHATSAPP_APP_SECRET, use: "Optional: WhatsApp, checks replies come from Meta (the app's secret)", needed: false },
    { name: 'WHATSAPP_VERIFY_TOKEN', ok: !!process.env.WHATSAPP_VERIFY_TOKEN, use: "Optional: WhatsApp, any random string, also typed into Meta's webhook setup", needed: false },
  ];

  return (
    <>
      <PageHeader title="Settings" description="How the pipeline runs and what the drafts say." />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SettingsForm settings={settings} />
        </div>
        <div className="space-y-6">
          <section className="card p-5">
            <h2 className="text-sm font-semibold">API keys</h2>
            <p className="mb-3 text-xs text-muted">Set as environment variables on the server (Vercel → Settings → Environment Variables), never in the app.</p>
            <ul className="space-y-2 text-sm">
              {status.map((k) => (
                <li key={k.name} className="flex items-start gap-2">
                  <span
                    className={`mt-0.5 inline-flex h-5 shrink-0 items-center rounded px-1.5 text-[11px] font-medium ${
                      k.ok ? 'bg-good-soft text-good-ink' : k.needed ? 'bg-critical-soft text-critical-ink' : 'bg-neutral-soft text-ink-2'
                    }`}
                  >
                    {k.ok ? 'Set' : k.needed ? 'Missing' : 'Not set'}
                  </span>
                  <span>
                    <code className="text-xs">{k.name}</code>
                    <span className="block text-xs text-muted">{k.use}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="card p-5">
            <h2 className="text-sm font-semibold">Inbound demo sheet</h2>
            <p className="mb-3 text-xs text-muted">
              Demo requests from the website form (sheet <code>{process.env.INBOUND_DEMO_SHEET_ID?.trim() || INBOUND_SHEET_ID}</code>, tab <code>{process.env.INBOUND_DEMO_SHEET_TAB?.trim() || INBOUND_SHEET_TAB}</code>), read-only with the CA sheet&apos;s service account. New rows go to Pooja, Anshul, Anuradha and Parimal in turn.
            </p>
            <form action={syncInboundDemosAction}><button className="btn-secondary">Sync now</button></form>
            <p className="mt-3 text-sm">Next request goes to <span className="font-semibold">{rotation.next.name}</span>{rotation.next.user ? (rotation.next.user !== rotation.next.name ? ` (${rotation.next.user})` : '') : <span className="text-warning-ink"> (no matching user yet)</span>}.</p>
            {rotation.recent.length > 0 && (
              <div className="mt-2 text-xs">
                <div className="font-medium text-ink-2">Latest requests and who got them</div>
                <ul className="mt-1 divide-y divide-line">
                  {rotation.recent.map((r, i) => (
                    <li key={i} className="py-1.5">
                      <span className="font-medium">{r.who}</span>{r.company ? `, ${r.company}` : ''} → <span className="font-medium">{r.bda}</span>
                      <span className="text-muted"> · {formatDate(r.when)} · {r.state === 'meeting' ? 'Teams meeting booked' : r.state === 'blocked' ? 'waiting for the user' : 'imported'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {demoSync ? (
              <div className="mt-3 space-y-2 text-xs">
                <p className="text-muted">Last sync {formatDate(new Date(demoSync.at))}: {demoSync.read} rows read, {demoSync.created} new leads, {demoSync.meetings} Teams meetings, {demoSync.merged} repeat submissions.</p>
                {demoSync.error && <p className="text-critical-ink">{demoSync.error}</p>}
                {demoSync.mismatches.map((m) => <p key={m.rotationName} className="text-warning-ink"><span className="font-medium">{m.rotationName}:</span> {m.problem}</p>)}
                {demoSync.blocked.length > 0 && (
                  <div><div className="font-medium text-warning-ink">Waiting ({demoSync.blocked.length})</div><ul className="list-disc pl-4 text-ink-2">{demoSync.blocked.map((b) => <li key={b.row}>Row {b.row}, {b.who}: {b.reason}</li>)}</ul></div>
                )}
                {demoSync.noMeeting.length > 0 && (
                  <div><div className="font-medium text-warning-ink">No Teams meeting yet ({demoSync.noMeeting.length})</div><ul className="list-disc pl-4 text-ink-2">{demoSync.noMeeting.map((b) => <li key={`${b.row}-${b.who}`}>Row {b.row}, {b.who} ({b.company}): {b.reason}</li>)}</ul></div>
                )}
                {demoSync.skipped.length > 0 && (
                  <div><div className="font-medium text-ink-2">Not imported ({demoSync.skipped.length})</div><ul className="list-disc pl-4 text-ink-2">{demoSync.skipped.map((b) => <li key={`${b.row}-${b.who}`}>Row {b.row}, {b.who}: {b.reason}</li>)}</ul></div>
                )}
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted">Not synced yet.</p>
            )}
          </section>
          <section className="card p-5">
            <h2 className="text-sm font-semibold">Holidays</h2>
            <p className="mb-3 text-xs text-muted">A holiday is treated like a weekend: follow-ups never fall on it, and the ones already planned move to the next working day.</p>
            <form action={addHolidayAction} className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <label htmlFor="holiday-day" className="label">Date</label>
                <input id="holiday-day" name="day" type="date" required min={istDay()} className="field" />
              </div>
              <button className="btn-primary">Mark as holiday</button>
            </form>
            {holidays.length > 0 ? (
              <ul className="mt-3 divide-y divide-line text-sm">
                {holidays.map((d) => (
                  <li key={d} className="flex items-center justify-between gap-2 py-1.5">
                    <span>{formatDate(new Date(`${d}T12:00:00+05:30`))}</span>
                    <form action={removeHolidayAction}>
                      <input type="hidden" name="day" value={d} />
                      <button className="text-xs text-muted hover:text-ink hover:underline">Remove</button>
                    </form>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-muted">No holidays marked.</p>
            )}
          </section>
          <section className="card p-5 text-sm text-ink-2">
            <h2 className="mb-2 text-sm font-semibold text-ink">Schedule & database</h2>
            <p>Runs start automatically every weekday at 6:00 am IST (Vercel Cron), and search for new prospects on the day set here. At 8:00 am the day’s leads are drawn at random from the researched list and split evenly across the team.</p>
            <p className="mt-2 text-xs text-muted">
              Database: {url && !url.startsWith('memory://') && !url.startsWith('pglite://') ? 'Postgres' : 'local embedded database (development only)'}
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
