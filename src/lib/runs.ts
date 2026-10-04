import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import type { Db } from './db';
import { clients, icps, leads, prospectResults, prospectSearches, runEvents, runs, users, type Lead, type Run, type RunStats } from './db/schema';
import { processLead } from './pipeline/process-lead';
import { findProspects, type ProspectHistory } from './pipeline/prospects';
import { normQuery } from './pipeline/query-history';
import { contactFromTeam } from './team-contact';
export { contactFromTeam };
import type { Services } from './pipeline/services';
import { hunterCredits, mapLimit } from './pipeline/services';
import { errorMessage, normCompany } from './pipeline/text';
import { draftDueFollowUps } from './pipeline/follow-ups';
import { scanRadar } from './pipeline/radar';
import { logActivity } from './activity';
import type { LeadResult, LeadUpdate } from './pipeline/process-lead';
import { savePeople } from './people';
import { assignUnowned } from './assign';

const EMPTY_STATS: RunStats = { prospectsAdded: 0, processed: 0, drafted: 0, disqualified: 0, needsReview: 0, existingClients: 0, errors: 0 };
/** A run with no heartbeat for this long is considered dead (its function timed out or crashed). */
const STALE_MS = 10 * 60 * 1000;
/** Research attempts that time out before a lead stops being retried (it goes to Error; Research again resets it). */
export const MAX_RESEARCH_ATTEMPTS = 2;
/** How far back the prospect finder looks: searches not to repeat, and companies already turned up. */
const SEARCH_MEMORY_DAYS = 90;
const SEEN_MEMORY_DAYS = 180;
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
export async function startRun(db: Db, opts: { findProspects: boolean; trigger: string; prospectsTo?: string }): Promise<{ run: Run; created: boolean }> {
  const existing = await activeRun(db);
  if (existing) return { run: existing, created: false };
  const [run] = await db
    .insert(runs)
    .values({ findProspects: opts.findProspects, trigger: opts.trigger, prospectsTo: opts.prospectsTo ?? '', stats: EMPTY_STATS })
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
    UPDATE leads SET status = 'Processing', processing_started_at = now(), research_attempts = research_attempts + 1, updated_at = now()
    WHERE id IN (
      SELECT id FROM leads WHERE status = 'New' ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    RETURNING id`);
  const ids = (Array.isArray(rows) ? rows : (rows as { rows: { id: number }[] }).rows).map((r) => Number((r as { id: number }).id));
  if (!ids.length) return [];
  return db.select().from(leads).where(inArray(leads.id, ids)).orderBy(asc(leads.id));
}

/**
 * Hands newly found prospects out as the admin chose when starting the search: 'team' splits them
 * evenly across the active team now, a user id gives them all to that person, '' leaves them for the
 * morning draw. Returns a line for the run log.
 */
export async function delegateProspects(db: Db, ids: number[], to: string): Promise<string> {
  if (!ids.length || !to) return '';
  const team = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.role, 'bda'), eq(users.active, true))).orderBy(asc(users.id));
  const chosen = to === 'team' ? team : team.filter((u) => String(u.id) === to);
  if (!chosen.length) return '';
  const per = new Map<number, number>();
  for (const [i, id] of ids.entries()) {
    const owner = chosen[i % chosen.length];
    await db.update(leads).set({ ownerId: owner.id }).where(eq(leads.id, id));
    per.set(owner.id, (per.get(owner.id) ?? 0) + 1);
  }
  return `New prospects handed out: ${chosen.map((u) => `${u.name} ${per.get(u.id) ?? 0}`).join(', ')}`;
}

/**
 * The prospect finder's memory, kept in the database across runs: recent searches (not to be
 * repeated), companies earlier searches turned up, and where this run records its own.
 */
export async function prospectHistory(db: Db, runId: number | null): Promise<ProspectHistory> {
  const since = (days: number) => new Date(Date.now() - days * 86_400_000);
  const [searches, seen] = await Promise.all([
    db
      .select({ query: prospectSearches.query, fresh: prospectSearches.freshCount, added: prospectSearches.addedCount })
      .from(prospectSearches)
      .where(and(eq(prospectSearches.status, 'ok'), gte(prospectSearches.searchedAt, since(SEARCH_MEMORY_DAYS))))
      .orderBy(desc(prospectSearches.searchedAt))
      .limit(400),
    db
      .select({ name: prospectResults.normCompany, domain: prospectResults.domain })
      .from(prospectResults)
      .where(and(inArray(prospectResults.outcome, ['added', 'duplicate']), gte(prospectResults.seenAt, since(SEEN_MEMORY_DAYS)))),
  ]);
  return {
    searches,
    seenNames: seen.map((r) => r.name).filter(Boolean),
    seenDomains: seen.map((r) => r.domain).filter(Boolean),
    async recordSearch(s) {
      const [row] = await db
        .insert(prospectSearches)
        .values({ query: s.query, normQuery: normQuery(s.query), segment: s.segment, runId, status: s.status, resultsCount: s.resultsCount, freshCount: s.freshCount, error: s.error ?? '' })
        .returning({ id: prospectSearches.id });
      return row?.id ?? null;
    },
    async recordResults(searchId, rows) {
      if (!rows.length) return;
      await db.insert(prospectResults).values(
        rows.map((r) => ({ searchId, runId, url: r.url, domain: r.domain, title: r.title.slice(0, 500), company: r.company ?? '', normCompany: normCompany(r.company ?? ''), outcome: r.outcome })),
      );
    },
    async recordAdded(searchId, count) {
      if (searchId === null || !count) return;
      await db.update(prospectSearches).set({ addedCount: sql`${prospectSearches.addedCount} + ${count}` }).where(eq(prospectSearches.id, searchId));
    },
  };
}

/** Claims leads waiting for their contacts to be found again; a claim older than 15 minutes is retried. */
async function claimRefetch(db: Db, limit: number): Promise<Lead[]> {
  const rows = await db.execute(sql`
    UPDATE leads SET refetch_claimed_at = now()
    WHERE id IN (
      SELECT id FROM leads
      WHERE refetch_pending AND (refetch_claimed_at IS NULL OR refetch_claimed_at < now() - interval '15 minutes')
      ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED
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
  // Stop means stop: companies still waiting to have their contacts found again are dropped from the
  // queue (their saved contacts stay as they are), so opening Today doesn't start it all again.
  const stop = async (): Promise<'done'> => {
    const left = await db.update(leads).set({ refetchPending: false, refetchClaimedAt: null }).where(eq(leads.refetchPending, true)).returning({ id: leads.id });
    await log(`Stopped by user${left.length ? `; ${left.length} compan${left.length === 1 ? 'y' : 'ies'} left with the contacts they had` : ''}`, 'warn');
    await save({ status: 'cancelled', finishedAt: new Date() });
    return 'done';
  };

  try {
    // Leads stuck in "Processing" from a crashed or timed-out invocation go back in the queue, but
    // only so often: one that keeps timing out goes to Error instead of being researched forever.
    const stale = and(eq(leads.status, 'Processing'), lt(leads.processingStartedAt, new Date(Date.now() - STALE_MS)));
    const gaveUp = await db
      .update(leads)
      .set({ status: 'Error', lastError: `Research didn't finish (timed out) ${MAX_RESEARCH_ATTEMPTS} times. Press Research again to try once more.`, processingStartedAt: null })
      .where(and(stale, sql`${leads.researchAttempts} >= ${MAX_RESEARCH_ATTEMPTS}`))
      .returning({ id: leads.id, company: leads.company });
    for (const l of gaveUp) {
      await logActivity(db, l.id, 'error', `Research didn't finish (timed out) ${MAX_RESEARCH_ATTEMPTS} times; stopped retrying. Press Research again to try once more.`);
      await log(`${l.company}: research timed out ${MAX_RESEARCH_ATTEMPTS} times; not retried automatically`, 'error', l.id);
    }
    await db.update(leads).set({ status: 'New' }).where(stale);

    // Every ICP, so a lead whose segment names a switched-off one is flagged as such (only active ones
    // are used to search for prospects or to check a fit).
    const [allIcps, clientList, taken] = await Promise.all([
      db.select().from(icps).orderBy(asc(icps.id)),
      db.select().from(clients),
      // Every lead's main contact, so two branches of one company don't get the same person.
      db.select({ leadId: leads.id, company: leads.company, website: leads.website, contactName: leads.contactName }).from(leads).where(ne(leads.contactName, '')),
    ]);
    const activeIcps = allIcps.filter((i) => i.active);
    if (!activeIcps.length) throw new Error('No active ICP. Turn on at least one ICP.');

    if (run.findProspects && !run.prospectsDone) {
      await log('Finding new prospects');
      try {
        const known = await db.select({ company: leads.company, website: leads.website }).from(leads);
        const found = await findProspects(svc, activeIcps, clientList, known, (m, l) => log(m, l), await prospectHistory(db, runId));
        if (found.length) {
          const rows = await db.insert(leads).values(found.map((p) => ({ ...p, status: 'New' as const }))).returning({ id: leads.id, source: leads.source });
          for (const r of rows) await logActivity(db, r.id, 'added', `Found by the prospect search. ${r.source}`);
          // The admin chose who gets them: the team now, one person, or (default) the morning draw.
          const given = await delegateProspects(db, rows.map((r) => r.id), run.prospectsTo);
          if (given) await log(given);
          await assignUnowned(db);
        }
        stats.prospectsAdded += found.length;
        await log(found.length ? `Added ${found.length} new prospects: ${found.map((p) => p.company).join(', ')}` : 'No new prospects found');
        await save({ prospectsDone: true });
      } catch (e) {
        // Recorded on the run, so it ends as failed (not "Finished") once the waiting leads are done.
        const error = 'Prospect search failed: ' + errorMessage(e);
        await log(error, 'error');
        run.error = error;
        await save({ prospectsDone: true, error });
      }
    }

    if (stats.processed === 0) {
      if (!svc.keys.prospeo && !svc.keys.apollo) await log('No email provider is set up (PROSPEO_API_KEY, APOLLO_API_KEY): emails come only from published addresses and the company\'s format.', 'warn');
      // Hunter is only the mail-server check now.
      if (svc.keys.hunter) {
        const credits = await hunterCredits(svc);
        if (credits.error) await log(`Couldn't read the email verification credits (Hunter): ${credits.error}`, 'warn');
        else if (!credits.verificationsLeft) {
          await log(
            `Email verification (Hunter) has no checks left${credits.resetDate ? ` (resets ${credits.resetDate})` : ''}. ` +
              'Until then addresses are saved labelled unverified or inferred, never as verified, unless Apollo verified them.',
            'warn',
          );
        }
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
      if (fresh?.cancel) return stop();
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
          result = await processLead(svc, lead, { icps: allIcps, clients: clientList, taken }, (m, l) => log(m, l, lead.id), { teamContact: await contactFromTeam(db, lead) });
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
        if (update.status === 'Needs Review') stats.needsReview = (stats.needsReview ?? 0) + 1;
        if (update.status === 'Existing Client') stats.existingClients++;
        if (update.status === 'Error') stats.errors++;
      });
      await save();
    }

    // Contacts reset: companies whose contacts are found again from scratch, research kept.
    let refetched = 0;
    for (;;) {
      const [fresh] = await db.select({ cancel: runs.cancelRequested }).from(runs).where(eq(runs.id, runId));
      if (fresh?.cancel) return stop();
      if (Date.now() - started > budgetMs * 0.6) {
        await save();
        return 'continue';
      }
      const batch = await claimRefetch(db, CONCURRENCY);
      if (!batch.length) break;
      await mapLimit(batch, CONCURRENCY, async (lead) => {
        try {
          const result = await processLead(svc, lead, { icps: allIcps, clients: clientList, taken }, (m, l) => log(m, l, lead.id), { contactsOnly: true, teamContact: await contactFromTeam(db, lead) });
          const { people: found, ...update } = result;
          await db.update(leads).set({ ...update, refetchPending: false, refetchClaimedAt: null, processingStartedAt: null, updatedAt: new Date() }).where(eq(leads.id, lead.id));
          if (found) await savePeople(db, lead.id, found);
          await logActivity(
            db,
            lead.id,
            'contact',
            update.contactName ? `Contacts found again after the reset: ${[update.contactName, update.contactTitle].filter(Boolean).join(', ')}` : 'Contacts found again after the reset: nobody on the ICP lists yet',
          );
          refetched++;
        } catch (e) {
          // Not retried in a loop: the lead keeps the contacts it had. A failed search (out of credits,
          // say) stays waiting and is tried again on a later run (the claim holds it for 15 minutes);
          // anything else is left to the next contact check.
          const searchDown = /LinkedIn search failed/.test(errorMessage(e)) && !lead.contactName;
          await db.update(leads).set(searchDown ? { lastError: `Contacts not searched: ${errorMessage(e).slice(0, 160)}. Searched again automatically on a later run.` } : { refetchPending: false, refetchClaimedAt: null }).where(eq(leads.id, lead.id));
          await log(`${lead.company}: finding contacts again failed, kept the contacts it had: ${errorMessage(e)}`, 'error', lead.id);
        }
      });
      await save();
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(leads).where(eq(leads.refetchPending, true));
      await log(`Finding contacts again: ${refetched} done${Number(n) ? `, ${n} still waiting` : ''}`);
    }
    if (refetched) await log(`Contacts found again for ${refetched} compan${refetched === 1 ? 'y' : 'ies'}`);

    await log(`Done: ${stats.processed} researched, ${stats.drafted} drafts ready`);
    if (run.error) await log(`Finished with an error: ${run.error}`, 'error');
    await save({ status: run.error ? 'failed' : 'done', finishedAt: new Date() });
    return 'done';
  } catch (e) {
    await log('Run failed: ' + errorMessage(e), 'error');
    await save({ status: 'failed', error: errorMessage(e), finishedAt: new Date() });
    return 'done';
  }
}

/** What research found, as entries on the lead's timeline. */
export async function recordOutcome(db: Db, leadId: number, u: LeadUpdate) {
  if (u.status === 'Existing Client') return logActivity(db, leadId, 'researched', u.fitReason || 'Matches a current client; not contacted');
  if (u.status === 'Error') return logActivity(db, leadId, 'error', `Research stopped: ${u.lastError || 'unknown error'}`);
  const fit = u.fitScore != null ? `ICP fit ${u.fitScore}/10` : '';
  if (u.riskFlags?.length) {
    await logActivity(db, leadId, 'note', `Commercial risk noted (kept apart from the ICP fit): ${u.riskFlags.map((r) => `${r.label}: “${r.evidence}”${r.url ? ` (${r.url})` : ''}`).join('; ')}`);
  }
  if (u.status === 'Disqualified' || u.status === 'Needs Review') {
    const decision = u.fitDecision || (u.status === 'Disqualified' ? ['Not a fit', u.fitReason].filter(Boolean).join('. ') : 'Needs review');
    return logActivity(db, leadId, 'researched', `${decision}${fit ? `. ${fit}` : ''}`);
  }
  await logActivity(db, leadId, 'researched', [`Researched: ${fit}`, u.fitReason].filter(Boolean).join('. '));
  if (u.contactName) {
    await logActivity(db, leadId, 'contact', `Decision-maker: ${[u.contactName, u.contactTitle].filter(Boolean).join(', ')}${u.emailStatus ? `. Email: ${u.contactEmail || '—'} (${u.emailStatus})` : ''}`);
  }
  if (u.status === 'Awaiting Approval') await logActivity(db, leadId, 'draft', `Outreach draft ready (score ${u.finalScore})`);
  else await logActivity(db, leadId, 'stage', `${u.status} (score ${u.finalScore ?? '—'})`, u.status ?? '');
}
