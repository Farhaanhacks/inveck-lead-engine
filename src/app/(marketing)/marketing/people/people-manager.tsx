'use client';
import { useState, useTransition } from 'react';
import { addPersonAction, removePersonAction, renamePersonAction } from '@/app/marketing-actions';
import type { PersonView } from '@/lib/content-meta';

export function PeopleManager({ initial }: { initial: PersonView[] }) {
  const [people, setPeople] = useState(initial);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, start] = useTransition();
  const sorted = [...people].sort((a, b) => a.name.localeCompare(b.name));

  const add = () => {
    setError('');
    start(async () => {
      const r = await addPersonAction(name);
      if (r.ok) {
        setPeople((p) => [...p, r.person]);
        setName('');
      } else setError(r.error);
    });
  };
  const rename = () => {
    if (!editing) return;
    setError('');
    start(async () => {
      const r = await renamePersonAction(editing.id, editing.name);
      if (r.ok) {
        setPeople((p) => p.map((x) => (x.id === r.person.id ? r.person : x)));
        setEditing(null);
      } else setError(r.error);
    });
  };
  const remove = (p: PersonView) => {
    if (!window.confirm(`Remove ${p.name}? Content assigned to them stays, with nobody assigned.`)) return;
    setError('');
    start(async () => {
      const r = await removePersonAction(p.id);
      if (r.ok) setPeople((all) => all.filter((x) => x.id !== p.id));
    });
  };

  return (
    <div className="max-w-xl space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
        className="glass flex gap-2 rounded-2xl p-3"
      >
        <label htmlFor="person-name" className="sr-only">Name</label>
        <input id="person-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Add a person, e.g. Priya Nair" className="field flex-1" />
        <button className="btn-primary" disabled={busy || !name.trim()}>Add</button>
      </form>
      {error && <p role="alert" className="text-sm text-critical-ink">{error}</p>}
      <ul className="glass divide-y divide-line/60 rounded-2xl">
        {sorted.length === 0 && <li className="p-4 text-sm text-muted">Nobody yet. Add the people content can be assigned to.</li>}
        {sorted.map((p) => (
          <li key={p.id} className="flex items-center gap-2 p-3">
            {editing?.id === p.id ? (
              <form
                className="flex flex-1 gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  rename();
                }}
              >
                <label htmlFor={`rename-${p.id}`} className="sr-only">Name</label>
                <input id={`rename-${p.id}`} autoFocus value={editing.name} onChange={(e) => setEditing({ id: p.id, name: e.target.value })} maxLength={80} className="field flex-1" />
                <button className="btn-primary" disabled={busy}>Save</button>
                <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
              </form>
            ) : (
              <>
                <span className="flex-1 text-sm font-medium">{p.name}</span>
                <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setEditing({ id: p.id, name: p.name })}>Rename</button>
                <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => remove(p)} disabled={busy}>Remove</button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
