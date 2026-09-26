import type { Services } from './services';
import { googleSearch, mapLimit } from './services';
import { errorMessage, rootDomain } from './text';

/**
 * Reads a company website for research. Sites fail in different ways (bad certificate on the
 * bare domain, bot protection, JavaScript-only pages, slow pages), so it tries, in order:
 *  1. the page's own HTML, fetched directly: fast and free; with and without "www."
 *  2. Jina Reader, which renders JavaScript-heavy sites in a browser
 *  3. Google's index of the site (titles and snippets of its pages)
 */

export type SiteText = {
  text: string;
  error: string;
  via: '' | 'direct' | 'reader' | 'google';
  /** The address that worked, and links from it to other pages on the same site. */
  url?: string;
  links?: string[];
};

/** Links to other pages of the same site, from HTML (href) or the reader's markdown ([text](url)). */
export function siteLinks(content: string, pageUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const root = rootDomain(base.hostname);
  const raw = [
    ...[...content.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)].map((m) => m[1]),
    ...[...content.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]),
  ];
  const out = new Set<string>();
  for (const href of raw) {
    if (/^(mailto|tel|javascript):/i.test(href)) continue;
    try {
      const u = new URL(href, base);
      if (!/^https?:$/.test(u.protocol) || rootDomain(u.hostname) !== root) continue;
      if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|pptx?|mp4|css|js)$/i.test(u.pathname)) continue;
      u.hash = '';
      out.add(u.toString());
    } catch {}
  }
  return [...out];
}

// The pages worth reading, most useful first.
const CRAWL_PRIORITY = [
  /contact|reach-?us|get-?in-?touch|enquir/,
  /team|leadership|management|board|directors|key-?(managerial|person)|people/,
  /about|who-?we-?are|overview|profile|company/,
  /locations?|plants?|facilit|infrastructure|manufactur|network|branch|offices?|warehous/,
  /investor|annual-?report|governance|compliance|shareholder/,
  /press|news|media/,
];

/** Up to `max` links to read, one per kind of page first (contact, team, about…). */
export function pickCrawlLinks(links: string[], homeUrl: string, max = 6): string[] {
  const home = homeUrl.replace(/\/$/, '');
  const scored = links
    .filter((l) => l.replace(/\/$/, '') !== home)
    .map((l) => {
      const path = new URL(l).pathname.toLowerCase();
      const rank = CRAWL_PRIORITY.findIndex((re) => re.test(path));
      return { l, rank, depth: path.split('/').filter(Boolean).length };
    })
    .filter((x) => x.rank >= 0 && x.depth <= 3)
    .sort((a, b) => a.rank - b.rank || a.depth - b.depth || a.l.length - b.l.length);
  const picked: string[] = [];
  const kinds = new Set<number>();
  for (const x of scored) {
    if (kinds.has(x.rank) || picked.length >= max) continue;
    kinds.add(x.rank);
    picked.push(x.l);
  }
  for (const x of scored) if (!picked.includes(x.l) && picked.length < max) picked.push(x.l);
  return picked;
}

export type CrawledPage = { url: string; text: string };

/**
 * Reads the site's contact, team, about, locations and investor pages (not just the home
 * page): that's where named managers, emails and plant phone numbers usually are.
 */
export async function crawlSite(svc: Services, site: SiteText, max = 6): Promise<CrawledPage[]> {
  if (!site.url || !site.links?.length || site.via === 'google') return [];
  const targets = pickCrawlLinks(site.links, site.url, max);
  const pages = await mapLimit(targets, 3, async (url): Promise<CrawledPage | null> => {
    try {
      const text = site.via === 'reader' ? await fetchReader(svc, url) : htmlToText(await fetchHtml(svc, url));
      // Short pages count: a leadership page can be just a few names.
      return text.length >= 40 && !(text.length < 2000 && CHALLENGE.test(text)) ? { url, text: text.slice(0, 20_000) } : null;
    } catch {
      return null;
    }
  });
  return pages.filter((p): p is CrawledPage => !!p);
}

const DIRECT_TIMEOUT = 10_000;
const READER_TIMEOUT = 30_000;
const MAX_HTML = 3_000_000;
const MIN_TEXT = 300;
// Bot-check pages that some sites show instead of content.
const CHALLENGE = /just a moment|enable javascript and cookies|attention required|access denied|verify you are (a )?human|captcha|request unsuccessful/i;

/** The address as given, plus the same with "www." added or removed. */
export function urlVariants(website: string): string[] {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
  } catch {
    return [];
  }
  url.protocol = 'https:';
  const other = new URL(url);
  other.hostname = url.hostname.startsWith('www.') ? url.hostname.slice(4) : `www.${url.hostname}`;
  return [url.toString(), other.toString()];
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', hellip: '…', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', rarr: '→', larr: '←',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Readable text from HTML: title, description, body text, and any email/phone links. */
export function htmlToText(html: string): string {
  const links = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']\s*(mailto|tel):([^"'?#]+)/gi)) {
    let value = m[2];
    try {
      value = decodeURIComponent(value);
    } catch {}
    links.add(`${m[1].toLowerCase() === 'mailto' ? 'Email' : 'Phone'}: ${value.trim()}`);
  }
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const description = decodeEntities(
    html.match(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
      html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:og:)?description["']/i)?.[1] ??
      '',
  ).trim();
  const body = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|template|iframe|canvas)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer|\/ul|\/ol|\/table|\/address)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return [title && `Title: ${title}`, description && `Description: ${description}`, body, [...links].join('\n')].filter(Boolean).join('\n\n');
}

async function fetchHtml(svc: Services, url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIRECT_TIMEOUT);
  try {
    const res = await svc.fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-IN,en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
    const type = res.headers.get('content-type') || '';
    if (type && !/html|xml|text\/plain/i.test(type)) throw new Error(`not a web page (${type.split(';')[0]})`);
    return (await res.text()).slice(0, MAX_HTML);
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw new Error(`no answer within ${DIRECT_TIMEOUT / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchReader(svc: Services, url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READER_TIMEOUT);
  try {
    const res = await svc.fetch(`https://r.jina.ai/${url}`, {
      signal: controller.signal,
      headers: {
        // Return what has loaded after 20s instead of failing on pages that never go quiet.
        'x-timeout': '20',
        ...(svc.keys.jina ? { authorization: `Bearer ${svc.keys.jina}` } : {}),
      },
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`reader ${res.status}: ${body.replace(/\s+/g, ' ').slice(0, 120)}`);
    return body;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw new Error(`reader: no answer within ${READER_TIMEOUT / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Short, readable reason for the log: "certificate problem", "blocked (403)"… */
function shortReason(e: unknown): string {
  const msg = errorMessage(e);
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code || '';
  if (/CERT|SSL|TLS/i.test(code + msg)) return 'certificate problem';
  if (/ENOTFOUND|EAI_AGAIN/i.test(code + msg)) return 'domain not found';
  if (/ECONNREFUSED|ECONNRESET|socket|terminated|fetch failed/i.test(code + msg)) return 'connection failed';
  return msg.replace(/\s+/g, ' ').slice(0, 120);
}

export async function fetchWebsiteText(svc: Services, website: string, { useGoogle = true } = {}): Promise<SiteText> {
  if (!website) return { text: '', error: '', via: '' };
  const urls = urlVariants(website);
  if (!urls.length) return { text: '', error: 'not a valid web address', via: '' };
  const problems: string[] = [];
  let reachable = ''; // a variant that answered, even if its page had no usable text

  // 1. The page's own HTML.
  for (const url of urls) {
    try {
      const html = await fetchHtml(svc, url);
      reachable ||= url;
      const text = htmlToText(html);
      if (text.length >= MIN_TEXT && !(text.length < 2000 && CHALLENGE.test(text))) return { text, error: '', via: 'direct', url, links: siteLinks(html, url) };
      problems.push(CHALLENGE.test(text) ? 'bot check page' : 'page needs JavaScript');
      break; // the other variant serves the same site
    } catch (e) {
      problems.push(shortReason(e));
    }
  }

  // 2. Jina Reader renders the page in a browser.
  try {
    const url = reachable || urls[0];
    const text = await fetchReader(svc, url);
    if (text.trim().length >= 200 && !(text.length < 2000 && CHALLENGE.test(text))) return { text, error: '', via: 'reader', url, links: siteLinks(text, url) };
    problems.push('reader got no text');
  } catch (e) {
    problems.push(shortReason(e));
  }

  // 3. Google's index of the site.
  const domain = rootDomain(website);
  if (useGoogle && domain) {
    try {
      const results = await googleSearch(svc, `site:${domain}`);
      const text = results
        .slice(0, 10)
        .map((r) => [r.title, r.snippet].filter(Boolean).join('\n'))
        .filter(Boolean)
        .join('\n\n');
      if (text.length >= 150) return { text: `Pages of ${domain} as indexed by Google:\n\n${text}`, error: '', via: 'google' };
    } catch {}
  }
  return { text: '', error: [...new Set(problems)].join('; '), via: '' };
}
