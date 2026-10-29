import type { DomainConfig } from '../domains/config';
import type { Issue, Seo, SourceDoc, ValidationReport } from './schemas';
import {
  citationMarkers,
  containment,
  extractFigures,
  extractQuotes,
  fillerHits,
  headings,
  jaccardSets,
  keywordDensity,
  markdownLinks,
  normalizeForSearch,
  repetition,
  shingles,
  stripMarkdown,
  textHasFigure,
  wordCount,
} from './text';

export type ExistingArticle = { id: string; title: string; slug: string; bodyMarkdown: string };

export type ValidateInput = {
  title: string;
  bodyMarkdown: string;
  seo: Seo | null;
  primaryKeyword: string;
  sources: SourceDoc[];
  claims: { text: string; sourceIds: string[] }[];
  domain: { slug: string; name: string; config: DomainConfig };
  targetWords: number;
  existing: ExistingArticle[];
  hasImage?: boolean;
  round: number;
  now: Date;
};

const HIGH_RISK_DOMAINS = new Set(['health', 'finance']);
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const DISCLAIMERS: Record<string, string> = {
  health: '*This article is for general information only and is not medical advice. Talk to a qualified health professional about your own situation.*',
  finance: '*This article is for general information only and is not financial advice. Consider speaking to a licensed adviser before making financial decisions.*',
};

/** Fixes that need no judgement. Returns the corrected text and what was changed. */
export function applyDeterministicFixes(md: string, domainSlug: string): { markdown: string; changes: string[] } {
  const changes: string[] = [];
  let out = md.replace(/\r\n/g, '\n');
  const h1 = /^\s*#\s+.+\n+/;
  if (h1.test(out)) {
    out = out.replace(h1, '');
    changes.push('Removed a leading H1 (the title is the H1)');
  }
  const d = DISCLAIMERS[domainSlug];
  if (d && !/not (medical|financial|investment) advice/i.test(out)) {
    out = `${out.trimEnd()}\n\n${d}\n`;
    changes.push(`Added the ${domainSlug} disclaimer`);
  }
  return { markdown: out, changes };
}

/**
 * Checks that can be answered without a model. Severity guide:
 * critical = invented or copied content, unsafe claims; major = must be fixed before publishing; minor = advisory.
 */
export function validateArticle(input: ValidateInput): ValidationReport {
  const issues: Issue[] = [];
  const { bodyMarkdown: md, seo, sources, domain } = input;
  const add = (i: Issue) => issues.push(i);
  const sourceIds = new Set(sources.map((s) => s.id));
  const highRisk = HIGH_RISK_DOMAINS.has(domain.slug);
  const plain = stripMarkdown(md);
  const words = wordCount(md);

  // --- Metadata ---
  if (!input.title.trim()) add({ code: 'missing_title', severity: 'critical', message: 'The article has no title.' });
  if (!seo) {
    add({ code: 'missing_seo', severity: 'critical', message: 'SEO metadata was not generated.' });
  } else {
    if (seo.seoTitle.length > 70) add({ code: 'seo_title_long', severity: 'major', message: `SEO title is ${seo.seoTitle.length} characters; keep it under about 60-70.` });
    else if (seo.seoTitle.length > 60) add({ code: 'seo_title_long', severity: 'minor', message: `SEO title is ${seo.seoTitle.length} characters and may be truncated in results.` });
    if (seo.metaDescription.length < 70 || seo.metaDescription.length > 170) add({ code: 'meta_description_length', severity: 'major', message: `Meta description is ${seo.metaDescription.length} characters; aim for 120-160.` });
    else if (seo.metaDescription.length < 110 || seo.metaDescription.length > 165) add({ code: 'meta_description_length', severity: 'minor', message: `Meta description is ${seo.metaDescription.length} characters; aim for 120-160.` });
    if (!SLUG_RE.test(seo.slug)) add({ code: 'bad_slug', severity: 'major', message: `Slug "${seo.slug}" is not lowercase words joined by hyphens.` });
    if (!seo.imageAlt.trim()) add({ code: 'missing_alt_text', severity: 'major', message: 'The featured image has no alt text.' });
    if (keywordDensity(seo.metaDescription, input.primaryKeyword) > 0.25) add({ code: 'keyword_stuffed_meta', severity: 'major', message: 'The meta description repeats the keyword unnaturally.' });
    if (keywordDensity(seo.seoTitle, input.primaryKeyword) > 0.5) add({ code: 'keyword_stuffed_title', severity: 'major', message: 'The SEO title is mostly the keyword.' });
  }

  // --- Structure ---
  const hs = headings(md);
  if (hs.some((h) => h.level === 1)) add({ code: 'body_has_h1', severity: 'major', message: 'The body contains an H1; the title is the only H1.' });
  const h2 = hs.filter((h) => h.level === 2);
  if (h2.length < 3) add({ code: 'few_sections', severity: 'major', message: `Only ${h2.length} H2 section(s); expected at least 3.` });
  for (let i = 1; i < hs.length; i++) if (hs[i].level - hs[i - 1].level > 1) add({ code: 'heading_skip', severity: 'minor', message: `Heading "${hs[i].text}" skips a level.` });
  const lines = md.split('\n');
  hs.forEach((h, i) => {
    const next = hs[i + 1]?.line ?? lines.length;
    const body = lines.slice(h.line + 1, next).join(' ').trim();
    if (!body && !(hs[i + 1] && hs[i + 1].level > h.level)) add({ code: 'empty_section', severity: 'major', message: `The section "${h.text}" has no content.` });
  });
  if ((md.match(/```/g) ?? []).length % 2 === 1) add({ code: 'unclosed_code_fence', severity: 'major', message: 'A code block is not closed.' });
  if (/<\/?(script|iframe|style|object|embed|form)\b/i.test(md)) add({ code: 'raw_html', severity: 'critical', message: 'The body contains disallowed raw HTML.' });
  if (/\b(lorem ipsum|\[insert|\[todo|\bTBD\b|as an ai language model)/i.test(md)) add({ code: 'placeholder_text', severity: 'critical', message: 'The body contains placeholder or AI-boilerplate text.' });
  const minWords = Math.max(300, Math.round(input.targetWords * 0.6));
  if (words < 300) add({ code: 'too_short', severity: 'critical', message: `Only ${words} words.` });
  else if (words < minWords) add({ code: 'shorter_than_target', severity: 'major', message: `${words} words against a target of about ${input.targetWords}.` });
  else if (words > input.targetWords * 1.8) add({ code: 'longer_than_target', severity: 'minor', message: `${words} words against a target of about ${input.targetWords}.` });

  // --- Keyword use ---
  const dens = keywordDensity(plain, input.primaryKeyword);
  if (dens > 0.045) add({ code: 'keyword_stuffing', severity: 'critical', message: `The primary keyword makes up ${(dens * 100).toFixed(1)}% of the words.` });
  else if (dens > 0.03) add({ code: 'keyword_density_high', severity: 'major', message: `The primary keyword makes up ${(dens * 100).toFixed(1)}% of the words.` });
  const kwInLead = keywordDensity(plain.split(/\s+/).slice(0, 120).join(' '), input.primaryKeyword) > 0 || keywordDensity(input.title, input.primaryKeyword) > 0;
  if (!kwInLead) add({ code: 'keyword_missing_lead', severity: 'minor', message: 'The primary keyword does not appear in the title or opening.' });

  // --- Writing quality ---
  const filler = fillerHits(plain);
  if (filler.length >= 3) add({ code: 'generic_filler', severity: 'major', message: `Generic filler phrases: ${filler.slice(0, 5).join('; ')}.` });
  else if (filler.length) add({ code: 'generic_filler', severity: 'minor', message: `Generic filler phrases: ${filler.join('; ')}.` });
  const rep = repetition(plain);
  if (rep.repeatedSentences > 0.05 || rep.repeatedFourGrams > 0.12) add({ code: 'repetitive', severity: 'major', message: 'The text repeats sentences or phrases.' });

  // --- Citations and evidence ---
  const markers = citationMarkers(md);
  const bad = [...new Set(markers.filter((m) => !sourceIds.has(m)))];
  if (bad.length) add({ code: 'unknown_citation', severity: 'critical', message: `Citations to sources that do not exist: ${bad.join(', ')}.`, evidence: bad.join(', ') });
  const cited = new Set(markers.filter((m) => sourceIds.has(m)));
  const minCited = highRisk ? 3 : 2;
  if (cited.size < minCited) add({ code: 'too_few_citations', severity: 'major', message: `Cites ${cited.size} source(s); ${domain.name} articles need at least ${minCited}.` });
  for (const c of input.claims) {
    const missing = c.sourceIds.filter((s) => !sourceIds.has(s));
    if (missing.length || !c.sourceIds.length) add({ code: 'claim_without_source', severity: 'critical', message: `A listed claim cites no valid source: "${c.text.slice(0, 120)}"`, evidence: c.text });
  }

  // Figures: every percentage, amount and larger number must appear in the sources.
  const corpus = normalizeForSearch(sources.map((s) => `${s.title} ${s.text} ${s.excerpts.join(' ')}`).join(' \n '));
  const unsupported = new Map<string, string>();
  for (const f of extractFigures(plain)) if (!textHasFigure(corpus, f.digits)) unsupported.set(f.digits, f.raw);
  if (unsupported.size) {
    add({ code: 'unsupported_figure', severity: 'critical', message: `Figures that appear in no source: ${[...unsupported.values()].slice(0, 6).join(', ')}.`, evidence: [...unsupported.values()].join(', ') });
  }

  // Quotes: quoted passages must be verbatim from a source.
  const corpusLower = corpus.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  for (const q of extractQuotes(plain)) {
    const needle = normalizeForSearch(q).toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    if (!corpusLower.includes(needle)) add({ code: 'unverified_quote', severity: 'critical', message: `A quotation does not appear in any source: "${q.slice(0, 100)}"`, evidence: q });
  }

  // Dates in the body that contradict each other or the sources are caught as unsupported figures only for amounts; flag impossible years.
  const years = [...plain.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
  const future = years.filter((y) => y > input.now.getUTCFullYear() + 2);
  if (future.length) add({ code: 'far_future_year', severity: 'minor', message: `Mentions years far in the future: ${[...new Set(future)].join(', ')}.` });

  // --- Originality ---
  const art5 = shingles(plain, 5);
  const art8 = shingles(plain, 8);
  for (const s of sources) {
    const copied = containment(art8, shingles(s.text, 8));
    if (copied > 0.12) add({ code: 'close_to_source', severity: 'critical', message: `${Math.round(copied * 100)}% of 8-word phrases are copied from ${s.publisher ?? s.url}.`, evidence: s.url });
    else if (copied > 0.05) add({ code: 'close_to_source', severity: 'major', message: `${Math.round(copied * 100)}% of 8-word phrases match ${s.publisher ?? s.url}; rephrase.`, evidence: s.url });
  }
  for (const e of input.existing) {
    const sim = jaccardSets(art5, shingles(stripMarkdown(e.bodyMarkdown), 5));
    if (sim > 0.35) add({ code: 'near_duplicate', severity: 'critical', message: `Very similar to the existing article "${e.title}" (${Math.round(sim * 100)}% overlap).`, evidence: e.id });
    else if (sim > 0.2) add({ code: 'similar_to_existing', severity: 'major', message: `Overlaps with the existing article "${e.title}" (${Math.round(sim * 100)}%).`, evidence: e.id });
  }

  // --- Links ---
  const known = new Set(sources.map((s) => s.url));
  const internal = new Set(input.existing.map((e) => `/${e.slug}`));
  for (const l of markdownLinks(md)) {
    if (!/^https?:\/\//i.test(l.url) && !l.url.startsWith('/') && !l.url.startsWith('#')) add({ code: 'bad_link', severity: 'critical', message: `Link with a disallowed address: ${l.url.slice(0, 60)}` });
    else if (/^https?:\/\//i.test(l.url) && !known.has(l.url)) add({ code: 'link_not_in_sources', severity: 'major', message: `Links to ${l.url.slice(0, 80)}, which is not one of the researched sources.` });
    else if (l.url.startsWith('/') && !internal.has(l.url.replace(/\/$/, ''))) add({ code: 'unknown_internal_link', severity: 'major', message: `Internal link ${l.url} does not match an existing article.` });
  }

  // --- Image ---
  if (input.hasImage === false) add({ code: 'missing_image', severity: 'major', message: 'There is no valid featured image yet.' });

  // --- Domain rules ---
  for (const p of domain.config.validation.blockPatterns) {
    let re: RegExp;
    try { re = new RegExp(p, 'i'); } catch { continue; }
    const hit = re.exec(plain);
    if (hit) {
      const at = Math.max(0, hit.index - 60);
      add({ code: 'restricted_pattern', severity: 'critical', overridable: true, message: `Matches a restricted pattern for ${domain.name} ("${hit[0]}").`, evidence: plain.slice(at, hit.index + 80) });
    }
  }
  if (DISCLAIMERS[domain.slug] && !/not (medical|financial|investment) advice/i.test(md)) {
    add({ code: 'missing_disclaimer', severity: 'major', message: `A ${domain.slug} article needs a general-information disclaimer.` });
  }

  const blocking = issues.filter((i) => i.severity !== 'minor');
  return {
    checkedAt: input.now.toISOString(),
    round: input.round,
    passed: blocking.length === 0,
    issues,
    stats: { words, targetWords: input.targetWords, citedSources: cited.size, claims: input.claims.length, claimsVerified: 0 },
  };
}
