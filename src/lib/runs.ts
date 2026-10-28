import { and, asc, desc, eq, gt, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import type { Db } from './db';
import { listKnownCompanies } from './known-companies';
import { KnownBranches } from './branches';
import { clients, icps, leads, prospectResults, prospectSearches, runEvents, runs, users, type Lead, type Run, type RunStats } from './db/schema';
import { processLead } from './pipeline/process-lead';
import { findProspects, queryPlannerPrompt, type ProspectHistory } from './pipeline/prospects';
import { defaultProduct, listIcps } from './config';
import { products, type Product } from './db/schema';
import { normSegment } from './icp-match';
import { isCaSegment } from './tasks';
import { peopleFirstContacts, sourceProspects, wantsAnotherRound } from './sourcing/morning';
import { RESEARCH_CREDITS, RESEARCH_DAY_CREDITS, researchCreditsLeft, researchMeter, searchBudgetLeft } from './search-budget';
import { normQuery } from './pipeline/query-history';
import { contactFromTeam } from './team-contact';
export { contactFromTeam };
import type { Services } from './pipeline/services';
import { mapLimit } from './pipeline/services';
import { errorMessage, normCompany } from './pipeline/text';
import { draftDueFollowUps } from './pipeline/follow-ups';
import { scanRadar } from './pipeline/radar';
import { logActivity } from './activity';
import type { LeadResult, LeadUpdate } from './pipeline/process-lead';
import { savePeople } from './people';
import { RESUME_AFTER_MS } from './invocations';
import { assignUnowned } from './assign';

const EMPTY_STATS: RunStats = { prospectsAdded: 0, processed: 0, drafted: 0, disqualified: 0, needsReview: 0, existingClients: 0, errors: 0 };
/** A lead in "Processing" this long was being researched by an invocation that timed out or crashed. */
const STALE_MS = 10 * 60 * 1000;
/**
 * A run with no heartbeat for this long is closed as dead. One that stalls sooner (Vercel ends a long
 * chain of invocations each calling the next, after a few) is picked up again first: see claimStalledRun.
 */
const RUN_STALE_MS = 45 * 60 * 1000;
/** Times a run is picked up again before it's closed as failed (one that keeps dying isn't retried forever). */
export const MAX_RESUMES = 40;
/** Research attempts that time out before a lead stops being retried (it goes to Error; Research again resets it). */
export const MAX_RESEARCH_ATTEMPTS = 2;
/** How far back the prospect finder looks: searches not to repeat, and companies already turned up. */
const SEARCH_MEMORY_DAYS = 90;
const SEEN_MEMORY_DAYS = 180;
/** Leads researched in parallel. */
const CONCURRENCY = 5;

export async function activeRun(db: Db): Promise<Run | undefined> {
  const [run] = await db.select().from(runs).where(eq(runs.status, 'running')).orderBy(desc(runs.id)).limit(1);
  if (!run) return undefined;
  if (Date.now() - new Date(run.heartbeatAt).getTime() > RUN_STALE_MS) {
    await db.update(runs).set({ status: 'failed', error: 'Stopped responding', finishedAt: new Date() }).where(eq(runs.id, run.id));
    return undefined;
  }
  return run;
}

/**
 * The run now running, if its invocations stopped (the next couldn't be called, or one died): claimed for
 * carrying on, by one caller only (its heartbeat moves on). Null when there's none, or one is still working.
 */
export async function claimStalledRun(db: Db, now = new Date()): Promise<Run | null> {
  const [run] = await db
    .update(runs)
    .set({ heartbeatAt: now })
    .where(
      and(
        eq(runs.id, sql`(select max(${runs.id}) from ${runs} where ${runs.status} = 'running')`),
        eq(runs.status, 'running'),
        lt(runs.heartbeatAt, new Date(now.getTime() - RESUME_AFTER_MS)),
        gt(runs.heartbeatAt, new Date(now.getTime() - RUN_STALE_MS)),
      ),
    )
    .returning();
  return run ?? null;
}

/** A run whose next invocation couldn't be called: ready to be picked up again by the next request. */
export async function markRunPaused(db: Db, runId: number) {
  await db.update(runs).set({ heartbeatAt: new Date(Date.now() - RESUME_AFTER_MS - 1000) }).where(and(eq(runs.id, runId), eq(runs.status, 'running')));
}

/** Starts a run, or returns the one already running (only one at a time). */
export async function startRun(db: Db, opts: { findProspects: boolean; trigger: string; prospectsTo?: string; prospectsWanted?: Partial<Record<string, number>> | null; productId?: number }): Promise<{ run: Run; created: boolean }> {
  const existing = await activeRun(db);
  if (existing) return { run: existing, created: false };
  // Which product the run is for, the version of its configuration, and (for the AI planner) the exact prompt used.
  const product = opts.productId ? ((await db.select().from(products).where(eq(products.id, opts.productId)))[0] ?? null) : await defaultProduct(db);
  const planner = product && product.searchMode === 'ai_planner' ? queryPlannerPrompt((await listIcps(db, product.id)).filter((i) => i.active && !isCaSegment(i.segment)), product.searchPrompt) : '';
  const [run] = await db
    .insert(runs)
    .values({ findProspects: opts.findProspects, trigger: opts.trigger, prospectsTo: opts.prospectsTo ?? '', prospectsWanted: opts.prospectsWanted ?? null, stats: EMPTY_STATS, productId: product?.id ?? null, configVersion: product?.configVersion ?? null, plannerPrompt: planner })
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
/** Records which product, ICP and configuration version the leads were found under (a label: nothing else on them changes). */
export async function stampLeads(db: Db, ids: number[], product: Product, configVersion: number): Promise<void> {
  if (!ids.length) return;
  const productIcps = await listIcps(db, product.id);
  await db.update(leads).set({ productId: product.id, configVersion }).where(inArray(leads.id, ids));
  for (const icp of productIcps) {
    const matching = (await db.select({ id: leads.id, segment: leads.segment }).from(leads).where(inArray(leads.id, ids))).filter((l) => normSegment(l.segment) === normSegment(icp.segment)).map((l) => l.id);
    if (matching.length) await db.update(leads).set({ icpId: icp.id }).where(inArray(leads.id, matching));
  }
}

/**
 * The AI planner's search for a product: its shared prompt and its active ICPs' instructions go to DeepSeek, which
 * plans the searches; those go to Serper and the companies found are added as leads (researched like any other).
 */
async function aiPlannerStep(db: Db, svc: Services, run: Run, product: Product, log: (m: string, l?: 'info' | 'warn' | 'error') => Promise<void>, onAdded: (ids: number[]) => Promise<void>) {
  const active = (await listIcps(db, product.id)).filter((i) => i.active && !isCaSegment(i.segment));
  if (!active.length) throw new Error(`${product.name} has no active ICP to search for. Turn one on under Configuration.`);
  await log(`Finding new prospects for ${product.name} with the AI planner (${active.map((i) => i.segment).join(', ')}; configuration version ${run.configVersion ?? product.configVersion})`);
  const clientList = await db.select().from(clients);
  const known = [...(await db.select({ company: leads.company, website: leads.website, city: leads.city }).from(leads)), ...(await listKnownCompanies(db))];
  const planner = product.description.trim() ? { ...svc, settings: { ...svc.settings, productDescription: product.description.trim() } } : svc;
  const found = await findProspects(planner, active, clientList, known, log, await prospectHistory(db, run.id), { basePrompt: product.searchPrompt });
  if (found.length) {
    const rows = await db.insert(leads).values(found.map((p) => ({ ...p, status: 'New' as const }))).returning({ id: leads.id, source: leads.source });
    for (const r of rows) await logActivity(db, r.id, 'added', `Found by the prospect search (${product.name}). ${r.source}`);
    await onAdded(rows.map((r) => r.id));
  } else await log('No new prospects found');
}

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
      .select({ company: prospectResults.company, domain: prospectResults.domain, city: prospectResults.city })
      .from(prospectResults)
      .where(and(inArray(prospectResults.outcome, ['added', 'duplicate']), gte(prospectResults.seenAt, since(SEEN_MEMORY_DAYS)))),
  ]);
  return {
    searches,
    seenBranches: seen.filter((r) => r.company || r.domain).map((r) => ({ company: r.company, website: r.domain, city: r.city })),
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
        rows.map((r) => ({ searchId, runId, url: r.url, domain: r.domain, title: r.title.slice(0, 500), company: r.company ?? '', normCompany: normCompany(r.company ?? ''), city: r.city ?? '', outcome: r.outcome })),
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
export async function executeRun(db: Db, runId: number, live: Services, budgetMs: number): Promise<'done' | 'continue'> {
  const started = Date.now();
  // Everything a run searches counts into the day's research total too (RESEARCH_DAY_CREDITS; live runs only).
  const svc: Services = live.meter ? { ...live, meter: researchMeter(db, live.meter) } : live;
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run || run.status !== 'running') return 'done';
  const stats: RunStats = { ...EMPTY_STATS, ...run.stats };
  const log = (msg: string, level: 'info' | 'warn' | 'error' = 'info', leadId?: number) => logEvent(db, runId, msg, level, leadId);
  const save = async (extra: Partial<Run> = {}) => {
    await db.update(runs).set({ stats, heartbeatAt: new Date(), ...extra }).where(eq(runs.id, runId));
  };
  // Stop means stop: companies still waiting to have their contacts found again are dropped from the
  // queue (their saved contacts stay as they are), so opening Today doesn't start it all again.
  // Whether the day's Google search budget (counted only on live runs, which have a meter) has room for this much, and
  // the day's research limit (RESEARCH_DAY_CREDITS) too.
  const budgetFor = async (credits: number) => !svc.meter || ((await searchBudgetLeft(db, svc.settings)) >= credits && (await researchCreditsLeft(db)) >= credits);
  let budgetLogged = false;
  const logBudgetUsed = async () => {
    if (budgetLogged) return;
    budgetLogged = true;
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(leads).where(eq(leads.status, 'New'));
    const which =
      (await researchCreditsLeft(db)) < CONCURRENCY * RESEARCH_CREDITS.other
        ? `The day's research limit (${RESEARCH_DAY_CREDITS.toLocaleString('en-IN')} Google search credits)`
        : `The day's Google search budget (${svc.settings.dailySearchBudget.toLocaleString('en-IN')})`;
    await log(`${which} is used${Number(n) ? `: ${n} compan${Number(n) === 1 ? 'y waits' : 'ies wait'} for research on the next day` : ''}`, 'warn');
  };
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
    // INVECK's own lead list, by branch: a lead on it is set aside, not researched.
    const ownLeads = new KnownBranches(await listKnownCompanies(db), []);
    const activeIcps = allIcps.filter((i) => i.active);
    if (!activeIcps.length) throw new Error('No active ICP. Turn on at least one ICP.');

    // New plants and warehouses in the news (at most every 12 hours), while the day's search budget allows.
    if (stats.processed === 0 && svc.settings.radarEnabled && (await budgetFor(50))) {
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

    // New prospects, people first (see sourcing/morning.ts): as many as the morning draw is short of.
    // Research decides each one (the ICP check: Approved or Disqualified); while it rules companies out
    // and the draw is still short, the run searches again, a few rounds at most.
    for (;;) {
      if (run.findProspects && !run.prospectsDone) {
        const added: number[] = [];
        let outcome: 'done' | 'continue' = 'done';
        const product = run.productId ? ((await db.select().from(products).where(eq(products.id, run.productId)))[0] ?? null) : await defaultProduct(db);
        try {
          // A product on the AI planner: its configured prompt goes to DeepSeek for the searches, which go to Serper.
          // (Inveck is on people-first search, which is what ran before: untouched.)
          if (product && product.searchMode === 'ai_planner') await aiPlannerStep(db, svc, run, product, (m, l) => log(m, l), async (ids) => void added.push(...ids));
          else outcome = await sourceProspects(db, svc, run, {
            started,
            budgetMs,
            log: (m, l) => log(m, l),
            onAdded: async (ids) => void added.push(...ids),
            stopped: async () => !!(await db.select({ cancel: runs.cancelRequested }).from(runs).where(eq(runs.id, runId)))[0]?.cancel,
          });
        } catch (e) {
          // Recorded on the run, so it ends as failed (not "Finished") once the waiting leads are done.
          const error = 'Prospect search failed: ' + errorMessage(e);
          await log(error, 'error');
          run.error = error;
          await save({ error });
        }
        if (added.length) {
          if (product) await stampLeads(db, added, product, run.configVersion ?? product.configVersion);
          stats.prospectsAdded += added.length;
          const names = await db.select({ company: leads.company }).from(leads).where(inArray(leads.id, added));
          await log(`Added ${added.length} new prospect${added.length === 1 ? '' : 's'}: ${names.map((n) => n.company).join(', ')}`);
          // The admin chose who gets them: the team now, one person, or (default) the morning draw.
          const given = await delegateProspects(db, added, run.prospectsTo);
          if (given) await log(given);
          await assignUnowned(db);
        }
        if (outcome === 'continue') {
          await save();
          return 'continue';
        }
        run.prospectsDone = true;
        await save({ prospectsDone: true });
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
        // The day's Google search budget: companies left over wait for tomorrow's run (never researched halfway).
        if (!(await budgetFor(CONCURRENCY * RESEARCH_CREDITS.peopleFirst))) {
          await logBudgetUsed();
          break;
        }
        const batch = await claimLeads(db, CONCURRENCY);
        if (!batch.length) break;

        await mapLimit(batch, CONCURRENCY, async (lead) => {
          let result: LeadResult;
          try {
            result = await processLead(svc, lead, { icps: allIcps, clients: clientList, taken, ownLeads }, (m, l) => log(m, l, lead.id), {
              teamContact: await contactFromTeam(db, lead),
              found: await peopleFirstContacts(db, lead),
              // The daily run's research rules for every lead (CA firms keep theirs).
              lean: !isCaSegment(lead.segment),
            });
          } catch (e) {
            result = { status: 'Error' as const, lastError: errorMessage(e) };
            await log(`${lead.company}: ${errorMessage(e)}`, 'error', lead.id);
          }
          const { people: found, ...update } = result;
          await db.update(leads).set({ ...update, processingStartedAt: null, updatedAt: new Date() }).where(eq(leads.id, lead.id));
          if (found) await savePeople(db, lead.id, found);
          await recordOutcome(db, lead.id, update);
          stats.processed++;
          // `drafted` counts the leads approved (the name is kept so earlier runs' stats still read).
          if (update.status === 'Approved') stats.drafted++;
          if (update.status === 'Disqualified') stats.disqualified++;
          if (update.status === 'Existing Client') stats.existingClients++;
          if (update.status === 'Error') stats.errors++;
        });
        await save();
      }

      // Research ruled some out and the draw is still short: search again.
      const [now] = run.findProspects ? await db.select().from(runs).where(eq(runs.id, runId)) : [];
      if (now && (await wantsAnotherRound(db, svc, now))) {
        run.prospectsDone = false;
        await save({ prospectsDone: false });
        continue;
      }
      break;
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
      if (!(await budgetFor(CONCURRENCY * RESEARCH_CREDITS.other))) {
        await logBudgetUsed();
        break;
      }
      const batch = await claimRefetch(db, CONCURRENCY);
      if (!batch.length) break;
      await mapLimit(batch, CONCURRENCY, async (lead) => {
        try {
          const result = await processLead(svc, lead, { icps: allIcps, clients: clientList, taken }, (m, l) => log(m, l, lead.id), {
            contactsOnly: true,
            teamContact: await contactFromTeam(db, lead),
            found: await peopleFirstContacts(db, lead),
            lean: !isCaSegment(lead.segment),
          });
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

    await log(`Done: ${stats.processed} researched, ${stats.drafted} approved`);
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
  if (u.status === 'Disqualified') {
    const decision = u.fitDecision || ['Not a fit', u.fitReason].filter(Boolean).join('. ');
    return logActivity(db, leadId, 'researched', `${decision}${fit ? `. ${fit}` : ''}`);
  }
  await logActivity(db, leadId, 'researched', [`Researched: ${fit}`, u.fitReason].filter(Boolean).join('. '));
  if (u.contactName) {
    await logActivity(db, leadId, 'contact', `Decision-maker: ${[u.contactName, u.contactTitle].filter(Boolean).join(', ')}${u.emailStatus ? `. Email: ${u.contactEmail || '—'} (${u.emailStatus})` : ''}`);
  }
  if (u.status === 'Deleted') await logActivity(db, leadId, 'stage', `Moved to Deleted. ${u.deletedReason ?? ''}`.trim(), 'Deleted');
  else if (u.status === 'Approved') await logActivity(db, leadId, 'approved', `Approved: fits the ICP and has a contact; outreach draft ready (score ${u.finalScore})`, 'Approved');
  else await logActivity(db, leadId, 'stage', `${u.status} (score ${u.finalScore ?? '—'})`, u.status ?? '');
}
