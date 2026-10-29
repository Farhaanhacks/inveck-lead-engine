import 'server-only';
import { z } from 'zod';

const serverSchema = z.object({
  GEMINI_API_KEY: z.string().optional(),
  // Featured images via WaveSpeed AI (preferred when set).
  WAVESPEED_API_KEY: z.string().optional(),
  WAVESPEED_IMAGE_MODEL: z.string().optional(),
  // Featured images via pollinations.ai (server-side sk_ key). Without it, Gemini's image model is used.
  POLLINATIONS_API_KEY: z.string().optional(),
  POLLINATIONS_IMAGE_MODEL: z.string().optional(),
  EXA_API_KEY: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  CMS_ADAPTER: z.enum(['mock', 'wordpress']).optional(),
  CMS_BASE_URL: z.string().optional(),
  CMS_USERNAME: z.string().optional(),
  CMS_APP_PASSWORD: z.string().optional(),
  // Google (read-only): one service account for Search Console and GA4.
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GSC_SITE_URL: z.string().optional(),
  GA4_PROPERTY_ID: z.string().optional(),
  // Optional: a Slack/Discord-style incoming webhook that receives failure alerts.
  ALERT_WEBHOOK_URL: z.string().optional(),
  APP_URL: z.string().optional(),
  // The first Blogs login's starting password, read once when the user is created (never stored or shown). See README.
  BLOGS_INITIAL_PASSWORD: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | undefined;

/** Validated server environment. Throws one readable error listing every problem. */
export function env(): ServerEnv {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${problems}`);
  }
  cached = parsed.data;
  return cached;
}

/** Which integrations have credentials present. Never returns the values. */
export function integrationPresence() {
  const e = env();
  return {
    gemini: !!e.GEMINI_API_KEY,
    pollinations: !!e.POLLINATIONS_API_KEY,
    wavespeed: !!e.WAVESPEED_API_KEY,
    exa: !!e.EXA_API_KEY,
    cms: (e.CMS_ADAPTER ?? (process.env.NODE_ENV === 'production' ? 'wordpress' : 'mock')) === 'mock' ? ('mock' as const) : e.CMS_BASE_URL && e.CMS_USERNAME && e.CMS_APP_PASSWORD ? ('configured' as const) : ('not_configured' as const),
    searchConsole: !!e.GOOGLE_SERVICE_ACCOUNT_JSON && !!e.GSC_SITE_URL,
    ga4: !!e.GOOGLE_SERVICE_ACCOUNT_JSON && !!e.GA4_PROPERTY_ID,
    alerts: !!e.ALERT_WEBHOOK_URL,
  };
}
