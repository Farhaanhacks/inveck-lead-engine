'use client';

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="card border-danger/50 px-5 py-6">
      <h1 className="text-base font-semibold text-danger">This page could not load</h1>
      <p className="mt-1 text-sm text-muted">The error was recorded. {error.digest ? `Reference: ${error.digest}` : ''}</p>
      <button className="btn mt-4" onClick={reset}>Try again</button>
    </div>
  );
}
