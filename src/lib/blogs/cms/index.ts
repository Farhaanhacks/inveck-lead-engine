import 'server-only';
import { env } from '../env';
import { MockCmsAdapter, UnconfiguredCmsAdapter } from './mock';
import type { CmsAdapter } from './types';
import { WordPressAdapter } from './wordpress';

let mock: MockCmsAdapter | undefined;

/**
 * Chooses the adapter from configuration. The mock is for local development only: in production a missing
 * or mock configuration yields an adapter that reports "not configured" and refuses to publish.
 */
export function getCmsAdapter(): CmsAdapter {
  const e = env();
  const production = process.env.NODE_ENV === 'production';
  const wanted = e.CMS_ADAPTER ?? (production ? 'wordpress' : 'mock');
  if (wanted === 'mock') {
    if (production) return new UnconfiguredCmsAdapter('CMS_ADAPTER=mock is not allowed in production. Configure the WordPress connection.');
    return (mock ??= new MockCmsAdapter());
  }
  const missing = (['CMS_BASE_URL', 'CMS_USERNAME', 'CMS_APP_PASSWORD'] as const).filter((k) => !e[k]?.trim());
  if (missing.length) {
    // Names only, never values. On Vercel, a variable added after the last deployment is not visible until a redeploy.
    return new UnconfiguredCmsAdapter(`WordPress is not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing in this deployment. Add ${missing.length === 1 ? 'it' : 'them'} for the Production environment and redeploy.`);
  }
  return new WordPressAdapter(e.CMS_BASE_URL!.trim(), e.CMS_USERNAME!.trim(), e.CMS_APP_PASSWORD!);
}
