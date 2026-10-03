import { z } from 'zod';
import type { Db } from './db';
import { settings as settingsTable } from './db/schema';
import { eq } from 'drizzle-orm';

export const DEFAULT_PRODUCT_DESCRIPTION = [
  'INVECK is a mobile-first inventory and asset verification platform.',
  'Teams count stock and verify fixed assets on their phones, capture data on the spot,',
  'reconcile it against ERP or book records without Excel, and get audit-ready reports',
  'with a full audit trail. It replaces paper registers, spreadsheets and manual reconciliation.',
  'Used by manufacturers, warehouses and 3PLs for stock and asset verification, and by',
  'CA firms to digitise verification work in stock, asset and statutory audits:',
  'verification, data capture, reconciliation, reporting and audit trail in one workflow.',
].join(' ');

export const settingsSchema = z.object({
  /** No longer used: every waiting company is researched. Kept so saved settings still parse. */
  dailyLimit: z.coerce.number().int().min(1).max(500).default(25),
  /** No longer used: every reachable, qualified lead gets a draft. Kept so saved settings still parse. */
  minScore: z.coerce.number().int().min(0).max(100).default(55),
  /** Companies handed out to the team each working morning, split evenly between them. */
  leadsPerMorning: z.coerce.number().int().min(0).max(500).default(100),
  /** Common email formats to try, and verify with the mail-server check, when the company's format is unknown. */
  maxEmailGuesses: z.coerce.number().int().min(0).max(6).default(3),
  /**
   * Apollo email lookups per company: the main contact first, then the best-ranked others the
   * pipeline selected. Cached results don't count. 0 switches Apollo off.
   */
  apolloPerCompany: z.coerce.number().int().min(0).max(10).default(3),
  /**
   * Save an address built from the company's proven email format when its mail server can't
   * confirm single addresses (marked "likely"). Plain guesses are never saved.
   */
  useCompanyFormat: z.boolean().default(true),
  /** Scan the news for new plants and warehouses on each run. */
  radarEnabled: z.boolean().default(true),
  /** Most new companies the prospect search adds per run. */
  prospectsPerRun: z.coerce.number().int().min(1).max(50).default(15),
  /** On scheduled runs, also search for new prospects on this weekday (0 = Sunday … 6 = Saturday, -1 = never). */
  prospectDay: z.coerce.number().int().min(-1).max(6).default(1),
  aiProvider: z.enum(['deepseek', 'anthropic']).default('deepseek'),
  aiModel: z.string().trim().min(1).default('deepseek-chat'),
  aiEffort: z.enum(['low', 'medium', 'high']).default('medium'),
  senderName: z.string().trim().default('INVECK Sales Team'),
  senderTitle: z.string().trim().default('Business Development'),
  senderCompany: z.string().trim().default('INVECK India'),
  demoLink: z.string().trim().default(''),
  productDescription: z.string().trim().min(20).default(DEFAULT_PRODUCT_DESCRIPTION),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_MODELS: Record<Settings['aiProvider'], string> = {
  deepseek: 'deepseek-chat',
  anthropic: 'claude-opus-5',
};

export async function getSettings(db: Db): Promise<Settings> {
  const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'app'));
  const stored = rows[0]?.value;
  const parsed = settingsSchema.safeParse(stored && typeof stored === 'object' ? stored : {});
  return parsed.success ? parsed.data : settingsSchema.parse({});
}

export async function saveSettings(db: Db, value: Settings) {
  await db
    .insert(settingsTable)
    .values({ key: 'app', value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value } });
}

/** Tolerates keys pasted with quotes, spaces, line breaks or a "Bearer " prefix. */
function envKey(name: string): string {
  return (process.env[name] || '').trim().replace(/^["']|["']$/g, '').replace(/^bearer\s+/i, '').trim();
}

/** API keys come from environment variables, never from the database. */
export function apiKeys() {
  return {
    deepseek: envKey('DEEPSEEK_API_KEY'),
    anthropic: envKey('ANTHROPIC_API_KEY'),
    serper: envKey('SERPER_API_KEY'),
    /** Only for the mail-server check (verifying addresses); Hunter is no longer an email source. */
    hunter: envKey('HUNTER_API_KEY'),
    /** Email enrichment (emails only). Server-side only: never sent to the browser or written to logs. */
    apollo: envKey('APOLLO_API_KEY'),
    /** Optional: Jina Reader works without a key, but with lower rate limits. */
    jina: envKey('JINA_API_KEY'),
  };
}
export type ApiKeys = ReturnType<typeof apiKeys>;
