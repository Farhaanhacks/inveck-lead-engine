import 'server-only';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from './db/client';
import { appSettings } from './db/schema';

export const scoringWeightsSchema = z
  .object({
    trendMomentum: z.number().min(0).max(100),
    searchDemand: z.number().min(0).max(100),
    competitionGap: z.number().min(0).max(100),
    relevance: z.number().min(0).max(100),
    engagementPotential: z.number().min(0).max(100),
  })
  .refine((w) => Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 100) < 0.001, { message: 'Weights must add up to 100' });

export const queueConfigSchema = z.object({
  timezone: z.string().default('Asia/Kolkata'),
  targetPerDay: z.number().int().min(1).max(50).default(5),
  maxPerDay: z.number().int().min(1).max(50).default(10),
  windows: z.array(z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })).default([{ start: '09:00', end: '21:00' }]),
  minIntervalMinutes: z.number().int().min(1).default(60),
  maxConcurrentJobs: z.number().int().min(1).max(10).default(2),
  autoSlotApproved: z.boolean().default(false),
});

export const budgetSchema = z.object({
  dailyUsd: z.number().min(0).nullable().default(null),
  monthlyUsd: z.number().min(0).nullable().default(null),
});

export const SETTING_DEFAULTS = {
  scoringWeights: { trendMomentum: 25, searchDemand: 25, competitionGap: 20, relevance: 15, engagementPotential: 15 },
  queue: { timezone: 'Asia/Kolkata', targetPerDay: 5, maxPerDay: 10, windows: [{ start: '09:00', end: '21:00' }], minIntervalMinutes: 60, maxConcurrentJobs: 2, autoSlotApproved: false },
  budget: { dailyUsd: null, monthlyUsd: null },
  cmsStatus: null as null | { state: string; detail: string; checkedAt: string; siteName?: string },
  // Verified against the project's key on 2026-10-18: Pro models returned 429 (quota) and 2.5-* returned 404, so Flash models are the defaults.
  // Re-checked 2026-10-22: 3.8-flash hit this key's free daily quota (429); 3.5-flash with low thinking wrote 760 words in ~10s.
  models: { writing: 'gemini-3.5-flash', fast: 'gemini-3.5-flash', image: 'gemini-3.1-flash-image' },
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type ScoringWeights = z.infer<typeof scoringWeightsSchema>;
export type QueueConfig = z.infer<typeof queueConfigSchema>;

export async function getSetting<K extends SettingKey>(key: K): Promise<(typeof SETTING_DEFAULTS)[K]> {
  const [row] = await (await getDb()).select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return (row ? { ...SETTING_DEFAULTS[key], ...(row.value as object) } : SETTING_DEFAULTS[key]) as (typeof SETTING_DEFAULTS)[K];
}

export async function putSetting(key: SettingKey, value: unknown) {
  await (await getDb())
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}
