/**
 * Plain text and HTML for email bodies, with no dependencies, so the editor in the browser and the server share it.
 * (Cleaning HTML for sending is mail/sanitize.ts, server side.)
 */

export const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const decode = (s: string) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** Plain text (blank line between paragraphs, single line breaks inside them) as HTML: what the templates were before they held formatting. */
export function plainToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((para) => `<p>${escHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** HTML as plain text: paragraphs and breaks kept, list items as "* ", links as their text then the address when it differs. */
export function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
        const text = inner.replace(/<[^>]+>/g, '');
        return decode(text).trim() === decode(href).trim() || !href ? text : `${text} (${href})`;
      })
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|ul|ol|h[1-6])>/gi, '\n\n')
      .replace(/<li\b[^>]*>/gi, '* ')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
