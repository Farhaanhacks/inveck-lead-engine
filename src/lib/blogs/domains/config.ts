import { z } from 'zod';

const list = z.array(z.string().trim().min(1)).default([]);

/** Everything about a domain that is configuration rather than code. Adding a domain = adding a row. */
export const domainConfigSchema = z.object({
  researchSources: z.object({
    preferred: list,
    avoid: list,
    notes: z.string().default(''),
  }).default({ preferred: [], avoid: [], notes: '' }),
  articleFormats: list,
  seoRules: list,
  restrictedClaims: list,
  restrictedTopics: list,
  evidenceStandards: list,
  internalLinking: z.object({
    minLinks: z.number().int().min(0).default(2),
    maxLinks: z.number().int().min(0).default(6),
    rules: list,
  }).default({ minLinks: 2, maxLinks: 6, rules: [] }),
  publishing: z.object({
    categories: list,
    defaultTags: list,
  }).default({ categories: [], defaultTags: [] }),
  /** Inveck-specific prompt additions per stage (see PROMPT_STAGES). Empty until they are written. */
  prompts: z.object({
    discovery: z.string().default(''),
    planning: z.string().default(''),
    writing: z.string().default(''),
    seo: z.string().default(''),
    image: z.string().default(''),
  }).default({ discovery: '', planning: '', writing: '', seo: '', image: '' }),
  validation: z.object({
    /** Articles in this domain always stop for a person before publishing. */
    requireHumanReview: z.boolean().default(false),
    /** Claims matching these patterns block publication and go to the exception queue. */
    blockPatterns: list,
    notes: list,
  }).default({ requireHumanReview: false, blockPatterns: [], notes: [] }),
});

/**
 * Where Inveck's own blog prompts go (Blogs → Settings → Prompts). Each is plain text added to the end of that stage's built-in
 * instructions; all start empty. Nothing about Inveck's content strategy is written in the code.
 */
export const PROMPT_STAGES = ['discovery', 'planning', 'writing', 'seo', 'image'] as const;
export type PromptStage = (typeof PROMPT_STAGES)[number];
export const PROMPT_STAGE_LABEL: Record<PromptStage, string> = {
  discovery: 'Topic discovery: how topics are chosen',
  planning: 'Outline: how an article is structured',
  writing: 'Writing: voice, style and rules for the article text',
  seo: 'SEO: titles, descriptions and keywords',
  image: 'Featured image: the look and feel of the picture',
};

export type DomainConfig = z.infer<typeof domainConfigSchema>;

export const domainFormSchema = z.object({
  name: z.string().trim().min(2).max(60),
  audience: z.string().trim().min(2).max(300),
  geography: z.string().trim().min(2).max(120),
  locale: z.string().trim().min(2).max(10),
  tone: z.string().trim().min(2).max(300),
  defaultArticleLength: z.coerce.number().int().min(300).max(5000),
  enabled: z.boolean(),
});

export function splitLines(value: FormDataEntryValue | null): string[] {
  return String(value ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}
