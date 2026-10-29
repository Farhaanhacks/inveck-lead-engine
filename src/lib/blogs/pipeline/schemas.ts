import { z } from 'zod';
import { listish } from '../discovery/engine';

const list = <T extends z.ZodType>(item: T, max: number) => z.preprocess(listish, z.array(item).max(max));
const sid = z.string().regex(/^S\d+$/);
const sids = z.preprocess((v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'number' ? `S${x}` : typeof x === 'string' ? x.trim().replace(/^\[|\]$/g, '') : x)) : listish(v)), z.array(sid).max(8));

export const outlineSchema = z.object({
  title: z.string().trim().min(15).max(160),
  angle: z.string().trim().min(10).max(400),
  sections: z
    .array(
      z.object({
        heading: z.string().trim().min(4).max(120),
        level: z.coerce.number().int().min(2).max(3).default(2),
        keyPoints: list(z.string().trim().min(3).max(300), 8),
        sourceIds: sids,
        example: z.string().trim().max(300).optional().nullable(),
      }),
    )
    .min(3)
    .max(12),
  faqs: z
    .array(z.object({ question: z.string().trim().min(8).max(200), keyPoints: list(z.string().trim().min(3).max(300), 5), sourceIds: sids }))
    .max(6)
    .default([]),
  comparison: z.object({ title: z.string().trim().max(120), columns: list(z.string().trim().max(60), 6), note: z.string().trim().max(300).default('') }).nullable().optional(),
  conclusionPoints: list(z.string().trim().min(3).max(300), 5),
  internalLinks: z.array(z.object({ slug: z.string().trim().min(1).max(120), anchor: z.string().trim().min(2).max(120), reason: z.string().trim().max(200).default('') })).max(6).default([]),
});
export type Outline = z.infer<typeof outlineSchema>;

export const claimSchema = z.object({ text: z.string().trim().min(10).max(500), sourceIds: sids.pipe(z.array(sid).min(1)) });

export const draftSchema = z.object({
  bodyMarkdown: z.string().trim().min(600),
  claims: z.array(claimSchema).max(60),
});
export type Draft = z.infer<typeof draftSchema>;

export const seoSchema = z.object({
  seoTitle: z.string().trim().min(15).max(80),
  metaDescription: z.string().trim().min(60).max(220),
  slug: z.string().trim().min(5).max(120),
  secondaryKeywords: list(z.string().trim().min(2).max(100), 8),
  excerpt: z.string().trim().min(40).max(400),
  imageAlt: z.string().trim().min(10).max(220),
  imagePrompt: z.string().trim().min(20).max(600),
  category: z.string().trim().min(2).max(60),
  tags: list(z.string().trim().min(2).max(40), 8),
  canonicalNote: z.string().trim().max(300).default(''),
  structuredData: list(z.enum(['Article', 'NewsArticle', 'FAQPage', 'HowTo', 'BreadcrumbList']), 4),
});
export type Seo = z.infer<typeof seoSchema>;

export const verdictsSchema = z.object({
  verdicts: z.array(
    z.object({
      index: z.coerce.number().int().min(0),
      verdict: z.enum(['supported', 'partial', 'unsupported']),
      evidenceQuote: z.string().trim().max(600).optional().nullable(),
      /** Source ids the model found the support in; may differ from the ones the writer cited. */
      supportedBy: sids.optional(),
      note: z.string().trim().max(300).optional().nullable(),
    }),
  ),
});

export type Severity = 'critical' | 'major' | 'minor';
/** How one listed claim fared. `risk` decides how strictly a failure is treated (see claim-policy.ts). */
export type ClaimCheck = {
  text: string;
  sourceIds: string[];
  risk: 'protected' | 'general';
  outcome: 'verified' | 'miscited' | 'overstated' | 'unconfirmed' | 'unsupported' | 'unassessed';
  quote?: string;
  supportedBy?: string[];
  note?: string;
};

export type Issue = {
  code: string;
  severity: Severity;
  message: string;
  evidence?: string;
  claim?: ClaimCheck;
  /** A person may release the article despite this issue (a risk flag), unlike a factual or integrity failure. */
  overridable?: boolean;
};
export type ValidationReport = {
  checkedAt: string;
  round: number;
  passed: boolean;
  issues: Issue[];
  stats: { words: number; targetWords: number; citedSources: number; claims: number; claimsVerified: number };
  /** Every claim that was checked and what was found. */
  claimChecks?: ClaimCheck[];
  /** Sentences the system deleted because a general claim in them was not supported. Kept so a person can see exactly what changed. */
  removed?: { sentence: string; claim: string }[];
  warnings?: number;
};

/** A source as the pipeline uses it: text is for checking claims, never for following. */
export type SourceDoc = {
  n: number;
  id: string;
  url: string;
  title: string;
  publisher: string | null;
  publishedAt: string | null;
  excerpts: string[];
  text: string;
};
