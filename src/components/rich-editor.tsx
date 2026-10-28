'use client';

import { useEffect, useRef } from 'react';

const ALLOWED = new Set(['P', 'BR', 'STRONG', 'EM', 'U', 'UL', 'OL', 'LI', 'A']);
const DROP_WITH_CONTENT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'HEAD', 'TITLE']);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Pasted or typed content reduced to what an email keeps: paragraphs, line breaks, bold, italic, underline, lists and links.
 * Bold and italic that arrive as styles (Word, Outlook, web pages) become <strong> and <em>. The server cleans again when saving
 * or sending: this keeps the editor itself tidy and shows what will be sent.
 */
export function cleanPastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return esc(node.textContent ?? '');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as HTMLElement;
    if (DROP_WITH_CONTENT.has(el.tagName)) return '';
    const inner = Array.from(el.childNodes).map(walk).join('');
    const style = el.getAttribute('style') ?? '';
    let tag = el.tagName;
    if (tag === 'B') tag = 'STRONG';
    else if (tag === 'I') tag = 'EM';
    else if (tag === 'DIV' || /^H[1-6]$/.test(tag)) tag = 'P';
    else if (tag === 'SPAN' || tag === 'FONT') tag = /font-weight\s*:\s*(bold|[6-9]00)/i.test(style) ? 'STRONG' : /font-style\s*:\s*italic/i.test(style) ? 'EM' : /text-decoration[^;]*underline/i.test(style) ? 'U' : '';
    if (tag === 'A') {
      const href = el.getAttribute('href') ?? '';
      return /^(https?:|mailto:)/i.test(href) ? `<a href="${esc(href)}">${inner}</a>` : inner;
    }
    if (!tag || !ALLOWED.has(tag)) return inner;
    const t = tag.toLowerCase();
    return t === 'br' ? '<br>' : `<${t}>${inner}</${t}>`;
  };
  return Array.from(doc.body.childNodes).map(walk).join('').replace(/<p>(\s|<br>)*<\/p>/g, '');
}

const BTN = 'rounded border border-line bg-surface px-2 py-0.5 text-xs hover:bg-surface-2';

/**
 * A small formatting editor for email text: bold, italic, underline, bullets and links, with pasted formatting (bold text, line
 * breaks, links) kept. Its HTML goes in the hidden field `name`, so it posts with the form like a text box.
 */
export function RichEditor({ id, name, defaultHtml, minHeight = 200, label }: { id: string; name: string; defaultHtml: string; minHeight?: number; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const sync = () => {
    if (field.current && box.current) field.current.value = cleanPastedHtml(box.current.innerHTML);
  };
  useEffect(() => {
    if (box.current) box.current.innerHTML = defaultHtml;
    sync();
    // The starting text only: later typing is the editor's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = (cmd: string, value?: string) => {
    box.current?.focus();
    document.execCommand(cmd, false, value);
    sync();
  };
  return (
    <div>
      <div className="mb-1 flex flex-wrap gap-1" role="toolbar" aria-label="Formatting">
        <button type="button" className={`${BTN} font-bold`} onMouseDown={(e) => e.preventDefault()} onClick={() => run('bold')} aria-label="Bold" title="Bold">B</button>
        <button type="button" className={`${BTN} italic`} onMouseDown={(e) => e.preventDefault()} onClick={() => run('italic')} aria-label="Italic" title="Italic">I</button>
        <button type="button" className={`${BTN} underline`} onMouseDown={(e) => e.preventDefault()} onClick={() => run('underline')} aria-label="Underline" title="Underline">U</button>
        <button type="button" className={BTN} onMouseDown={(e) => e.preventDefault()} onClick={() => run('insertUnorderedList')} aria-label="Bulleted list" title="Bulleted list">• List</button>
        <button
          type="button"
          className={BTN}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const url = window.prompt('Link address (https://…)');
            if (url && /^(https?:\/\/|mailto:)/i.test(url.trim())) run('createLink', url.trim());
          }}
          aria-label="Add link"
          title="Add link"
        >
          Link
        </button>
        <button type="button" className={BTN} onMouseDown={(e) => e.preventDefault()} onClick={() => run('removeFormat')} aria-label="Clear formatting" title="Clear formatting">Clear</button>
      </div>
      <div
        id={id}
        ref={box}
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        contentEditable
        suppressContentEditableWarning
        onFocus={() => document.execCommand('defaultParagraphSeparator', false, 'p')}
        onInput={sync}
        onBlur={sync}
        onPaste={(e) => {
          e.preventDefault();
          const html = e.clipboardData.getData('text/html');
          const text = e.clipboardData.getData('text/plain');
          // Formatted text keeps its bold, links and breaks; plain text keeps its line breaks.
          const out = html ? cleanPastedHtml(html) : esc(text).replace(/\r?\n/g, '<br>');
          document.execCommand('insertHTML', false, out);
          sync();
        }}
        className="field min-h-[var(--min-h)] overflow-auto font-[inherit] leading-relaxed [&_a]:text-accent [&_a]:underline [&_p]:mb-3 [&_ul]:list-disc [&_ul]:pl-5"
        style={{ ['--min-h' as string]: `${minHeight}px` }}
      />
      <input ref={field} type="hidden" name={name} defaultValue={defaultHtml} />
    </div>
  );
}
