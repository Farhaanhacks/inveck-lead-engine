import { getDb } from '@/lib/db';
import { getCurrentUser, listBdas } from '@/lib/users';
import { PageHeader } from '@/components/page-header';
import { PasswordForm } from './password-form';
import { resetPasswordAction } from '../../team-actions';
import { disconnectMailboxAction } from '../../mail-actions';
import { getMailbox, mailConfig } from '@/lib/mail/outlook';
import { formatDate } from '@/lib/dates';

/** What came back from connecting Outlook. */
const MAIL_NOTICE: Record<string, { text: string; good?: boolean }> = {
  connected: { text: 'Outlook is connected. Send mail on Today now sends from your mailbox.', good: true },
  declined: { text: "Outlook wasn't connected: the Microsoft sign-in was cancelled or not allowed." },
  expired: { text: 'That sign-in took too long or came from another browser. Try Connect Outlook again.' },
  failed: { text: "Outlook couldn't be connected. Try again; if it keeps failing, your Microsoft 365 administrator may need to allow the app." },
  'not-set-up': { text: "Sending from Outlook isn't set up on the server yet." },
  'needs-login': { text: 'Log in with your own account to connect your Outlook.' },
};

export default async function AccountPage({ searchParams }: PageProps<'/account'>) {
  const me = (await getCurrentUser())!;
  const db = await getDb();
  const team = me.role === 'admin' ? await listBdas(db) : [];
  const mailReady = !!mailConfig();
  const mailbox = me.id ? await getMailbox(db, me.id) : null;
  const sp = await searchParams;
  const notice = typeof sp.mail === 'string' ? MAIL_NOTICE[sp.mail] : undefined;
  // Microsoft's reason, for a sign-in that was refused or failed.
  const why = notice && (sp.mail === 'declined' || sp.mail === 'failed') && typeof sp.why === 'string' ? sp.why.slice(0, 300) : '';
  return (
    <>
      <PageHeader title="Account" description={me.id ? `Logged in as ${me.name} (${me.username}).` : 'Logged in as the administrator.'} />
      {me.id ? (
        <PasswordForm />
      ) : (
        <p className="mb-6 max-w-md text-sm text-ink-2">The administrator password is the APP_PASSWORD setting on the server. Change it there.</p>
      )}
      {me.id > 0 && (
        <section className="card mt-6 max-w-md space-y-3 p-5">
          <h2 className="text-sm font-semibold">Outlook</h2>
          {notice && <p role="status" className={`text-xs ${notice.good ? 'text-good-ink' : 'text-warning-ink'}`}>{notice.text}</p>}
          {why && <p className="text-xs text-muted">Microsoft said: {why}</p>}
          {!mailReady ? (
            <p className="text-xs text-muted">Sending from Outlook isn&apos;t set up yet. An administrator adds INVECK&apos;s Microsoft app details to the server first (see the README).</p>
          ) : mailbox ? (
            <>
              <p className="text-sm">
                Connected: <span className="font-medium">{mailbox.address}</span>
                <span className="text-muted">, since {formatDate(mailbox.connectedAt)}</span>
              </p>
              <p className="text-xs text-muted">Send mail on Today sends from this mailbox; sent emails show in its Sent Items, and replies come to its inbox.</p>
              {mailbox.lastError && <p className="text-xs text-warning-ink">{mailbox.lastError}</p>}
              <div className="flex gap-2">
                {mailbox.lastError && <a href="/api/mail/connect" className="btn-primary">Connect again</a>}
                <form action={disconnectMailboxAction}>
                  <button className="btn-secondary">Disconnect</button>
                </form>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-muted">Connect your INVECK Outlook once, and Send mail on Today sends emails from your own mailbox.</p>
              <a href="/api/mail/connect" className="btn-primary">Connect Outlook</a>
            </>
          )}
        </section>
      )}
      {me.role === 'admin' && team.length > 0 && (
        <section className="card mt-6 max-w-md space-y-3 p-5">
          <h2 className="text-sm font-semibold">Reset a team member&apos;s password</h2>
          <p className="text-xs text-muted">Puts them back on the starting password. They are asked to change it.</p>
          <form action={resetPasswordAction} className="flex gap-2">
            <label htmlFor="userId" className="sr-only">Team member</label>
            <select id="userId" name="userId" className="field">
              {team.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.username})</option>)}
            </select>
            <button className="btn-secondary">Reset</button>
          </form>
        </section>
      )}
    </>
  );
}
