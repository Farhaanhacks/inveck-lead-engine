import type { Icp } from './db/schema';

export type Tier = 'P1' | 'P2' | 'P3' | 'Avoid' | '';

// Titles are written many ways: "VP - Operations", "Vice President Operations", "Head, Supply Chain".
const ALIASES: [RegExp, string][] = [
  [/\bassistant vice president\b|\ba\.?v\.?p\b/g, 'avp'],
  [/\bsenior vice president\b|\bsvp\b/g, 'vp'],
  [/\bvice president\b|\bv\.?p\b/g, 'vp'],
  [/\bdeputy general manager\b|\bd\.?g\.?m\b/g, 'dgm'],
  [/\bassistant general manager\b|\ba\.?g\.?m\b/g, 'agm'],
  [/\bgeneral manager\b|\bg\.?m\b/g, 'gm'],
  [/\bchief operating officer\b|\bc\.?o\.?o\b/g, 'coo'],
  // "Chief of Operations" is the Operations Head.
  [/\bchief of\b/g, 'head of'],
  [/\bchief financial officer\b|\bc\.?f\.?o\b/g, 'cfo'],
  [/\bmanaging director\b|\bm\.?d\b/g, 'md'],
  [/\bhuman resources?\b|\bh\.?r\b/g, 'hr'],
  [/\bquality assurance\b|\bq\.?a\b/g, 'quality'],
  [/\badministration\b/g, 'admin'],
  [/\bstores\b/g, 'store'],
];
const FILLER = new Set(['of', 'the', 'and', 'for', 'at', 'in', 'a', 'an', 'senior', 'sr', 'jr']);

function tokens(text: string): string[] {
  let s = text.toLowerCase().replace(/[–—]/g, '-');
  for (const [re, to] of ALIASES) s = s.replace(re, to);
  return s.split(/[^a-z0-9]+/).filter((w) => w && !FILLER.has(w));
}

/** True when every word of the role (after aliases) appears in the title: "Head of Supply Chain" matches "Supply Chain Head". */
function matches(title: string[], role: string): boolean {
  const want = tokens(role);
  return want.length > 0 && want.every((w) => title.includes(w));
}

const list = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);

/** Where a person sits in the ICP's contact priority: P1 decision-maker, P2 process owner, P3 process level, or a function to avoid. */
export function tierOf(title: string, icp: Pick<Icp, 'targetTitles' | 'p2Titles' | 'p3Titles' | 'avoidTitles'> | undefined): Tier {
  if (!title || !icp) return '';
  const t = tokens(title);
  // HR, admin and quality people are never a priority, even with a senior title ("GM - HR").
  if (list(icp.avoidTitles).some((r) => matches(t, r))) return 'Avoid';
  const tiers: [Tier, string][] = [
    ['P1', icp.targetTitles],
    ['P2', icp.p2Titles],
    ['P3', icp.p3Titles],
  ];
  for (const [tier, roles] of tiers) if (list(roles).some((r) => matches(t, r))) return tier;
  return '';
}

export const TIER_LABEL: Record<Tier, string> = {
  P1: 'P1 decision-maker',
  P2: 'P2 process owner',
  P3: 'P3 process level',
  Avoid: 'Not a priority',
  '': '',
};
