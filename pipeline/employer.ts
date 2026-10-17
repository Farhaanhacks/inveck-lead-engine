import { distanceKm, pointOf, SITE_RADIUS_KM } from './places';

/**
 * Does this person work at the company now? LinkedIn results are found by searching for the company's
 * name, so they include people who used to work there ("Plant Head at PepsiCo", "ex-Nestle"). This
 * reads the headline, the Google result title and the snippet for who they work for today.
 */

export type Employer = 'here' | 'elsewhere' | 'unknown';

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** "Auto Diecasting Company (ADC)": the name without its bracketed abbreviation or note. */
const unbracketed = (s: string) => s.replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ').trim() || s;

const words = (s: string) =>
  plain(unbracketed(s))
    .replace(/\b(pvt|private|ltd|limited|llp|inc|india|indian|the|co|company|group|corp|corporation|plc|sa|ag)\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

/**
 * Words that don't make a company name distinctive on their own: what the company does
 * ("bearings", "tyres", "paints") rather than who it is. Many companies share them.
 */
const GENERIC = new Set([
  'auto', 'automotive', 'automobiles', 'industries', 'industry', 'industrial', 'technologies', 'technology', 'tech', 'world', 'global',
  'international', 'enterprises', 'enterprise', 'systems', 'solutions', 'logistics', 'motor', 'motors', 'steel', 'steels', 'foods', 'food',
  'products', 'engineering', 'engineers', 'manufacturing', 'manufacturers', 'services', 'holdings', 'ventures', 'group', 'and',
  'bearings', 'bearing', 'tyres', 'tyre', 'tires', 'tire', 'paints', 'paint', 'coatings', 'chemicals', 'chemical', 'pharma', 'pharmaceuticals',
  'pharmaceutical', 'healthcare', 'laboratories', 'labs', 'textiles', 'textile', 'fabrics', 'garments', 'apparel', 'cables', 'cable', 'wires',
  'wire', 'forgings', 'forging', 'castings', 'casting', 'plastics', 'polymers', 'packaging', 'rubber', 'metals', 'metal', 'alloys', 'fasteners',
  'springs', 'gears', 'pumps', 'valves', 'pipes', 'tubes', 'tools', 'machines', 'machinery', 'equipment', 'instruments', 'components',
  'electricals', 'electrical', 'electronics', 'electric', 'power', 'energy', 'solar', 'cement', 'cements', 'glass', 'paper', 'papers', 'ceramics',
  'tiles', 'sugar', 'sugars', 'dairy', 'agro', 'fertilizers', 'fertilisers', 'seeds', 'beverages', 'spices', 'exports', 'export', 'impex',
  'overseas', 'traders', 'trading', 'distributors', 'retail', 'express', 'transport', 'transports', 'carriers', 'shipping', 'freight', 'cargo',
  'warehousing', 'supply', 'chain', 'infra', 'infrastructure', 'construction', 'builders', 'projects', 'consultants', 'associates', 'partners',
  'brothers', 'sons', 'mills', 'works', 'plant', 'plants', 'parts', 'ancillaries', 'ancillary', 'precision', 'drugs', 'lifesciences', 'life', 'sciences', 'biotech', 'formulations', 'unit', 'division', 'com', 'co', 'in', 'pvt', 'ltd',
  // Common first words that many unrelated companies share ("Bharat Forge", "Bharat Petroleum").
  'bharat', 'hindustan', 'indian', 'national', 'united', 'general', 'standard', 'royal', 'shree', 'shri', 'sree', 'modern', 'super',
  'star', 'prime', 'supreme', 'apex', 'asian', 'eastern', 'western', 'southern', 'northern', 'central', 'premier', 'universal', 'golden',
  'classic', 'new', 'first', 'best', 'great', 'jai', 'maa', 'om', 'sai',
]);

/**
 * The brand: the company name's first word, when it is distinctive ("Lumax" in "Lumax Auto
 * Technologies"), so staff who write "Lumax World" or "Lumax Industries" still match. A short first
 * word ("NBC" in "NBC Bearings", "MRF Tyres") is no brand: the name must then match in full, and the
 * next word never stands in for it ("bearings" would match RBC Bearings and SKF Bearings).
 */
export function brandOf(company: string): string {
  const first = plain(company)
    .replace(/\b(the)\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .find(Boolean);
  return first && first.length >= 4 && !GENERIC.has(first) && !/^(pvt|private|ltd|limited|india|indian)$/.test(first) ? first : '';
}

/**
 * Each company's own website name, as an alias its staff write ("Lumax World" for Lumax Auto
 * Technologies, whose site is lumaxworld.in). Recorded wherever a lead is worked on (registerFirmWebsite).
 */
const firmSites = new Map<string, string>();
const firmKey = (company: string) => words(company).join(' ');
const squash = (ws: string[]) => ws.join('');

export function registerFirmWebsite(company: string, website: string | null | undefined): void {
  const host = String(website ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const label = host.split('.')[0]?.replace(/-/g, '') ?? '';
  if (company.trim() && label.length >= 4) firmSites.set(firmKey(company), label);
}

/**
 * The names the company goes by on its own LinkedIn page ("Micron Technology" for Micron
 * Semiconductor Technology India at micron.com): what its staff's profiles show as their employer.
 * Recorded by learnFirm, only for a page that lists the company's own website.
 */
const firmAliases = new Map<string, string[]>();

export function registerFirmAliases(company: string, names: string[]): void {
  const own = names.map((n) => n.trim()).filter((n) => n && firmKey(n) !== firmKey(company));
  if (company.trim() && own.length) firmAliases.set(firmKey(company), [...new Set(own)]);
}

export function firmAliasesOf(company: string): string[] {
  return firmAliases.get(firmKey(company)) ?? [];
}

/** The company's own website name, when known ("lumaxworld"). */
export function firmSiteName(company: string): string {
  return firmSites.get(firmKey(company)) ?? '';
}

/**
 * Whether a person's employer, as they write it, is this company. It must name the company in full
 * (every word of its name, legal words like "Pvt Ltd" aside): "National Engineering Industries Ltd.
 * (NBC Bearings)" is NBC Bearings, "Nestlé" is Nestle India. A shared word is never enough: Ultra
 * Corpotech is not Ultra Drugs, Tata Steel is not Tata Motors, Minda Corporation is not Minda
 * Industries, Sakthi Auto Component is not Sakthi Auto Ancillary, PKF Sridhar & Santhanam is not PKF India.
 * The one alias is the company's own
 * website name ("Lumax World" for lumaxworld.in). A name made only of generic words ("Warehousing
 * Express Logistics") must match exactly, with nothing added.
 */
export function sameFirm(text: string, company: string): boolean {
  if (namesFirm(text, company, firmSiteName(company))) return true;
  // Or the name on its own LinkedIn page, in full.
  return firmAliasesOf(company).some((alias) => namesFirm(text, alias, ''));
}

function namesFirm(text: string, company: string, site: string): boolean {
  const a = words(text);
  const b = words(company);
  if (!a.length || !b.length) return false;
  if (b.every((w) => GENERIC.has(w))) return a.length === b.length && b.every((w) => a.includes(w));
  // A name that comes down to one short word ("PKF" India, "Ucal"): exactly that, nothing added.
  // "PKF Sridhar & Santhanam" is another firm in the same network.
  if (b.length === 1 && b[0].length <= 4) return a.every((w) => w === b[0] || VAGUE.has(w));
  // A one-word name ("BESCO" Limited) followed by words that make another company's name ("Besco
  // Water Treatment", in Michigan) is not this company. Fine: the name alone or with words staff add
  // or drop ("BESCO Ltd (Foundry Division)"), or the Indian registered name in full ("Godamwale
  // Trading & Logistics Pvt Ltd").
  if (b.length === 1 && a.includes(b[0])) {
    const LEGAL_WORD = /^(pvt|private|ltd|limited|llp|inc|india|indian|co|company|corp|corporation)$/;
    const next = [...plain(unbracketed(text)).matchAll(new RegExp(`\\b${b[0]}\\b(?:[^a-z0-9]+([a-z0-9]+))?`, 'g'))].map((m) => m[1] ?? '');
    const plainUse = next.some((w) => !w || VAGUE.has(w) || LEGAL_WORD.test(w) || w.length <= 1);
    if (!plainUse && !/\b(pvt|private|ltd|limited|llp)\b/i.test(unbracketed(text))) return false;
  }
  if (b.every((w) => a.includes(w))) return true;
  // The same name spaced differently: "Euro Cast Engineering" is Eurocast Engineering.
  if (squash(a) === squash(b)) return true;
  if (!site) return false;
  // A shorter form of the company's own name that keeps its brand, when the brand is also its website
  // ("Micron Semiconductor" for Micron Semiconductor Technology India at micron.com). Never a name
  // with a word the company's name doesn't have.
  const brand = brandOf(company);
  if (brand && brand === site && a[0] === brand && a.length >= 2 && a.every((w) => b.includes(w) || VAGUE.has(w))) return true;
  const named = a.filter((w) => !['com', 'in', 'co', 'net', 'org'].includes(w));
  return squash(named) === site || squash(named.filter((w) => !VAGUE.has(w))) === site;
}

/** Words a company's staff add or drop without it being another company. */
const VAGUE = new Set([
  'world', 'global', 'international', 'industries', 'industry', 'industrial', 'enterprises', 'enterprise', 'group', 'holdings', 'ventures',
  'technologies', 'technology', 'tech', 'solutions', 'systems', 'services', 'corporation', 'corp', 'unit', 'division', 'plant', 'plants',
  'com', 'co', 'in', 'pvt', 'ltd', 'private', 'limited', 'llp', 'inc', 'and',
]);

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
  // "Experience: Euro Cast Engineering" names the employer; "Experience: 18 years of experience in
  // high pressure diecasting" is a sentence from the About section and says nothing either way.
  const expText = exp?.[1].trim() ?? '';
  if (expText && (sameFirm(expText, company) || (!/\d/.test(expText) && !PROSE.test(expText) && expText.split(/\s+/).length <= 8))) {
    say.push(sameFirm(expText, company) ? 'here' : 'elsewhere');
  }
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

/** `location`: where that job is, when the entry names it ("… Jan 2010 - Present · 14 yrs. Coimbatore, Tamil Nadu, India"). */
export type SnippetRole = { role: string; company: string; current: boolean; location?: string };

const DATE = String.raw`(?:[A-Z][a-z]{2,8}\s)?\d{4}`;
// The company may hold a dot inside it ("Godamwale.com"), never one followed by a space.
const ROLE_LINE = new RegExp(String.raw`([A-Za-z][^.|·]{1,70}?)\.\s+((?:[^.|·]|\.(?=\S)){2,80}?)\.?,?\s+(${DATE})\s*[-–]\s*(Present|${DATE})`, 'g');
/** About-section prose ("My career spans roles including Regional Head at X") isn't a current job. */
const PROSE = /\b(my|i|career|including|included|roles|spans|years|worked|previously|formerly|former|was|were|have|has|had|experience|journey|from|served|as)\b/i;
/** After a job's dates: its length ("14 yrs 9 mos"), then the place it is at, up to the end of the entry. */
const JOB_PLACE = /^[\s.,·]*(?:\(?\s*(?:\d+\s*(?:yrs?|years?|mos?|months?)\s*)+\)?[\s.,·]*)?([A-Z][A-Za-z ]{2,40}(?:,\s*[A-Z][A-Za-z ]{2,30}){0,2})(?=\s*(?:[.·|]|$))/;
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
    if (!role || /^experience$/i.test(role)) continue;
    // The entry's own place, after its dates and length: the location of that job, not of the profile.
    const after = text.slice((m.index ?? 0) + m[0].length);
    const at = JOB_PLACE.exec(after)?.[1]?.trim() ?? '';
    const location = at && INDIA_PLACES.test(at) && !ROLE.test(at) ? at : '';
    out.push({ role, company: m[2].trim(), current: /present/i.test(m[4]), ...(location ? { location } : {}) });
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

/**
 * The site a title says someone is responsible for: "Plant Head - Coimbatore", "Head of Operations,
 * Hosur Plant" give that town. A state or the country ("Head - South India") names no one site.
 */
export function placeNamedIn(title: string): string {
  const m = new RegExp(INDIA_PLACES.source, 'gi');
  for (const hit of String(title ?? '').matchAll(m)) {
    if (!REGION_ONLY.test(hit[1]) && !/^(jammu|kashmir|ladakh|dadra|daman|ncr)$/i.test(hit[1])) return hit[1];
  }
  return '';
}

/** A place rather than a job ("Ahmedabad, Gujarat, India"): names an Indian place and no role word. */
export function isPlace(text: string): boolean {
  return INDIA_PLACES.test(text) && !ROLE.test(text);
}

/**
 * Places outside India, as LinkedIn writes them: countries (a country named anywhere wins, so
 * "Lahore, Punjab, Pakistan" is abroad), then US states, US-style metro areas and big foreign cities.
 */
const FOREIGN_COUNTRY = /\b(united states|usa|u\.s\.a|united kingdom|england|scotland|wales|ireland|germany|deutschland|france|italy|italia|spain|españa|portugal|netherlands|nederland|belgium|sweden|norway|denmark|finland|poland|czechia|czech republic|austria|switzerland|hungary|romania|greece|turkey|türkiye|russia|ukraine|canada|mexico|brazil|argentina|chile|colombia|peru|australia|new zealand|singapore|malaysia|indonesia|thailand|vietnam|philippines|china|hong kong|taiwan|japan|south korea|korea|united arab emirates|uae|saudi arabia|saudi|qatar|oman|kuwait|bahrain|israel|egypt|morocco|pakistan|bangladesh|sri lanka|nepal|bhutan|myanmar|south africa|nigeria|kenya|ghana|tanzania|uganda|ethiopia)\b/i;
const FOREIGN_PLACE = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|metropolitan area|bay area|ontario|quebec|british columbia|alberta|new south wales|victoria|queensland|london|manchester|paris|berlin|munich|frankfurt|amsterdam|zurich|geneva|dubai|abu dhabi|sharjah|riyadh|jeddah|doha|muscat|kuala lumpur|bangkok|jakarta|manila|tokyo|shanghai|beijing|shenzhen|seoul|sydney|melbourne|toronto|vancouver|montreal|karachi|lahore|islamabad|dhaka|colombo|kathmandu|nairobi|lagos|johannesburg|cape town)\b/i;
/** Written in another script (Arabic, Chinese, Cyrillic…): a profile from another country's LinkedIn. */
const OTHER_SCRIPT = /[\u0400-\u04FF\u0590-\u06FF\u0E00-\u0E7F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;

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
 * Detroit Metropolitan Area is no contact for Rheinmetall Pune. Only a place that is clearly abroad
 * counts: any Indian town, listed or not (Jalandhar, Belagavi, Greater Tiruchirappalli Area), is kept.
 */
export function basedAbroad(location: string, snippet = '', profileUrl = ''): boolean {
  if (location) {
    if (FOREIGN_COUNTRY.test(location)) return !/\bindia\b/i.test(location);
    if (INDIA_PLACES.test(location)) return false;
    if (OTHER_SCRIPT.test(location) || FOREIGN_PLACE.test(location)) return true;
    // A place that isn't recognisably Indian, on a profile LinkedIn doesn't serve from India
    // (in.linkedin.com): abroad ("Greater Sioux Falls Area"). An Indian town missing from the list
    // ("Greater Tiruchirappalli Area") is on an in.linkedin.com profile, so it is kept.
    const host = /^https?:\/\/([a-z]{2,3})\.linkedin\.com\//i.exec(profileUrl)?.[1]?.toLowerCase() ?? '';
    if (profileUrl && host !== 'in') return true;
    return false;
  }
  // No location line: a profile LinkedIn serves from another country (us.linkedin.com, uk.linkedin.com)...
  const host = /^https?:\/\/([a-z]{2,3})\.linkedin\.com\//i.exec(profileUrl)?.[1]?.toLowerCase() ?? '';
  if (host && host !== 'in' && host !== 'www') return true;
  // ...or an obviously foreign place in the snippet, with no Indian one.
  return (FOREIGN_COUNTRY.test(snippet) || /metropolitan area/i.test(snippet)) && !INDIA_PLACES.test(snippet);
}

/** Areas that belong to one city: Pimpri Chinchwad and Chakan are Pune, Gurugram and Noida are Delhi NCR. */
const METRO: Record<string, RegExp> = {
  pune: /\b(pune|pimpri|chinchwad|chakan|hinjewadi|talegaon|ranjangaon|bhosari|hadapsar)\b/i,
  jaipur: /\b(jaipur|sitapura|bagru|vishwakarma industrial|mahindra world city,? jaipur)\b/i,
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
  // A site in a metro's industrial belt (Sanand, Chakan, Hosur) counts its city's people too: staff at
  // the Sanand plant write "Ahmedabad, Gujarat" on LinkedIn.
  const metro = METRO[place] ?? Object.values(METRO).find((m) => m.test(place));
  return metro ? metro.test(text) : text.toLowerCase().includes(place);
}

/** States and the country: a location naming only these doesn't say which site someone is at. */
const REGION_ONLY = /^(india|bharat|maharashtra|maharastra|gujarat|gujrat|tamilnadu|karnatka|telengana|orissa|karnataka|tamil nadu|telangana|andhra pradesh|kerala|goa|rajasthan|madhya pradesh|uttar pradesh|uttarakhand|haryana|punjab|himachal pradesh|jammu and kashmir|jammu & kashmir|bihar|jharkhand|odisha|west bengal|assam|chhattisgarh|north india|south india|east india|west india)$/i;

/** No usable place: empty, or only a state or the country ("India", "Tamil Nadu, India"). */
export function vagueLocation(location: string | null | undefined): boolean {
  const place = String(location ?? '').split(',')[0].replace(/\b(greater|area|region|division|district|metropolitan)\b/gi, '').trim();
  return !place || REGION_ONLY.test(place);
}

/**
 * Whether someone works at the lead's site: 'here' when their location is the lead's city or its
 * metro area, 'elsewhere' when it names another place, 'unknown' when there is no location, it names
 * only a state or the country, or the lead has no city. (Abroad is decided by basedAbroad.)
 */
export function siteOf(location: string | undefined, city: string): 'here' | 'elsewhere' | 'unknown' {
  const loc = (location ?? '').trim();
  if (!loc || !city.trim()) return 'unknown';
  // By distance, when both places have been looked up (knowPlaces): within the site's metro area.
  const site = pointOf(city);
  const there = pointOf(loc);
  if (site && there) return distanceKm(site, there) <= SITE_RADIUS_KM ? 'here' : 'elsewhere';
  if (inCity(loc, city)) return 'here';
  const place = loc.split(',')[0].replace(/\b(greater|area|region|division|district|metropolitan)\b/gi, '').trim();
  if (!place || REGION_ONLY.test(place)) return 'unknown';
  // Looked up and not found on the map: not known, rather than somewhere else.
  if (there === null && site !== undefined) return 'unknown';
  return 'elsewhere';
}
