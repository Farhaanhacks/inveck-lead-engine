import { getDb } from '@/lib/db';
import { getCurrentUser, listBdas } from '@/lib/users';
import { PageHeader } from '@/components/page-header';
import { PasswordForm } from './password-form';
import { resetPasswordAction } from '../../team-actions';

export default async function AccountPage() {
  const me = (await getCurrentUser())!;
  const team = me.role === 'admin' ? await listBdas(await getDb()) : [];
  return (
    <>
      <PageHeader title="Account" description={me.id ? `Logged in as ${me.name} (${me.username}).` : 'Logged in as the administrator.'} />
      {me.id ? (
        <PasswordForm />
      ) : (
        <p className="mb-6 max-w-md text-sm text-ink-2">The administrator password is the APP_PASSWORD setting on the server. Change it there.</p>
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
