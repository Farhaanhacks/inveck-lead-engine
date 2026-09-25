import { asc } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { clients, icps, type Icp } from '@/lib/db/schema';
import { PageHeader } from '@/components/page-header';
import { SubmitButton } from '@/components/submit-button';
import { deleteIcpAction, saveIcpAction } from '../../actions';
import { ClientsGrid } from './clients-grid';

const ICP_FIELDS: { name: keyof Icp; label: string; rows?: number; hint?: string }[] = [
  { name: 'description', label: 'Description', rows: 2 },
  { name: 'industries', label: 'Industries', rows: 2 },
  { name: 'companySize', label: 'Company size' },
  { name: 'geography', label: 'Geography' },
  { name: 'mustHaves', label: 'Must-haves', rows: 2, hint: 'Hard requirements; a company missing one is disqualified.' },
  { name: 'dealBreakers', label: 'Deal-breakers', rows: 2, hint: 'Any of these disqualifies a company.' },
  { name: 'targetTitles', label: 'Target job titles', rows: 2, hint: 'Comma separated, most important first.' },
  { name: 'pitchAngle', label: 'Pitch angle', rows: 3, hint: 'The problem INVECK solves for this segment; shapes the drafts.' },
];

function IcpForm({ icp }: { icp?: Icp }) {
  return (
    <form action={saveIcpAction} className="space-y-3">
      <input type="hidden" name="id" value={icp?.id ?? ''} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <label className="label" htmlFor={`segment-${icp?.id ?? 'new'}`}>Segment name</label>
          <input id={`segment-${icp?.id ?? 'new'}`} name="segment" defaultValue={icp?.segment} required className="field" />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={icp?.active ?? true} /> Active
        </label>
      </div>
      {ICP_FIELDS.map((f) => (
        <div key={f.name}>
          <label className="label" htmlFor={`${f.name}-${icp?.id ?? 'new'}`}>{f.label}</label>
          {f.rows ? (
            <textarea id={`${f.name}-${icp?.id ?? 'new'}`} name={f.name} defaultValue={icp ? String(icp[f.name] ?? '') : ''} rows={f.rows} className="field" />
          ) : (
            <input id={`${f.name}-${icp?.id ?? 'new'}`} name={f.name} defaultValue={icp ? String(icp[f.name] ?? '') : ''} className="field" />
          )}
          {f.hint && <p className="mt-1 text-xs text-muted">{f.hint}</p>}
        </div>
      ))}
      <div className="flex gap-2">
        <SubmitButton pendingText="Saving…">{icp ? 'Save ICP' : 'Add ICP'}</SubmitButton>
        {icp && (
          <button formAction={deleteIcpAction} className="btn-danger">Delete</button>
        )}
      </div>
    </form>
  );
}

export default async function TargetsPage() {
  const db = await getDb();
  const [icpList, clientList] = await Promise.all([
    db.select().from(icps).orderBy(asc(icps.id)),
    db.select().from(clients).orderBy(asc(clients.id)),
  ]);

  return (
    <>
      <PageHeader
        title="ICPs & clients"
        description="Who INVECK sells to. The AI qualifies every company against these profiles, and the prospect search looks for companies like your clients."
      />

      <h2 className="mb-3 text-sm font-semibold">Ideal customer profiles</h2>
      <div className="space-y-3">
        {icpList.map((icp) => (
          <details key={icp.id} className="card p-5">
            <summary className="flex cursor-pointer items-center justify-between gap-3">
              <span className="font-medium">{icp.segment}</span>
              <span className="text-xs text-muted">{icp.active ? 'Active' : 'Off'}</span>
            </summary>
            <div className="mt-4">
              <IcpForm icp={icp} />
            </div>
          </details>
        ))}
        <details className="card p-5">
          <summary className="cursor-pointer text-sm text-accent">+ Add an ICP</summary>
          <div className="mt-4">
            <IcpForm />
          </div>
        </details>
      </div>

      <h2 id="clients" className="mt-10 mb-1 scroll-mt-6 text-sm font-semibold">Current clients</h2>
      <p className="mb-3 text-sm text-ink-2">
        Clients are never researched or contacted, and the prospect search finds companies like them. Leads marked Won are added here automatically.
      </p>
      <ClientsGrid clients={clientList} />
    </>
  );
}
