import 'server-only';
import { getDb } from '../db/client';
import { env } from '../env';
import { Ga4Provider } from './ga4';
import { GoogleAuth, parseServiceAccount } from './google-auth';
import { SearchConsoleProvider } from './search-console';
import { syncAnalytics, type SyncResult } from './sync';

function auth(scope: string) {
  const raw = env().GOOGLE_SERVICE_ACCOUNT_JSON;
  return raw ? new GoogleAuth(parseServiceAccount(raw), scope) : null;
}

export function liveSearchConsole(): SearchConsoleProvider | null {
  const site = env().GSC_SITE_URL;
  const a = auth('https://www.googleapis.com/auth/webmasters.readonly');
  return a && site ? new SearchConsoleProvider(a, site) : null;
}

export function liveGa4(): Ga4Provider | null {
  const property = env().GA4_PROPERTY_ID;
  const a = auth('https://www.googleapis.com/auth/analytics.readonly');
  return a && property ? new Ga4Provider(a, property) : null;
}

export async function runAnalyticsSync(): Promise<SyncResult> {
  return syncAnalytics((await getDb()), { search: liveSearchConsole(), engagement: liveGa4() });
}
