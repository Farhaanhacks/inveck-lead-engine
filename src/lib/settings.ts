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
  /** Leads each associate is handed every working morning, by segment: 12 + 8 = 20 a day (80 for four associates). */
  manufacturingPerAssociate: z.coerce.number().int().min(0).max(100).default(12),
  logisticsPerAssociate: z.coerce.number().int().min(0).max(100).default(8),
  /** Scan the news for new plants and warehouses on each run. */
  radarEnabled: z.boolean().default(true),
  /** The fewest new companies "Find new prospects" adds (split across Manufacturing and 3PL by the draw's quotas). */
  prospectsPerRun: z.coerce.number().int().min(1).max(50).default(15),
  /** No longer used (the weekday the old prospect search ran): see morningSearch. Kept so saved settings still parse. */
  prospectDay: z.coerce.number().int().min(-1).max(7).default(1),
  /** The 6 am run finds new prospects, people first, for what the 8 am draw is short of (working days, not holidays). */
  morningSearch: z.boolean().default(true),
  aiProvider: z.enum(['deepseek', 'anthropic']).default('deepseek'),
  aiModel: z.string().trim().min(1).default('deepseek-chat'),
  aiEffort: z.enum(['low', 'medium', 'high']).default('medium'),
  senderName: z.string().trim().default('INVECK Sales Team'),
  senderTitle: z.string().trim().default('Business Development'),
  senderCompany: z.string().trim().default('INVECK India'),
  demoLink: z.string().trim().default(''),
  productDescription: z.string().trim().min(20).default(DEFAULT_PRODUCT_DESCRIPTION),
  /**
   * The WhatsApp template Meta approved for INVECK's first message to someone who agreed: its name,
   * language code and body text exactly as approved, where {{1}} is the contact's first name, {{2}}
   * the sender's name and {{3}} the company. Empty: nothing goes from INVECK's number.
   */
  waTemplateName: z.string().trim().regex(/^[a-z0-9_]*$/, 'lowercase letters, numbers and _ only, as in Meta').default(''),
  waTemplateLanguage: z.string().trim().regex(/^[a-zA-Z_]{2,10}$/, 'a language code such as en or en_US').default('en'),
  waTemplateText: z
    .string()
    .trim()
    .max(1024)
    .refine((t) => [...t.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].every((m) => ['1', '2', '3'].includes(m[1])), 'only {{1}}, {{2}} and {{3}} can be filled in')
    .default(''),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_MODELS: Record<Settings['aiProvider'], string> = {
  deepseek: 'deepseek-chat',
  anthropic: 'claude-opus-5',
};

export async function getSettings(db: Db): Promise<Settings> {
  const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'app'));
  const stored = rows[0]?.value;
  const value: Record<string, unknown> = stored && typeof stored === 'object' ? { ...(stored as Record<string, unknown>) } : {};
  const parsed = settingsSchema.safeParse(value);
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
    /** Optional: Jina Reader works without a key, but with lower rate limits. */
    jina: envKey('JINA_API_KEY'),
  };
}
export type ApiKeys = ReturnType<typeof apiKeys>;
