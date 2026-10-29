// Duplicate detection by normalised keywords and token overlap. This is lexical only: it catches
// repeated wording but not a same-intent topic phrased very differently (embedding similarity is a planned addition).

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that',
  'the', 'to', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'your', 'you', 'can', 'do', 'does', 'this',
  'guide', 'best', 'top', 'new', 'complete', 'ultimate', 'vs', 'versus',
]);

function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('sses')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .map(stem);
}

/** Order-independent key for a keyword or headline. */
export function normalizedKey(text: string): string {
  return [...new Set(tokens(text))].sort().join(' ');
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export type ExistingItem = {
  id: string;
  kind: 'article' | 'topic';
  /** Topic status or article status. */
  status: string;
  headline: string;
  keyword: string | null;
  createdAt: Date;
};

export type CandidateLike = { headline: string; primaryKeyword: string; newestSourceAt: Date | null };

export type Match = { id: string; kind: ExistingItem['kind']; status: string; headline: string; score: number; reason: string; overridden: boolean };

export const REJECTED_MEMORY_DAYS = 90;
export const NEW_DEVELOPMENT_AFTER_DAYS = 30;
const HEADLINE_THRESHOLD = 0.6;

/**
 * Finds existing items this candidate would duplicate.
 * A match is "overridden" (allowed) only when the old item is a month or more old and the candidate rests on
 * reporting published after it, and the wording is not a near-copy: a genuine new development, not a repeat.
 * Topics still in the pipeline and recent rejections are never overridden; the administrator's decision stands.
 */
export function findMatches(candidate: CandidateLike, existing: ExistingItem[], now: Date): Match[] {
  const candKey = normalizedKey(candidate.primaryKeyword);
  const candHead = tokens(candidate.headline);
  const candKw = tokens(candidate.primaryKeyword);
  const out: Match[] = [];

  for (const e of existing) {
    const ageDays = (now.getTime() - e.createdAt.getTime()) / 864e5;
    // A rejection only blocks for a while; everything else (live topics, drafts, published) always counts.
    if (e.status === 'rejected' && ageDays > REJECTED_MEMORY_DAYS) continue;

    const headScore = jaccard(candHead, tokens(e.headline));
    const eKey = e.keyword ? normalizedKey(e.keyword) : '';
    const sameKeyword = !!eKey && eKey === candKey;
    const keywordContained = !!e.keyword && candKw.length > 0 && tokens(e.keyword).length > 0 && (isSubset(candKw, tokens(e.headline)) || isSubset(tokens(e.keyword), candHead));
    let reason = '';
    let score = 0;
    if (sameKeyword) { reason = 'same primary keyword'; score = Math.max(0.9, headScore); }
    else if (headScore >= HEADLINE_THRESHOLD) { reason = 'very similar headline'; score = headScore; }
    else if (keywordContained && headScore >= 0.4) { reason = 'overlapping keyword and headline'; score = Math.max(headScore, 0.6); }
    if (!reason) continue;

    const newer = !!candidate.newestSourceAt && candidate.newestSourceAt.getTime() > e.createdAt.getTime();
    const overridden = ageDays >= NEW_DEVELOPMENT_AFTER_DAYS && newer && headScore < 0.85 && !['pending', 'approved', 'generating', 'rejected'].includes(e.status);
    out.push({ id: e.id, kind: e.kind, status: e.status, headline: e.headline, score: Math.round(score * 100) / 100, reason, overridden });
  }
  return out.sort((a, b) => b.score - a.score);
}

function isSubset(small: string[], big: string[]): boolean {
  const B = new Set(big);
  return small.every((t) => B.has(t));
}

export const isBlocked = (matches: Match[]) => matches.some((m) => !m.overridden);
