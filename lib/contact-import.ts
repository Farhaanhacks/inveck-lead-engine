import type { Db } from './db';
import { leads, people } from './db/schema';
import { logActivity } from './activity';
import type { KnownBranches } from './branches';
import { domainOf } from './pipeline/text';
import { cleanPhone } from './tracker';

/** Where an imported company came from: research checks its fit against the ICP chosen on import. */
export const IMPORTED_SOURCE = 'Imported list (researched by the team)';

/** One company from a list the team researched: its numbers, email and the people with their LinkedIn. */
export type ContactRow = {
  company: string;
  website: string;
  city: string;
  phones: string[];
  emails: string[];
  people: { name: string; title: string; linkedin: string }[];
};

const find = (header: string[], re: RegExp) => header.findIndex((h) => re.test(h));
const all = (header: string[], re: RegExp) => header.map((h, i) => (re.test(h) ? i : -1)).filter((i) => i >= 0);
/** "9449651169 / 080-2222 3333", one per line, or comma separated. */
const splitList = (v: string) => v.split(/\s*(?:\n|;|,|\/|\|)\s*/).map((x) => x.trim()).filter(Boolean);

/**
 * A sheet of companies with their points of contact, read by its header: Firm or Company; Phone (one
 * or several columns, or several numbers in a cell); Email; the names ("Matched partner / proprietor",
 * "Contact name": "1. Prakash Anantharaman" one per line, a note in brackets dropped); Role or
 * Designation; LinkedIn 1, LinkedIn 2… (the nth profile is the nth name's); optional City and Website.
 */
export function parseContactSheet(rows: string[][]): { rows: ContactRow[]; error: string } {
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const company = find(header, /^(firm|company|firm name|company name|name of (the )?(firm|company))$/);
  if (company < 0) return { rows: [], error: 'No "Firm" or "Company" column in the first row.' };
  const phones = all(header, /phone|mobile|contact (no|number)/);
  const emails = all(header, /e-?mail/);
  const names = find(header, /partner|proprietor|contact name|contact person|^name$|^person$/);
  const role = find(header, /^(role|title|designation|position)$/);
  const linkedins = all(header, /linkedin/);
  const city = find(header, /^(city|location|town)$/);
  const website = find(header, /website|domain|url$/);
  const out: ContactRow[] = [];
  for (const r of rows.slice(1)) {
    const cell = (i: number) => (i >= 0 ? String(r[i] ?? '').trim() : '');
    const name = cell(company);
    if (!name) continue;
    const listed = splitLines(cell(names));
    const profiles = linkedins.map(cell);
    const title = cell(role);
    const ppl = listed.map((n, i) => ({ name: n, title, linkedin: normLinkedin(profiles[i] ?? '') }));
    // Profiles without a name beside them still belong to the company.
    for (let i = listed.length; i < profiles.length; i++) if (profiles[i]) ppl.push({ name: '', title, linkedin: normLinkedin(profiles[i]) });
    out.push({
      company: name,
      website: domainOf(cell(website)),
      city: cell(city),
      phones: [...new Set(phones.flatMap((i) => splitList(cell(i))).map((p) => cleanPhone(p)).filter((p): p is string => !!p))],
      emails: [...new Set(emails.flatMap((i) => splitList(cell(i))).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))],
      people: ppl.filter((p) => p.name || p.linkedin),
    });
  }
  return { rows: out, error: out.length ? '' : 'No companies found under the header row.' };
}

/** "1. Prakash Anantharaman\n2. Prashant Khinvasara" gives both names; "(LinkedIn: Kishna Kumar)" is dropped. */
function splitLines(v: string): string[] {
  return v
    .split(/\n|;/)
    .map((x) => x.replace(/^\s*\d+[.)]\s*/, '').replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function normLinkedin(v: string): string {
  const t = v.trim();
  if (!t) return '';
  return /^https?:\/\//i.test(t) ? t : /linkedin\.com/i.test(t) ? `https://${t.replace(/^\/+/, '')}` : '';
}

/**
 * Adds the companies as leads with every point of contact. The first person is the main contact
 * (with the company's first number and email), confirmed by the team; the others, and any further
 * numbers or emails, are kept as more points of contact. Research scores each company against the
 * chosen ICP like any other (its own evidence and score) and writes the email. A company already a
 * lead or a client is skipped.
 */
export async function importContactSheet(
  db: Db,
  parsed: ContactRow[],
  opts: { segment: string; ownerId: number | null; known: KnownBranches; by: string },
): Promise<{ added: number; skipped: string[] }> {
  let added = 0;
  const skipped: string[] = [];
  const now = new Date();
  for (const row of parsed) {
    if (opts.known.has(row.company, row.website, row.city)) {
      skipped.push(row.company);
      continue;
    }
    opts.known.add(row.company, row.website, row.city);
    const [main, ...rest] = row.people.length ? row.people : [{ name: '', title: '', linkedin: '' }];
    const [lead] = await db
      .insert(leads)
      .values({
        company: row.company,
        website: row.website,
        city: row.city,
        segment: opts.segment,
        source: IMPORTED_SOURCE,
        ownerId: opts.ownerId,
        nameEvidence: 'set by the team',
        contactName: main.name,
        contactTitle: main.title,
        contactPhone: row.phones[0] ?? '',
        contactEmail: row.emails[0] ?? '',
        contactLinkedin: main.linkedin,
        contactVerifiedAt: main.name ? now : null,
      })
      .returning({ id: leads.id });
    const contacts = [
      ...(main.name ? [{ ...main, phone: row.phones[0] ?? '', email: row.emails[0] ?? '', source: 'Sales team', isPrimary: true }] : []),
      ...rest.map((p) => ({ ...p, name: p.name || 'LinkedIn profile', phone: '', email: '', source: 'Added by the team', isPrimary: false })),
      // More numbers and addresses for the company: points of contact of their own.
      ...row.phones.slice(1).map((phone) => ({ name: 'Other number', title: '', linkedin: '', phone, email: '', source: 'Added by the team', isPrimary: false })),
      ...row.emails.slice(1).map((email) => ({ name: 'Other email', title: '', linkedin: '', phone: '', email, source: 'Added by the team', isPrimary: false })),
    ];
    if (contacts.length) await db.insert(people).values(contacts.map((c) => ({ ...c, leadId: lead.id, evidence: 'On the team\'s researched list' })));
    await logActivity(db, lead.id, 'added', `Imported by ${opts.by} with ${row.people.length} ${row.people.length === 1 ? 'person' : 'people'} to contact`);
    // The team chose this person: never replaced automatically by someone research finds.
    if (main.name) await logActivity(db, lead.id, 'contact', `Point of contact updated: ${main.name}${main.title ? `, ${main.title}` : ''} (from the imported list)`);
    added++;
  }
  return { added, skipped };
}
