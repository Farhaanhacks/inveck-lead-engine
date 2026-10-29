// Deterministic text helpers used by the validators. No model calls here.

export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[S\d+\]/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+(?:['’][a-z]+)?/g) ?? [];
export const wordCount = (md: string): number => words(stripMarkdown(md)).length;

export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9“"'(])/).map((s) => s.trim()).filter((s) => s.length > 0);
}

export function shingles(text: string, n: number): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}

/** Share of `a`'s n-grams that also appear in `b`. 1 means every phrase of `a` is found in `b`. */
export function containment(a: Set<string>, b: Set<string>): number {
  if (!a.size) return 0;
  let hit = 0;
  for (const s of a) if (b.has(s)) hit++;
  return hit / a.size;
}

export function jaccardSets(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

export type Figure = { raw: string; digits: string };

/**
 * Figures that need a source: percentages, currency amounts, decimals and numbers above ten.
 * Plain years and small counts ("3 steps") are not treated as claims.
 */
export function extractFigures(text: string): Figure[] {
  const out: Figure[] = [];
  const re = /(?:[$€£₹]\s?)?\d[\d,]*(?:\.\d+)?\s?(?:%|percent|per cent|million|billion|trillion|thousand|crore|lakh|bn|m\b|k\b)?/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[0].trim();
    const digits = raw.replace(/[^\d.]/g, '').replace(/\.$/, '');
    if (!digits) continue;
    const hasUnit = /[$€£₹%]|percent|per cent|million|billion|trillion|thousand|crore|lakh|bn|m$|k$/i.test(raw);
    const n = Number(digits);
    const isYear = !hasUnit && /^\d{4}$/.test(digits) && n >= 1900 && n <= 2100;
    if (isYear) continue;
    if (!hasUnit && !digits.includes('.') && n <= 10) continue;
    out.push({ raw, digits });
  }
  return out;
}

export function normalizeForSearch(text: string): string {
  return text.replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/\s+/g, ' ');
}

/** True when the number appears in the text as a whole number (not as part of a longer one). */
export function textHasFigure(haystackNormalized: string, digits: string): boolean {
  const escaped = digits.replace(/\./g, '\\.');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d])`).test(haystackNormalized);
}

/** Quoted passages of at least `minWords` words. Short scare quotes are ignored. */
export function extractQuotes(text: string, minWords = 6): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[“"]([^”"\n]{10,400})[”"]/g)) {
    if (words(m[1]).length >= minWords) out.push(m[1].trim());
  }
  return out;
}

export function keywordDensity(text: string, keyword: string): number {
  const w = words(text);
  const k = words(keyword);
  if (!w.length || !k.length) return 0;
  let hits = 0;
  for (let i = 0; i + k.length <= w.length; i++) if (k.every((t, j) => w[i + j] === t)) hits++;
  return (hits * k.length) / w.length;
}

const FILLER = [
  "in today's fast-paced world", 'in the ever-evolving', 'it is important to note', "it's important to note", 'it goes without saying',
  'in the realm of', 'a testament to', 'delve into', 'unlock the power', 'game-changer', 'in conclusion,', 'at the end of the day',
  'navigating the landscape', 'rapidly evolving landscape', 'plays a crucial role', 'tapestry',
];
export function fillerHits(text: string): string[] {
  const lower = text.toLowerCase().replace(/[’]/g, "'");
  return FILLER.filter((f) => lower.includes(f));
}

/** Share of sentences that repeat an earlier sentence, plus share of repeated 4-grams. */
export function repetition(text: string): { repeatedSentences: number; repeatedFourGrams: number } {
  const ss = sentences(text).map((s) => words(s).join(' ')).filter((s) => s.split(' ').length >= 5);
  const seen = new Set<string>();
  let dup = 0;
  for (const s of ss) {
    if (seen.has(s)) dup++;
    else seen.add(s);
  }
  const w = words(text);
  const grams = new Map<string, number>();
  for (let i = 0; i + 4 <= w.length; i++) {
    const g = w.slice(i, i + 4).join(' ');
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let rep = 0;
  for (const c of grams.values()) if (c > 1) rep += c - 1;
  return { repeatedSentences: ss.length ? dup / ss.length : 0, repeatedFourGrams: w.length ? rep / w.length : 0 };
}

export type Heading = { level: number; text: string; line: number };
export function headings(md: string): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  md.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], line: i });
  });
  return out;
}

export function markdownLinks(md: string): { text: string; url: string }[] {
  return [...md.matchAll(/(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => ({ text: m[1], url: m[2] }));
}

export function citationMarkers(md: string): string[] {
  return [...md.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]);
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .slice(0, 80)
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------------------------
// Tolerant text matching, used to confirm that a model-supplied evidence quote really is in a source
// ---------------------------------------------------------------------------------------------
const FUNCTION_WORDS = new Set(['the', 'and', 'for', 'that', 'with', 'this', 'from', 'are', 'was', 'were', 'has', 'have', 'had', 'but', 'not', 'its', 'their', 'they', 'which', 'would', 'could', 'been', 'than', 'into', 'also', 'about', 'more', 'some', 'such', 'when', 'what', 'will', 'can']);

/** Lowercase, drop markdown and punctuation, keep digits with their % and currency signs, collapse spaces. */
export function normalizeLoose(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/[^a-z0-9%$\u20ac\u00a3\u20b9.\s]/g, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const contentTokens = (norm: string) => norm.split(' ').filter((t) => /\d/.test(t) || (t.length >= 4 && !FUNCTION_WORDS.has(t)));

/**
 * Is `quote` in `haystack`? Exact after normalisation, or (for quotes with at least three meaningful words) a stretch of the
 * haystack contains at least 85% of the quote's meaningful words in a window barely longer than the quote. This forgives the
 * punctuation, markdown, ellipsis and word-order slips that make exact matching brittle, without accepting a loose topical overlap.
 */
export function fuzzyIncludes(haystack: string, quote: string): boolean {
  const q = normalizeLoose(quote);
  if (q.length < 12) return false;
  const h = normalizeLoose(haystack);
  if (h.includes(q)) return true;
  const qTokens = q.split(' ');
  const qContent = new Set(contentTokens(q));
  if (qContent.size < 3) return false;
  const hTokens = h.split(' ');
  // Figures never get the benefit of the doubt: every number in the quote must appear, exactly, in the source.
  const hSet = new Set(hTokens);
  for (const t of qTokens) if (/\d/.test(t) && !hSet.has(t)) return false;
  const win = qTokens.length + 4;
  const need = Math.ceil(qContent.size * 0.85);
  const hit = hTokens.map((t) => (qContent.has(t) ? t : ''));
  const counts = new Map<string, number>();
  let distinct = 0;
  for (let i = 0; i < hit.length; i++) {
    if (hit[i]) { const c = counts.get(hit[i]) ?? 0; counts.set(hit[i], c + 1); if (c === 0) distinct++; }
    const out = i - win;
    if (out >= 0 && hit[out]) { const c = counts.get(hit[out])! - 1; counts.set(hit[out], c); if (c === 0) distinct--; }
    if (distinct >= need) return true;
  }
  return false;
}

/** Content-word overlap of two texts, relative to the first. */
export function overlapRatio(a: string, b: string): number {
  const A = new Set(contentTokens(normalizeLoose(a)));
  if (!A.size) return 0;
  const B = new Set(contentTokens(normalizeLoose(b)));
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n / A.size;
}

/**
 * Removes the sentence in `markdown` that best matches `claim`. Only prose lines are touched (never headings, tables or code),
 * and only when the match is clear, so a wrong sentence is not deleted. Returns the removed sentence, or null.
 */
export function removeClaimSentence(markdown: string, claim: string): { markdown: string; removed: string } | null {
  const lines = markdown.split('\n');
  let best: { line: number; sentence: string; score: number } | null = null;
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence || /^\s*(#|\||>)/.test(line) || !line.trim()) return;
    for (const sentence of sentences(line)) {
      const score = overlapRatio(claim, sentence.replace(/\[S\d+\]/g, ' '));
      if (score > (best?.score ?? 0)) best = { line: i, sentence, score };
    }
  });
  const found = best as { line: number; sentence: string; score: number } | null;
  if (!found || found.score < 0.6) return null;
  const line = lines[found.line];
  const at = line.indexOf(found.sentence);
  if (at < 0) return null;
  const rest = (line.slice(0, at) + line.slice(at + found.sentence.length)).replace(/\s{2,}/g, ' ').trim();
  const out = [...lines];
  if (rest) out[found.line] = rest;
  else out.splice(found.line, 1);
  return { markdown: out.join('\n').replace(/\n{3,}/g, '\n\n'), removed: found.sentence };
}
