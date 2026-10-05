import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { activities, icps, leads, tasks, users, type Icp, type Lead } from '@/lib/db/schema';
import { DEFAULT_ICPS } from '@/lib/db/seed';
import { settingsSchema } from '@/lib/settings';
import type { Services } from '@/lib/pipeline/services';
import { processLead, type LeadResult } from '@/lib/pipeline/process-lead';
import { buildSources, decideFit, detectRisks, icpCriteria, quoteFound, splitItems, type FitEvidence } from '@/lib/pipeline/fit';
import { canonicalSegment, resolveIcp } from '@/lib/icp-match';
import { icpFor } from '@/lib/tiers';
import { confirmFit, markNotFit, reassessLeads } from '@/lib/reassess';
import { executeRun, startRun } from '@/lib/runs';
import { drawPool } from '@/lib/draw';
import { ensureSequences } from '@/lib/tasks';
import { loadTracker } from '@/lib/tracker';
import { applyStage } from '@/lib/stages';
import { fitAnswer, researchRequest } from './fake-apis';

// ─── A scripted outside world ────────────────────────────────────────────

const KLT_SITE = `<html><head><title>KLT Automotive and Tubular Products Ltd</title></head><body>
<div class="notice">CORPORATE INSOLVENCY RESOLUTION PROCESS (CIRP) INITIATED ON 26TH SEPTEMBER 2024 UNDER INSOLVENCY &amp; BANKRUPTCY CODE, 2016</div>
<h1>KLT Auto</h1>
<p>KLT is the leading authority when it comes to chassis manufacturing for several OEMs in India as well as overseas.</p>
<p>Our manufacturing facilities produce chassis frames, precision tubes and pressed components, with plant equipment including tube mills, presses and robotic welding lines.</p>
</body></html>`;

const SOFTWARE_SITE = `<html><head><title>Acme Stockware</title></head><body>
<h1>Acme Stockware</h1>
<p>Acme Stockware builds cloud inventory audit software for retailers and warehouses. We are a pure software company with no manufacturing of our own.</p>
<p>Book a demo of our stock counting app, used by 400 stores across India, with offline mode and barcode scanning.</p>
<p>Plans start with a free trial. Our support team answers within a day, and onboarding takes less than a week for most retailers.</p>
</body></html>`;

const FORGE_SITE = `<html><head><title>Rathi Forge</title></head><body>
<h1>Rathi Forge</h1>
<p>Welcome to Rathi Forge. We value long relationships with our customers and partners across India, and we are proud of our people.</p>
<p>Contact us for enquiries, careers and vendor registration. Our team will respond within two working days.</p>
<p>Read our latest news, our corporate social responsibility work in nearby villages, and the messages from our founders.</p>
</body></html>`;

type Script = {
  /** The AI's answers to research requests, by how many have been asked so far (0, 1…). */
  research: (user: string, n: number) => unknown;
  /** Its second look at the quotes behind a rejection; by default every quote shows what it claims. */
  check?: (user: string) => unknown;
  /** Google results by query; anything else returns nothing. Throwing means Google is down. */
  google?: (q: string) => { title: string; link: string; snippet: string }[];
  /** The AI that suggests the contact can't be reached. */
  contactAiDown?: boolean;
};

type Seen = { research: string[]; google: string[]; deepseek: number };

function scriptedServices(script: Script, seen: Seen): Services {
  const sites: Record<string, string> = {
    'kltauto.example': KLT_SITE,
    'acmestockware.example': SOFTWARE_SITE,
    'rathiforge.example': FORGE_SITE,
    'advanceforgings.in': `<html><head><title>Advance Forgings | Closed die forgings</title></head><body><h1>Advance Forgings Pvt. Ltd.</h1><p>Advance Forgings Pvt. Ltd. makes closed-die steel forgings and machined components for automotive and engineering customers at its plants, with forging presses, machining lines and a tool room.</p><p>Our manufacturing facilities hold raw steel, dies, WIP forgings and finished stampings across several locations.</p></body></html>`,
    'smithforge.example': `<html><head><title>Home</title></head><body><h1>Welcome</h1><p>We make closed-die steel forgings and machined components for automotive and engineering customers at our plants, with forging presses, machining lines and a tool room.</p><p>Our manufacturing facilities hold raw steel, dies, WIP forgings and finished stampings across several locations, served from one site.</p></body></html>`,
  };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const host = url.hostname.replace(/^www\./, '');
    if (sites[host]) return new Response(sites[host], { status: 200, headers: { 'content-type': 'text/html' } });
    if (url.host === 'r.jina.ai') return new Response('nope', { status: 500 });
    if (url.host === 'google.serper.dev') {
      const { q } = JSON.parse(String(init.body));
      if (url.pathname === '/news') return json({ news: [] });
      // Google Maps: the towns these tests use.
      if (url.pathname === '/maps') {
        const towns: Record<string, { latitude: number; longitude: number }> = { hosur: { latitude: 12.74, longitude: 77.83 }, chennai: { latitude: 13.08, longitude: 80.27 }, coimbatore: { latitude: 11.02, longitude: 76.96 } };
        const hit = Object.entries(towns).find(([k]) => String(q).toLowerCase().startsWith(k))?.[1];
        return json({ places: hit ? [{ title: 'x', ...hit }] : [] });
      }
      seen.google.push(q);
      try {
        return json({ organic: script.google?.(q) ?? [] });
      } catch {
        return new Response('search is down', { status: 500 });
      }
    }
    if (url.host === 'api.hunter.io') return json({ data: { emails: [] } });
    if (url.host === 'api.deepseek.com') {
      seen.deepseek++;
      const body = JSON.parse(String(init.body));
      const system: string = body.messages[0].content;
      const user: string = body.messages[1].content;
      let reply: unknown;
      if (system.startsWith('You are a B2B research analyst')) {
        reply = script.research(user, seen.research.length);
        seen.research.push(user);
      } else if (system.startsWith('You double-check the evidence')) {
        reply = script.check?.(user) ?? { checks: [...user.matchAll(/^- id ([A-Z]+\d*):/gm)].map((m) => ({ id: m[1], supports: true, why: 'Shows it' })) };
      } else if (system.startsWith('You pick the best person') && script.contactAiDown) {
        return new Response('overloaded', { status: 503 });
      } else if (system.startsWith('You pick the best person')) reply = { chosen_id: '', role_match: false, reason: '', other_ids: [], roles_to_find_on_linkedin: [] };
      else if (system.startsWith('You extract the people')) reply = { people: [] };
      else if (system.startsWith('You spot buying signals')) reply = { signals: [] };
      else if (system.startsWith('You write first-touch')) reply = { email_subject: 'Stock checks', email_body: 'Hello,\nBody', linkedin_message: 'Hello' };
      else if (system.startsWith('You write a first-touch LinkedIn')) reply = { linkedin_message: 'Hello' };
      else throw new Error('Unexpected prompt: ' + system.slice(0, 60));
      return json({ choices: [{ finish_reason: 'stop', message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] });
    }
    throw new Error('Unexpected request to ' + url.host);
  }) as typeof fetch;
  return { fetch: fetchFn, keys: { deepseek: 'ds-test', anthropic: '', serper: 'serper-test', jina: '' }, settings: settingsSchema.parse({}) };
}

/** A quote from the numbered source whose text contains `needle`, as the AI should give it. */
function cite(user: string, needle: string): [string, string] {
  const s = researchRequest(user).sources.find((x) => x.text.includes(needle));
  return [needle, s?.id ?? 'S99'];
}

let db: Db;
let seen: Seen;

beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
  seen = { research: [], google: [], deepseek: 0 };
});

async function addLead(values: Partial<typeof leads.$inferInsert> & { company: string }): Promise<Lead> {
  const [row] = await db.insert(leads).values({ segment: 'Manufacturing', ...values }).returning();
  return row;
}

async function allIcps(): Promise<Icp[]> {
  return db.select().from(icps);
}

async function run(lead: Lead, script: Script, icpList?: Icp[]): Promise<LeadResult> {
  return processLead(scriptedServices(script, seen), lead, { icps: icpList ?? (await allIcps()), clients: [] }, () => {});
}

const klt = (extra: Partial<typeof leads.$inferInsert> = {}) => addLead({ company: 'KLT Automotive and Tubular Products', website: 'kltauto.example', city: 'Pune', ...extra });

/** KLT as a careful analyst reads it: a chassis maker (quoted), ERP and size not stated, the CIRP notice as a risk. */
function kltAnswer(user: string, fields: Record<string, unknown> = {}, findings: Parameters<typeof fitAnswer>[2] = {}) {
  const [maker, s] = cite(user, 'KLT is the leading authority when it comes to chassis manufacturing for several OEMs in India as well as overseas');
  const [notice, n] = cite(user, 'CORPORATE INSOLVENCY RESOLUTION PROCESS (CIRP) INITIATED ON 26TH SEPTEMBER 2024');
  return fitAnswer(
    user,
    { summary: 'Chassis and precision tube maker for OEMs', risks: [{ kind: 'insolvency', evidence: notice, source: n }], fit_reason: 'Chassis manufacturer with plants: a strong fit; the insolvency process is a commercial risk, not a fit issue', ...fields },
    { M1: ['met', maker, s], P1: ['unknown', 'No ERP or WMS mentioned', ''], GEO: ['met', maker, s], IND: ['met', maker, s], ...findings },
  );
}

// ─── Reading the ICP ─────────────────────────────────────────────────────

describe('criteria from the ICP settings', () => {
  it('reads must-haves, pluses, deal-breakers and targets from the Manufacturing ICP', () => {
    const criteria = icpCriteria(DEFAULT_ICPS[0]);
    expect(criteria.map((c) => [c.id, c.kind])).toEqual([
      ['M1', 'requirement'],
      ['P1', 'preference'],
      ['D1', 'deal_breaker'],
      ['D2', 'deal_breaker'],
      ['D3', 'deal_breaker'],
      ['SIZE', 'size'],
      ['GEO', 'geography'],
      ['IND', 'industry'],
    ]);
    // "ERP or WMS in use is a plus" is wanted, never required.
    expect(criteria[1].text).toMatch(/^ERP or WMS in use is a plus/);
  });

  it('splits at semicolons and new lines but not inside brackets or at commas', () => {
    expect(splitItems('No physical inventory (software; services, consulting); a single small shop\n- sells audit software')).toEqual([
      'No physical inventory (software; services, consulting)',
      'a single small shop',
      'sells audit software',
    ]);
  });
});

describe('matching a lead to its ICP', () => {
  const list = [
    { id: 1, segment: 'Manufacturing', active: true },
    { id: 2, segment: '3PL & Logistics', active: true },
    { id: 3, segment: 'CA Firms', active: false },
  ];

  it('needs the one active ICP the segment names, ignoring case, spacing and punctuation', () => {
    expect(resolveIcp(' manufacturing ', list).icp?.id).toBe(1);
    expect(resolveIcp('3pl and logistics', list).icp?.id).toBe(2);
    expect(resolveIcp('', list)).toMatchObject({ problem: 'missing' });
    expect(resolveIcp('Pharma', list)).toMatchObject({ problem: 'unknown' });
    expect(resolveIcp('CA Firms', list)).toMatchObject({ problem: 'inactive' });
    expect(resolveIcp('Manufacturing', [...list, { id: 4, segment: 'MANUFACTURING', active: true }])).toMatchObject({ problem: 'ambiguous' });
  });

  it('never falls back to another ICP for contact lists either', () => {
    expect(icpFor('Pharma', list)).toBeUndefined();
    expect(icpFor('', list)).toBeUndefined();
    // A switched-off ICP still ranks the contacts of its own leads.
    expect(icpFor('ca firms', list)?.id).toBe(3);
  });

  it('keeps a typed segment no ICP has as typed, instead of swapping in the first ICP', () => {
    expect(canonicalSegment('manufacturing', ['Manufacturing', 'CA Firms'])).toBe('Manufacturing');
    expect(canonicalSegment('Pharma', ['Manufacturing', 'CA Firms'])).toBe('Pharma');
  });
});

// ─── Evidence ────────────────────────────────────────────────────────────

describe('checking quotes and risks', () => {
  const page = 'KLT is the leading authority when it comes to chassis manufacturing for several OEMs in India as well as overseas.';

  it('accepts a quote word for word or with small slips, never an invented one', () => {
    expect(quoteFound('leading authority when it comes to CHASSIS manufacturing', page)).toBe(true);
    expect(quoteFound('KLT is the leading authority for chassis manufacturing for several OEMs in India', page)).toBe(true);
    expect(quoteFound('The company is a pure trading firm with no inventory of its own', page)).toBe(false);
    expect(quoteFound('several OEMs … as well as overseas', page)).toBe(true);
    expect(quoteFound('', page)).toBe(false);
  });

  it("finds a company's own insolvency notice, not a CA firm's IBC services", () => {
    const [risk] = detectRisks([{ url: 'https://kltauto.example/', text: 'CORPORATE INSOLVENCY RESOLUTION PROCESS (CIRP) INITIATED ON 26TH SEPTEMBER 2024 UNDER INSOLVENCY & BANKRUPTCY CODE, 2016' }]);
    expect(risk).toMatchObject({ kind: 'insolvency', url: 'https://kltauto.example/', verified: true });
    expect(risk.evidence).toContain('CIRP');
    expect(detectRisks([{ url: 'https://ca.example/', text: 'We advise lenders on the Insolvency and Bankruptcy Code and IBC proceedings.' }])).toEqual([]);
    // Google's line for KLT's resolution page names the process as KLT's own.
    const page = { url: 'https://kltauto.com/resolution-process.html', text: 'Corporate Insolvency Resolution Process of KLT Automotive & Tubular Products Limited NCLT Petitions and Orders.' };
    expect(detectRisks([page], 'KLT Automotive and Tubular Products')[0]).toMatchObject({ kind: 'insolvency', url: page.url });
    expect(detectRisks([{ url: 'https://ca.example/', text: 'We handle the corporate insolvency resolution process of companies for lenders.' }], 'Kirtane & Pandit')).toEqual([]);
  });

  it('adds a notice cut off from its page as a source of its own, so it can be quoted', () => {
    const long = `${'Our plants make parts. '.repeat(1000)}\nA resolution professional has been appointed by the NCLT.`;
    const { sources, risks } = buildSources([{ url: 'https://x.example/', title: '', text: long }]);
    expect(risks).toHaveLength(1);
    expect(sources).toHaveLength(2);
    expect(sources[1].text).toContain('resolution professional has been appointed');
  });
});

describe('the decision rules', () => {
  const e = (over: Partial<FitEvidence>): FitEvidence => ({ id: 'M1', kind: 'requirement', criterion: 'Makes physical goods', status: 'met', evidence: 'We make parts', source: 'S1', url: 'https://x.example/', verified: true, ...over });

  it('rules a company out only on verified evidence', () => {
    expect(decideFit([e({ status: 'not_met', evidence: 'We are a bank' })], []).status).toBe('not_fit');
    expect(decideFit([e({}), e({ id: 'D1', kind: 'deal_breaker', criterion: 'Pure software', evidence: 'We sell software' })], []).status).toBe('not_fit');
    // The same claims without a quote found in a source: review, not rejection.
    expect(decideFit([e({ status: 'not_met', verified: false })], []).status).toBe('review');
    expect(decideFit([e({}), e({ id: 'D1', kind: 'deal_breaker', verified: false })], []).status).toBe('review');
  });

  it('sends unconfirmed must-haves and missed targets to review, and qualifies the rest', () => {
    expect(decideFit([e({ status: 'unknown', evidence: '', source: '', url: '', verified: false })], []).status).toBe('review');
    expect(decideFit([e({}), e({ id: 'SIZE', kind: 'size', status: 'not_met', evidence: '12 employees' })], []).status).toBe('review');
    const ok = decideFit([e({}), e({ id: 'P1', kind: 'preference', status: 'not_met' }), e({ id: 'SIZE', kind: 'size', status: 'unknown', verified: false })], []);
    expect(ok.status).toBe('qualified');
    // Met from what is widely known still counts, and says so.
    expect(decideFit([e({ source: 'K', url: '', verified: false })], []).reason).toContain('widely known');
  });
});

// ─── The cases from the KLT investigation ───────────────────────────────

describe('an automotive manufacturer with evidenced physical operations (KLT)', () => {
  it('qualifies on the quoted evidence; ERP and size not being stated cost it nothing', async () => {
    const r = await run(await klt(), { research: (user) => kltAnswer(user) });
    expect(r.fitStatus).toBe('qualified');
    expect(r.qualified).toBe(true);
    expect(r.fitScore).toBe(8);
    expect(r.status).not.toBe('Disqualified');
    expect(r.fitEvidence?.find((x) => x.id === 'M1')).toMatchObject({ status: 'met', verified: true, url: 'https://kltauto.example/' });
    expect(r.fitEvidence?.find((x) => x.id === 'P1')?.status).toBe('unknown');
    expect(r.fitEvidence?.find((x) => x.id === 'SIZE')?.status).toBe('unknown');
    expect(r.fitDecision).toMatch(/^Meets every must-have/);
    expect(r.assessedIcp).toBe('Manufacturing');
  });

  it('records the insolvency notice as commercial risk, apart from the fit, when the ICP does not exclude it', async () => {
    const r = await run(await klt(), { research: (user) => kltAnswer(user) });
    expect(r.fitStatus).toBe('qualified');
    expect(r.riskFlags).toHaveLength(1);
    expect(r.riskFlags?.[0]).toMatchObject({ kind: 'insolvency', url: 'https://kltauto.example/', verified: true });
    // The AI was shown the notice and told it isn't a fit issue.
    expect(seen.research[0]).toContain('## Notices found in the sources');
  });

  it('rules it out on the notice when the ICP makes insolvency a deal-breaker', async () => {
    const strict = (await allIcps()).map((i) => (i.segment === 'Manufacturing' ? { ...i, dealBreakers: `${i.dealBreakers}; Company under insolvency or liquidation proceedings` } : i));
    const r = await run(
      await klt(),
      {
        research: (user) => {
          const [notice, n] = cite(user, 'CORPORATE INSOLVENCY RESOLUTION PROCESS (CIRP) INITIATED ON 26TH SEPTEMBER 2024');
          return kltAnswer(user, { qualified: false, fit_reason: 'Meets the must-haves but the insolvency deal-breaker applies' }, { D4: ['met', notice, n] });
        },
      },
      strict,
    );
    expect(r.status).toBe('Disqualified');
    expect(r.fitStatus).toBe('not_fit');
    expect(r.fitDecision).toContain('deal-breaker “Company under insolvency or liquidation proceedings” applies');
    expect(r.fitDecision).toContain('https://kltauto.example/');
    // Ruled out on evidence before any contact search.
    expect(seen.google.filter((q) => !q.startsWith('site:'))).toEqual([]);
  });

  it('goes to review, not through, when the ICP excludes insolvency but the AI ignores the notice', async () => {
    const strict = (await allIcps()).map((i) => (i.segment === 'Manufacturing' ? { ...i, dealBreakers: `${i.dealBreakers}; Company under insolvency or liquidation proceedings` } : i));
    const r = await run(await klt(), { research: (user) => kltAnswer(user, {}, { D4: ['unknown', '', ''] }) }, strict);
    expect(r.status).toBe('Needs Review');
    expect(r.fitDecision).toContain('may apply');
    expect(seen.research).toHaveLength(2);
  });
});

describe('AI answers that are malformed or contradict themselves', () => {
  it('missing fields and wrong types: asked again, then review; never Disqualified', async () => {
    const r = await run(await klt(), { research: () => ({ summary: 'x', qualified: 'false', fit_score: '2', fit_reason: { why: 'no' } }) });
    expect(seen.research).toHaveLength(2);
    expect(seen.research[1]).toContain('## Your previous answer was rejected');
    expect(r.status).toBe('Needs Review');
    expect(r.qualified).toBeNull();
    expect(r.fitScore).toBeNull();
    expect(r.fitDecision).toContain('failed the checks');
  });

  it('a malformed first answer followed by a good one qualifies', async () => {
    const r = await run(await klt(), { research: (user, n) => (n === 0 ? { ...kltAnswer(user), criteria: [] } : kltAnswer(user)) });
    expect(seen.research).toHaveLength(2);
    expect(r.fitStatus).toBe('qualified');
  });

  it('a score that contradicts the verdict goes to review', async () => {
    const r = await run(await klt(), { research: (user) => kltAnswer(user, { fit_score: 9, qualified: false }) });
    expect(seen.research).toHaveLength(2);
    expect(r.status).toBe('Needs Review');
    expect(r.fitDecision).toContain('contradicts its evidence');
  });

  it('a low score alone does not reject a company that meets every criterion', async () => {
    // Self-consistent (3/10, not qualified) but nothing evidenced against it: that is not a rejection.
    const r = await run(await klt(), { research: (user) => kltAnswer(user, { fit_score: 3, qualified: false, fit_reason: 'In insolvency, low priority' }) });
    expect(r.status).toBe('Needs Review');
    expect(r.qualified).toBeNull();
    expect(r.fitScore).toBe(3);
    expect(r.fitDecision).toContain('no must-have shown not met');
  });

  it('a rejection quote the source does not contain cannot rule a company out', async () => {
    const google = (q: string) =>
      q.startsWith('site:') ? [] : [{ title: 'Rathi Forge - forging plant in Chakan', link: 'https://directory.example/rathi', snippet: 'Rathi Forge manufactures forged crankshafts and axle beams at its Chakan plant.' }];
    const r = await run(await addLead({ company: 'Rathi Forge', website: 'rathiforge.example', city: 'Pune' }), {
      google,
      research: (user, n) => {
        if (n === 0) return fitAnswer(user, { fit_score: 2, qualified: false }, { M1: ['not_met', 'Rathi Forge is a trading company with no manufacturing', 'S1'] });
        const [made, s] = cite(user, 'Rathi Forge manufactures forged crankshafts and axle beams at its Chakan plant');
        return fitAnswer(user, {}, { M1: ['met', made, s] });
      },
    });
    // The invented quote put it to one more search, whose result settled it.
    expect(seen.google.some((q) => q.includes('"Rathi Forge"'))).toBe(true);
    expect(r.fitStatus).toBe('qualified');
    expect(r.fitEvidence?.find((x) => x.id === 'M1')).toMatchObject({ status: 'met', verified: true, url: 'https://directory.example/rathi' });
  });

  it('a must-have still unconfirmed after searching further goes to review', async () => {
    const r = await run(await addLead({ company: 'Rathi Forge', website: 'rathiforge.example' }), {
      google: (q) => (q.startsWith('site:') ? [] : [{ title: 'Rathi Forge', link: 'https://news.example/r', snippet: 'Rathi Forge celebrates 25 years.' }]),
      research: (user) => fitAnswer(user, {}, { M1: ['unknown', 'Nothing says what it makes', ''] }),
    });
    expect(seen.research).toHaveLength(2);
    expect(r.status).toBe('Needs Review');
    expect(r.fitDecision).toContain('couldn\'t confirm must-have');
  });
});

describe('a rejection resting on a quote that does not show the failure', () => {
  it('is not ruled out: the quote is set aside on a second look and the company goes to review', async () => {
    const r = await run(await addLead({ company: 'Acme Stockware', website: 'acmestockware.example' }), {
      research: (user) => {
        const [unrelated, s] = cite(user, 'Our support team answers within a day');
        return fitAnswer(user, { fit_score: 2, qualified: false }, { M1: ['not_met', unrelated, s] });
      },
      check: (user) => ({ checks: [{ id: /^- id ([A-Z]+\d*):/m.exec(user)![1], supports: false, why: 'It is about customer support, not what the company makes' }] }),
      google: (q) => (q.startsWith('site:') ? [] : [{ title: 'Acme Stockware', link: 'https://news.example/a', snippet: 'Acme Stockware raises funds.' }]),
    });
    expect(r.status).toBe('Needs Review');
    expect(r.fitDecision).toContain('the quote doesn\'t show it');
    expect(r.fitEvidence?.find((x) => x.id === 'M1')).toMatchObject({ verified: false, check: 'It is about customer support, not what the company makes' });
  });

  it('an unreadable second look confirms nothing: review, not rejection', async () => {
    const r = await run(await addLead({ company: 'Acme Stockware', website: 'acmestockware.example' }), {
      research: (user) => {
        const [what, s] = cite(user, 'We are a pure software company with no manufacturing of our own');
        return fitAnswer(user, { fit_score: 1, qualified: false }, { M1: ['not_met', what, s] });
      },
      check: () => 'not json at all',
    });
    expect(r.status).toBe('Needs Review');
    expect(r.qualified).toBeNull();
  });
});

describe('segments that name no usable ICP', () => {
  it('unknown, missing or switched off: flagged for review without researching or guessing', async () => {
    await db.update(icps).set({ active: false }).where(eq(icps.segment, 'CA Firms'));
    const research = () => {
      throw new Error('should not be asked');
    };
    const pharma = await run(await addLead({ company: 'Pharma Co', segment: 'Pharma' }), { research });
    const blank = await run(await addLead({ company: 'Blank Co', segment: '' }), { research });
    const off = await run(await addLead({ company: 'Audit Co', segment: 'CA Firms' }), { research });
    expect(pharma).toMatchObject({ status: 'Needs Review', fitStatus: 'review', qualified: null, assessedIcp: '' });
    expect(pharma.fitDecision).toContain('Segment "Pharma" matches no ICP');
    expect(blank.fitDecision).toContain('No segment set');
    expect(off.fitDecision).toContain('switched off');
    expect(seen.deepseek).toBe(0);
    // The lead's segment isn't overwritten with another ICP's.
    expect(pharma.segment).toBeUndefined();
  });
});

describe('a genuinely unsuitable company', () => {
  it('is ruled out with the quote that shows it, before any contact search', async () => {
    const r = await run(await addLead({ company: 'Acme Stockware', website: 'acmestockware.example' }), {
      research: (user) => {
        const [what, s] = cite(user, 'We are a pure software company with no manufacturing of our own');
        const [sells, s2] = cite(user, 'Acme Stockware builds cloud inventory audit software for retailers and warehouses');
        return fitAnswer(user, { fit_score: 1, qualified: false, fit_reason: 'Sells inventory software' }, { M1: ['not_met', what, s], D1: ['met', what, s], D3: ['met', sells, s2] });
      },
    });
    expect(r.status).toBe('Disqualified');
    expect(r.fitStatus).toBe('not_fit');
    expect(r.qualified).toBe(false);
    expect(r.fitDecision).toContain('fails must-have');
    expect(r.fitDecision).toContain('pure software company');
    expect(seen.google.filter((q) => !q.startsWith('site:'))).toEqual([]);
  });
});

describe('finding contacts is separate from the fit', () => {
  it('a failed contact search leaves the company fit as assessed', async () => {
    const r = await run(await klt(), {
      research: (user) => kltAnswer(user),
      // Google is down for every search (LinkedIn profiles, leaders, emails).
      google: () => {
        throw new Error('down');
      },
    });
    expect(r.otherDecisionMakers).toContain('LinkedIn search error');
    expect(r.status).toBe('Needs Manual Contact');
    expect(r).toMatchObject({ fitStatus: 'qualified', qualified: true, fitScore: 8 });
    expect(r.fitDecision).toMatch(/^Meets every must-have/);
  });
});

describe('Auto Diecasting Company (ADC): a CEO found with no location shown', () => {
  it('is kept as a candidate pending verification, not rejected as working elsewhere', async () => {
    const hari = { title: 'Hari Viswanathan - CEO, Auto Diecasting Company | LinkedIn', link: 'https://in.linkedin.com/in/hari-viswanathan', snippet: 'Experience: 18 years of experience in high pressure diecasting, with a focus on incorporating cutting-edge technologies for improved production processes.' };
    const r = await run(await klt({ company: 'Auto Diecasting Company (ADC)', city: 'Coimbatore' }), {
      research: (user) => kltAnswer(user, { risks: [] }),
      google: (q) => (q.startsWith('site:linkedin.com/in') ? [hari] : []),
    });
    const person = r.people?.find((p) => p.name === 'Hari Viswanathan');
    expect(person).toMatchObject({ title: 'CEO', passedReason: 'unverified' });
    expect(person?.whyNot).toContain('Corporate contact (CEO, a company-wide role), for review; no location shown');
    expect(r.otherDecisionMakers).not.toContain('another company');
  });
});

describe('Alumina India Casting: the managing partner of a small firm', () => {
  const nandini = { title: 'Nandini Easwaran - Managing Partner - Alumina India Casting Company | LinkedIn', subtitle: 'Chennai, Tamil Nadu, India · Managing Partner · Alumina India Casting Company', link: 'https://in.linkedin.com/in/nandini-easwaran', snippet: '' };
  const lead = () => klt({ company: 'Alumina India Casting', city: 'Coimbatore' });

  it('with only a Chennai profile, is kept as a potential company contact pending verification', async () => {
    const r = await run(await lead(), { research: (user) => kltAnswer(user, { risks: [] }), google: (q) => (q.startsWith('site:linkedin.com/in') ? [nandini] : []) });
    expect(r.contactName ?? '').toBe('');
    const person = r.people?.find((p) => p.name === 'Nandini Easwaran');
    expect(person).toMatchObject({ title: 'Managing Partner', location: 'Chennai, Tamil Nadu, India', passedReason: 'unverified' });
    expect(person?.whyNot).toContain('Corporate contact (Managing Partner, a company-wide role), for review');
    expect(person?.whyNot).toContain('not a Coimbatore site contact unless confirmed there');
  });

  it('with her current job shown in Coimbatore, becomes the main contact', async () => {
    const withJob = { ...nandini, snippet: 'Managing Partner. Alumina India Casting Company. Jan 2010 - Present · 14 yrs 9 mos. Coimbatore, Tamil Nadu, India' };
    const r = await run(await lead(), { research: (user) => kltAnswer(user, { risks: [] }), google: (q) => (q.startsWith('site:linkedin.com/in') ? [withJob] : []) });
    expect(r.contactName).toBe('Nandini Easwaran');
    expect(r.people?.find((p) => p.isPrimary)).toMatchObject({ jobLocation: 'Coimbatore, Tamil Nadu, India', location: 'Chennai, Tamil Nadu, India' });
  });
});

describe('EL Forge Limited (Hosur): corporate contacts in Chennai, and why nobody is the main contact', () => {
  const results = [
    { title: 'Srihari K.R - Chief Executive Officer at El Forge Ltd.', subtitle: 'India · Chief Executive Officer · El Forge Ltd.', link: 'https://in.linkedin.com/in/srihari-kr', snippet: 'Experienced Chief Operating Officer with a demonstrated history of working in the steel forgings industry. Skilled in Business Planning, Operations Management, ...' },
    { title: 'NIRMAL KUMAR DEBNATH - EXECUTIVE DIRECTOR at ...', subtitle: 'Chennai, Tamil Nadu, India · EXECUTIVE DIRECTORSINCE 1999. · EL FORGE LTD.', link: 'https://in.linkedin.com/in/nirmal-debnath', snippet: 'Experience · EXECUTIVE DIRECTORSINCE 1999. EL FORGE LTD. Nov 1992 - Present 33 years 11 months · GENERAL MANAGER(QA). KELTRON,TRIVANDRUM. Apr 1980 - Oct 1992 12 ...' },
    { title: 'vignesh swaminathan - Deputy Manager @ EL FORGE ...', subtitle: 'Chennai, Tamil Nadu, India · Deputy Manager · El Forge Ltd.', link: 'https://in.linkedin.com/in/vignesh-swaminathan', snippet: 'Deputy Manager. El Forge Ltd. Jun 2024 - Present 2 years 4 months · Head of Production. ASIAAN METALS & ALUMINIUM CASTING PRIVATE LIMITED. Feb 2024 - May 2024 4 ...' },
    { title: 'RAMACHANDRAN TK - el forge ltd', subtitle: 'Chennai, Tamil Nadu, India · President & Chief Technical Officer · EL FORGE LTD', link: 'https://in.linkedin.com/in/ramachandran-tk', snippet: 'President & Chief Technical Officer at EL FORGE LTD · Experience: EL FORGE LTD · Location: Chennai · 1 connection on LinkedIn.' },
  ];

  it('keeps the corporate contacts with the reason each is not the Hosur contact, and searches for the leadership', async () => {
    const r = await run(await klt({ company: 'EL Forge Limited', city: 'Hosur' }), {
      research: (user) => kltAnswer(user, { risks: [] }),
      google: (q) => (q.startsWith('site:linkedin.com/in') ? results : []),
    });
    // A Chennai profile never becomes the Hosur plant contact on its own.
    expect(r.contactName ?? '').toBe('');
    const by = Object.fromEntries((r.people ?? []).map((p) => [p.name, p]));
    // The Executive Director isn't kept (directors, other than the MD, aren't contacted), nor is a
    // Deputy Manager with no department (off the ICP lists).
    expect(Object.keys(by).sort()).toEqual(['RAMACHANDRAN TK', 'Srihari K.R']);
    for (const name of ['Srihari K.R', 'RAMACHANDRAN TK']) {
      expect(by[name]).toMatchObject({ passedReason: 'unverified' });
      expect(by[name].whyNot).toMatch(/^Corporate contact \(.+, a company-wide role\), for review/);
    }
    expect(by['Srihari K.R'].title).toBe('Chief Executive Officer');
    expect(by['RAMACHANDRAN TK'].title).toBe('President & Chief Technical Officer');
    // The search also asked for the company's leadership, as nobody was found at Hosur.
    expect(seen.google.some((q) => q.includes('"chief executive"'))).toBe(true);

    const { contactAvailability } = await import('@/lib/fit-view');
    const shown = contactAvailability({ ...r, contactName: '', contactTitle: '', contactEmail: '', emailStatus: '', contactLinkedin: '', contactVerifiedAt: null, city: 'Hosur', status: 'Needs Manual Contact', qualified: true } as never, (r.people ?? []) as never);
    expect(shown.label).toBe('Company contacts found; no Hosur contact confirmed');
    expect(shown.detail).toContain('Srihari K.R (Chief Executive Officer)');
    expect(shown.detail).toMatch(/^Corporate contacts for review: /);
    // Everyone else is counted, not listed: their reasons are under People.
    expect(shown.detail).not.toContain('vignesh');
    expect(shown.detail).not.toContain('NIRMAL');
    expect(shown.detail.length).toBeLessThan(400);
  });
});

describe('the company name, checked against its own website (Advance Forgings)', () => {
  it('corrects a name a letter off the one its website and domain show, before searching or drafting', async () => {
    const lead = await addLead({ company: 'Advanced Forgings Pvt. Ltd.', website: 'advanceforgings.in', city: 'Pune' });
    const r = await run(lead, { research: (user) => fitAnswer(user) });
    expect(r).toMatchObject({ company: 'Advance Forgings Pvt. Ltd.', nameAsFound: 'Advanced Forgings Pvt. Ltd.' });
    expect(r.nameEvidence).toContain('its website names it "Advance Forgings Pvt. Ltd."');
    // Nothing was searched under the wrong name.
    expect(seen.google.filter((q) => /Advanced Forgings/i.test(q))).toEqual([]);
    expect(seen.research.every((u) => !u.includes('Advanced Forgings'))).toBe(true);
  });

  it('a website that shows no name: the spelling its own domain uses is taken, before any research', async () => {
    const lead = await addLead({ company: 'Smith Forges', website: 'smithforge.example', city: 'Pune' });
    const r = await run(lead, { research: (user) => fitAnswer(user) });
    expect(r).toMatchObject({ company: 'Smith Forge', nameAsFound: 'Smith Forges' });
    expect(r.status).not.toBe('Needs Review');
    expect(seen.research.every((u) => !u.includes('Smith Forges'))).toBe(true);
  });

  it('a name its website shows is confirmed; a domain unlike the name is normal', async () => {
    const { checkCompanyName } = await import('@/lib/pipeline/company-name');
    expect(checkCompanyName('Advance Forgings Pvt Ltd', 'advanceforgings.in', 'Title: Advance Forgings').status).toBe('confirmed');
    expect(checkCompanyName('Lumax Auto Technologies', 'lumaxworld.in', 'Title: Lumax World').status).toBe('unchecked');
    // The live site shows no name: the domain decides the spelling.
    expect(checkCompanyName('Advanced Forgings Pvt. Ltd.', 'advanceforgings.in', 'Title: Home')).toMatchObject({ status: 'corrected', name: 'Advance Forgings Pvt. Ltd.' });
    expect(checkCompanyName('ADVANCED FORGINGS', 'advanceforgings.in', '')).toMatchObject({ status: 'corrected', name: 'ADVANCE FORGINGS' });
    // A brand spelled its own way in its domain is not a typo in the name.
    expect(checkCompanyName('Finder Co', 'findr.in', '').name).toBe('Finder Co');
  });
});

describe('contacts: the review of the contact pipeline', () => {
  const plantHead = (subtitle: string, snippet = '') => ({ title: 'Karthik R - Plant Head - Hosur Gears', subtitle, link: 'https://in.linkedin.com/in/karthik-r', snippet });

  it('"India" is a missing location: looked up by name, and the job\'s own location (Hosur) is kept, not just the home city', async () => {
    const lead = await klt({ company: 'Hosur Gears', city: 'Hosur' });
    const r = await run(lead, {
      research: (user) => kltAnswer(user, { risks: [] }),
      google: (q) =>
        q.includes('"Karthik R"')
          ? [plantHead('Bengaluru, Karnataka, India · Plant Head · Hosur Gears', 'Plant Head. Hosur Gears. Jan 2020 - Present 4 years. Hosur, Tamil Nadu, India')]
          : q.startsWith('site:linkedin.com/in')
            ? [plantHead('India · Plant Head · Hosur Gears')]
            : [],
    });
    expect(r.contactName).toBe('Karthik R');
    expect(r.people?.find((p) => p.isPrimary)).toMatchObject({ location: 'Bengaluru, Karnataka, India', jobLocation: 'Hosur, Tamil Nadu, India' });
  });

  it('the AI being down still gives a contact: INVECK\'s ranking picks from the LinkedIn candidates found', async () => {
    const lead = await klt({ company: 'Hosur Gears', city: 'Hosur' });
    const r = await run(lead, {
      contactAiDown: true,
      research: (user) => kltAnswer(user, { risks: [] }),
      google: (q) => (q.startsWith('site:linkedin.com/in') ? [plantHead('Hosur, Tamil Nadu, India · Plant Head · Hosur Gears')] : []),
    });
    expect(r.contactName).toBe('Karthik R');
    expect(r.status).toBe('Awaiting Approval');
    expect(r.otherDecisionMakers).toContain("Contact picked by INVECK's ranking alone");
  });

  it('a company prospect search put in the wrong segment is checked against the other ICPs and moved to the one it fits', async () => {
    // A chassis maker the search labelled 3PL: not a 3PL, a manufacturer.
    const answer = (user: string) =>
      !user.includes('## ICP: Manufacturing')
        ? kltAnswer(user, { qualified: false, fit_score: 2 }, { M1: ['not_met', ...cite(user, 'KLT is the leading authority when it comes to chassis manufacturing for several OEMs in India as well as overseas')] })
        : kltAnswer(user, { risks: [] });
    const found = await klt({ segment: '3PL & Logistics', source: 'Found by prospect search' });
    const r = await run(found, { research: answer });
    expect(r.segment).toBe('Manufacturing');
    expect(r.status).not.toBe('Disqualified');
    // A segment the team chose is never second-guessed.
    const typed = await klt({ company: 'KLT Typed', segment: '3PL & Logistics', source: '' });
    const t = await run(typed, { research: answer });
    expect(t.status).toBe('Disqualified');
  });

  it('a firm imported with its partners keeps them through research: the main contact stays, the fit stays confirmed', async () => {
    const { importContactSheet, parseContactSheet } = await import('@/lib/contact-import');
    const { KnownBranches } = await import('@/lib/branches');
    const { people } = await import('@/lib/db/schema');
    const { rows } = parseContactSheet([
      ['Firm', 'Phone', 'Email', 'Matched partner / proprietor', 'Role', 'LinkedIn 1', 'LinkedIn 2'],
      ['ALPHA & CO', '9800000002', 'alpha@example.com', '1. Ravi Kumar\n2. Meena Iyer', 'Partner', 'https://in.linkedin.com/in/ravi-k', 'https://in.linkedin.com/in/meena-i'],
    ]);
    await importContactSheet(db, rows, { segment: 'CA Firms', ownerId: null, known: new KnownBranches([], []), by: 'Puja' });
    const [lead] = await db.select().from(leads).where(eq(leads.company, 'ALPHA & CO'));
    // The AI would call it not a fit: the team's call stands.
    // CA Firms switched off for the prospect search: the team's list is still worked under it.
    const off = (await allIcps()).map((i) => (i.segment === 'CA Firms' ? { ...i, active: false } : i));
    const r = await run(lead, { research: (user) => kltAnswer(user, { qualified: false, fit_score: 2 }), google: () => [] }, off);
    expect(r.status).toBe('Awaiting Approval');
    expect(r.segment ?? 'CA Firms').toBe('CA Firms');
    expect(r.contactName ?? lead.contactName).toBe('Ravi Kumar');
    const names = (await db.select().from(people).where(eq(people.leadId, lead.id))).map((p) => p.name);
    expect(names).toContain('Meena Iyer');
  });

  it('the AI being down never bypasses the checks: role, employer and site still decide', async () => {
    const lead = await klt({ company: 'Hosur Gears', city: 'Hosur' });
    const results = [
      { title: 'Asha R - HR Manager - Hosur Gears', subtitle: 'Hosur, Tamil Nadu, India · HR Manager · Hosur Gears', link: 'https://in.linkedin.com/in/asha-r', snippet: '' },
      { title: 'Vikram P - Plant Head - Hosur Gears', subtitle: 'Chennai, Tamil Nadu, India · Plant Head · Hosur Gears', link: 'https://in.linkedin.com/in/vikram-p', snippet: '' },
      { title: 'Divya N - Plant Head', subtitle: '', link: 'https://in.linkedin.com/in/divya-n', snippet: 'Plant Head. Hosur Gears. Jan 2015 - Dec 2022 8 years. Hosur, Tamil Nadu, India' },
      { title: 'Meena S - Plant Head', subtitle: 'Hosur, Tamil Nadu, India · Consultant · Lean Partners', link: 'https://in.linkedin.com/in/meena-s', snippet: 'Plant Head. Hosur Gears Pvt Ltd. Jan 2023 - Present. Hosur, Tamil Nadu, India' },
    ];
    const r = await run(lead, { contactAiDown: true, research: (user) => kltAnswer(user, { risks: [] }), google: (q) => (q.startsWith('site:linkedin.com/in') ? results : []) });
    // HR (role), left in 2022 (employer), two current jobs (unverified) are ruled out; the plant head
    // at another site (Chennai) is a P1, which comes before anyone lower at this site.
    expect(r.contactName).toBe('Vikram P');
    const meena = r.people?.find((p) => p.name === 'Meena S');
    expect(meena).toMatchObject({ isPrimary: false, passedReason: 'unverified' });
    expect(meena?.whyNot).toContain('needs verification');
    expect(r.people?.some((p) => p.name === 'Divya N')).toBe(false);
  });

  it('research again that finds nobody clears the earlier (non-team) contact instead of leaving it showing', async () => {
    const lead = await klt({
      company: 'Hosur Gears',
      city: 'Hosur',
      researchSummary: 'Makes gears.',
      contactName: 'Old Person',
      contactTitle: 'Plant Head',
      contactLinkedin: 'https://in.linkedin.com/in/old-person',
      status: 'Awaiting Approval',
    });
    const r = await run(lead, { research: (user) => kltAnswer(user, { risks: [] }), google: () => [] });
    expect(r).toMatchObject({ contactName: '', contactTitle: '', contactLinkedin: '', status: 'Needs Manual Contact' });
  });

  it("research again keeps the team's own contact when nobody is found", async () => {
    const lead = await klt({ company: 'Hosur Gears', city: 'Hosur', contactName: 'Team Pick', contactTitle: 'Plant Head', contactPhone: '9876543210' });
    const r = await run(lead, { research: (user) => kltAnswer(user, { risks: [] }), google: () => [] });
    expect(r.contactName ?? 'Team Pick').toBe('Team Pick');
  });
});

// ─── Reassessing, and a person's own call ────────────────────────────────

describe('reassessing companies ruled out before', () => {
  it('requeues only the chosen ruled-out leads, keeping their earlier assessment on the timeline', async () => {
    const old = await klt({ status: 'Disqualified', qualified: false, fitScore: 3, fitReason: 'Under insolvency; low priority', researchSummary: 'KLT makes chassis frames.' });
    const other = await addLead({ company: 'Other Rejected', status: 'Disqualified', qualified: false, fitScore: 2, fitReason: 'Bank' });
    const good = await addLead({ company: 'Working Co', status: 'Awaiting Approval', qualified: true, fitScore: 8 });

    expect(await reassessLeads(db, [old.id, good.id], 'Admin')).toBe(1);
    const after = Object.fromEntries((await db.select().from(leads)).map((l) => [l.company, l]));
    expect(after[old.company]).toMatchObject({ status: 'New', researchAttempts: 0, fitScore: 3, fitReason: 'Under insolvency; low priority', researchSummary: 'KLT makes chassis frames.' });
    expect(after['Other Rejected']).toMatchObject({ status: 'Disqualified', fitScore: 2 });
    expect(after['Working Co']).toMatchObject({ status: 'Awaiting Approval', fitScore: 8 });
    const notes = (await db.select().from(activities).where(eq(activities.leadId, old.id))).map((a) => a.text);
    expect(notes.find((t) => t.startsWith('Fit reassessment asked for by Admin'))).toContain('Earlier assessment: Disqualified, ICP fit 3/10');
    expect(notes.join('\n')).toContain('Under insolvency; low priority');
    expect(notes.join('\n')).toContain('KLT makes chassis frames.');

    // Researched again under the evidence rules: a fit, with the insolvency kept apart.
    const { run: r } = await startRun(db, { findProspects: false, trigger: 'test' });
    await executeRun(db, r.id, scriptedServices({ research: (user) => kltAnswer(user) }, seen), Number.POSITIVE_INFINITY);
    const [now] = await db.select().from(leads).where(eq(leads.id, old.id));
    expect(now).toMatchObject({ fitStatus: 'qualified', qualified: true, fitScore: 8 });
    expect(now.status).toMatch(/^(Awaiting Approval|Needs Manual Contact)$/);
    expect(now.riskFlags[0]?.kind).toBe('insolvency');
    // The lead nobody chose was never researched.
    expect((await db.select().from(leads).where(eq(leads.id, other.id)))[0].status).toBe('Disqualified');
  });

  it("a person's confirmed fit stands: research finds contacts without assessing the fit again", async () => {
    const lead = await klt({ status: 'Needs Review', fitStatus: 'review', fitDecision: 'Needs review: something', fitScore: 5, researchSummary: 'KLT makes chassis frames.', assessedIcp: 'Manufacturing' });
    expect(await confirmFit(db, lead.id, 'Parimal', 'Known chassis maker')).toBe(true);
    const [queued] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(queued).toMatchObject({ status: 'New', fitOverride: 'qualified', fitStatus: 'qualified', qualified: true, fitDecision: 'Confirmed as a fit by Parimal: Known chassis maker' });
    const r = await run(queued, {
      research: () => {
        throw new Error('the fit was confirmed; research must not reassess it');
      },
    });
    expect(seen.research).toHaveLength(0);
    expect(r.status).toMatch(/^(Awaiting Approval|Needs Manual Contact)$/);
    expect(r.fitStatus).toBeUndefined();
  });

  it("a person's not-a-fit call stands through Research again, until someone reassesses", async () => {
    const lead = await klt({ status: 'Needs Review', fitStatus: 'review', researchSummary: 'KLT makes chassis frames.', assessedIcp: 'Manufacturing' });
    expect(await markNotFit(db, lead.id, 'Admin', 'In liquidation talks')).toBe(true);
    await applyStage(db, [lead.id], 'New');
    const [queued] = await db.select().from(leads).where(eq(leads.id, lead.id));
    const r = await run(queued, { research: () => ({}) });
    expect(seen.deepseek).toBe(0);
    expect(r.status).toBe('Disqualified');
    // Reassessing clears the call and checks the evidence again.
    await db.update(leads).set({ status: 'Disqualified' }).where(eq(leads.id, lead.id));
    expect(await reassessLeads(db, [lead.id], 'Admin')).toBe(1);
    expect((await db.select().from(leads).where(eq(leads.id, lead.id)))[0]).toMatchObject({ status: 'New', fitOverride: '' });
  });
});

describe('Needs Review is held back from the team until decided', () => {
  it('is never drawn, gets no outreach steps and stays off the tracker', async () => {
    const [bda] = await db.select().from(users).limit(1);
    await addLead({ company: 'Pending Fit', status: 'Needs Review', fitStatus: 'review', qualified: null });
    const owned = await addLead({ company: 'Owned Pending', status: 'Needs Review', fitStatus: 'review', qualified: null, ownerId: bda.id, contactName: 'Asha Rao' });
    expect(await drawPool(db)).toEqual({ total: 0, withContact: 0 });
    await ensureSequences(db);
    expect(await db.select().from(tasks).where(eq(tasks.leadId, owned.id))).toEqual([]);
    expect((await loadTracker(db, bda.id)).map((r) => r.lead.company)).not.toContain('Owned Pending');
  });
});
