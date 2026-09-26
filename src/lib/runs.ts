import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from './db';
import { clients, icps, leads, runEvents, runs, type Lead, type Run, type RunStats } from './db/schema';
import { processLead } from './pipeline/process-lead';
import { findProspects } from './pipeline/prospects';
import type { Services } from './pipeline/services';
import { hunterCredits, mapLimit } from './pipeline/services';
import { errorMessage } from './pipeline/text';
import { draftDueFollowUps } from './pipeline/follow-ups';
import { scanRadar } from './pipeline/radar';
import { logActivity } from './activity';
import type { LeadResult, LeadUpdate } from './pipeline/process-lead';
import { savePeople } from './people';

const EMPTY_STATS: RunStats = { prospectsAdded: 0, processed: 0, drafted: 0, disqualified: 0, existingClients: 0, errors: 0 };
/** A run with no heartbeat for this long is considered dead (its function timed out or crashed). */
const STALE_MS = 10 * 60 * 1000;
/** Leads researched in parallel. */
const CONCURRENCY = 3;

export async function activeRun(db: Db): Promise<Run | undefined> {
  const [run] = await db.select().from(runs).where(eq(runs.status, 'running')).orderBy(desc(runs.id)).limit(1);
  if (!run) return undefined;
  if (Date.now() - new Date(run.heartbeatAt).getTime() > STALE_MS) {
    await db.update(runs).set({ status: 'failed', error: 'Stopped responding', finishedAt: new Date() }).where(eq(runs.id, run.id));
    return undefined;
  }
  return run;
}

/** Starts a run, or returns the one already running (only one at a time). */
export async function startRun(db: Db, opts: { findProspects: boolean; trigger: string }): Promise<{ run: Run; created: boolean }> {
  const existing = await activeRun(db);
  if (existing) return { run: existing, created: false };
  const [run] = await db
    .insert(runs)
    .values({ findProspects: opts.findProspects, trigger: opts.trigger, stats: EMPTY_STATS })
    .returning();
  return { run, created: true };
}

export async function logEvent(db: Db, runId: number, message: string, level: 'info' | 'warn' | 'error' = 'info', leadId?: number) {
  await db.insert(runEvents).values({ runId, message, level, leadId: leadId ?? null });
}

async function claimLeads(db: Db, limit: number): Promise<Lead[]> {
  if (limit <= 0) return [];
  // Claim atomically so two overlapping invocations never process the same lead.
  const rows = await db.execute(sql`
    UPDATE leads SET status = 'Processing', processing_started_at = now(), updated_at = now()
    WHERE id IN (
      SELECT id FROM leads WHERE status = 'New' ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    RETURNING id`);
  const ids = (Array.isArray(rows) ? rows : (rows as { rows: { id: number }[] }).rows).map((r) => Number((r as { id: number }).id));
  if (!ids.length) return [];
  return db.select().from(leads).where(inArray(leads.id, ids)).orderBy(asc(leads.id));
}

/**
 * Works on a run until it's finished or `budgetMs` runs out.
 * Returns 'continue' when there's more to do (the caller then schedules another invocation).
 */
export async function executeRun(db: Db, runId: number, svc: Services, budgetMs: number): Promise<'done' | 'continue'> {
  const started = Date.now();
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run || run.status !== 'running') return 'done';
  const stats: RunStats = { ...EMPTY_STATS, ...run.stats };
  const log = (msg: string, level: 'info' | 'warn' | 'error' = 'info', leadId?: number) => logEvent(db, runId, msg, level, leadId);
  const save = async (extra: Partial<Run> = {}) => {
    await db.update(runs).set({ stats, heartbeatAt: new Date(), ...extra }).where(eq(runs.id, runId));
  };

  try {
    // Leads stuck in "Processing" from a crashed invocation go back in the queue.
    await db
      .update(leads)
      .set({ status: 'New' })
      .where(and(eq(leads.status, 'Processing'), lt(leads.processingStartedAt, new Date(Date.now() - STALE_MS))));

    const [activeIcps, clientList] = await Promise.all([
      db.select().from(icps).where(eq(icps.active, true)).orderBy(asc(icps.id)),
      db.select().from(clients),
    ]);
    if (!activeIcps.length) throw new Error('No active ICP. Turn on at least one ICP.');

    if (run.findProspects && !run.prospectsDone) {
      await log('Finding new prospects');
      try {
        const known = await db.select({ company: leads.company, website: leads.website }).from(leads);
        const found = await findProspects(svc, activeIcps, clientList, known, (m, l) => log(m, l));
        if (found.length) {
          const rows = await db.insert(leads).values(found.map((p) => ({ ...p, status: 'New' as const }))).returning({ id: leads.id, source: leads.source });
          for (const r of rows) await logActivity(db, r.id, 'added', `Found by the prospect search. ${r.source}`);
        }
        stats.prospectsAdded += found.length;
        await log(found.length ? `Added ${found.length} new prospects: ${found.map((p) => p.company).join(', ')}` : 'No new prospects found');
      } catch (e) {
        await log('Prospect search failed: ' + errorMessage(e), 'error');
      }
      await save({ prospectsDone: true });
    }

    if (stats.processed === 0) {
      const credits = await hunterCredits(svc);
      if (credits.error) await log(`Couldn't read Hunter credits: ${credits.error}`, 'warn');
      else if (!credits.verificationsLeft || !credits.searchesLeft) {
        await log(
          `Hunter has ${credits.searchesLeft} searches and ${credits.verificationsLeft} email checks left${credits.resetDate ? ` (resets ${credits.resetDate})` : ''}. ` +
            'Until then only emails published on the web can be found; guessed emails can\'t be confirmed.',
          'warn',
        );
      }
    }

    // New plants and warehouses in the news (at most every 12 hours).
    if (stats.processed === 0 && svc.settings.radarEnabled) {
      try {
        const r = await scanRadar(db, svc, (m, l) => log(m, l));
        if (r.error) await log('New facility radar: ' + r.error, 'warn');
      } catch (e) {
        await log('New facility radar failed: ' + errorMessage(e), 'warn');
      }
    }

    // Follow-ups that fell due since the last run.
    if (stats.processed === 0) {
      try {
        await draftDueFollowUps(db, svc, (m, l) => log(m, l));
      } catch (e) {
        await log('Follow-up drafting failed: ' + errorMessage(e), 'warn');
      }
    }

    // Every waiting company gets researched: there's no per-run cap. Long runs hand over to
    // a fresh invocation when this one's time runs out.
    for (;;) {
      const [fresh] = await db.select({ cancel: runs.cancelRequested }).from(runs).where(eq(runs.id, runId));
      if (fresh?.cancel) {
        await log('Stopped by user', 'warn');
        await save({ status: 'cancelled', finishedAt: new Date() });
        return 'done';
      }
      // Stop claiming work when a batch might not finish inside this invocation.
      if (Date.now() - started > budgetMs * 0.6) {
        await save();
        return 'continue';
      }
      const batch = await claimLeads(db, CONCURRENCY);
      if (!batch.length) break;

      await mapLimit(batch, CONCURRENCY, async (lead) => {
        let result: LeadResult;
        try {
          result = await processLead(svc, lead, { icps: activeIcps, clients: clientList }, (m, l) => log(m, l, lead.id));
        } catch (e) {
          result = { status: 'Error' as const, lastError: errorMessage(e) };
          await log(`${lead.company}: ${errorMessage(e)}`, 'error', lead.id);
        }
        const { people: found, ...update } = result;
        await db.update(leads).set({ ...update, processingStartedAt: null, updatedAt: new Date() }).where(eq(leads.id, lead.id));
        if (found) await savePeople(db, lead.id, found);
        await recordOutcome(db, lead.id, update);
        stats.processed++;
        if (update.status === 'Awaiting Approval') stats.drafted++;
        if (update.status === 'Disqualified') stats.disqualified++;
        if (update.status === 'Existing Client') stats.existingClients++;
        if (update.status === 'Error') stats.errors++;
      });
      await save();
    }

    await log(`Done: ${stats.processed} researched, ${stats.drafted} drafts ready`);
    await save({ status: 'done', finishedAt: new Date() });
    return 'done';
  } catch (e) {
    await log('Run failed: ' + errorMessage(e), 'error');
    await save({ status: 'failed', error: errorMessage(e), finishedAt: new Date() });
    return 'done';
  }
}

/** What research found, as entries on the lead's timeline. */
async function recordOutcome(db: Db, leadId: number, u: LeadUpdate) {
  if (u.status === 'Existing Client') return logActivity(db, leadId, 'researched', u.fitReason || 'Matches a current client; not contacted');
  if (u.status === 'Error') return logActivity(db, leadId, 'error', `Research stopped: ${u.lastError || 'unknown error'}`);
  const fit = u.fitScore != null ? `fit ${u.fitScore}/10` : '';
  await logActivity(db, leadId, 'researched', [u.status === 'Disqualified' ? `Disqualified (${fit})` : `Researched: ${fit}`, u.fitReason].filter(Boolean).join('. '));
  if (u.status === 'Disqualified') return;
  for (const s of u.signals || []) await logActivity(db, leadId, 'signal', `${s.headline}${s.source ? ` (${s.source}${s.date ? `, ${s.date}` : ''})` : ''}`);
  if (u.contactName) {
    await logActivity(db, leadId, 'contact', `Decision-maker: ${[u.contactName, u.contactTitle].filter(Boolean).join(', ')}${u.emailStatus ? `. Email: ${u.contactEmail || '—'} (${u.emailStatus})` : ''}`);
  }
  if (u.status === 'Awaiting Approval') await logActivity(db, leadId, 'draft', `Outreach draft ready (score ${u.finalScore})`);
  else await logActivity(db, leadId, 'stage', `${u.status} (score ${u.finalScore ?? '—'})`, u.status ?? '');
}
