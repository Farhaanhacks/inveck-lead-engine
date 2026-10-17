import type { Tier } from '@/lib/tiers';

const TIER_TITLE: Record<string, string> = {
  P1: 'P1: primary decision-maker',
  P2: 'P2: process owner',
  P3: 'P3: process-level contact',
};

/** "P1", "P2" or "P3" next to a person's name: where their title sits on the ICP's contact lists. */
export function TierBadge({ tier }: { tier: Tier }) {
  if (tier !== 'P1' && tier !== 'P2' && tier !== 'P3') return null;
  const tone = tier === 'P1' ? 'bg-good-soft text-good-ink' : tier === 'P2' ? 'bg-accent-soft text-accent' : 'bg-neutral-soft text-ink-2';
  return (
    <span title={TIER_TITLE[tier]} className={`ml-2 rounded px-1.5 py-0.5 align-middle text-[11px] font-semibold tabular-nums ${tone}`}>
      {tier}
    </span>
  );
}
