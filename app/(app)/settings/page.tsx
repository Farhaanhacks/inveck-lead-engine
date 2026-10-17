import { getDb, databaseUrl } from '@/lib/db';
import { apiKeys, getSettings } from '@/lib/settings';
import { PageHeader } from '@/components/page-header';
import { SettingsForm } from './settings-form';
import { adminPage } from '@/lib/access';

export default async function SettingsPage() {
  await adminPage();
  const db = await getDb();
  const settings = await getSettings(db);
  const keys = apiKeys();
  const url = databaseUrl();
  const status = [
    { name: 'DEEPSEEK_API_KEY', ok: !!keys.deepseek, use: 'AI (DeepSeek)', needed: settings.aiProvider === 'deepseek' },
    { name: 'ANTHROPIC_API_KEY', ok: !!keys.anthropic, use: 'AI (Claude)', needed: settings.aiProvider === 'anthropic' },
    { name: 'SERPER_API_KEY', ok: !!keys.serper, use: 'Google search: LinkedIn profiles & prospects', needed: true },
    { name: 'JINA_API_KEY', ok: !!keys.jina, use: 'Optional: higher limits for reading JavaScript-heavy websites', needed: false },
    { name: 'APP_PASSWORD', ok: !!process.env.APP_PASSWORD, use: 'Team login', needed: true },
    { name: 'CRON_SECRET', ok: !!process.env.CRON_SECRET, use: 'Scheduled runs on Vercel', needed: !!process.env.VERCEL },
    { name: 'MS_CLIENT_ID', ok: !!process.env.MS_CLIENT_ID, use: 'Optional: Send mail from Outlook (the Entra app\'s client ID)', needed: false },
    { name: 'MS_CLIENT_SECRET', ok: !!process.env.MS_CLIENT_SECRET, use: 'Optional: Outlook, the Entra app\'s client secret (it expires: renew it in Entra)', needed: false },
    { name: 'MS_TENANT_ID', ok: !!process.env.MS_TENANT_ID, use: "Optional: Outlook, INVECK's directory (tenant) ID", needed: false },
    { name: 'MAIL_TOKEN_KEY', ok: !!process.env.MAIL_TOKEN_KEY, use: 'Optional: Outlook, any long random string; saved connections are encrypted with it', needed: false },
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
