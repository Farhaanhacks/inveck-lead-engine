/** Shown at once while a page loads, so a click never looks like it did nothing. */
export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <div className="h-1 w-full overflow-hidden rounded-full bg-surface-2">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
      </div>
      <p className="text-sm text-muted">Loading…</p>
      <div className="grid gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card h-20 animate-pulse bg-surface-2" />
        ))}
      </div>
      <div className="card h-64 animate-pulse bg-surface-2" />
    </div>
  );
}
