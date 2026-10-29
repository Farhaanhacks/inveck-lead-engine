import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

export type RenderSource = { n: number; title: string; url: string; publisher: string | null };

const ALLOWED_TAGS = ['h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'a', 'strong', 'em', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'code', 'pre', 'br', 'hr', 'section', 'h1'];

/**
 * Markdown to safe HTML. Generated text is untrusted: raw HTML in it is escaped, only http(s) links survive,
 * and the result is sanitised against an allow-list. Citation markers like [S3] become numbered links to the source list.
 */
export function renderArticleHtml(markdown: string, sources: RenderSource[]): string {
  const byId = new Map(sources.map((s) => [`S${s.n}`, s]));
  const withMarkers = markdown.replace(/\[(S\d+)\]/g, (whole, id: string) => (byId.has(id) ? `<sup class="cite"><a href="#source-${id.slice(1)}">${id.slice(1)}</a></sup>` : ''));
  // marked passes inline HTML through; the sanitiser below is the real gate.
  const html = marked.parse(withMarkers, { async: false, gfm: true, breaks: false }) as string;
  const sourceList = sources.length
    ? `<section class="sources"><h2>Sources</h2><ol>${sources
        .map((s) => `<li id="source-${s.n}"><a href="${escapeAttr(s.url)}" rel="noopener noreferrer">${escapeText(s.title)}</a>${s.publisher ? ` (${escapeText(s.publisher)})` : ''}</li>`)
        .join('')}</ol></section>`
    : '';
  return sanitizeHtml(html + sourceList, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href', 'rel', 'id'], li: ['id'], sup: ['class'], section: ['class'], th: ['align'], td: ['align'] },
    allowedSchemes: ['http', 'https'],
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, ...(attribs.href?.startsWith('#') ? {} : { rel: 'noopener noreferrer' }) },
      }),
    },
  });
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');
