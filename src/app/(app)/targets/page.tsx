import { asc, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { clients, icps, knownCompanies, type Icp } from '@/lib/db/schema';
import { PageHeader } from '@/components/page-header';
import { SubmitButton } from '@/components/submit-button';
import { deleteIcpAction, saveIcpAction } from '../../actions';
import { ClientsGrid } from './clients-grid';
import { KnownCompanies } from './known-companies';
import { adminPage } from '@/lib/access';
import { icpCriteria, KIND_LABEL } from '@/lib/pipeline/fit';

const ICP_FIELDS: { name: keyof Icp; label: string; rows?: number; hint?: string }[] = [
  { name: 'description', label: 'Description', rows: 2 },
  { name: 'industries', label: 'Industries', rows: 2, hint: 'A target: a company shown to be in another industry goes to review, never ruled out by this alone.' },
  { name: 'companySize', label: 'Company size', hint: 'A target: a company shown to be clearly smaller goes to review; unknown size is only noted.' },
  { name: 'geography', label: 'Geography', hint: 'A target: a company shown to be elsewhere goes to review.' },
  {
    name: 'mustHaves',
    label: 'Must-haves',
    rows: 2,
    hint: 'One per line or separated by semicolons. A company is ruled out only when a source shows it fails one; one that can\'t be confirmed goes to review. Write "is a plus" in an item to make it optional.',
  },
  {
    name: 'dealBreakers',
    label: 'Deal-breakers',
    rows: 2,
    hint: 'One per line or separated by semicolons. Rules a company out only when a source shows it applies. Commercial risk (insolvency, liquidation) is recorded separately and rules a company out only when named here.',
  },
  { name: 'targetTitles', label: 'P1: primary decision-makers', rows: 2, hint: 'Comma separated, most important first. Approached first.' },
  { name: 'p2Titles', label: 'P2: process owners', rows: 2, hint: 'Approached when nobody at P1 can be found or reached.' },
  { name: 'p3Titles', label: 'P3: process-level contacts', rows: 2, hint: 'The last resort.' },
  { name: 'avoidTitles', label: 'Do not prioritise', rows: 1, hint: 'Functions never picked as the main contact, e.g. HR, Admin, Quality Assurance.' },
  { name: 'pitchAngle', label: 'Pitch angle', rows: 3, hint: 'The problem INVECK solves for this segment; shapes the drafts.' },
];

/** How the ICP's settings are read when a company is checked: each item a criterion with its id. */
function CriteriaList({ icp }: { icp: Icp }) {
  const criteria = icpCriteria(icp);
  if (!criteria.length) return null;
  return (
    <div className="mb-4 rounded-md border border-line bg-surface-2 p-3">
      <p className="mb-2 text-xs font-medium text-ink-2">How companies are checked against this ICP</p>
      <ul className="space-y-1 text-xs text-ink-2">
        {criteria.map((c) => (
          <li key={c.id} className="flex gap-2">
            <span className="w-36 shrink-0 text-muted">{c.id} · {KIND_LABEL[c.kind]}</span>
            <span className="min-w-0 break-words">{c.text}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">
        Ruled out only by a must-have shown not met or a deal-breaker shown to apply, each with a quote from a source. Anything unconfirmed goes to Needs review.
      </p>
    </div>
  );
}

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

export default async function TargetsPage({ searchParams }: PageProps<'/targets'>) {
  await adminPage();
  const sp = await searchParams;
  const icpError = typeof sp.icpError === 'string' ? sp.icpError.slice(0, 300) : '';
  const db = await getDb();
  const [icpList, clientList, [{ knownCount }], knownSample] = await Promise.all([
    db.select().from(icps).orderBy(asc(icps.id)),
    db.select().from(clients).orderBy(asc(clients.id)),
    db.select({ knownCount: sql<number>`count(*)::int` }).from(knownCompanies),
    db.select({ company: knownCompanies.company }).from(knownCompanies).orderBy(asc(knownCompanies.id)).limit(8),
  ]);

  return (
    <>
      <PageHeader
        title="ICPs & clients"
        description="Who INVECK sells to. The AI qualifies every company against these profiles, and the prospect search looks for companies like your clients."
      />

      <h2 className="mb-3 text-sm font-semibold">Ideal customer profiles</h2>
      {icpError && (
        <div className="mb-3 rounded-lg border border-line bg-critical-soft px-4 py-3 text-sm text-critical-ink" role="alert">
          {icpError}
        </div>
      )}
      <div className="space-y-3">
        {icpList.map((icp) => (
          <details key={icp.id} className="card p-5">
            <summary className="flex cursor-pointer items-center justify-between gap-3">
              <span className="font-medium">{icp.segment}</span>
              <span className="text-xs text-muted">{icp.active ? 'Active' : 'Off'}</span>
            </summary>
            <div className="mt-4">
              <CriteriaList icp={icp} />
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

      <h2 id="own-leads" className="mt-10 mb-1 scroll-mt-6 text-sm font-semibold">Leads INVECK already has</h2>
      <p className="mb-3 text-sm text-ink-2">
        Companies already in the team&apos;s own lead lists. The prospect search and the new facility radar never offer them again.
      </p>
      <KnownCompanies count={knownCount} sample={knownSample.map((k) => k.company)} />
    </>
  );
}
