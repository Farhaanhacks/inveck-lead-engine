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
  /** Most leads researched per run. */
  dailyLimit: z.coerce.number().int().min(1).max(500).default(25),
  /** Leads scoring below this (0-100) get no draft. */
  minScore: z.coerce.number().int().min(0).max(100).default(55),
  /** Common email formats to try, and verify with Hunter, when the company's format is unknown. */
  maxEmailGuesses: z.coerce.number().int().min(0).max(6).default(3),
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
    hunter: envKey('HUNTER_API_KEY'),
  };
}
export type ApiKeys = ReturnType<typeof apiKeys>;
