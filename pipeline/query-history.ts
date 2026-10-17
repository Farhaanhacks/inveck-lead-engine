/**
 * Telling search queries apart. "automotive suppliers Pune" and "Pune automotive supplier companies"
 * are the same search: the words that carry no meaning are dropped, plurals folded and the rest
 * compared as a set, so a reworded repeat of an earlier search is caught in code, not left to the AI.
 */

/** Words that don't change what a search finds. */
const FILLER = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'at', 'for', 'with', 'near', 'from', 'to', 'by', 'on',
  'company', 'companies', 'firm', 'firms', 'business', 'businesses', 'list', 'lists', 'top', 'best', 'leading', 'major',
  'india', 'indian', 'ltd', 'limited', 'pvt', 'private', 'llp', 'inc', 'based', 'located',
]);

/** Same word, other spelling or form. */
const SAME: Record<string, string> = {
  manufacturer: 'manufactur', manufacturing: 'manufactur', manufacture: 'manufactur', maker: 'manufactur', producer: 'manufactur',
  supplier: 'supply', supply: 'supply', vendor: 'supply',
  automobile: 'auto', automotive: 'auto', auto: 'auto',
  warehouse: 'warehous', warehousing: 'warehous',
  logistic: 'logistic', logistics: 'logistic',
  bengaluru: 'bangalore', gurugram: 'gurgaon', mumbai: 'mumbai', bombay: 'mumbai',
  ca: 'chartered', chartered: 'chartered', accountant: 'chartered',
  pharmaceutical: 'pharma', pharma: 'pharma',
  plant: 'plant', factory: 'plant', unit: 'plant',
  part: 'component', parts: 'component', component: 'component', spare: 'component',
};

function fold(word: string): string {
  let w = word;
  if (SAME[w]) return SAME[w];
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return SAME[w] ?? w;
}

/** The words a query searches for, as a sorted set: "Pune automotive supplier companies" → "auto pune supply". */
export function queryTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .replace(/["'’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !FILLER.has(w))
    .map(fold)
    .filter((w) => w && !FILLER.has(w));
  return [...new Set(words)].sort();
}

/** A stable key for a query, for storing and exact look-ups. */
export function normQuery(query: string): string {
  return queryTerms(query).join(' ');
}

/** How alike two queries are, 0 to 1 (shared words over all words). */
export function querySimilarity(a: string, b: string): number {
  const x = new Set(queryTerms(a));
  const y = new Set(queryTerms(b));
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

/** Shared words over all words at or above this: the same search reworded. */
export const SIMILAR_AT = 0.7;

/**
 * The earlier query this one merely repeats, or null. A repeat is the same words reworded or mostly
 * the same words, or an earlier query with words added ("auto component manufacturer Pune ISO 9001"
 * after "auto component manufacturer Pune": Google returns much the same companies).
 */
export function tooSimilar(query: string, earlier: string[]): string | null {
  const x = queryTerms(query);
  if (!x.length) return null;
  for (const e of earlier) {
    const y = queryTerms(e);
    if (!y.length) continue;
    if (querySimilarity(query, e) >= SIMILAR_AT) return e;
    const [small, big] = x.length <= y.length ? [x, y] : [y, x];
    if (small.length >= 2 && small.every((w) => big.includes(w))) return e;
  }
  return null;
}
