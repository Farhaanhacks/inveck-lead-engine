import type { Icp } from '../db/schema';
import { askJson } from './ai';
import { CONTACT_PROMPT } from './prompts';
import type { Research } from './research';
import type { Services } from './services';
import { googleSearch, hunter } from './services';
import { asBool, asText, asTextList, errorMessage } from './text';

export type Candidate = {
  id: string;
  source: 'Sales team' | 'LinkedIn' | 'Email database';
  name: string;
  title: string;
  email: string;
  phone: string;
  linkedin: string;
  snippet: string;
};

export type ManualContact = { name: string; title: string; email: string; phone: string; linkedin: string };

export type Contact = {
  name: string;
  title: string;
  email: string;
  phone: string;
  linkedin: string;
  /** Where the email came from, when it came with the contact. */
  emailSource: '' | 'hunter' | 'manual';
  roleMatch: boolean;
  reason: string;
};

export const EMPTY_CONTACT: Contact = { name: '', title: '', email: '', phone: '', linkedin: '', emailSource: '', roleMatch: false, reason: '' };

/** Google query for public LinkedIn profiles of the target roles at this company. */
export function linkedinQuery(company: string, city: string, research: Research, icp: Icp): string {
  const roles = (research.targetRoles.length ? research.targetRoles : icp.targetTitles.split(','))
    .map((r) => String(r).trim())
    .filter(Boolean)
    .slice(0, 4);
  return [
    'site:linkedin.com/in',
    `"${company}"`,
    roles.length ? '(' + roles.map((r) => `"${r}"`).join(' OR ') + ')' : '',
    city,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Google results → LinkedIn people. Titles look like "Ravi Kumar - Plant Head - Tata Motors | LinkedIn". */
export async function searchLinkedIn(svc: Services, query: string): Promise<{ people: Omit<Candidate, 'id' | 'source' | 'email' | 'phone'>[]; error: string }> {
  try {
    const results = await googleSearch(svc, query);
    const people = results
      .filter((r) => /linkedin\.com\/in\//i.test(r.link || ''))
      .map((r) => {
        const title = String(r.title || '').replace(/\s*[|\-–]\s*LinkedIn\s*$/i, '');
        const [name, ...rest] = title.split(/\s+[-–|]\s+/);
        return { name: (name || '').trim(), title: rest.join(' - ').trim(), linkedin: r.link || '', snippet: r.snippet || '' };
      })
      .filter((p) => p.name);
    return { people, error: '' };
  } catch (e) {
    return { people: [], error: errorMessage(e) };
  }
}

type HunterEmail = { value?: string; first_name?: string; last_name?: string; position?: string; phone_number?: string; linkedin?: string };

/** People with known work emails at a domain, and the domain's email format (e.g. "{first}.{last}"). */
export async function hunterDomainSearch(svc: Services, domain: string): Promise<{ emails: HunterEmail[]; pattern: string; error: string }> {
  if (!domain) return { emails: [], pattern: '', error: '' };
  try {
    const data = await hunter<{ emails?: HunterEmail[]; pattern?: string }>(svc, 'domain-search', { domain, type: 'personal', limit: '10' });
    return { emails: Array.isArray(data.emails) ? data.emails : [], pattern: typeof data.pattern === 'string' ? data.pattern : '', error: '' };
  } catch (e) {
    return { emails: [], pattern: '', error: errorMessage(e) };
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/** One candidate list from the sales team's contact, LinkedIn and Hunter; the same person on two lists is merged. */
export function buildCandidates(
  manual: ManualContact,
  linkedin: Omit<Candidate, 'id' | 'source' | 'email' | 'phone'>[],
  hunterEmails: HunterEmail[],
): Candidate[] {
  const candidates: Candidate[] = linkedin.map((p, i) => ({ id: `L${i + 1}`, source: 'LinkedIn', email: '', phone: '', ...p }));
  hunterEmails.forEach((e, i) => {
    const person = {
      name: [e.first_name, e.last_name].filter(Boolean).join(' '),
      title: e.position || '',
      email: e.value || '',
      phone: e.phone_number || '',
      linkedin: e.linkedin || '',
    };
    const twin = candidates.find((c) => c.source === 'LinkedIn' && person.name && norm(c.name) === norm(person.name));
    if (twin) {
      twin.email = person.email;
      twin.phone = person.phone;
      if (!twin.title) twin.title = person.title;
    } else {
      candidates.push({ id: `H${i + 1}`, source: 'Email database', snippet: '', ...person });
    }
  });
  if (manual.name || manual.email) candidates.unshift({ id: 'M', source: 'Sales team', snippet: '', ...manual });
  return candidates;
}

const schema = {
  type: 'object',
  properties: {
    chosen_id: { type: 'string' },
    role_match: { type: 'boolean' },
    reason: { type: 'string' },
    other_ids: { type: 'array', items: { type: 'string' } },
    roles_to_find_on_linkedin: { type: 'array', items: { type: 'string' } },
  },
  required: ['chosen_id', 'role_match', 'reason', 'other_ids', 'roles_to_find_on_linkedin'],
  additionalProperties: false,
};

/**
 * The AI picks the best person by candidate id only, so every name, title, email and
 * profile URL comes from a real search result.
 */
export async function pickContact(
  svc: Services,
  lead: { company: string; domain: string; city: string; segment: string },
  research: Research,
  icp: Icp,
  candidates: Candidate[],
): Promise<{ contact: Contact; notes: string[]; error: string }> {
  const userText = [
    `Company: ${lead.company} (${lead.domain || 'no domain'})${lead.city ? `, focus location: ${lead.city}` : ''}`,
    `Segment: ${lead.segment}`,
    `Roles to approach, best first: ${research.targetRoles.join(', ')}`,
    `ICP target titles: ${icp.targetTitles}`,
    '',
    '## Candidates',
    candidates.length ? JSON.stringify(candidates, null, 2) : '(none found)',
  ].join('\n');

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const toContact = (c: Candidate, roleMatch: boolean, reason: string): Contact => ({
    name: c.name,
    title: c.title,
    email: c.email,
    phone: c.phone,
    linkedin: c.linkedin,
    emailSource: c.email ? (c.source === 'Sales team' ? 'manual' : 'hunter') : '',
    roleMatch,
    reason,
  });

  if (!candidates.length) return { contact: { ...EMPTY_CONTACT }, notes: [], error: '' };

  const result = await askJson(svc, CONTACT_PROMPT, userText, schema);
  if (result.error !== undefined) {
    const manual = byId.get('M');
    return { contact: manual ? toContact(manual, false, 'Supplied by the sales team') : { ...EMPTY_CONTACT }, notes: [], error: result.error };
  }
  const d = result.data;
  const chosen = byId.get(asText(d.chosen_id));
  const contact = chosen ? toContact(chosen, asBool(d.role_match), asText(d.reason)) : { ...EMPTY_CONTACT };

  const others = asTextList(d.other_ids)
    .map((id) => byId.get(id.trim()))
    .filter((c): c is Candidate => !!c && c !== chosen)
    .slice(0, 4)
    .map((c) => [c.name, c.title, c.email || c.linkedin].filter(Boolean).join(' | '));
  const rolesToFind = asTextList(d.roles_to_find_on_linkedin);

  const notes: string[] = [];
  if (others.length) notes.push('Other decision-makers:\n' + others.join('\n'));
  if (rolesToFind.length) notes.push('Still to find on LinkedIn: ' + rolesToFind.join(', '));
  return { contact, notes, error: '' };
}
