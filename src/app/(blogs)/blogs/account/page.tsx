import { PageHeader } from '@/components/blogs/ui';
import { blogsPage } from '@/lib/access';
import { PasswordForm } from '@/app/(app)/account/password-form';

export default async function BlogsAccount() {
  const me = await blogsPage();
  return (
    <>
      <PageHeader title="Account" description={me.id ? `Logged in as ${me.name} (${me.username}).` : 'Logged in as the administrator.'} />
      {me.id ? <PasswordForm /> : <p className="max-w-md text-sm text-ink-2">The administrator password is the APP_PASSWORD setting on the server. Change it there.</p>}
    </>
  );
}
