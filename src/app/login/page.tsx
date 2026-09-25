import { LoginForm } from './login-form';
import { Logo } from '@/components/logo';

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const next = (await searchParams).next;
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="card w-full max-w-sm p-6">
        <div className="mb-6">
          <Logo className="h-10 w-auto text-ink" />
          <div className="mt-2 text-sm font-medium text-ink-2">Lead Engine</div>
          <p className="mt-3 text-sm text-ink-2">Enter the team password to continue.</p>
        </div>
        <LoginForm next={typeof next === 'string' ? next : '/'} />
      </div>
    </div>
  );
}
