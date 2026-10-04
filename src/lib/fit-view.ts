import type { Lead, Person } from './db/schema';
import type { FitEvidence } from './pipeline/fit';

/** How a lead's four assessments read on screen: a short label, its tone, and a line of detail. */
export type Assessment = { label: string; tone: 'good' | 'warning' | 'critical' | 'neutral'; detail: string };

export const TONE_CLASS: Record<Assessment['tone'], string> = {
  good: 'bg-good-soft text-good-ink',
  warning: 'bg-warning-soft text-warning-ink',
  critical: 'bg-critical-soft text-critical-ink',
  neutral: 'bg-neutral-soft text-ink-2',
};

type FitFields = Pick<Lead, 'fitStatus' | 'fitOverride' | 'fitDecision' | 'fitReason' | 'status' | 'qualified' | 'researchSummary'>;

/** Company fit against the ICP, or null for a company not researched yet. */
export function fitAssessment(l: FitFields): Assessment | null {
  if (l.fitStatus === 'qualified') {
    return { label: l.fitOverride === 'qualified' ? 'Fit, confirmed by the team' : 'Qualified', tone: 'good', detail: l.fitDecision };
  }
  if (l.fitStatus === 'not_fit') return { label: l.fitOverride === 'not_fit' ? 'Not a fit, decided by the team' : 'Not a fit', tone: 'neutral', detail: l.fitDecision };
  if (l.fitStatus === 'review') return { label: 'Needs review', tone: 'warning', detail: l.fitDecision };
  // Researched before every decision needed evidence.
  if (l.status === 'Disqualified') {
    return { label: 'Rejected by the old check', tone: 'neutral', detail: `${l.fitReason ? `${l.fitReason} ` : ''}(Ruled out before evidence was required: reassess to check it against the evidence rules.)` };
  }
  if (l.qualified === true) return { label: 'Qualified', tone: 'good', detail: l.fitReason };
  if (l.qualified === false) return { label: 'Not a fit', tone: 'neutral', detail: l.fitReason };
  return null;
}

/** The criterion's finding in words: deal-breakers "apply", everything else is "met". */
export function evidenceLabel(e: Pick<FitEvidence, 'kind' | 'status'>): string {
  if (e.kind === 'deal_breaker') return e.status === 'met' ? 'Applies' : e.status === 'not_met' ? 'Does not apply' : 'Not found';
  return e.status === 'met' ? 'Met' : e.status === 'not_met' ? 'Not met' : 'Unknown';
}

/** Red for what rules a company out, amber for what's unsettled, green for what's in its favour. */
export function evidenceTone(e: Pick<FitEvidence, 'kind' | 'status' | 'verified'>): Assessment['tone'] {
  const against = (e.kind === 'deal_breaker' && e.status === 'met') || (e.kind !== 'deal_breaker' && e.status === 'not_met');
  if (against) return e.verified && (e.kind === 'requirement' || e.kind === 'deal_breaker') ? 'critical' : 'warning';
  if (e.status === 'unknown') return e.kind === 'requirement' ? 'warning' : 'neutral';
  return 'good';
}

/** Where a finding came from, in words. */
export function evidenceSource(e: Pick<FitEvidence, 'status' | 'source' | 'url' | 'verified' | 'check'>): string {
  if (e.status === 'unknown') return '';
  if (e.check) return `set aside on a second look: ${e.check}`;
  if (e.url) return e.verified ? '' : 'quote not found in this source';
  if (e.source === 'K') return 'widely known, no source';
  return 'no source given';
}

/** Commercial risk, recorded apart from the fit. */
export function riskAssessment(l: Pick<Lead, 'riskFlags' | 'fitStatus'>): Assessment {
  if (l.riskFlags.length) return { label: l.riskFlags.map((r) => r.label).join(', '), tone: 'warning', detail: 'Recorded apart from the ICP fit; it rules a company out only when an ICP deal-breaker names it.' };
  return { label: l.fitStatus ? 'None found' : 'Not checked', tone: 'neutral', detail: '' };
}

type ContactFields = Pick<Lead, 'contactName' | 'contactTitle' | 'contactEmail' | 'emailStatus' | 'contactLinkedin' | 'contactVerifiedAt' | 'city' | 'status' | 'qualified'> &
  Partial<Pick<Lead, 'refetchPending' | 'lastError'>>;

/** Whether there is someone to contact, and how they can be reached. Separate from the fit. */
type PersonFields = Pick<Person, 'name' | 'isPrimary' | 'passedAt' | 'passedReason' | 'location'> & Partial<Pick<Person, 'title' | 'whyNot'>>;

/** A corporate contact (owner, partner, CEO, director) set aside for the team to review. */
export const isCorporateContact = (p: Partial<Pick<Person, 'whyNot' | 'passedReason'>>) => p.passedReason !== 'tried' && !!p.whyNot?.startsWith('Corporate contact');

/** Why someone listed under People isn't the main contact. */
function notMainBecause(p: PersonFields, city: string): string {
  if (p.passedAt && p.passedReason === 'excluded') return p.whyNot || 'not a contact for this site';
  if (p.passedAt && p.passedReason !== 'tried' && p.whyNot?.startsWith('Potential company contact')) {
    return 'potential company contact; title and current employment need confirmation (checked again weekly)';
  }
  if (p.passedAt) return p.passedReason === 'tried' ? 'tried, no luck' : 'not confirmed on LinkedIn at this site yet (checked again weekly)';
  if (!p.location) return 'location not confirmed';
  return city ? `based in ${p.location}` : 'not picked';
}

export function contactAvailability(l: ContactFields, found: PersonFields[] = []): Assessment {
  if (!l.contactName) {
    // The search itself failed: nobody was looked for, so "nobody found" would be wrong.
    if (l.refetchPending && l.lastError?.startsWith('Contacts not searched')) return { label: 'Search failed', tone: 'warning', detail: l.lastError };
    // People were found but none is the main contact: say who, and why not.
    if (found.length && l.status !== 'New' && l.status !== 'Processing') {
      // Company contacts were found and set aside: say who, and why each isn't the main contact.
      const corporate = found.filter(isCorporateContact);
      const rest = found.filter((p) => !isCorporateContact(p));
      const parts = [
        corporate.length ? `Corporate contacts for review: ${corporate.map((p) => `${p.name} (${[p.title, p.location].filter(Boolean).join(', ') || 'no title shown'})`).join('; ')}` : '',
        rest.length ? `${corporate.length ? 'Others: ' : ''}${rest.map((p) => `${p.name} (${notMainBecause(p, l.city)})`).join('; ')}` : '',
      ].filter(Boolean);
      return {
        label: l.city ? `Company contacts found; no ${l.city} contact confirmed` : `${found.length} found, no main contact`,
        tone: 'warning',
        detail: `${parts.join('. ')}. Use "Make main contact" to choose one now.`,
      };
    }
    const detail =
      l.status === 'Needs Review' || l.status === 'Disqualified' || l.qualified === false
        ? 'Contacts are searched once the company is a confirmed fit.'
        : l.status === 'New' || l.status === 'Processing'
          ? 'Not searched yet.'
          : 'Nobody on the ICP lists could be confirmed at this company; the team finds someone.';
    return { label: 'No contact yet', tone: l.status === 'Needs Manual Contact' ? 'warning' : 'neutral', detail };
  }
  const ways = [l.contactEmail && 'email', l.contactLinkedin && 'LinkedIn'].filter(Boolean);
  return {
    label: ways.length ? `Reachable by ${ways.join(' and ')}` : 'Found, no email or LinkedIn yet',
    tone: ways.length ? 'good' : 'warning',
    detail: [l.contactName, l.contactTitle].filter(Boolean).join(', '),
  };
}

/** Whether the main contact is confirmed at this lead's site. Separate from the fit. */
export function contactGeography(l: ContactFields, primary?: { location: string; source: string }): Assessment {
  if (!l.contactName) return { label: 'No contact', tone: 'neutral', detail: '' };
  const where = primary?.location ? `Based in ${primary.location}` : '';
  if (primary?.source === 'Sales team') return { label: 'Entered by the sales team', tone: 'good', detail: where };
  if (l.contactVerifiedAt) {
    return { label: l.city ? `Confirmed at the ${l.city} site` : 'Confirmed at the company', tone: 'good', detail: where ? `${where} (LinkedIn)` : 'LinkedIn profile at this company' };
  }
  return { label: 'Not confirmed at the site', tone: 'warning', detail: `${where ? `${where}. ` : ''}Held back from the morning draw until confirmed.` };
}
