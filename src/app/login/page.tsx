import { LoginForm } from './login-form';

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const next = (await searchParams).next;
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="card w-full max-w-sm p-6">
        <div className="mb-6">
          <div className="text-lg font-semibold tracking-tight">INVECK Lead Engine</div>
          <p className="mt-1 text-sm text-ink-2">Enter the team password to continue.</p>
        </div>
        <LoginForm next={typeof next === 'string' ? next : '/'} />
      </div>
    </div>
  );
}
