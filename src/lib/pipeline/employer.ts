/**
 * Does this person work at the company now? LinkedIn results are found by searching for the company's
 * name, so they include people who used to work there ("Plant Head at PepsiCo", "ex-Nestle"). This
 * reads the headline, the Google result title and the snippet for who they work for today.
 */

export type Employer = 'here' | 'elsewhere' | 'unknown';

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (s: string) =>
  plain(s)
    .replace(/\b(pvt|private|ltd|limited|llp|inc|india|indian|the|co|company|group|corp|corporation|plc|sa|ag)\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

/** "Nestlé India Ltd" matches "Nestle" and "Nestle India"; "Tata Steel" doesn't match "Tata Motors". */
export function sameFirm(text: string, company: string): boolean {
  const a = words(text);
  const b = words(company);
  if (!a.length || !b.length) return false;
  return b.every((w) => a.includes(w)) || a.every((w) => b.includes(w));
}

const ROLE = /\b(head|manager|director|officer|vp|president|engineer|executive|lead|chief|gm|dgm|agm|founder|partner|analyst|consultant|specialist|supervisor|coordinator|associate|intern|ceo|cfo|coo|cto|md|controller|owner|incharge|in-charge|planner|buyer|leader|member|trainee|assistant|deputy|senior|sr|general)\b/i;

/** The employers named in a headline: "Plant Head at Bisleri || Unilever" gives Bisleri, Unilever. */
function employersAfterAt(text: string): string[] {
  const m = /\s(?:at|@)\s+(.+)$/i.exec(text);
  if (!m) return [];
  return m[1].split(/\s*(?:\|\||\||,|;|\/| - | – )\s*/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Where the person works now, from what LinkedIn and Google show:
 * - a headline "X at Company", or a result title "Name - Role - Company | LinkedIn";
 * - a snippet "Experience: Company";
 * - "ex-Company" / "former ... Company" means they left.
 */
export function currentEmployer(person: { name: string; title: string; snippet?: string; titleParts?: string[] }, company: string): Employer {
  if (!company.trim()) return 'unknown';
  const say: Employer[] = [];

  const firstEmployer = (list: string[]) => {
    if (list.length) say.push(sameFirm(list[0], company) ? 'here' : 'elsewhere');
  };
  firstEmployer(employersAfterAt(person.title));
  // Google's title "Name - Role - Company": with two or more parts after the name, the last is the
  // company. A single part is the role or a headline, never read as an employer.
  const parts = (person.titleParts ?? []).map((p) => p.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  if (last && (parts.length >= 2 || sameFirm(last, company)) && !ROLE.test(last)) say.push(sameFirm(last, company) ? 'here' : 'elsewhere');
  for (const p of parts) firstEmployer(employersAfterAt(p));

  const snippet = person.snippet ?? '';
  const exp = /experience:\s*([^·•|\n]+)/i.exec(snippet);
  if (exp) say.push(sameFirm(exp[1], company) ? 'here' : 'elsewhere');
  const left = new RegExp(`\\b(ex[- ]|former(ly)?\\b[^.]{0,40})${words(company)[0] ?? '$^'}`, 'i');
  if (left.test(plain(`${person.title} ${snippet}`))) return 'elsewhere';

  // The current role decides: the headline / title first, then the snippet.
  if (say[0]) return say[0];
  return 'unknown';
}

/**
 * A LinkedIn profile whose surname is the company's name ("Cynthia Nestle") is a company page or a
 * made-up profile. Only applied to LinkedIn search results: family firms' leaders (a Godrej at Godrej)
 * come from the company's own records instead.
 */
export function nameIsTheCompany(name: string, company: string): boolean {
  const firm = words(company);
  return words(name).slice(1).some((w) => firm.includes(w));
}
