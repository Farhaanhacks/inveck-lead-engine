import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from './db';
import { leads, type Lead } from './db/schema';
import { logActivity } from './activity';
import { applyStage } from './stages';
import { KIND_LABEL } from './pipeline/fit';

/** Stages where the fit was the reason the company isn't being worked: what "Reassess fit" is for. */
export const REASSESSABLE = ['Disqualified'] as const;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * The assessment a lead has now, written out for its timeline before anything replaces it: stage,
 * ICP fit, the ICP it was checked against, the reason, every criterion with its evidence, any
 * commercial risk, and the research summary.
 */
export function assessmentRecord(l: Lead): string {
  const head = [`Earlier assessment: ${l.status}`];
  if (l.fitScore != null) head.push(`ICP fit ${l.fitScore}/10`);
  if (l.assessedIcp || l.segment) head.push(`ICP ${l.assessedIcp || l.segment}`);
  if (!l.fitStatus && l.researchSummary) head.push('checked before evidence was required');
  const lines = [head.join(', ')];
  const why = l.fitDecision || l.fitReason;
  if (why) lines.push(`Reason: ${clip(why, 600)}`);
  for (const e of l.fitEvidence) {
    lines.push(`${e.id} ${KIND_LABEL[e.kind] ?? e.kind} (${e.status.replace('_', ' ')}): ${clip(e.criterion, 80)}${e.evidence ? ` | “${clip(e.evidence, 160)}”` : ''}${e.url ? ` (${e.url})` : ''}`);
  }
  for (const r of l.riskFlags) lines.push(`Commercial risk: ${r.label}: “${clip(r.evidence, 160)}”${r.url ? ` (${r.url})` : ''}`);
  if (l.researchSummary) lines.push(`Research then: ${clip(l.researchSummary.replace(/\s*\n+\s*/g, ' · '), 900)}`);
  return lines.join('\n');
}

/**
 * Puts leads back in the research queue to have their fit checked again under the current rules,
 * keeping the earlier assessment on each timeline. Only leads ruled out or waiting on review; a
 * person's earlier call on the fit is set aside (that is what reassessing asks for). Returns how many.
 */
export async function reassessLeads(db: Db, ids: number[], by: string): Promise<number> {
  if (!ids.length) return 0;
  const rows = await db.select().from(leads).where(and(inArray(leads.id, ids), inArray(leads.status, [...REASSESSABLE])));
  if (!rows.length) return 0;
  for (const l of rows) await logActivity(db, l.id, 'note', `Fit reassessment asked for by ${by}.\n${assessmentRecord(l)}`);
  const chosen = rows.map((l) => l.id);
  await db.update(leads).set({ fitOverride: '', researchAttempts: 0 }).where(inArray(leads.id, chosen));
  await applyStage(db, chosen, 'New');
  return rows.length;
}

/**
 * Notes the current assessment of leads about to be researched again ("Research again"), so what
 * they were judged before stays on their timelines.
 */
export async function recordAssessments(db: Db, ids: number[], by: string): Promise<void> {
  if (!ids.length) return;
  const rows = await db.select().from(leads).where(and(inArray(leads.id, ids), inArray(leads.status, [...REASSESSABLE])));
  for (const l of rows) await logActivity(db, l.id, 'note', `Researched again at the request of ${by}.\n${assessmentRecord(l)}`);
}

/**
 * A person confirms the company fits: their call stands over the AI's, and the lead goes back in the
 * queue to find its contacts and write its drafts (research keeps the confirmed fit).
 */
export async function confirmFit(db: Db, id: number, by: string, note: string): Promise<boolean> {
  const [l] = await db.select().from(leads).where(eq(leads.id, id));
  if (!l || !(REASSESSABLE as readonly string[]).includes(l.status)) return false;
  const decision = `Confirmed as a fit by ${by}${note ? `: ${note}` : ''}`;
  await logActivity(db, id, 'note', `${decision}.\n${assessmentRecord(l)}`);
  await db.update(leads).set({ fitOverride: 'qualified', fitStatus: 'qualified', qualified: true, fitDecision: decision, researchAttempts: 0, updatedAt: new Date() }).where(eq(leads.id, id));
  await applyStage(db, [id], 'New');
  return true;
}

/** A person decides the company isn't a fit: it is ruled out, and research again keeps that call. */
export async function markNotFit(db: Db, id: number, by: string, note: string): Promise<boolean> {
  const [l] = await db.select().from(leads).where(eq(leads.id, id));
  // Only a fit research couldn't confirm: a decided not-fit needs no second ruling.
  if (!l || l.status !== 'Disqualified' || l.fitStatus !== 'review') return false;
  const decision = `Marked not a fit by ${by}${note ? `: ${note}` : ''}`;
  await logActivity(db, id, 'note', `${decision}.\n${assessmentRecord(l)}`);
  await db.update(leads).set({ fitOverride: 'not_fit', fitStatus: 'not_fit', qualified: false, fitDecision: decision, finalScore: null, updatedAt: new Date() }).where(eq(leads.id, id));
  await applyStage(db, [id], 'Disqualified');
  return true;
}
