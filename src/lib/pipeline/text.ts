// Helpers for reading AI answers and cleaning up names, domains and company names.
// DeepSeek's JSON mode doesn't enforce the schema, so every field is read defensively.

/** A list, whatever shape the AI used: an array, or one comma/semicolon/newline separated string. */
export function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined || v === '') return [];
  if (typeof v === 'string') return v.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  return [v];
}

/** A list of plain strings, even when the AI sent objects like {"role": "Plant Head"}. */
export function asTextList(v: unknown): string[] {
  return asList(v)
    .map((x) => {
      if (typeof x === 'string') return x;
      if (x && typeof x === 'object') {
        return (Object.values(x as Record<string, unknown>).find((y) => typeof y === 'string') as string) || '';
      }
      return x === null || x === undefined ? '' : String(x);
    })
    .map((x) => x.trim())
    .filter(Boolean);
}

/** One piece of text, whatever type the AI used. */
export function asText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return asTextList(v).join(', ');
  if (typeof v === 'object') return asTextList([v]).join(', ') || JSON.stringify(v);
  return String(v);
}

/** true for true, "true", "yes" or 1. */
export function asBool(v: unknown): boolean {
  return v === true || /^(true|yes|y|1)$/i.test(String(v ?? '').trim());
}

/** "https://www.Example.com/path" → "example.com" */
export function domainOf(s: string | null | undefined): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#\s]/)[0];
}

const SECOND_LEVEL = /^(co|com|net|org|gov|ac|edu|res|gen|firm|ind)$/;

/** The registrable domain: "buildings.honeywell.com" → "honeywell.com", "www.cwls.co.in" → "cwls.co.in". */
export function rootDomain(s: string | null | undefined): string {
  const parts = domainOf(s).split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const keep = SECOND_LEVEL.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-keep).join('.');
}

/** The name people actually search by: "Ash Logistics and Traders Pvt Ltd" → "Ash Logistics and Traders". */
export function searchName(company: string): string {
  return company
    .replace(/[.,]/g, ' ')
    .replace(/\b(pvt|private|ltd|limited|llp|inc|opc)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Adds https:// to a bare domain; '' stays ''. */
export function normalizeWebsite(s: string | null | undefined): string {
  const w = String(s || '').trim();
  if (!w) return '';
  return /^https?:\/\//i.test(w) ? w : `https://${w}`;
}

/** Company names compared without legal suffixes, so "Haldex India Pvt Ltd" matches "Haldex". */
export function normCompany(s: string | null | undefined): string {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|llp|inc|india|the|and|co|company|group)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const HONORIFICS = /^(mr|mrs|ms|dr|er|ca|cs|cma|prof|shri|smt)\.?$/i;

/**
 * Splits a LinkedIn name for email lookups, dropping titles, credentials and initials:
 * "R P Sharma" → R / Sharma, "Dr. Anil Kumar" → Anil / Kumar, "Sandeep Welling, CA" → Sandeep / Welling.
 */
export function splitName(name: string | null | undefined): { first: string; last: string; middle: string } {
  const parts = String(name || '')
    .replace(/\(.*?\)/g, ' ')
    .split(',')[0]
    .split(/\s+/)
    .map((p) => p.replace(/[^A-Za-z'-]/g, ''))
    .filter((p) => p && !HONORIFICS.test(p));
  const full = parts.filter((p) => p.length > 1);
  // "Ashamol A P": a first name followed by initials, no surname.
  if (parts.length > 1 && full.length === 1 && parts[0] === full[0]) return { first: full[0], last: '', middle: '' };
  // "R P Sharma" has no full first name, so fall back to the first initial.
  const first = full.length > 1 ? full[0] : parts.length > 1 ? parts[0] : '';
  const last = full.length ? full[full.length - 1] : '';
  // Initials of any names in between: "Rabindra Pratap Singh" → "p", "R P Sharma" → "p".
  const firstIdx = first ? parts.indexOf(first) : -1;
  const lastIdx = last ? parts.lastIndexOf(last) : -1;
  const middle = firstIdx >= 0 && lastIdx > firstIdx + 1
    ? parts.slice(firstIdx + 1, lastIdx).map((p) => p.charAt(0).toLowerCase()).join('')
    : '';
  return { first, last, middle };
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : JSON.stringify(e);
}
