// A stand-in for Jina, Serper, Hunter, DeepSeek and Anthropic. It gives deliberately
// messy answers (wrong types, code fences, plain text, API errors) so the tests cover
// every parsing and fallback path.

type Handler = (url: URL, init: RequestInit & { body?: string }) => Response | Promise<Response>;

export type FakeLog = { calls: string[]; verified: string[]; finder: string[] };

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const text = (t: string, status = 200) => new Response(t, { status, headers: { 'content-type': 'text/plain' } });

function researchFor(company: string): unknown {
  switch (company) {
    case 'Garbage Output Ltd':
      return 'Sorry, I cannot help with that.';
    case 'Bajaj Finance':
      return { summary: 'NBFC lender', qualified: false, fit_score: 1, fit_reason: 'Lender, no physical inventory', target_roles: [], pitch_hook: '' };
    case 'Tata Motors':
      return { summary: 'Auto OEM', industry: 'Automotive', qualified: 'true', fit_score: '8', fit_reason: { reason: '6 plants, SAP' }, target_roles: [{ role: 'Plant Head', priority: 1 }, { title: 'COO' }], pitch_hook: '6 plants' };
    case 'Kirtane & Pandit':
      return '```json\n' + JSON.stringify({ summary: 'CA firm', qualified: true, fit_score: 7, fit_reason: 'Audit practice', target_roles: 'Managing Partner, Audit Partner', pitch_hook: 'stock audits' }) + '\n```';
    case 'Mystery Castings':
      return { summary: 'Unknown foundry', qualified: 'yes', fit_score: 6.4, fit_reason: 'Probably fits', target_roles: null, pitch_hook: null };
    default:
      return { summary: `${company} makes things`, qualified: true, fit_score: 8, fit_reason: 'Fits', target_roles: ['Plant Head'], pitch_hook: 'plants' };
  }
}

const PEOPLE: Record<string, string> = {
  'Website Email Co': 'Arjun Mehta - Plant Head',
  'Format Guess Co': 'Neha Kapoor - Plant Head',
  'Finder Co': 'Kiran Rao - COO',
  'Catchall Co': 'Amit Joshi - Plant Head',
  'No Draft Industries': 'Ravi Shah - COO',
  Honeywell: 'Mayank Singh - Plant Head',
};

function aiReply(system: string, user: string): unknown {
  if (system.startsWith('You are a B2B research analyst')) {
    const m = user.match(/Name: ([^\n]+)/);
    return researchFor(m ? m[1].trim() : '');
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
        { company: 'Tata Motors Limited', website: 'tatamotors.com', segment: 'Manufacturing & 3PL', lookalike_of: '', why: 'dup' },
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
          { title: 'Sangamnath Digge - Plant Head - Tata Motors | LinkedIn', link: 'https://in.linkedin.com/in/sdigge', snippet: 'Pune' },
          { title: 'Anita Rao – Head Supply Chain – Tata Motors | LinkedIn', link: 'https://in.linkedin.com/in/anita', snippet: '' },
          { title: 'Tata Motors | LinkedIn', link: 'https://www.linkedin.com/company/tata-motors', snippet: '' },
        ],
      });
    }
    if (/Mystery/.test(q)) return text('boom', 500);
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
      if (q.includes(`"${co}"`)) return json({ organic: [{ title: `${who} - ${co} | LinkedIn`, link: 'https://in.linkedin.com/in/' + who.split(' ')[0].toLowerCase(), snippet: '' }] });
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
