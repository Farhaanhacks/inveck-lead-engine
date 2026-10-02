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

/** Words that don't make a company name distinctive on their own. */
const GENERIC = new Set(['auto', 'automotive', 'industries', 'industry', 'technologies', 'technology', 'tech', 'world', 'global', 'international', 'enterprises', 'systems', 'solutions', 'logistics', 'motors', 'steel', 'foods', 'products', 'engineering', 'manufacturing', 'services', 'holdings', 'ventures', 'group', 'and']);

/** The brand: the company name's first distinctive word ("Lumax" in "Lumax Auto Technologies"). */
export function brandOf(company: string): string {
  const w = words(company).find((x) => x.length >= 4 && !GENERIC.has(x));
  return w ?? '';
}

/**
 * The same company under the names its people use: "Nestlé India Ltd" matches "Nestle" and "Nestle
 * India"; "Lumax Auto Technologies" matches "Lumax World" and "Lumax Industries" (same brand, how its
 * staff write it on LinkedIn).
 */
export function sameFirm(text: string, company: string): boolean {
  const a = words(text);
  const b = words(company);
  if (!a.length || !b.length) return false;
  if (b.every((w) => a.includes(w)) || a.every((w) => b.includes(w))) return true;
  const brand = brandOf(company);
  return !!brand && brandOf(text) === brand;
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

export type SnippetRole = { role: string; company: string; current: boolean };

const DATE = String.raw`(?:[A-Z][a-z]{2,8}\s)?\d{4}`;
// The company may hold a dot inside it ("Godamwale.com"), never one followed by a space.
const ROLE_LINE = new RegExp(String.raw`([A-Za-z][^.|·]{1,70}?)\.\s+((?:[^.|·]|\.(?=\S)){2,80}?)\.?,?\s+(${DATE})\s*[-–]\s*(Present|${DATE})`, 'g');
/** About-section prose ("My career spans roles including Regional Head at X") isn't a current job. */
const PROSE = /\b(my|i|career|including|included|roles|spans|years|worked|previously|formerly|former|was|were|have|has|had|experience|journey|from|served|as)\b/i;
const HEADLINE = /([A-Za-z][^·|.]{2,60}?)\s*(?:-?@|\bat\b)\s*([^·|.,]{2,60})/;

/**
 * Jobs a LinkedIn snippet shows, with whether each is current: "Group Plant Head. CIE Automotive
 * India Ltd. Mar 2025 - Present" is current; "Plant Head. CIE Automotive India Ltd. Nov 2024 - May
 * 2026" has ended. A headline ("Group Plant Head -@CIE Automotive India Ltd") counts as current.
 */
export function snippetRoles(snippet: string): SnippetRole[] {
  const text = snippet.replace(/\s*·\s*/g, '. ').replace(/\s+/g, ' ');
  const out: SnippetRole[] = [];
  for (const m of text.matchAll(ROLE_LINE)) {
    const role = m[1].replace(/^(experience|present)\s*/i, '').trim();
    if (role && !/^experience$/i.test(role)) out.push({ role, company: m[2].trim(), current: /present/i.test(m[4]) });
  }
  const h = HEADLINE.exec(snippet.split(/\s*[·|]\s*/).find((p) => /-?@|\bat\b/.test(p)) ?? '');
  const role = h ? h[1].replace(/^.*?·\s*/, '').trim() : '';
  if (h && !PROSE.test(role) && role.split(/\s+/).length <= 6) out.push({ role, company: h[2].trim(), current: true });
  return out;
}

/**
 * Google's line under a LinkedIn result, "Mumbai, Maharashtra, India · Head of Unit · Balmer Lawrie
 * & Co. Ltd.": the place, then the current role and current employer from the profile itself. It is
 * the most reliable sign of where someone works now; null when the line doesn't have all three.
 */
export function subtitleJob(subtitle: string | undefined): { role: string; company: string } | null {
  const parts = String(subtitle ?? '').split(/\s+·\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  return { role: parts[parts.length - 2], company: parts[parts.length - 1] };
}

const INDIA_PLACES = new RegExp(
  String.raw`\b(india|bharat|` +
    // States and union territories.
    String.raw`maharashtra|gujarat|karnataka|tamil nadu|telangana|andhra pradesh|kerala|goa|rajasthan|madhya pradesh|uttar pradesh|uttarakhand|haryana|punjab|himachal pradesh|jammu|kashmir|ladakh|delhi|bihar|jharkhand|odisha|orissa|west bengal|assam|meghalaya|tripura|manipur|mizoram|nagaland|sikkim|arunachal|chhattisgarh|chandigarh|puducherry|pondicherry|dadra|daman|` +
    // Cities and areas LinkedIn names without the country ("Greater Bengaluru Area").
    String.raw`mumbai|bombay|thane|navi mumbai|bhiwandi|pune|pimpri|chinchwad|chakan|hinjewadi|nashik|nagpur|aurangabad|kolhapur|ahmedabad|vadodara|baroda|surat|rajkot|vapi|bengaluru|bangalore|mysuru|mysore|hosur|chennai|madras|coimbatore|hyderabad|secunderabad|vizag|visakhapatnam|kochi|cochin|trivandrum|thiruvananthapuram|gurugram|gurgaon|noida|ghaziabad|faridabad|ncr|kolkata|calcutta|jaipur|indore|bhopal|lucknow|kanpur|ludhiana|jamshedpur|ranchi|patna|bhubaneswar|guwahati|dehradun|haridwar|sonipat|manesar|neemrana|sri city|sanand|halol)\b`,
  'i',
);

/** Countries and regions abroad, for results with no location line ("Jackson, Michigan, United States"). */
const ABROAD = /\b(united states|usa|united kingdom|england|germany|deutschland|france|italy|spain|netherlands|belgium|sweden|poland|czech|austria|switzerland|canada|mexico|brazil|australia|new zealand|singapore|malaysia|indonesia|thailand|vietnam|philippines|china|japan|korea|united arab emirates|uae|dubai|abu dhabi|saudi|qatar|oman|kuwait|bahrain|pakistan|bangladesh|sri lanka|nepal|south africa|nigeria|kenya|metropolitan area|bay area)\b/i;

/**
 * Where the person is based: the first part of Google's line under a LinkedIn result ("Pimpri
 * Chinchwad, Maharashtra, India · Head of Operations · Rheinmetall"), else a "Location: X" in the snippet.
 */
export function profileLocation(subtitle: string | undefined, snippet = ''): string {
  const parts = String(subtitle ?? '').split(/\s+·\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[0];
  return /location:\s*([^·|.]+)/i.exec(snippet)?.[1].trim() ?? '';
}

/**
 * Based outside India. INVECK sells to Indian sites, so a "Supply Chain Manager at Rheinmetall" in the
 * Detroit Metropolitan Area is no contact for Rheinmetall Pune. A location must name an Indian place;
 * with no location, an obviously foreign place in the snippet counts.
 */
export function basedAbroad(location: string, snippet = ''): boolean {
  if (location) return !INDIA_PLACES.test(location);
  return ABROAD.test(snippet) && !INDIA_PLACES.test(snippet);
}

/** Areas that belong to one city: Pimpri Chinchwad and Chakan are Pune, Gurugram and Noida are Delhi NCR. */
const METRO: Record<string, RegExp> = {
  pune: /\b(pune|pimpri|chinchwad|chakan|hinjewadi|talegaon|ranjangaon|bhosari|hadapsar)\b/i,
  mumbai: /\b(mumbai|bombay|thane|navi mumbai|bhiwandi|panvel|vasai|kalyan|andheri|powai)\b/i,
  delhi: /\b(delhi|ncr|gurugram|gurgaon|noida|ghaziabad|faridabad|manesar)\b/i,
  bengaluru: /\b(bengaluru|bangalore|hosur|whitefield|electronic city)\b/i,
  bangalore: /\b(bengaluru|bangalore|hosur|whitefield|electronic city)\b/i,
  chennai: /\b(chennai|madras|sriperumbudur|oragadam|ambattur)\b/i,
  hyderabad: /\b(hyderabad|secunderabad)\b/i,
  kolkata: /\b(kolkata|calcutta|howrah)\b/i,
  ahmedabad: /\b(ahmedabad|sanand|gandhinagar)\b/i,
};

/** The text places the person in this city or its metro area. */
export function inCity(text: string, city: string): boolean {
  const place = city.split(',')[0].trim().toLowerCase();
  if (place.length < 3) return false;
  const metro = METRO[place] ?? (place === 'new delhi' || place === 'gurgaon' || place === 'gurugram' || place === 'noida' ? METRO.delhi : undefined);
  return metro ? metro.test(text) : text.toLowerCase().includes(place);
}
