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
  // "Director - Supply Chain" heads the function, like "Head of Supply Chain".
  [/\bdirector\s*[-,–:]?\s*(?=(supply|operations|manufacturing|production|logistics|plant|warehous|procurement|inventory|finance)\b)/g, 'head '],
  // A plant manager, factory manager, works manager or site head runs the plant: the Plant Head.
  // ("Head Plant Engineering" or "Plant Maintenance Manager" are engineering, not the plant head.)
  [/\b(plant|factory|works|unit|site)\s+(manager|in-?charge|incharge|lead|leader)\b|\bhead\s*[-–]?\s*(plant|factory|works)\b(?!\s+(engineering|maintenance|quality|projects?|hr|accounts|finance|it|admin|safety|electrical|mechanical))|\b(factory|works|unit|site)\s+head\b/g, 'plant head'],
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
/** The role without the company after it ("Plant Head @ Lumax World" gives "Plant Head"). */
export const roleOnly = (title: string) => title.split(/\s+(?:at|@)\s+|\s*-?@\s*/i)[0];

export function tierOf(title: string, icp: Pick<Icp, 'targetTitles' | 'p2Titles' | 'p3Titles' | 'avoidTitles'> | undefined): Tier {
  if (!title || !icp) return '';
  // Only the role, not the company after it: "Manager at Allcargo Logistics" is a manager, not a logistics manager.
  const t = tokens(roleOnly(title));
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

/** Top of the company: they rarely answer a cold call. Reached only when nobody else is found. */
const TOP_EXEC = /\b(md|ceo|coo|cfo|cto|cio|chief executive|chief \w+ officer|chairman|chairperson|founder|co-?founder|owner|proprietor|whole ?time director|executive director|president|promoter)\b/;
/** Senior but a step away from the floor: VPs, CXOs, functional directors. */
const SENIOR = /\b(vp|avp|coo|cfo|cto|director|chief)\b/;
const FUNCTION = /\b(supply|chain|operations|plant|manufacturing|production|logistics|warehous\w*|procurement|purchase|inventory|stores?|finance|works)\b/;

/**
 * Who to approach first; lower is better. INVECK's rule: people who run the floor answer, the top
 * of the company doesn't. So within the ICP's lists: plant heads and supply chain managers first,
 * then regional / national / warehouse heads, then other hands-on heads
 * (operations, manufacturing, supply chain, warehouse, logistics, national / regional heads), then
 * P2 process owners, then VPs and CXOs, then P3, and the MD / CEO / founder last. HR, admin, quality
 * and titles on no list aren't wanted (99).
 */
export function contactPriority(title: string, icp: Pick<Icp, 'targetTitles' | 'p2Titles' | 'p3Titles' | 'avoidTitles'> | undefined): number {
  const tier = tierOf(title, icp);
  if (tier === 'Avoid' || tier === '') return 99;
  // Functions that have nothing to do with stock or assets, whatever their rank ("GM - Marketing").
  if (/\b(marketing|sales|business development|legal|secretarial|investor|public relations|human resources|talent|commercial|customer service|engineering|maintenance|projects?|safety|design|r&d|research)\b/i.test(roleOnly(title))) return 99;
  const t = tokens(roleOnly(title)).join(' ');
  const vpOrCxo = SENIOR.test(t) || /\bdirector\b/i.test(title);
  if (TOP_EXEC.test(t) && !/\bvice\b/.test(t)) return 50;
  if (/\bdirector\b/.test(t) && !FUNCTION.test(t)) return 50;
  // Plant heads and supply chain managers / heads answer and own the stock: they come first.
  if ((tier === 'P1' || tier === 'P2') && (/\bplant head\b/.test(t) || /\bsupply chain\b.*\b(head|manager|lead)\b|\b(head|manager|lead)\b.*\bsupply chain\b/.test(t))) return 5;
  if (tier === 'P1') {
    // Then the people who run a region or a warehouse (logistics: national, regional and warehouse
    // heads). Finance comes after the process owners.
    if (/\b(regional|national|zonal|cluster|warehouse)\b.*\bhead\b|\bhead\b.*\b(regional|national|zonal|warehouse)\b/.test(t)) return 7;
    if (/\b(finance|accounts|controller|cfo)\b/.test(t)) return 22;
    return vpOrCxo ? 25 : 10;
  }
  if (tier === 'P2') return 20;
  return 30;
}

/**
 * The ICP whose rules apply to a lead: its segment's, or (as research does) the first active ICP
 * when the segment matches none, so contacts are always ranked by some list.
 */
export function icpFor<T extends Pick<Icp, 'segment'> & Partial<Pick<Icp, 'id' | 'active'>>>(segment: string, icps: T[]): T | undefined {
  const s = segment.trim().toLowerCase();
  const sorted = [...icps].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  return sorted.find((i) => i.segment.trim().toLowerCase() === s) ?? sorted.find((i) => i.active !== false) ?? sorted[0];
}
