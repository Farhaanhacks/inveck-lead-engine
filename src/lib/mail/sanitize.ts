import sanitizeHtml from 'sanitize-html';

/**
 * The only HTML that goes into a template or an email: paragraphs, line breaks, bold, italic, underline, lists and links.
 * Anything else (scripts, styles, classes, images, event handlers, javascript: links) is removed. Formatting pasted from Word,
 * Outlook or a web page arrives as spans with inline styles: bold and italic ones become <strong> and <em> first.
 */
const P_STYLE = 'margin:0 0 12px;';

const bold = (style: string) => /font-weight\s*:\s*(bold|[6-9]00)/i.test(style);
const italic = (style: string) => /font-style\s*:\s*italic/i.test(style);
const underline = (style: string) => /text-decoration[^;]*underline/i.test(style);

export function sanitizeEmailHtml(html: string): string {
  const clean = sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'strong', 'em', 'u', 'ul', 'ol', 'li', 'a'],
    allowedAttributes: { a: ['href'], p: ['style'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    // Text of tags that are dropped is dropped with them (a <script>'s code is never text in the email).
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'head'],
    transformTags: {
      b: 'strong',
      i: 'em',
      div: () => ({ tagName: 'p', attribs: {} }),
      h1: 'p', h2: 'p', h3: 'p', h4: 'p', h5: 'p', h6: 'p',
      p: () => ({ tagName: 'p', attribs: { style: P_STYLE } }),
      a: (_tag, attribs) => ({ tagName: 'a', attribs: attribs.href ? { href: attribs.href } : ({} as Record<string, string>) }),
      // Pasted spans/fonts carry bold or italic only as a style: keep the meaning, drop the rest.
      span: (_tag, attribs) => {
        const style = attribs.style ?? '';
        return { tagName: bold(style) ? 'strong' : italic(style) ? 'em' : underline(style) ? 'u' : 'span', attribs: {} };
      },
    },
  });
  // Our own paragraph spacing: every <p> carries it (so Outlook and Gmail agree), and the leftover plain spans go.
  return clean
    .replace(/<p>/g, `<p style="${P_STYLE}">`)
    .replace(/<span>([\s\S]*?)<\/span>/g, '$1')
    .replace(/(<p style="[^"]*">)(\s|<br\s*\/?>)*<\/p>/g, '')
    .trim();
}
