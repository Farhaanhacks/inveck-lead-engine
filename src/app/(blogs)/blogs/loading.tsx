export default function Loading() {
  return (
    <div role="status" aria-label="Loading" className="animate-pulse space-y-4">
      <div className="h-8 w-56 rounded-lg bg-subtle" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-20 rounded-[var(--radius)] bg-subtle" />)}
      </div>
      <div className="h-48 rounded-[var(--radius)] bg-subtle" />
    </div>
  );
}
