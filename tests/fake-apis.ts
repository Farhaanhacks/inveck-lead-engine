// A stand-in for Jina, Serper, Hunter, DeepSeek and Anthropic. It gives deliberately
// messy answers (wrong types, code fences, plain text, API errors) so the tests cover
// every parsing and fallback path.

type Handler = (url: URL, init: RequestInit & { body?: string }) => Response | Promise<Response>;

export type FakeLog = { calls: string[]; verified: string[]; finder: string[]; apollo?: URL[] };

/**
 * Apollo's People Enrichment, as the fake knows it: who it has, at which employer, with what email
 * and status. Every reply also carries phone numbers, which the app must never read or keep.
 */
const APOLLO_PEOPLE: Record<string, { email: string; status: string; org: string; domain: string; linkedin?: string }> = {
  'ravi shah@nodraft.in': { email: 'ravi.shah@nodraft.in', status: 'verified', org: 'No Draft Industries', domain: 'nodraft.in' },
  'kiran rao@findr.in': { email: 'k.rao@findr.in', status: 'extrapolated', org: 'Finder Co', domain: 'findr.in' },
  'anita rao@tatamotors.com': { email: 'anita.rao@tatamotors.com', status: 'verified', org: 'Tata Motors Limited', domain: 'tatamotors.com', linkedin: 'https://in.linkedin.com/in/anita' },
};

export function apolloReply(url: URL): Response {
  const q = url.searchParams;
  const key = `${(q.get('first_name') ?? '').toLowerCase()} ${(q.get('last_name') ?? '').toLowerCase()}@${q.get('domain') ?? ''}`;
  const p = APOLLO_PEOPLE[key];
  if (!p) return json({ person: null });
  return json({
    person: {
      id: 'ap1',
      first_name: q.get('first_name'),
      last_name: q.get('last_name'),
      name: `${q.get('first_name')} ${q.get('last_name')}`,
      linkedin_url: p.linkedin ?? null,
      email: p.email,
      email_status: p.status,
      phone_numbers: [{ raw_number: '+91 98765 43210', sanitized_number: '+919876543210', type: 'mobile' }],
      organization: { name: p.org, primary_domain: p.domain, primary_phone: { number: '+91 20 1234 5678' }, phone: '+91 20 1234 5678' },
    },
  });
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const text = (t: string, status = 200) => new Response(t, { status, headers: { 'content-type': 'text/plain' } });

/** The criteria ids and numbered sources a research request lists, to answer it. */
export function researchRequest(user: string) {
  const criteria = [...user.matchAll(/^- ([A-Z]+\d*) \(([^)]+)\):/gm)].map((m) => m[1]);
  const sources = [...user.matchAll(/^\[(S\d+)\] (\S+)[^\n]*\n<source>\n([\s\S]*?)\n<\/source>/gm)].map((m) => ({ id: m[1], url: m[2], text: m[3] }));
  return { criteria, sources, retry: user.includes('## Your previous answer was rejected') };
}

type Finding = [status: 'met' | 'not_met' | 'unknown', evidence: string, source: string];

/**
 * A complete, well-formed assessment: must-haves and targets met by a line quoted from the first
 * source (or widely known when there is none), deal-breakers not applying, size unknown.
 */
export function fitAnswer(user: string, fields: Record<string, unknown> = {}, findings: Record<string, Finding> = {}) {
  const { criteria, sources } = researchRequest(user);
  const s1 = sources[0];
  const line = s1?.text.split('\n').map((l) => l.trim()).find((l) => l.length > 20) ?? '';
  const quote = line.split(/(?<=\.)\s/)[0].slice(0, 200);
  return {
    summary: 'Makes things',
    industry: 'Manufacturing',
    company_size: 'unknown',
    locations: 'Pune',
    inventory_complexity: 'High',
    warehousing_3pl: 'No',
    erp_wms: 'SAP',
    verification_need: 'High',
    criteria: criteria.map((id) => {
      const f = findings[id];
      if (f) return { id, status: f[0], evidence: f[1], source: f[2] };
      if (id.startsWith('D')) return { id, status: 'not_met', evidence: 'Makes physical products', source: 'K' };
      if (id === 'SIZE') return { id, status: 'unknown', evidence: 'Not stated', source: '' };
      return quote ? { id, status: 'met', evidence: quote, source: s1.id } : { id, status: 'met', evidence: 'A widely known manufacturer', source: 'K' };
    }),
    risks: [],
    fit_score: 8,
    qualified: true,
    fit_reason: 'Fits',
    target_roles: ['Plant Head'],
    pitch_hook: 'plants',
    ...fields,
  };
}

function researchFor(company: string, user: string): unknown {
  const { sources, retry } = researchRequest(user);
  switch (company) {
    case 'Garbage Output Ltd':
      return 'Sorry, I cannot help with that.';
    case 'Bajaj Finance': {
      // Its own pages (Google's index of them) say what it is: a lender, nothing physical to verify.
      const s = sources.find((x) => x.text.includes('non-banking financial company'));
      const quote = 'Bajaj Finance Limited is a deposit-taking non-banking financial company';
      return fitAnswer(
        user,
        { summary: 'NBFC lender', fit_score: 1, qualified: false, fit_reason: 'Lender, no physical inventory', target_roles: [], pitch_hook: '' },
        { M1: ['not_met', quote, s?.id ?? 'K'], D1: ['met', quote, s?.id ?? 'K'] },
      );
    }
    case 'Tata Motors':
      // Wrong types and missing criteria the first time: asked again, it answers properly.
      if (retry) return fitAnswer(user, { industry: 'Automotive', fit_reason: '6 plants, SAP', target_roles: ['Plant Head', 'COO'], pitch_hook: '6 plants' });
      return { summary: 'Auto OEM', industry: 'Automotive', qualified: 'true', fit_score: '8', fit_reason: { reason: '6 plants, SAP' }, target_roles: [{ role: 'Plant Head', priority: 1 }, { title: 'COO' }], pitch_hook: '6 plants' };
    case 'Kirtane & Pandit':
      return '```json\n' + JSON.stringify(fitAnswer(user, { summary: 'CA firm', fit_score: 7, fit_reason: 'Audit practice', target_roles: ['Managing Partner', 'Audit Partner'], pitch_hook: 'stock audits' })) + '\n```';
    case 'Mystery Castings':
      // A score that isn't a whole number fails the checks; the second answer is fine.
      return fitAnswer(user, { summary: 'Unknown foundry', fit_score: retry ? 6 : 6.4, fit_reason: 'Probably fits', target_roles: [], pitch_hook: '' });
    default:
      return fitAnswer(user, { summary: `${company} makes things` });
  }
}

const PEOPLE: Record<string, string> = {
  'Website Email Co': 'Arjun Mehta - Plant Head',
  'Format Guess Co': 'Neha Kapoor - Plant Head',
  'Finder Co': 'Kiran Rao - Plant Head',
  'Catchall Co': 'Amit Joshi - Plant Head',
  'No Draft Industries': 'Ravi Shah - Plant Head',
  Honeywell: 'Mayank Singh - Plant Head',
};

function aiReply(system: string, user: string): unknown {
  if (system.startsWith('You are a B2B research analyst')) {
    const m = user.match(/Name: ([^\n]+)/);
    return researchFor(m ? m[1].trim() : '', user);
  }
  if (system.startsWith('You double-check the evidence')) {
    // Every quote behind a rejection shows what it claims.
    return { checks: [...user.matchAll(/^- id ([A-Z]+\d*):/gm)].map((m) => ({ id: m[1], supports: true, why: 'Shows it' })) };
  }
  if (system.startsWith('You pick the best person')) {
    const ids = [...user.matchAll(/"id": "([A-Z]\d*)"/g)].map((m) => m[1]);
    if (!ids.length) return { chosen_id: '', role_match: false, reason: 'none', other_ids: [], roles_to_find_on_linkedin: ['Plant Head'] };
    return { chosen_id: ids[0], role_match: 'true', reason: ['Plant Head at Pune'], other_ids: ids.slice(1).join(', ') + ', Z9', roles_to_find_on_linkedin: [{ role: 'CFO' }] };
  }
  if (system.startsWith('You extract the people who run a company')) {
    if (!user.startsWith('Company: Ash Logistics')) return { people: [] };
    return {
      people: [
        { name: 'Dr. Jitendra Govind Joshi', title: 'Founder, Chairman and Managing Director' },
        { name: 'Vidya Girish Pathak', title: 'CFO' },
        { name: 'Invented Person', title: 'COO' }, // not in the text: must be dropped
      ],
    };
  }
  if (system.startsWith('You find new-facility openings')) {
    return {
      openings: [
        { id: '1', company: 'Tata Motors', headline: 'New EV plant in Sanand', location: 'Sanand, Gujarat', kind: 'new_plant', segment: 'Manufacturing', why: 'x' },
        { id: '2', company: 'Varroc Engineering Ltd', headline: 'New lighting plant in Chakan', location: 'Chakan, Maharashtra', kind: 'new_plant', segment: ' MANUFACTURING ', why: 'New plant, new stock to verify' },
        { id: '3', company: 'Invented Industries', headline: 'Not in the article', location: '', kind: 'new_plant', segment: 'Manufacturing', why: 'x' },
        { id: '9', company: 'Ghost Co', headline: 'No such item', location: '', kind: 'new_plant', segment: 'CA Firms', why: 'x' },
      ],
    };
  }
  if (system.startsWith('You spot buying signals')) {
    // Item 7 doesn't exist: it must be ignored, never invented.
    return { signals: [{ id: '1', headline: 'Opening a new plant in Chakan', kind: 'new_facility' }, { id: '7', headline: 'Made up', kind: 'funding' }] };
  }
  if (system.startsWith('You write a follow-up')) {
    const step = (user.match(/This is follow-up (\d)/) || [])[1];
    return { email: { subject: `Re: original`, body: `Follow-up ${step} body` } };
  }
  if (system.startsWith('You write first-touch')) {
    const c = (user.match(/## Company: ([^\n(]+)/) || [])[1]?.trim();
    if (c === 'No Draft Industries') return { email_subject: 'Hi' };
    return { email_subject: `Stock checks at ${c}`, email_body: ['Hi,', 'body text'], linkedin_message: { text: 'Hello' } };
  }
  if (system.startsWith('You plan Google searches')) {
    return { queries: ['auto component manufacturer Pune', { query: 'CA firm stock audit Pune', segment: 'CA Firms', lookalike_of: ['Haldex'] }] };
  }
  if (system.startsWith('You pick new prospect companies')) {
    return {
      companies: [
        { company: 'Bharat Forge Ltd', website: 'https://www.bharatforge.com/', city: 'Pune', segment: 'manufacturing & 3pl', lookalike_of: 'Haldex', why: 'forging plants' },
        { company: 'Tata Motors Limited', website: 'tatamotors.com', segment: 'Manufacturing', lookalike_of: '', why: 'dup' },
        { company: 'Haldex India', website: 'haldex.com', segment: 'x', why: 'client' },
        'Just A String Co',
        { company: { name: 'Sona Comstar' }, website: null, city: null, segment: null, lookalike_of: null, why: null },
        { company: 'IndiaMART Listing Co', website: 'https://www.indiamart.com/x', segment: 'CA Firms', why: 'listing' },
      ],
    };
  }
  throw new Error('Unknown prompt: ' + system.slice(0, 50));
}

const handlers: Record<string, Handler> = {
  'r.jina.ai': (url) => {
    const target = url.pathname.slice(1);
    if (!target) return text('Jina Reader homepage');
    if (target.includes('bajajfinserv')) return text('rate limited', 429);
    const filler = ' We make precision components for leading automotive OEMs from plants in Pune and Chakan.'.repeat(3);
    if (target.includes('websiteemail')) return text('Contact our plant head Arjun Mehta at Arjun.Mehta@websiteemail.in or info@websiteemail.in. Partner: someone@gmail.com.' + filler);
    return text(`Website text for ${target}. We run 6 plants across Maharashtra with SAP.` + filler);
  },
  'google.serper.dev': (url, init) => {
    if ((init.headers as Record<string, string>)['X-API-KEY'] !== 'serper-test') return json({ message: 'Unauthorized. Sign up for a free account.' }, 403);
    const { q } = JSON.parse(init.body!);
    if (url.pathname === '/news') {
      if (/inaugurates new manufacturing plant/.test(q)) {
        return json({
          news: [
            { title: 'Tata Motors inaugurates new EV plant in Sanand', link: 'https://news.example/tata-ev', snippet: 'Tata Motors opened...', date: '2 days ago', source: 'Mint' },
            { title: 'Varroc Engineering lays foundation stone for new plant in Chakan', link: 'https://news.example/varroc', snippet: 'Varroc will build a lighting plant in Chakan, Pune.', date: '5 days ago', source: 'Economic Times' },
            { title: 'State announces new industrial policy', link: 'https://news.example/policy', snippet: 'Incentives for manufacturers.', date: '1 week ago', source: 'PTI' },
          ],
        });
      }
      if (!/Honeywell/.test(q)) return json({ news: [] });
      return json({
        news: [
          { title: 'Honeywell to open new warehouse automation plant in Pune', link: 'https://news.example/hw-pune', snippet: 'Honeywell will invest ₹400 crore in a new facility in Chakan.', date: '3 weeks ago', source: 'Economic Times' },
          { title: 'Honda launches new scooter', link: 'https://news.example/honda', snippet: 'Not about Honeywell at all? It mentions honeywell once.', date: '1 week ago', source: 'Autocar' },
        ],
      });
    }
    if (/Tata Motors/.test(q)) {
      return json({
        organic: [
          { title: 'Sangamnath Digge - Plant Head - Tata Motors | LinkedIn', subtitle: 'Pune, Maharashtra, India · Plant Head · Tata Motors', link: 'https://in.linkedin.com/in/sdigge', snippet: 'Pune' },
          // No location shown: listed, but not the main contact for the Pune lead until it's confirmed.
          { title: 'Anita Rao – Head Supply Chain – Tata Motors | LinkedIn', link: 'https://in.linkedin.com/in/anita', snippet: '' },
          { title: 'Tata Motors | LinkedIn', link: 'https://www.linkedin.com/company/tata-motors', snippet: '' },
        ],
      });
    }
    if (/Mystery/.test(q)) return text('boom', 500);
    if (q === 'site:bajajfinserv.in') {
      return json({
        organic: [
          {
            title: 'Bajaj Finance Ltd: Loans, Fixed Deposits and EMI Cards',
            link: 'https://www.bajajfinserv.in/',
            snippet: 'Bajaj Finance Limited is a deposit-taking non-banking financial company offering personal loans, business loans and fixed deposits.',
          },
        ],
      });
    }
    if (/email format/.test(q) && /Honeywell/.test(q)) {
      return json({
        organic: [
          {
            title: 'Honeywell Email Format | honeywell.com Emails - RocketReach',
            link: 'https://rocketreach.co/honeywell-email-format_123',
            snippet:
              'The most common Honeywell email format is [first].[last] (ex. jane.doe@honeywell.com) being used 88.4% of the time. Other common Honeywell email patterns are [first_initial][last] (ex. jdoe@honeywell.com).',
          },
        ],
      });
    }
    if (/email format/.test(q) && /John Deere/.test(q)) {
      return json({
        organic: [
          { title: 'Honda email format', link: 'https://x.com/honda', snippet: 'first.last@honda.com (90%)' },
          {
            title: 'John Deere Email Format - RocketReach',
            link: 'https://rocketreach.co/john-deere-email-format_1',
            snippet: 'The most common John Deere email format is [last][first] (ex. doejane@johndeere.com) being used 67% of the time.',
          },
        ],
      });
    }
    if (/"Priya Nair"/.test(q)) {
      return json({ organic: [{ title: 'Priya Nair - Kappa Metals | ContactOut', link: 'https://contactout.com/p', snippet: "Priya Nair's work email priya.nair@kappametals.com and phone" }] });
    }
    if (/Ash Logistics/.test(q)) {
      if (q.startsWith('site:')) return json({ organic: [] });
      return json({
        organic: [
          { title: 'Ash Logistics leadership', link: 'https://www.zaubacorp.com/ash', snippet: 'Dr. Jitendra Govind Joshi – Founder, Chairman and MD. Mrs. Vidya Girish Pathak – CFO and Director.' },
        ],
      });
    }
    for (const [co, who] of Object.entries(PEOPLE)) {
      if (q.includes(`"${co}"`)) return json({ organic: [{ title: `${who} - ${co} | LinkedIn`, subtitle: `Pune, Maharashtra, India · ${co}`, link: 'https://in.linkedin.com/in/' + who.split(' ')[0].toLowerCase(), snippet: '' }] });
    }
    if (!q.startsWith('site:')) {
      return json({
        organic: [
          { title: 'Top auto component manufacturers in Pune', link: 'https://www.indiamart.com/list', snippet: 'Bharat Forge, Sona Comstar and Haldex India' },
          { title: 'Bharat Forge', link: 'https://www.bharatforge.com/', snippet: 'Forging major with plants in Pune' },
        ],
      });
    }
    return json({ organic: [] });
  },
};

export function fakeFetch(log: FakeLog): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input));
    const body = req ? await req.text() : (init.body as string | undefined);
    const headers: Record<string, string> = {};
    new Headers(req ? req.headers : init.headers).forEach((v, k) => (headers[k] = v));
    // Serper checks the header in its original case.
    if (headers['x-api-key']) headers['X-API-KEY'] = headers['x-api-key'];
    log.calls.push(`${init.method || req?.method || 'GET'} ${url.host}${url.pathname}`);

    if (url.host === 'api.hunter.io') {
      if (url.searchParams.get('api_key') !== 'hunter-test') return json({ errors: [{ details: 'No user found for the API key supplied' }] }, 401);
      if (url.pathname === '/v2/domain-search') {
        const d = url.searchParams.get('domain');
        if (d === 'tatamotors.com') {
          return json({ data: { emails: [
            { value: 'anita.rao@tatamotors.com', first_name: 'Anita', last_name: 'Rao', position: 'Head SCM' },
            { value: 'cfo@tatamotors.com', first_name: 'P', last_name: 'B', position: 'CFO' },
          ] } });
        }
        if (d === 'kirtanepandit.com') return json({ errors: [{ details: 'usage limit' }] }, 429);
        if (d === 'nodraft.in') return json({ data: { emails: [], pattern: '{first}.{last}' } });
        return json({ data: { emails: [] } });
      }
      if (url.pathname === '/v2/email-finder') {
        log.finder.push(url.searchParams.get('domain') || '');
        if (url.searchParams.get('domain') === 'findr.in') return json({ data: { email: 'k.rao@findr.in' } });
        return json({ data: { email: null } });
      }
      if (url.pathname === '/v2/email-verifier') {
        const e = url.searchParams.get('email') || '';
        log.verified.push(e);
        if (e.endsWith('@websiteemail.in') || e.endsWith('@catchall.in')) return json({ data: { status: 'accept_all' } });
        if (e.endsWith('@formatguess.in')) return json({ data: { status: e === 'nkapoor@formatguess.in' ? 'valid' : 'invalid' } });
        if (e.endsWith('@findr.in')) return json({ data: { status: e === 'k.rao@findr.in' ? 'valid' : 'invalid' } });
        if (e.endsWith('@tatamotors.com')) return json({ data: { status: e.startsWith('sangamnath.digge') ? 'valid' : 'invalid' } });
        if (e.endsWith('@honeywell.com')) return json({ data: { status: 'accept_all' } });
        if (e.endsWith('@johndeere.com')) return json({ errors: [{ details: "You've used all your verification credits" }] }, 429);
        return json({ data: { status: e.startsWith('vijay') ? 'accept_all' : 'valid' } });
      }
    }

    if (url.host === 'api.apollo.io') {
      log.apollo?.push(url);
      if (headers['x-api-key'] !== 'apollo-test') return json({ error: 'Invalid access credentials.' }, 401);
      return apolloReply(url);
    }

    if (url.host === 'api.deepseek.com') {
      if (headers.authorization !== 'Bearer ds-test') return json({ error: { message: 'Authentication Fails' } }, 401);
      const b = JSON.parse(body!);
      const reply = aiReply(b.messages[0].content, b.messages[1].content);
      return json({ choices: [{ finish_reason: 'stop', message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] });
    }

    if (url.host === 'api.anthropic.com') {
      if (headers['x-api-key'] !== 'ant-test') return json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
      const b = JSON.parse(body!);
      if (!String(headers['anthropic-beta'] || '').includes('server-side-fallback-2026-07-01')) throw new Error('missing fallback beta');
      if (b.output_config?.format?.type !== 'json_schema') throw new Error('missing structured output');
      const reply = aiReply(b.system, b.messages[0].content);
      return json({
        id: 'msg_test', type: 'message', role: 'assistant', model: b.model, stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      });
    }

    const h = handlers[url.host];
    if (!h) throw new Error('Unexpected request to ' + url.host);
    return h(url, { ...init, body, headers });
  }) as typeof fetch;
}
