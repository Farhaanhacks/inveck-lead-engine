import { describe, expect, it } from 'vitest';
import { fetchWebsiteText, htmlToText, urlVariants } from '@/lib/pipeline/site-reader';
import type { Services } from '@/lib/pipeline/services';
import { settingsSchema } from '@/lib/settings';

const PAGE = `<!doctype html><html><head><title>John Deere India | Tractors &amp; Engines</title>
<meta name="description" content="Tractors, engines and equipment made in Pune.">
<style>.x{color:red}</style><script>window.dataLayer=[];var junk="<p>not text</p>";</script></head>
<body><nav><a href="/">Home</a></nav><h1>Nothing Runs Like a Deere</h1>
<p>John Deere India runs manufacturing plants in Pune and Dewas, with a spare-parts warehouse network across India.</p>
<p>We make tractors, engines and harvesters for farmers and contractors.&nbsp;Founded 1998 in India.</p>
<footer>Contact: <a href="mailto:Sales.India@JohnDeere.com">Email us</a> <a href="tel:+91-20-6642-0000">+91 20 6642 0000</a></footer>
</body></html>`;

type Call = { url: string; headers: Record<string, string> };

/** A fake network: each URL maps to a response, an error, or a function. */
function services(routes: Record<string, (url: string) => Response | Promise<Response>>, calls: Call[]): Services {
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url, headers });
    const route = Object.keys(routes).find((k) => url.startsWith(k));
    if (!route) throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    return routes[route](url);
  }) as typeof fetch;
  return { fetch, keys: { deepseek: '', anthropic: '', serper: 'serper-test', hunter: '', jina: '' }, settings: settingsSchema.parse({}) };
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const text = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain' } });
const serper = (organic: unknown[]) => () => new Response(JSON.stringify({ organic }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('reading company websites', () => {
  it('tries the www address when the bare domain has a bad certificate (deere.co.in)', async () => {
    const calls: Call[] = [];
    const svc = services(
      {
        'https://deere.co.in/': () => {
          throw new TypeError('fetch failed', { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } });
        },
        'https://www.deere.co.in/': () => html(PAGE),
      },
      calls,
    );
    const r = await fetchWebsiteText(svc, 'https://deere.co.in');
    expect(r.via).toBe('direct');
    expect(r.error).toBe('');
    expect(r.text).toContain('manufacturing plants in Pune and Dewas');
    expect(calls.map((c) => c.url)).toEqual(['https://deere.co.in/', 'https://www.deere.co.in/']);
    // Looks like a normal browser visit.
    expect(calls[0].headers['user-agent']).toMatch(/Mozilla/);
  });

  it('falls back to the reader, then to Google, when a site blocks both (honeywell.com)', async () => {
    const calls: Call[] = [];
    const svc = services(
      {
        'https://www.honeywell.com/': () => html('<html><body>Access Denied</body></html>', 403),
        'https://honeywell.com/': () => html('<html><body>Access Denied</body></html>', 403),
        'https://r.jina.ai/': () => text('{"code":422,"message":"Stream error in the HTTP/2 framing layer"}', 422),
        'https://google.serper.dev/': serper([
          { title: 'Honeywell | Industrial Automation, Aerospace, Building Technologies', snippet: 'Honeywell delivers industry-specific solutions that include aerospace products and services; control technologies for buildings and industry; and performance materials.' },
          { title: 'Warehouse and Workflow Solutions | Honeywell', snippet: 'Honeywell Intelligrated designs, manufactures and installs warehouse automation systems for distribution centres.' },
        ]),
      },
      calls,
    );
    const r = await fetchWebsiteText(svc, 'https://www.honeywell.com');
    expect(r.via).toBe('google');
    expect(r.error).toBe('');
    expect(r.text).toContain('warehouse automation systems');
    const google = calls.find((c) => c.url.startsWith('https://google.serper.dev/'));
    expect(google).toBeDefined();
  });

  it('uses the reader for JavaScript-only sites, without failing on pages that never go quiet (yazaki-group.com)', async () => {
    const calls: Call[] = [];
    const svc = services(
      {
        'https://yazaki-group.com/': () => html('<html><head><title>YAZAKI</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>'),
        'https://r.jina.ai/': () =>
          text('Title: Yazaki Group\n\nMarkdown Content:\nYazaki makes wiring harnesses, meters and components for automobiles, with plants in India in Pune, Bawal and Chennai. ' + 'Our global network spans 46 countries. '.repeat(3)),
      },
      calls,
    );
    const r = await fetchWebsiteText(svc, 'yazaki-group.com');
    expect(r.via).toBe('reader');
    expect(r.text).toContain('wiring harnesses');
    const reader = calls.find((c) => c.url.startsWith('https://r.jina.ai/'))!;
    expect(reader.url).toBe('https://r.jina.ai/https://yazaki-group.com/');
    expect(reader.headers['x-timeout']).toBe('20');
    // It doesn't retry www. when the site answered.
    expect(calls.some((c) => c.url === 'https://www.yazaki-group.com/')).toBe(false);
  });

  it('treats a bot-check page as blocked, and says why when nothing works', async () => {
    const calls: Call[] = [];
    const svc = services(
      {
        'https://blocked.example/': () => html('<html><title>Just a moment...</title><body>Enable JavaScript and cookies to continue</body></html>'),
        'https://r.jina.ai/': () => text('rate limited', 429),
        'https://google.serper.dev/': serper([]),
      },
      calls,
    );
    const r = await fetchWebsiteText(svc, 'blocked.example');
    expect(r.text).toBe('');
    expect(r.error).toContain('bot check page');
    expect(r.error).toContain('reader 429');
  });

  it('skips Google for sub-pages when asked', async () => {
    const calls: Call[] = [];
    const svc = services({ 'https://r.jina.ai/': () => text('nope', 500) }, calls);
    const r = await fetchWebsiteText(svc, 'https://acme.example/about-us', { useGoogle: false });
    expect(r.via).toBe('');
    expect(calls.some((c) => c.url.includes('serper'))).toBe(false);
  });

  it('turns HTML into readable text and keeps email and phone links', () => {
    const t = htmlToText(PAGE);
    expect(t).toContain('Title: John Deere India | Tractors & Engines');
    expect(t).toContain('Description: Tractors, engines and equipment made in Pune.');
    expect(t).toContain('Nothing Runs Like a Deere');
    expect(t).toContain('Email: Sales.India@JohnDeere.com');
    expect(t).toContain('Phone: +91-20-6642-0000');
    expect(t).not.toContain('dataLayer');
    expect(t).not.toContain('color:red');
    expect(t).not.toContain('<p>');
  });

  it('builds both address variants', () => {
    expect(urlVariants('bodal.com')).toEqual(['https://bodal.com/', 'https://www.bodal.com/']);
    expect(urlVariants('http://www.honeywell.com/in/en')).toEqual(['https://www.honeywell.com/in/en', 'https://honeywell.com/in/en']);
    expect(urlVariants('not a url')).toEqual([]);
  });
});
