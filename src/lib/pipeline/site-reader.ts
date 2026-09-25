import type { Services } from './services';
import { googleSearch } from './services';
import { errorMessage, rootDomain } from './text';

/**
 * Reads a company website for research. Sites fail in different ways (bad certificate on the
 * bare domain, bot protection, JavaScript-only pages, slow pages), so it tries, in order:
 *  1. the page's own HTML, fetched directly: fast and free; with and without "www."
 *  2. Jina Reader, which renders JavaScript-heavy sites in a browser
 *  3. Google's index of the site (titles and snippets of its pages)
 */

export type SiteText = { text: string; error: string; via: '' | 'direct' | 'reader' | 'google' };

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
      if (text.length >= MIN_TEXT && !(text.length < 2000 && CHALLENGE.test(text))) return { text, error: '', via: 'direct' };
      problems.push(CHALLENGE.test(text) ? 'bot check page' : 'page needs JavaScript');
      break; // the other variant serves the same site
    } catch (e) {
      problems.push(shortReason(e));
    }
  }

  // 2. Jina Reader renders the page in a browser.
  try {
    const text = await fetchReader(svc, reachable || urls[0]);
    if (text.trim().length >= 200 && !(text.length < 2000 && CHALLENGE.test(text))) return { text, error: '', via: 'reader' };
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
