/**
 * The company's official name, checked against its own website before research uses it. Names come
 * from the AI that suggests prospects, which can get them slightly wrong ("Advanced Forgings" for
 * Advance Forgings at advanceforgings.in); a wrong name would then be searched for, matched against
 * LinkedIn profiles and written into the outreach.
 */

const LEGAL = /\b(pvt|private|ltd|limited|llp|inc|the|co|company|india|corp|corporation)\b/g;

/** The name without legal words, letters and digits only: "Advance Forgings Pvt. Ltd." gives "advanceforgings". */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[.,]/g, ' ')
    .replace(LEGAL, ' ')
    .replace(/[^a-z0-9]/g, '');
}

/** Letters to add, drop or change to turn one into the other. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Nearly the same name: a letter or two apart ("advancedforgings" and "advanceforgings"). */
function nearly(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  const d = editDistance(a, b);
  return d <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 8));
}

/** Registered names on the page: "Advance Forgings Pvt. Ltd.", "Advance Forgings Private Limited". */
const WORD = String.raw`(?!(?:Pvt|Ltd|Limited|Private|LLP)\b)[A-Z][A-Za-z0-9&'.-]*`;
const REGISTERED = new RegExp(String.raw`\b(${WORD}(?:[ \t]+(?:&[ \t]+)?${WORD}){0,5})[ \t]+(Pvt\.?[ \t]*Ltd\.?|Private[ \t]+Limited|Pvt\.?[ \t]+Limited|Limited|Ltd\.?|LLP)(?![A-Za-z])`, 'g');

function namesOnPage(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(REGISTERED)) out.push(`${m[1]} ${m[2]}`.replace(/\s+/g, ' ').trim());
  // The page title's pieces ("Advance Forgings | Closed die forgings").
  const title = /^Title:\s*(.+)$/m.exec(text)?.[1] ?? '';
  for (const piece of title.split(/\s*[|–—:-]\s*/)) if (piece.trim().length >= 3) out.push(piece.trim());
  return out;
}

/**
 * The name respelled to match its domain, when the domain is the name with one word a letter or two
 * different: "Advanced Forgings Pvt. Ltd." at advanceforgings.in gives "Advance Forgings Pvt. Ltd.".
 * The domain is the company's own, so its spelling is the one to use. '' when no single word explains it.
 */
export function respellToDomain(given: string, label: string): string {
  const tokens = given.split(/(\s+)/);
  const words = tokens.map((t, i) => ({ t, i, key: nameKey(t) })).filter((w) => w.key);
  for (let k = 0; k < words.length; k++) {
    const before = words.slice(0, k).map((w) => w.key).join('');
    const after = words.slice(k + 1).map((w) => w.key).join('');
    if (!label.startsWith(before) || !label.endsWith(after) || label.length < before.length + after.length + 2) continue;
    const middle = label.slice(before.length, label.length - after.length);
    const word = words[k];
    // Only an ending added or dropped ("advanced" / "advance", "forging" / "forgings"): a brand's own
    // spelling inside a word ("findr" for Finder) is deliberate, not a typo.
    if (middle === word.key || editDistance(middle, word.key) > 2 || !(middle.startsWith(word.key) || word.key.startsWith(middle))) continue;
    // Keep how the word was written: capitalised, or in capitals.
    const cased = word.t === word.t.toUpperCase() ? middle.toUpperCase() : word.t[0] === word.t[0].toUpperCase() ? middle[0].toUpperCase() + middle.slice(1) : middle;
    const out = [...tokens];
    out[word.i] = cased;
    return out.join('');
  }
  return '';
}

export type NameCheck =
  | { status: 'confirmed'; name: string; evidence: string }
  | { status: 'corrected'; name: string; evidence: string }
  | { status: 'mismatch'; name: string; evidence: string }
  | { status: 'unchecked'; name: string; evidence: string };

/**
 * Checks the name against the domain and what the website (and the company's LinkedIn page, when
 * known) calls the company:
 * - confirmed: the website or the domain shows this name;
 * - corrected: the name is a letter or two off a name the website and the domain both show (that
 *   official name is used instead);
 * - mismatch: a letter or two off the domain, with nothing on the website to settle which is right;
 * - unchecked: no evidence either way (a domain unlike the name, "lumaxworld.in", is normal).
 */
export function checkCompanyName(given: string, domain: string, pageText: string, otherNames: string[] = []): NameCheck {
  const key = nameKey(given);
  const label = domain.toLowerCase().replace(/^www\./, '').split('.')[0].replace(/-/g, '');
  if (!key) return { status: 'unchecked', name: given, evidence: '' };
  const onPage = [...otherNames, ...namesOnPage(pageText)];
  const pageKeys = onPage.map(nameKey);
  if (pageKeys.includes(key)) return { status: 'confirmed', name: given, evidence: 'the name its website uses' };
  if (label && key === label) return { status: 'confirmed', name: given, evidence: `matches its domain, ${domain}` };
  // A name a letter or two off this one that the website shows, matching the domain (or the only near one).
  const near = onPage.filter((n, i) => nearly(pageKeys[i], key));
  const official = near.find((n) => nameKey(n) === label) ?? (near.length && new Set(near.map(nameKey)).size === 1 ? near[0] : '');
  if (official) {
    const registered = near.find((n) => nameKey(n) === nameKey(official) && /\b(ltd|limited|llp)\b/i.test(n));
    // The registered form when the site shows one; else the site's spelling with the legal words as given.
    const suffix = /\s+(pvt\.?\s*ltd\.?|private limited|limited|ltd\.?|llp)$/i.exec(given)?.[0] ?? '';
    const name = registered ?? `${official}${suffix && !/\b(ltd|limited|llp)\b/i.test(official) ? suffix : ''}`;
    return { status: 'corrected', name, evidence: `its website names it "${registered ?? official}"${nameKey(official) === label ? `, as its domain ${domain} does` : ''}` };
  }
  // No name on the website settles it, but the domain is the name with one word spelled differently:
  // the company's own domain decides the spelling.
  const respelled = label && nearly(key, label) ? respellToDomain(given, label) : '';
  if (respelled) return { status: 'corrected', name: respelled, evidence: `spelled as its own domain, ${domain}, spells it` };
  if (label && nearly(key, label)) {
    return { status: 'mismatch', name: given, evidence: `"${given}" is a letter or two off its domain, ${domain}, and its website doesn't show which spelling is right` };
  }
  return { status: 'unchecked', name: given, evidence: '' };
}
